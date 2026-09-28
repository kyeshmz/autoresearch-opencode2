/**
 * Pure experiment logic — no OpenCode imports, so it can be unit-tested with
 * plain `node --test`. Ported from pi-autoresearch's extension.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { sessionFilePath } from "./paths.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Actionable Side Information (ASI) — free-form diagnostics per experiment run.
 * The agent decides what to record. Any key/value pair is valid.
 */
export interface ASI {
  [key: string]: unknown;
}

export type ExperimentStatus = "keep" | "discard" | "crash" | "checks_failed";

export interface ExperimentResult {
  commit: string;
  metric: number;
  /** Additional tracked metrics: { name: value } */
  metrics: Record<string, number>;
  status: ExperimentStatus;
  description: string;
  timestamp: number;
  /** Segment index — increments on each config header. Current segment = highest. */
  segment: number;
  /** Session-level confidence score at the time this result was logged. null if insufficient data. */
  confidence: number | null;
  asi?: ASI;
}

export interface MetricDef {
  name: string;
  unit: string;
}

export interface ExperimentState {
  results: ExperimentResult[];
  /** Baseline primary metric (from first experiment in current segment) */
  bestMetric: number | null;
  bestDirection: "lower" | "higher";
  metricName: string;
  metricUnit: string;
  secondaryMetrics: MetricDef[];
  name: string | null;
  currentSegment: number;
  /** Maximum number of experiments before auto-stopping. null = unlimited. */
  maxExperiments: number | null;
  /** Current session confidence score (best improvement / noise floor). null if insufficient data. */
  confidence: number | null;
}

export function createExperimentState(): ExperimentState {
  return {
    results: [],
    bestMetric: null,
    bestDirection: "lower",
    metricName: "metric",
    metricUnit: "",
    secondaryMetrics: [],
    name: null,
    currentSegment: 0,
    maxExperiments: null,
    confidence: null,
  };
}

// ---------------------------------------------------------------------------
// Auto-resume guards
// ---------------------------------------------------------------------------

export const AUTORESUME_TURN_LIMIT = 200;
export const CONSECUTIVE_FAILURE_OVERRIDE_LIMIT = 20;

type AutoResumeGuardState = Pick<ExperimentState, "results" | "currentSegment">;
type AutoResumeGuardRuntime = {
  autoResumeTurns: number;
  state: AutoResumeGuardState;
};

/** Count trailing discard/crash results in the current segment. */
export function countConsecutiveDiscardOrCrashResults(state: AutoResumeGuardState): number {
  let count = 0;
  for (let i = state.results.length - 1; i >= 0; i--) {
    const result = state.results[i];
    if (result.segment !== state.currentSegment) break;
    if (result.status === "discard" || result.status === "crash") {
      count++;
      continue;
    }
    break;
  }
  return count;
}

