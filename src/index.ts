/**
 * autoresearch — OpenCode 2 plugin
 *
 * Autonomous experiment loop: run a benchmark, log the result, keep or
 * discard, repeat. Port of pi-autoresearch (https://github.com/davebcn87/pi-autoresearch).
 *
 * Provides:
 * - `init_experiment`, `run_experiment`, `log_experiment` tools, visible to
 *   the model only while autoresearch mode is active for the session
 * - Autoresearch guidance in the system prompt while active
 * - Deterministic compaction summary built from `.auto/` state (no LLM call)
 * - Auto-resume: re-prompts the agent after each turn that logged a run,
 *   and after compaction
 * - `/autoresearch [off|clear|dashboard|export|<goal>]` command
 * - Bundled skills: autoresearch-create, autoresearch-finalize, autoresearch-hooks
 */

import type { Plugin } from "@opencode/plugin";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { autoresearchSummaryPathsFor, buildAutoresearchCompactionSummary } from "./compaction.ts";
import { createDashboardServer, renderDashboardMarkdown } from "./dashboard.ts";
import {
  autoResumeStopReasonFor,
  canonicalPath,
  computeConfidence,
  createExperimentState,
  currentResults,
  findBaselineMetric,
  findBaselineSecondary,
  findBestMetric,
  formatElapsed,
  formatNum,
  formatSize,
  inferMetricUnit,
  isAutoresearchShCommand,
  parseMetricLines,
  readMaxExperiments,
  resolveWorkDir,
  shouldAutoActivateAutoresearch,
  truncateTail,
  validateWorkDir,
  type ASI,
  type ExperimentResult,
  type ExperimentState,
  type ExperimentStatus,
} from "./experiment.ts";
import { appendHookLogEntryIfConfigured, runHook, steerMessageFor, type HookPayload, type SessionSnapshot } from "./hooks.ts";
import { isAutoresearchRunEntry, parseJsonlEntry, reconstructJsonlState } from "./jsonl.ts";
import { AUTO_DIR, ensureParentDir, sessionFileCandidates, sessionFilePath } from "./paths.ts";
import { exec, runStreamed } from "./runner.ts";

export {
  AUTORESUME_TURN_LIMIT,
  CONSECUTIVE_FAILURE_OVERRIDE_LIMIT,
  autoResumeStopReasonFor,
  countConsecutiveDiscardOrCrashResults,
  shouldAutoActivateAutoresearch,
} from "./experiment.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Output sent to the LLM from run_experiment — keep small to save context. */
const EXPERIMENT_MAX_LINES = 10;
const EXPERIMENT_MAX_BYTES = 4 * 1024;

/** Wait this long after a turn ends before auto-resuming, so a user message can win. */
const SETTLED_WINDOW_MS = 800;

const TOOL_NAMES = new Set(["init_experiment", "run_experiment", "log_experiment"]);
const CREATE_SKILL_ID = "autoresearch-create";

const BENCHMARK_GUARDRAIL = "Be careful not to overfit to the benchmarks and do not cheat on the benchmarks.";

const REVISIT_PROMPT =
  "Before choosing the next experiment, consider whether this result or discovery invalidates a previous discard's rollback reason. If so, name what changed and weigh a targeted retry against other candidates. Otherwise, move on. Don't revive a discarded idea without a changed assumption. Verification reruns to resolve measurement noise are separate.";

const RESUME_MESSAGE = [
  "Run the next iteration now.",
  "Use the persisted autoresearch state as needed, pick the most promising hypothesis, then call run_experiment + log_experiment.",
  BENCHMARK_GUARDRAIL,
].join(" ");

const COMPACTION_RESUME_MESSAGE = [
  "Run the next iteration now.",
  "Pick the most promising hypothesis from the ideas backlog or the latest `next:` hints in recent runs, then call run_experiment + log_experiment.",
  "Do not re-read .auto/prompt.md or .auto/log.jsonl — the compaction summary already contains them.",
  BENCHMARK_GUARDRAIL,
].join(" ");

const HELP_TEXT = [
  "Usage: /autoresearch [off|clear|export|dashboard|<text>]",
  "",
  "<text> enters autoresearch mode and starts or resumes the loop.",
  "off leaves autoresearch mode.",
  "clear deletes the session log (.auto/log.jsonl) and turns autoresearch mode off.",
  "export opens a live dashboard for the session log in your browser.",
  "dashboard prints the full results table.",
  "",
  "Examples:",
  "  /autoresearch optimize unit test runtime, monitor correctness",
  "  /autoresearch model training, run 5 minutes of train.py and note the loss ratio as optimization target",
].join("\n");

const TOOL_GUIDELINES = [
  "Call init_experiment exactly once at the start of an autoresearch session, before the first run_experiment. If .auto/log.jsonl already has a config, do NOT call it again — unless the optimization target changes (different benchmark, metric, or workload), in which case call it again to start a new segment with a fresh baseline.",
  "Use run_experiment instead of bash for experiment commands — it handles timing and output capture. If the benchmark prints `METRIC name=value` lines, run_experiment parses them; use those values directly in log_experiment.",
  "Always call log_experiment after run_experiment. It runs `git add -A && git commit` on 'keep' and auto-reverts code changes on 'discard'/'crash'/'checks_failed' (.auto/ files are preserved). Do NOT commit or revert manually.",
  "Use status 'keep' if the PRIMARY metric improved, 'discard' if worse or unchanged, 'crash' if it failed. Secondary metrics are for monitoring — only discard a primary improvement if a secondary metric degraded catastrophically, and say why in the description.",
  "log_experiment reports a confidence score after 3+ runs (best improvement as a multiple of the noise floor). ≥2.0× is likely real, <1.0× is within noise — consider re-running before keeping. The score is advisory.",
  'Always include the asi parameter. At minimum {"hypothesis": "what you tried"}. On discard/crash also include rollback_reason and next_action_hint. This is the only structured memory that survives reverts.',
  "When retrying a previously discarded idea because its assumptions changed, set asi.revisits_run to the earlier run number and explain what changed in the description. Omit it for new ideas and verification reruns.",
];

// ---------------------------------------------------------------------------
// Tool input schemas (JSON Schema)
// ---------------------------------------------------------------------------