export function autoResumeStopReasonFor(runtime: AutoResumeGuardRuntime): string | null {
  if (runtime.autoResumeTurns >= AUTORESUME_TURN_LIMIT) {
    return `Autoresearch auto-resume limit reached (${AUTORESUME_TURN_LIMIT} turns)`;
  }
  const failures = countConsecutiveDiscardOrCrashResults(runtime.state);
  if (failures > CONSECUTIVE_FAILURE_OVERRIDE_LIMIT) {
    return `Autoresearch auto-resume stopped — ${failures} consecutive discards/crashes`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------

export function canonicalPath(existingPath: string): string {
  try {
    return fs.realpathSync.native(existingPath);
  } catch {
    return path.resolve(existingPath);
  }
}

export function samePath(a: string, b: string): boolean {
  return canonicalPath(a) === canonicalPath(b);
}

export function shouldAutoActivateAutoresearch(
  cwd: string,
  workDir: string,
  hasPersistedLog: boolean,
  recordedDecision: boolean | null = null,
): boolean {
  if (!hasPersistedLog) return false;
  // An explicit `/autoresearch <goal>|off` in this session always wins, so a
  // manual off survives compaction and restarts instead of snapping back on.
  if (recordedDecision !== null) return recordedDecision;
  // With no recorded decision, same-cwd sessions default on (a log implies intent);
  // redirected workingDir sessions default off until this session opts in.
  return samePath(cwd, workDir);
}

// ---------------------------------------------------------------------------
// METRIC line parsing
// ---------------------------------------------------------------------------

/** Metric names that could cause prototype pollution if used as object keys */
const DENIED_METRIC_NAMES = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Parse structured `METRIC name=value` lines from command output.
 * Names must be word chars, dots, or µ. Values must be finite numbers.
 * Duplicate names: last occurrence wins.
 */
export function parseMetricLines(output: string): Map<string, number> {
  const metrics = new Map<string, number>();
  const regex = /^METRIC\s+([\w.µ]+)=(\S+)\s*$/gm;
  let match;
  while ((match = regex.exec(output)) !== null) {
    const name = match[1];
    if (DENIED_METRIC_NAMES.has(name)) continue;
    const value = Number(match[2]);
    if (Number.isFinite(value)) metrics.set(name, value);
  }
  return metrics;
}

/** Infer a display unit from a secondary metric's name suffix. */
export function inferMetricUnit(name: string): string {
  if (name.endsWith("µs")) return "µs";
  if (name.endsWith("_ms")) return "ms";
  if (name.endsWith("_s") || name.endsWith("_sec")) return "s";
  if (name.endsWith("_kb")) return "kb";
  if (name.endsWith("_mb")) return "mb";
  return "";
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/** Format a number with comma-separated thousands: 15586 → "15,586" */
function commas(n: number): string {
  const s = String(Math.round(n));
  const parts: string[] = [];
  for (let i = s.length; i > 0; i -= 3) {
    parts.unshift(s.slice(Math.max(0, i - 3), i));
  }
  return parts.join(",");
}

function fmtNum(n: number, decimals: number = 0): string {
  if (decimals > 0) {
    const int = Math.floor(Math.abs(n));
    const frac = (Math.abs(n) - int).toFixed(decimals).slice(1);
    return (n < 0 ? "-" : "") + commas(int) + frac;
  }
  return commas(n);
}

export function formatNum(value: number | null, unit: string): string {
  if (value === null) return "—";
  const u = unit || "";
  if (value === Math.round(value)) return fmtNum(value) + u;
  return fmtNum(value, 2) + u;
}

export function formatElapsed(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (m > 0) return `${m}m ${String(s).padStart(2, "0")}s`;
  return `${s}s`;
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

export interface TailTruncation {
  content: string;
  truncated: boolean;
  truncatedBy: "lines" | "bytes" | null;
  totalLines: number;
  outputLines: number;
}

/** Keep the last `maxLines` lines of `text`, capped at `maxBytes` (whole lines only). */
export function truncateTail(text: string, opts: { maxLines: number; maxBytes: number }): TailTruncation {
  const lines = text.replace(/\n$/, "").split("\n");
  const totalLines = lines.length;
  const kept: string[] = [];
  let bytes = 0;
  let truncatedBy: TailTruncation["truncatedBy"] = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (kept.length >= opts.maxLines) {
      truncatedBy = "lines";
      break;
    }
    const lineBytes = Buffer.byteLength(lines[i], "utf-8") + 1;
    if (bytes + lineBytes > opts.maxBytes && kept.length > 0) {
      truncatedBy = "bytes";
      break;
    }
    kept.unshift(lines[i]);
    bytes += lineBytes;
  }
  return {
    content: kept.join("\n"),
    truncated: truncatedBy !== null,
    truncatedBy,
    totalLines,
    outputLines: kept.length,
  };
}

// ---------------------------------------------------------------------------
// Benchmark command guard
// ---------------------------------------------------------------------------

/**
 * Check if a command's primary purpose is running the benchmark script.
 * Strips harmless prefixes (env vars, env/time/nice/nohup) and requires the
 * benchmark script to be the first real command, so chaining tricks like
 * "evil.py; measure.sh" are rejected.
 */
export function isAutoresearchShCommand(command: string): boolean {
  let cmd = command.trim();
  cmd = cmd.replace(/^(?:\w+=\S*\s+)+/, "");
  let prev: string;
  do {
    prev = cmd;
    cmd = cmd.replace(/^(?:env|time|nice|nohup)(?:\s+-\S+(?:\s+\d+)?)*\s+/, "");
  } while (cmd !== prev);
  return /^(?:(?:bash|sh|source)\s+(?:-\w+\s+)*)?(?:\/|\.{1,2}\/|[\w.-]+\/)*(?:autoresearch\.sh|\.auto\/measure\.sh)(?:\s|$)/.test(cmd);
}

// ---------------------------------------------------------------------------
// Metrics math
// ---------------------------------------------------------------------------

export function isBetter(current: number, best: number, direction: "lower" | "higher"): boolean {
  return direction === "lower" ? current < best : current > best;
}

function sortedMedian(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

export function currentResults(results: ExperimentResult[], segment: number): ExperimentResult[] {
  return results.filter((r) => r.segment === segment);
}

/** Baseline = first experiment in current segment */
export function findBaselineMetric(results: ExperimentResult[], segment: number): number | null {
  const cur = currentResults(results, segment);
  return cur.length > 0 ? cur[0].metric : null;
}

export function findBaselineRunNumber(results: ExperimentResult[], segment: number): number | null {
  const index = results.findIndex((result) => result.segment === segment);
  return index >= 0 ? index + 1 : null;
}

/** Best = optimal metric across kept experiments in current segment */
export function findBestMetric(
  results: ExperimentResult[],
  segment: number,
  direction: "lower" | "higher",
): number | null {
  const kept = currentResults(results, segment)
    .filter((r) => r.status === "keep")
    .map((r) => r.metric);
  if (kept.length === 0) return null;
  return direction === "lower" ? Math.min(...kept) : Math.max(...kept);
}

/**
 * Secondary metric baselines from the first experiment in the current segment,
 * falling back to each metric's first occurrence when it was added later.
 */
export function findBaselineSecondary(
  results: ExperimentResult[],
  segment: number,
  knownMetrics?: MetricDef[],
): Record<string, number> {
  const cur = currentResults(results, segment);
  const base: Record<string, number> = cur.length > 0 ? { ...(cur[0].metrics ?? {}) } : {};
  for (const sm of knownMetrics ?? []) {
    if (base[sm.name] !== undefined) continue;
    for (const r of cur) {
      const val = (r.metrics ?? {})[sm.name];
      if (val !== undefined) {
        base[sm.name] = val;
        break;
      }
    }
  }
  return base;
}

/**
 * Confidence = |best kept − baseline| / MAD of all metric values in the
 * current segment. null with fewer than 3 data points or zero noise.
 */
export function computeConfidence(
  results: ExperimentResult[],
  segment: number,
  direction: "lower" | "higher",
): number | null {
  const cur = currentResults(results, segment).filter((r) => r.metric > 0);
  if (cur.length < 3) return null;

  const values = cur.map((r) => r.metric);
  const median = sortedMedian(values);
  const mad = sortedMedian(values.map((v) => Math.abs(v - median)));
  if (mad === 0) return null;

  const baseline = findBaselineMetric(results, segment);
  if (baseline === null) return null;

  let bestKept: number | null = null;
  for (const r of cur) {
    if (r.status === "keep" && r.metric > 0 && (bestKept === null || isBetter(r.metric, bestKept, direction))) {
      bestKept = r.metric;
    }
  }
  if (bestKept === null || bestKept === baseline) return null;

  return Math.abs(bestKept - baseline) / mad;
}

// ---------------------------------------------------------------------------
// Config (.auto/config.json)
// ---------------------------------------------------------------------------

export interface AutoresearchConfig {
  maxIterations?: number;
  workingDir?: string;
}

export function readConfig(cwd: string): AutoresearchConfig {
  try {
    const configPath = sessionFilePath(cwd, "config");
    if (!fs.existsSync(configPath)) return {};
    return JSON.parse(fs.readFileSync(configPath, "utf-8"));
  } catch {
    return {};
  }
}

export function readMaxExperiments(cwd: string): number | null {
  const config = readConfig(cwd);
  return typeof config.maxIterations === "number" && config.maxIterations > 0
    ? Math.floor(config.maxIterations)
    : null;
}

/** Effective working directory: `workingDir` from `.auto/config.json` in cwd, else cwd. */
export function resolveWorkDir(cwd: string): string {
  const config = readConfig(cwd);
  if (!config.workingDir) return cwd;
  return path.isAbsolute(config.workingDir) ? config.workingDir : path.resolve(cwd, config.workingDir);
}

/** Error message when the configured workingDir doesn't exist, else null. */
export function validateWorkDir(cwd: string): string | null {
  const workDir = resolveWorkDir(cwd);
  if (workDir === cwd) return null;
  try {
    if (!fs.statSync(workDir).isDirectory()) {
      return `workingDir "${workDir}" (from .auto/config.json) is not a directory.`;
    }
  } catch {
    return `workingDir "${workDir}" (from .auto/config.json) does not exist.`;
  }
  return null;
}