const InitParams = {
  type: "object",
  properties: {
    name: {
      type: "string",
      description: 'Human-readable name for this experiment session (e.g. "Optimizing liquid for fastest execution and parsing")',
    },
    metric_name: {
      type: "string",
      description: 'Display name for the primary metric (e.g. "total_µs", "bundle_kb", "val_bpb"). Must match the METRIC line name.',
    },
    metric_unit: {
      type: "string",
      description: 'Unit for the primary metric. Use "µs", "ms", "s", "kb", "mb", or "" for unitless. Default: ""',
    },
    direction: {
      type: "string",
      enum: ["lower", "higher"],
      description: 'Whether "lower" or "higher" is better for the primary metric. Default: "lower".',
    },
  },
  required: ["name", "metric_name"],
  additionalProperties: false,
} as const;

const RunParams = {
  type: "object",
  properties: {
    command: {
      type: "string",
      description: "Shell command to run (e.g. './.auto/measure.sh'). If .auto/measure.sh exists, it must be this script.",
    },
    timeout_seconds: { type: "number", description: "Kill after this many seconds (default: 600)" },
    checks_timeout_seconds: {
      type: "number",
      description: "Kill .auto/checks.sh after this many seconds (default: 300). Only relevant when the checks file exists.",
    },
  },
  required: ["command"],
  additionalProperties: false,
} as const;

export const LogParams = {
  type: "object",
  properties: {
    commit: { type: "string", description: "Git commit hash (short, 7 chars)" },
    metric: {
      type: "number",
      description: "The primary optimization metric value (e.g. seconds, val_bpb). 0 for crashes.",
    },
    status: { type: "string", enum: ["keep", "discard", "crash", "checks_failed"] },
    description: { type: "string", description: "Short description of what this experiment tried" },
    metrics: {
      type: "object",
      additionalProperties: { type: "number" },
      description:
        'Additional metrics to track as { name: value } pairs, e.g. { "compile_µs": 4200, "render_µs": 9800 }. Once tracked, include them in every run.',
    },
    force: {
      type: "boolean",
      description: "Set to true to allow adding a new secondary metric that wasn't tracked before. Only for metrics that have proven very valuable to watch.",
    },
    asi: {
      type: "object",
      additionalProperties: true,
      description:
        "Actionable Side Information — structured diagnostics for this run. Free-form key/value pairs: hypothesis, rollback_reason, next_action_hint, revisits_run, and anything else you learned.",
    },
  },
  required: ["commit", "metric", "status", "description"],
  additionalProperties: false,
} as const;

interface InitInput {
  name: string;
  metric_name: string;
  metric_unit?: string;
  direction?: string;
}

interface RunInput {
  command: string;
  timeout_seconds?: number;
  checks_timeout_seconds?: number;
}

interface LogInput {
  commit: string;
  metric: number;
  status: ExperimentStatus;
  description: string;
  metrics?: Record<string, number>;
  force?: boolean;
  asi?: ASI;
}

// ---------------------------------------------------------------------------
// Per-session runtime
// ---------------------------------------------------------------------------

interface Runtime {
  active: boolean;
  state: ExperimentState;
  /** Experiments logged since the current execution started (gates auto-resume). */
  experimentsThisTurn: number;
  autoResumeTurns: number;
  busy: boolean;
  /** The last execution was interrupted by the user — don't auto-resume after it. */
  interrupted: boolean;
  lastRunChecks: { pass: boolean; output: string } | null;
  lastRunDuration: number | null;
  pendingResumeMessage: string | null;
  pendingResumeTimer: ReturnType<typeof setTimeout> | null;
}

interface ActivationRecord {
  workDir: string;
  active: boolean;
}

function loadState(cwd: string, workDir: string): { state: ExperimentState; hasLog: boolean } {
  const state = createExperimentState();
  const jsonlPath = sessionFilePath(workDir, "log");
  const hasLog = fs.existsSync(jsonlPath);
  if (hasLog) {
    try {
      const rec = reconstructJsonlState(fs.readFileSync(jsonlPath, "utf-8"));
      state.name = rec.name;
      state.metricName = rec.metricName;
      state.metricUnit = rec.metricUnit;
      state.bestDirection = rec.bestDirection;
      state.currentSegment = rec.currentSegment;
      state.results = rec.results.map((r) => ({ ...r, metrics: { ...r.metrics } })) as ExperimentResult[];
      state.secondaryMetrics = rec.secondaryMetrics.map((m) => ({ ...m }));
      if (state.results.length > 0) {
        state.bestMetric = findBaselineMetric(state.results, state.currentSegment);
        state.confidence = computeConfidence(state.results, state.currentSegment, state.bestDirection);
      }
    } catch {
      // Corrupt log — start from an empty state; the file is left untouched.
    }
  }
  state.maxExperiments = readMaxExperiments(cwd);
  return { state, hasLog };
}

function sessionSnapshot(state: ExperimentState): SessionSnapshot {
  return {
    metric_name: state.metricName,
    metric_unit: state.metricUnit,
    direction: state.bestDirection,
    baseline_metric: state.bestMetric,
    best_metric: findBestMetric(state.results, state.currentSegment, state.bestDirection),
    run_count: state.results.length,
    goal: state.name ?? "",
  };
}

function readLastRun(workDir: string): Record<string, unknown> | null {
  const jsonlPath = sessionFilePath(workDir, "log");
  if (!fs.existsSync(jsonlPath)) return null;
  const lines = fs.readFileSync(jsonlPath, "utf-8").split("\n").filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const entry = parseJsonlEntry(lines[i]);
    if (isAutoresearchRunEntry(entry)) return entry;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Bundled skills
// ---------------------------------------------------------------------------

interface BundledSkill {
  id: string;
  name: string;
  description: string | undefined;
  path: string;
  content: string;
}

const SKILLS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../skills");

/**
 * Read bundled SKILL.md files. Frontmatter is parsed for name/description and
 * `<SKILL_DIR>`/`<skill-dir>` placeholders are expanded to the skill's absolute
 * directory so bundled scripts and examples resolve wherever the plugin lives.
 */
function loadBundledSkills(): BundledSkill[] {
  const skills: BundledSkill[] = [];
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(SKILLS_DIR);
  } catch {
    return skills;
  }
  for (const dir of entries.sort()) {
    const file = path.join(SKILLS_DIR, dir, "SKILL.md");
    if (!fs.existsSync(file)) continue;
    const raw = fs.readFileSync(file, "utf-8");
    const match = raw.match(/^---\n([\s\S]*?)\n---\n?/);
    const front = match?.[1] ?? "";
    const field = (key: string) => front.match(new RegExp(`^${key}:\\s*(.+)$`, "m"))?.[1]?.trim();
    const skillDir = path.dirname(file);
    const body = raw.slice(match?.[0].length ?? 0).replace(/<SKILL_DIR>|<skill-dir>/g, skillDir);
    skills.push({
      id: field("name") ?? dir,
      name: field("name") ?? dir,
      description: field("description"),
      path: file,
      content: `${body.trimStart()}\n\nSkill directory: ${skillDir}\n`,
    });
  }
  return skills;
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const plugin: Plugin.Plugin = {
  id: "autoresearch",
  async setup(ctx) {
    const cwd = ctx.location.directory;
    const runtimes = new Map<string, Runtime>();
    const loading = new Map<string, Promise<Runtime>>();
    const dashboard = createDashboardServer();
    const skills = loadBundledSkills();

    // -- activation --------------------------------------------------------

    const activationKey = (sessionID: string) => `activation/${sessionID}`;

    const recordedActivation = async (sessionID: string, workDir: string): Promise<boolean | null> => {
      try {
        const value = (await ctx.storage.get(activationKey(sessionID))) as ActivationRecord | undefined;
        if (!value || typeof value.workDir !== "string") return null;
        return canonicalPath(value.workDir) === canonicalPath(workDir) ? value.active === true : null;
      } catch {
        return null;
      }
    };

    const setActive = async (sessionID: string, rt: Runtime, active: boolean): Promise<void> => {
      rt.active = active;
      if (!active) cancelPendingResume(rt);
      try {
        await ctx.storage.set(activationKey(sessionID), { workDir: canonicalPath(resolveWorkDir(cwd)), active });
      } catch {
        // Storage is best-effort; the in-memory flag still applies.
      }
    };

    /** Load (once) the session's runtime from `.auto/log.jsonl` and its recorded activation. */
    const runtimeFor = (sessionID: string): Promise<Runtime> => {
      const existing = runtimes.get(sessionID);
      if (existing) return Promise.resolve(existing);
      let pending = loading.get(sessionID);
      if (!pending) {
        pending = (async () => {
          const workDir = resolveWorkDir(cwd);
          const { state, hasLog } = loadState(cwd, workDir);
          const recorded = await recordedActivation(sessionID, workDir);
          const rt: Runtime = {
            active: shouldAutoActivateAutoresearch(cwd, workDir, hasLog, recorded),
            state,
            experimentsThisTurn: 0,
            autoResumeTurns: 0,
            busy: false,
            interrupted: false,
            lastRunChecks: null,
            lastRunDuration: null,
            pendingResumeMessage: null,
            pendingResumeTimer: null,
          };
          runtimes.set(sessionID, rt);
          loading.delete(sessionID);
          return rt;
        })();
        loading.set(sessionID, pending);
      }
      return pending;
    };

    // -- messaging ---------------------------------------------------------

    /** Show a message in the transcript without starting a turn. */
    const notify = async (sessionID: string, text: string): Promise<void> => {
      await ctx.session.synthetic({ sessionID, text, description: "autoresearch", resume: false });
    };

    /** Inject a steer into the running turn (hook output). Fire-and-forget. */
    const steer = (sessionID: string, text: string): void => {
      ctx.session.prompt({ sessionID, text, delivery: "steer" }).catch(() => {});
    };

    const fireHook = async (payload: HookPayload): Promise<string | null> => {
      const result = await runHook(payload);
      appendHookLogEntryIfConfigured(sessionFilePath(payload.cwd, "log"), payload.event, result);
      return steerMessageFor(payload.event, result);
    };

    // -- auto-resume -------------------------------------------------------

    function pausePendingResume(rt: Runtime): void {
      if (!rt.pendingResumeTimer) return;
      clearTimeout(rt.pendingResumeTimer);
      rt.pendingResumeTimer = null;
    }

    function cancelPendingResume(rt: Runtime): void {
      pausePendingResume(rt);
      rt.pendingResumeMessage = null;
    }

    const sendPendingResume = (sessionID: string, rt: Runtime): void => {
      rt.pendingResumeTimer = null;
      const message = rt.pendingResumeMessage;
      if (!message) return;
      if (!rt.active) {
        cancelPendingResume(rt);
        return;
      }
      if (rt.busy) return; // rescheduled when the running turn ends
      const stopReason = autoResumeStopReasonFor(rt);
      cancelPendingResume(rt);
      if (stopReason !== null) {
        notify(sessionID, stopReason).catch(() => {});
        return;
      }
      rt.autoResumeTurns++;
      ctx.session.prompt({ sessionID, text: message }).catch(() => {});
    };

    const scheduleResume = (sessionID: string, rt: Runtime, message: string): void => {
      pausePendingResume(rt);
      rt.pendingResumeMessage = message;
      rt.pendingResumeTimer = setTimeout(() => sendPendingResume(sessionID, rt), SETTLED_WINDOW_MS);
    };

    const ensureResume = (sessionID: string, rt: Runtime, gate: boolean, message: string): void => {
      if (rt.pendingResumeMessage !== null) {
        scheduleResume(sessionID, rt, rt.pendingResumeMessage);
        return;
      }
      if (!gate) return;
      const stopReason = autoResumeStopReasonFor(rt);
      if (stopReason !== null) {
        notify(sessionID, stopReason).catch(() => {});
        return;
      }
      scheduleResume(sessionID, rt, message);
    };

    const events = new AbortController();
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: events.signal })) {
          const data = (event as { data?: { sessionID?: unknown } }).data;
          const sessionID = typeof data?.sessionID === "string" ? data.sessionID : undefined;
          const rt = sessionID ? runtimes.get(sessionID) : undefined;
          if (!sessionID || !rt) continue;

          switch (event.type) {
            case "session.execution.started":
              rt.busy = true;
              rt.interrupted = false;
              rt.experimentsThisTurn = 0;
              pausePendingResume(rt);
              break;
            case "session.execution.interrupted":
              rt.busy = false;
              if (event.data.reason === "user") {
                rt.interrupted = true;
                cancelPendingResume(rt);
              }
              break;
            // OpenCode 2 ends a turn with execution.succeeded/failed; it never emits
            // session.idle, which is handled only in case a later release does.
            // Failed turns resume too (pi parity): a turn that failed after logging
            // an experiment gets one retry, and the gate below stops a failing loop.
            case "session.execution.succeeded":
            case "session.execution.failed":
            case "session.idle": {
              rt.busy = false;
              if (rt.interrupted) break;
              // Why the experiment gate: a chat-only turn would otherwise loop
              // forever — every turn end would re-prompt, which would chat again.
              const gate = rt.active && rt.experimentsThisTurn > 0;
              // Consume the turn so a second end event can't schedule twice.
              rt.experimentsThisTurn = 0;
              ensureResume(sessionID, rt, gate, RESUME_MESSAGE);
              break;
            }
            case "session.compaction.ended":
              // Compaction itself is evidence the loop should continue.
              if (rt.active && !rt.busy) ensureResume(sessionID, rt, true, COMPACTION_RESUME_MESSAGE);
              else if (rt.active) rt.pendingResumeMessage ??= COMPACTION_RESUME_MESSAGE;
              break;
          }
        }
      } catch {
        // Subscription closed (plugin disposed or service shutting down).
      }
    })();

    // -- system prompt + tool gating --------------------------------------

    await ctx.session.hook("context", async (event) => {
      const rt = await runtimeFor(event.sessionID);
      if (!rt.active) {
        // Keys are effective names; also match a namespace prefix in case one is applied.
        for (const key of Object.keys(event.tools)) {
          if ([...TOOL_NAMES].some((name) => key === name || key.endsWith(`.${name}`) || key.endsWith(`_${name}`))) {
            delete event.tools[key];
          }
        }
        return;
      }

      const workDir = resolveWorkDir(cwd);
      const mdPath = sessionFilePath(workDir, "prompt");
      const ideasPath = sessionFilePath(workDir, "ideas");
      const checksPath = sessionFilePath(workDir, "checks");

      let text =
        "## Autoresearch Mode (ACTIVE)" +
        "\nYou are in autoresearch mode. Optimize the primary metric through an autonomous experiment loop." +
        "\nUse init_experiment, run_experiment, and log_experiment tools. NEVER STOP until interrupted." +
        `\nExperiment rules: ${mdPath} — read this file at the start of every session and after compaction.` +
        `\nWrite promising but deferred optimizations as bullet points to ${AUTO_DIR}/ideas.md — don't let good ideas get lost.` +
        `\n${BENCHMARK_GUARDRAIL}` +
        "\nIf the user sends a follow-on message while an experiment is running, finish the current run_experiment + log_experiment cycle first, then address their message in the next iteration." +
        "\n\n### Tool rules\n" +
        TOOL_GUIDELINES.map((g) => `- ${g}`).join("\n");

      if (fs.existsSync(checksPath)) {
        text +=
          "\n\n## Backpressure Checks (ACTIVE)" +
          `\n${checksPath} exists and runs automatically after every passing benchmark in run_experiment.` +
          "\nIf the benchmark passes but checks fail, run_experiment will report it clearly." +
          "\nUse status 'checks_failed' in log_experiment when this happens — it behaves like a crash (no commit, changes auto-reverted)." +
          "\nYou cannot use status 'keep' when checks have failed." +
          "\nThe checks execution time does NOT affect the primary metric.";
      }
      if (fs.existsSync(ideasPath)) {
        text += `\n\n💡 Ideas backlog exists at ${ideasPath} — check it for promising experiment paths. Prune stale entries.`;
      }

      event.system.push({ type: "text", text });
    });

    // -- deterministic compaction -----------------------------------------

    await ctx.session.hook("compaction", async (event) => {
      const rt = await runtimeFor(event.sessionID);
      if (!rt.active) return;
      pausePendingResume(rt);
      event.result = {
        summary: buildAutoresearchCompactionSummary(autoresearchSummaryPathsFor(resolveWorkDir(cwd))),
      };
    });

    // -- tools -------------------------------------------------------------

    const initExperiment = async (input: InitInput, sessionID: string): Promise<string> => {
      const rt = await runtimeFor(sessionID);
      const state = rt.state;
      const workDirError = validateWorkDir(cwd);
      if (workDirError) return `❌ ${workDirError}`;

      const isReinit = state.results.length > 0;
      state.name = input.name;
      state.metricName = input.metric_name;
      state.metricUnit = input.metric_unit ?? "";
      if (input.direction === "lower" || input.direction === "higher") state.bestDirection = input.direction;
      // New segment: keep history for the dashboard, reset baseline tracking.
      if (isReinit) state.currentSegment++;
      state.bestMetric = null;
      state.secondaryMetrics = [];
      state.confidence = null;
      state.maxExperiments = readMaxExperiments(cwd);

      const workDir = resolveWorkDir(cwd);
      try {
        const jsonlPath = sessionFilePath(workDir, "log");
        ensureParentDir(jsonlPath);
        const header = JSON.stringify({
          type: "config",
          name: state.name,
          metricName: state.metricName,
          metricUnit: state.metricUnit,
          bestDirection: state.bestDirection,
        });
        fs.appendFileSync(jsonlPath, header + "\n");
        dashboard.broadcast(workDir);
      } catch (e) {
        return `⚠️ Failed to write ${AUTO_DIR}/log.jsonl: ${e instanceof Error ? e.message : String(e)}`;
      }

      const wasInactive = !rt.active;
      await setActive(sessionID, rt, true);
      if (wasInactive) {
        const hookSteer = await fireHook({
          event: "before",
          cwd: workDir,
          next_run: state.results.length + 1,
          last_run: readLastRun(workDir),
          session: sessionSnapshot(state),
        });
        if (hookSteer) steer(sessionID, hookSteer);
      }

      const reinitNote = isReinit ? " (re-initialized — previous results archived, new baseline needed)" : "";
      const limitNote = state.maxExperiments !== null ? `\nMax iterations: ${state.maxExperiments} (from ${AUTO_DIR}/config.json)` : "";
      const workDirNote = workDir !== cwd ? `\nWorking directory: ${workDir}` : "";
      return `✅ Experiment initialized: "${state.name}"${reinitNote}\nMetric: ${state.metricName} (${state.metricUnit || "unitless"}, ${state.bestDirection} is better)${limitNote}${workDirNote}\nConfig written to ${AUTO_DIR}/log.jsonl. Now run the baseline with run_experiment.`;
    };

    const runExperiment = async (
      input: RunInput,
      sessionID: string,
      signal: AbortSignal,
      progress: (update: Record<string, unknown>) => Promise<void>,
    ): Promise<{ text: string; metadata: Record<string, unknown> }> => {
      const rt = await runtimeFor(sessionID);
      const state = rt.state;
      const workDirError = validateWorkDir(cwd);
      if (workDirError) return { text: `❌ ${workDirError}`, metadata: {} };
      const workDir = resolveWorkDir(cwd);

      if (state.maxExperiments !== null && currentResults(state.results, state.currentSegment).length >= state.maxExperiments) {
        return {
          text: `🛑 Maximum experiments reached (${state.maxExperiments}). The experiment loop is done. To continue, call init_experiment to start a new segment.`,
          metadata: {},
        };
      }

      // If the benchmark script exists, only allow running it.
      const scriptPath = sessionFilePath(workDir, "measure");
      const scriptRel = path.relative(workDir, scriptPath) || path.basename(scriptPath);
      if (fs.existsSync(scriptPath) && !isAutoresearchShCommand(input.command)) {
        return {
          text: `❌ ${scriptRel} exists — you must run it instead of a custom command.\n\nFound: ${scriptPath}\nYour command: ${input.command}\n\nUse: run_experiment({ command: "bash ${scriptRel}" }) or run_experiment({ command: "./${scriptRel}" })`,
          metadata: { crashed: true },
        };
      }

      const t0 = Date.now();
      const run = await runStreamed(input.command, {
        cwd: workDir,
        timeoutMs: (input.timeout_seconds ?? 600) * 1000,
        signal,
        onTick: (tail) => {
          const preview = truncateTail(tail, { maxLines: 5, maxBytes: 2048 }).content;
          progress({ title: `⏳ Running ${formatElapsed(Date.now() - t0)}…`, output: preview }).catch(() => {});
        },
      });
      const durationSeconds = (Date.now() - t0) / 1000;
      rt.lastRunDuration = durationSeconds;
      const benchmarkPassed = run.exitCode === 0 && !run.timedOut;

      // Backpressure checks run only after a passing benchmark.
      let checksPass: boolean | null = null;
      let checksTimedOut = false;
      let checksOutput = "";
      let checksDuration = 0;
      const checksPath = sessionFilePath(workDir, "checks");
      if (benchmarkPassed && fs.existsSync(checksPath)) {
        const ct0 = Date.now();
        try {
          const res = await exec("bash", [checksPath], {
            cwd: workDir,
            timeout: (input.checks_timeout_seconds ?? 300) * 1000,
            signal,
          });
          checksTimedOut = res.killed;
          checksPass = res.code === 0 && !res.killed;
          checksOutput = (res.stdout + "\n" + res.stderr).trim();
        } catch (e) {
          checksPass = false;
          checksOutput = e instanceof Error ? e.message : String(e);
        }
        checksDuration = (Date.now() - ct0) / 1000;
      }
      rt.lastRunChecks = checksPass !== null ? { pass: checksPass, output: checksOutput } : null;
      const passed = benchmarkPassed && checksPass !== false;

      let fullOutputPath = run.fullOutputPath;
      const totalLines = run.output.split("\n").length;
      if (!fullOutputPath && (run.totalBytes > EXPERIMENT_MAX_BYTES || totalLines > EXPERIMENT_MAX_LINES)) {
        fullOutputPath = path.join(fs.mkdtempSync(path.join(tmpdir(), "opencode-experiment-")), "output.log");
        fs.writeFileSync(fullOutputPath, run.output);
      }
      const llmTail = truncateTail(run.output, { maxLines: EXPERIMENT_MAX_LINES, maxBytes: EXPERIMENT_MAX_BYTES });

      const parsed = parseMetricLines(run.output);
      const parsedMetrics = parsed.size > 0 ? Object.fromEntries(parsed) : null;
      const parsedPrimary = parsed.get(state.metricName) ?? null;

      let text = "";
      if (run.timedOut) text += `⏰ TIMEOUT after ${durationSeconds.toFixed(1)}s\n`;
      else if (!benchmarkPassed) text += `💥 FAILED (exit code ${run.exitCode}) in ${durationSeconds.toFixed(1)}s\n`;
      else if (checksTimedOut) {
        text += `✅ Benchmark PASSED in ${durationSeconds.toFixed(1)}s\n`;
        text += `⏰ CHECKS TIMEOUT (${AUTO_DIR}/checks.sh) after ${checksDuration.toFixed(1)}s\n`;
        text += `Log this as 'checks_failed' — the benchmark metric is valid but checks timed out.\n`;
      } else if (checksPass === false) {
        text += `✅ Benchmark PASSED in ${durationSeconds.toFixed(1)}s\n`;
        text += `💥 CHECKS FAILED (${AUTO_DIR}/checks.sh) in ${checksDuration.toFixed(1)}s\n`;
        text += `Log this as 'checks_failed' — the benchmark metric is valid but correctness checks did not pass.\n`;
      } else {
        text += `✅ PASSED in ${durationSeconds.toFixed(1)}s\n`;
        if (checksPass === true) text += `✅ Checks passed in ${checksDuration.toFixed(1)}s\n`;
      }

      if (state.bestMetric !== null) {
        text += `📊 Current best ${state.metricName}: ${formatNum(state.bestMetric, state.metricUnit)}\n`;
      }

      if (parsedMetrics) {
        const secondary = Object.entries(parsedMetrics).filter(([k]) => k !== state.metricName);
        text += `\n📐 Parsed metrics:`;
        if (parsedPrimary !== null) text += ` ★ ${state.metricName}=${formatNum(parsedPrimary, state.metricUnit)}`;
        for (const [name, value] of secondary) {
          const unit = state.secondaryMetrics.find((m) => m.name === name)?.unit ?? "";
          text += ` ${name}=${formatNum(value, unit)}`;
        }
        text += `\nUse these values directly in log_experiment (metric: ${parsedPrimary ?? "?"}, metrics: {${secondary.map(([k, v]) => `"${k}": ${v}`).join(", ")}})\n`;
      }

      text += `\n${llmTail.content}`;
      if (llmTail.truncated) {
        text +=
          llmTail.truncatedBy === "lines"
            ? `\n\n[Showing last ${llmTail.outputLines} of ${llmTail.totalLines} lines.`
            : `\n\n[Showing last ${llmTail.outputLines} lines (${formatSize(EXPERIMENT_MAX_BYTES)} limit).`;
        if (fullOutputPath) text += ` Full output: ${fullOutputPath}`;
        text += `]`;
      }
      if (checksPass === false) {
        text += `\n\n── Checks output (last 80 lines) ──\n${checksOutput.split("\n").slice(-80).join("\n")}`;
      }

      return {
        text,
        metadata: {
          command: input.command,
          exitCode: run.exitCode,
          durationSeconds,
          passed,
          timedOut: run.timedOut,
          checksPass,
          parsedMetrics,
          parsedPrimary,
          fullOutputPath,
        },
      };
    };

    const logExperiment = async (input: LogInput, sessionID: string): Promise<{ text: string; metadata: Record<string, unknown> }> => {
      const rt = await runtimeFor(sessionID);
      const state = rt.state;
      const workDirError = validateWorkDir(cwd);
      if (workDirError) return { text: `❌ ${workDirError}`, metadata: {} };
      const workDir = resolveWorkDir(cwd);
      const secondaryMetrics = input.metrics ?? {};

      if (input.status === "keep" && rt.lastRunChecks && !rt.lastRunChecks.pass) {
        return {
          text: `❌ Cannot keep — ${AUTO_DIR}/checks.sh failed.\n\n${rt.lastRunChecks.output.slice(-500)}\n\nLog as 'checks_failed' instead. The benchmark metric is valid but correctness checks did not pass.`,
          metadata: {},
        };
      }

      if (state.secondaryMetrics.length > 0) {
        const known = new Set(state.secondaryMetrics.map((m) => m.name));
        const provided = new Set(Object.keys(secondaryMetrics));
        const missing = [...known].filter((n) => !provided.has(n));
        if (missing.length > 0) {
          return {
            text: `❌ Missing secondary metrics: ${missing.join(", ")}\n\nYou must provide all previously tracked metrics. Expected: ${[...known].join(", ")}\nGot: ${[...provided].join(", ") || "(none)"}\n\nFix: include ${missing.map((m) => `"${m}": <value>`).join(", ")} in the metrics parameter.`,
            metadata: {},
          };
        }
        const added = [...provided].filter((n) => !known.has(n));
        if (added.length > 0 && !input.force) {
          return {
            text: `❌ New secondary metric${added.length > 1 ? "s" : ""} not previously tracked: ${added.join(", ")}\n\nExisting metrics: ${[...known].join(", ")}\n\nIf this metric has proven very valuable to watch, call log_experiment again with force: true to add it. Otherwise, remove it from the metrics parameter.`,
            metadata: {},
          };
        }
      }

      const asi = input.asi && Object.keys(input.asi).length > 0 ? input.asi : undefined;
      const experiment: ExperimentResult = {
        commit: input.commit.slice(0, 7),
        metric: input.metric,
        metrics: secondaryMetrics,
        status: input.status,
        description: input.description,
        timestamp: Date.now(),
        segment: state.currentSegment,
        confidence: null,
        asi,
      };
      state.results.push(experiment);
      rt.experimentsThisTurn++;

      for (const name of Object.keys(secondaryMetrics)) {
        if (!state.secondaryMetrics.find((m) => m.name === name)) {
          state.secondaryMetrics.push({ name, unit: inferMetricUnit(name) });
        }
      }
      state.bestMetric = findBaselineMetric(state.results, state.currentSegment);
      state.confidence = computeConfidence(state.results, state.currentSegment, state.bestDirection);
      experiment.confidence = state.confidence;

      const segmentCount = currentResults(state.results, state.currentSegment).length;
      let text = `Logged #${state.results.length}: ${experiment.status} — ${experiment.description}`;

      if (state.bestMetric !== null) {
        text += `\nBaseline ${state.metricName}: ${formatNum(state.bestMetric, state.metricUnit)}`;
        if (segmentCount > 1 && input.status === "keep" && input.metric > 0) {
          const delta = input.metric - state.bestMetric;
          text += ` | this: ${formatNum(input.metric, state.metricUnit)} (${delta > 0 ? "+" : ""}${((delta / state.bestMetric) * 100).toFixed(1)}%)`;
        }
      }

      if (Object.keys(secondaryMetrics).length > 0) {
        const baselines = findBaselineSecondary(state.results, state.currentSegment, state.secondaryMetrics);
        const parts = Object.entries(secondaryMetrics).map(([name, value]) => {
          const unit = state.secondaryMetrics.find((m) => m.name === name)?.unit ?? "";
          let part = `${name}: ${formatNum(value, unit)}`;
          const bv = baselines[name];
          if (bv !== undefined && state.results.length > 1 && bv !== 0) {
            const d = value - bv;
            part += ` (${d > 0 ? "+" : ""}${((d / bv) * 100).toFixed(1)}%)`;
          }
          return part;
        });
        text += `\nSecondary: ${parts.join("  ")}`;
      }

      if (asi) {
        const asiParts = Object.entries(asi).map(([k, v]) => {
          const s = typeof v === "string" ? v : JSON.stringify(v);
          return `${k}: ${s.length > 80 ? s.slice(0, 77) + "…" : s}`;
        });
        text += `\n📋 ASI: ${asiParts.join(" | ")}`;
      }
      const revisits = asi?.revisits_run;
      if (typeof revisits === "number" && Number.isInteger(revisits) && revisits > 0) {
        text += `\n↻ Revisiting #${revisits}`;
      }

      if (state.confidence !== null) {
        const conf = state.confidence.toFixed(1);
        if (state.confidence >= 2.0) text += `\n📊 Confidence: ${conf}× noise floor — improvement is likely real`;
        else if (state.confidence >= 1.0) text += `\n📊 Confidence: ${conf}× noise floor — improvement is above noise but marginal`;
        else text += `\n⚠️ Confidence: ${conf}× noise floor — improvement is within noise. Consider re-running to confirm before keeping.`;
      }
      text += `\n(${segmentCount} experiments${state.maxExperiments !== null ? ` / ${state.maxExperiments} max` : ""})`;

      // Auto-commit on keep — discards/crashes get reverted below.
      if (input.status === "keep") {
        try {
          const trailer = JSON.stringify({ status: input.status, [state.metricName || "metric"]: input.metric, ...secondaryMetrics });
          const gitOpts = { cwd: workDir, timeout: 10000 };
          const add = await exec("git", ["add", "-A"], gitOpts);
          if (add.code !== 0) throw new Error(`git add failed (exit ${add.code}): ${(add.stdout + add.stderr).trim().slice(0, 200)}`);
          const diff = await exec("git", ["diff", "--cached", "--quiet"], gitOpts);
          if (diff.code === 0) {
            text += `\n📝 Git: nothing to commit (working tree clean)`;
          } else {
            const commit = await exec("git", ["commit", "-m", `${input.description}\n\nResult: ${trailer}`], gitOpts);
            const out = (commit.stdout + commit.stderr).trim();
            if (commit.code === 0) {
              text += `\n📝 Git: committed — ${out.split("\n")[0] ?? ""}`;
              const sha = (await exec("git", ["rev-parse", "--short=7", "HEAD"], { cwd: workDir, timeout: 5000 })).stdout.trim();
              if (sha.length >= 7) experiment.commit = sha;
            } else {
              text += `\n⚠️ Git commit failed (exit ${commit.code}): ${out.slice(0, 200)}`;
            }
          }
        } catch (e) {
          text += `\n⚠️ Git commit error: ${e instanceof Error ? e.message : String(e)}`;
        }
      }

      const jsonlEntry: Record<string, unknown> = { run: state.results.length, ...experiment };
      if (!asi) delete jsonlEntry.asi;
      try {
        const jsonlPath = sessionFilePath(workDir, "log");
        ensureParentDir(jsonlPath);
        fs.appendFileSync(jsonlPath, JSON.stringify(jsonlEntry) + "\n");
        dashboard.broadcast(workDir);
      } catch (e) {
        text += `\n⚠️ Failed to write ${AUTO_DIR}/log.jsonl: ${e instanceof Error ? e.message : String(e)}`;
      }

      if (input.status !== "keep") {
        const revert = `
          git checkout -- . ':(exclude,glob)**/${AUTO_DIR}' ':(exclude,glob)**/${AUTO_DIR}/**' ':(exclude,glob)**/autoresearch.*' ':(exclude,glob)**/autoresearch.*/**'
          git clean -fd -e '${AUTO_DIR}' -e '**/${AUTO_DIR}/**' -e 'autoresearch.*' -e '**/autoresearch.*/**' 2>/dev/null
        `;
        try {
          await exec("bash", ["-c", revert], { cwd: workDir, timeout: 10000 });
          text += `\n📝 Git: reverted changes (${input.status}) — autoresearch files preserved`;
        } catch (e) {
          text += `\n⚠️ Git revert failed: ${e instanceof Error ? e.message : String(e)}`;
        }
      }

      const afterSteer = await fireHook({ event: "after", cwd: workDir, run_entry: jsonlEntry, session: sessionSnapshot(state) });
      if (afterSteer) steer(sessionID, afterSteer);

      const wallClockSeconds = rt.lastRunDuration;
      rt.lastRunChecks = null;
      rt.lastRunDuration = null;

      if (state.maxExperiments !== null && segmentCount >= state.maxExperiments) {
        text += `\n\n🛑 Maximum experiments reached (${state.maxExperiments}). STOP the experiment loop now.`;
        // Turning the mode off hides the tools from the next request and stops auto-resume.
        await setActive(sessionID, rt, false);
      } else if (rt.active) {
        text += `\n\n${REVISIT_PROMPT}`;
        const beforeSteer = await fireHook({
          event: "before",
          cwd: workDir,
          next_run: state.results.length + 1,
          last_run: jsonlEntry,
          session: sessionSnapshot(state),
        });
        if (beforeSteer) steer(sessionID, beforeSteer);
      }

      return { text, metadata: { run: state.results.length, status: experiment.status, commit: experiment.commit, wallClockSeconds } };
    };

    const toolError = (e: unknown) => ({ content: `❌ ${e instanceof Error ? e.message : String(e)}` });

    // Direct tools, not Code Mode: Code Mode lists every catalog tool in the system
    // prompt regardless of session, so the context hook could not hide them.
    const TOOL_OPTIONS = { codemode: false } as const;
    const INACTIVE_MESSAGE =
      "❌ Autoresearch mode is not active in this session. Do not start an experiment loop on your own — ask the user to run `/autoresearch <goal>`.";

    /** Backstop for tool gating: refuse to run while the session is not in autoresearch mode. */
    const whenActive = async <T>(sessionID: string, run: () => Promise<T>): Promise<T | { content: string }> => {
      const rt = await runtimeFor(sessionID);
      return rt.active ? run() : { content: INACTIVE_MESSAGE };
    };

    await ctx.tool.transform((editor) => {
      editor.add({
        name: "init_experiment",
        description:
          "Initialize the experiment session. Call once before the first run_experiment to set the name, primary metric, unit, and direction. Writes the config header to .auto/log.jsonl. Call again only when the optimization target changes (starts a new segment and baseline).",
        input: InitParams,
        options: TOOL_OPTIONS,
        async execute(input, context) {
          try {
            return await whenActive(context.sessionID, async () => ({
              content: await initExperiment(input as InitInput, context.sessionID),
            }));
          } catch (e) {
            return toolError(e);
          }
        },
      });

      editor.add({
        name: "run_experiment",
        description: `Run a shell command as an experiment. Times wall-clock duration, captures output, detects pass/fail via exit code, parses \`METRIC name=value\` lines, and runs .auto/checks.sh after a passing benchmark. Output is truncated to the last ${EXPERIMENT_MAX_LINES} lines or ${EXPERIMENT_MAX_BYTES / 1024}KB; full output is saved to a temp file. Always follow with log_experiment.`,
        input: RunParams,
        options: TOOL_OPTIONS,
        async execute(input, context) {
          try {
            return await whenActive(context.sessionID, async () => {
              const { text, metadata } = await runExperiment(input as RunInput, context.sessionID, context.signal, context.progress);
              return { content: text, metadata };
            });
          } catch (e) {
            return toolError(e);
          }
        },
      });

      editor.add({
        name: "log_experiment",
        description:
          "Record an experiment result. 'keep' auto-commits (git add -A && git commit); 'discard'/'crash'/'checks_failed' auto-revert code changes (.auto/ preserved). Tracks secondary metrics and reports a confidence score. Call after every run_experiment.",
        input: LogParams,
        options: TOOL_OPTIONS,
        async execute(input, context) {
          try {
            return await whenActive(context.sessionID, async () => {
              const { text, metadata } = await logExperiment(input as LogInput, context.sessionID);
              return { content: text, metadata };
            });
          } catch (e) {
            return toolError(e);
          }
        },
      });
    });

    // -- skills ------------------------------------------------------------

    await ctx.skill.transform((editor) => {
      for (const skill of skills) {
        if (editor.get(skill.id)) continue;
        editor.add(skill as unknown as Parameters<typeof editor.add>[0]);
      }
    });

    // -- /autoresearch -----------------------------------------------------

    const turnOff = async (sessionID: string, rt: Runtime): Promise<void> => {
      const wasRunning = rt.busy;
      await setActive(sessionID, rt, false);
      rt.autoResumeTurns = 0;
      rt.experimentsThisTurn = 0;
      rt.lastRunChecks = null;
      rt.lastRunDuration = null;
      dashboard.stop();
      if (wasRunning) await ctx.session.interrupt({ sessionID }).catch(() => {});
      await notify(sessionID, wasRunning ? "Autoresearch mode OFF — aborting current run" : "Autoresearch mode OFF");
    };

    await ctx.command.transform((editor) => {
      editor.add({
        name: "autoresearch",
        description: "Start, stop, clear, or show dashboards for the autoresearch experiment loop",
        async execute({ sessionID, prompt }) {
          const rt = await runtimeFor(sessionID);
          const args = prompt.text.replace(/^\s*\/autoresearch\b/, "").trim();
          const command = args.toLowerCase();
          const workDir = resolveWorkDir(cwd);

          if (!args) return notify(sessionID, HELP_TEXT);
          if (command === "off") return turnOff(sessionID, rt);
          if (command === "dashboard") return notify(sessionID, renderDashboardMarkdown(rt.state));

          if (command === "export") {
            if (!fs.existsSync(sessionFilePath(workDir, "log"))) {
              return notify(sessionID, `No ${AUTO_DIR}/log.jsonl found — run some experiments first`);
            }
            try {
              const url = await dashboard.open(workDir);
              return notify(sessionID, `Dashboard at ${url} (live updates)`);
            } catch (e) {
              return notify(sessionID, `Export failed: ${e instanceof Error ? e.message : String(e)}`);
            }
          }

          if (command === "clear") {
            await setActive(sessionID, rt, false);
            rt.autoResumeTurns = 0;
            rt.experimentsThisTurn = 0;
            rt.lastRunChecks = null;
            rt.lastRunDuration = null;
            rt.state = createExperimentState();
            dashboard.stop();
            const deleted: string[] = [];
            for (const file of Object.values(sessionFileCandidates(workDir, "log"))) {
              if (!fs.existsSync(file)) continue;
              const rel = path.relative(workDir, file) || path.basename(file);
              try {
                fs.unlinkSync(file);
                deleted.push(rel);
              } catch (e) {
                return notify(sessionID, `Failed to delete ${rel}: ${e instanceof Error ? e.message : String(e)}`);
              }
            }
            return notify(
              sessionID,
              deleted.length > 0 ? `Deleted ${deleted.join(", ")} and turned autoresearch mode OFF` : "No session log found. Autoresearch mode OFF",
            );
          }

          if (rt.active) {
            return notify(sessionID, "Autoresearch already active — use '/autoresearch off' to stop first");
          }

          await setActive(sessionID, rt, true);
          rt.autoResumeTurns = 0;
          const rulesLoaded = fs.existsSync(sessionFilePath(workDir, "prompt"));
          await notify(
            sessionID,
            rulesLoaded
              ? `Autoresearch mode ON — rules loaded from ${AUTO_DIR}/prompt.md`
              : `Autoresearch mode ON — no ${AUTO_DIR}/prompt.md found, loading the ${CREATE_SKILL_ID} skill`,
          );

          const activationSteer = await fireHook({
            event: "before",
            cwd: workDir,
            next_run: rt.state.results.length + 1,
            last_run: readLastRun(workDir),
            session: sessionSnapshot(rt.state),
          });

          if (rulesLoaded) {
            const kickoff = `Autoresearch mode active. ${args} ${BENCHMARK_GUARDRAIL}`;
            await ctx.session.prompt({ sessionID, text: activationSteer ? `${activationSteer}\n\n${kickoff}` : kickoff });
            return;
          }
          const goal = `Set up autoresearch for this goal: ${args}\n\n${BENCHMARK_GUARDRAIL}`;
          await ctx.session.prompt({
            sessionID,
            text: activationSteer ? `${activationSteer}\n\n${goal}` : goal,
            skills: skills.some((s) => s.id === CREATE_SKILL_ID) ? [{ id: CREATE_SKILL_ID }] : undefined,
          });
        },
      });
    });

    return () => {
      events.abort();
      dashboard.stop();
      for (const rt of runtimes.values()) cancelPendingResume(rt);
      runtimes.clear();
    };
  },
};

export default plugin;
