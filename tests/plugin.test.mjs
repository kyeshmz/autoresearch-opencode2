import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import plugin from "../src/index.ts";

const TOOLS = ["init_experiment", "run_experiment", "log_experiment"];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Minimal stand-in for the OpenCode 2 plugin context. */
async function createHarness(directory) {
  const hooks = new Map();
  const tools = new Map();
  const skills = new Map();
  const commands = new Map();
  const storage = new Map();
  const prompts = [];
  const synthetics = [];
  const interrupts = [];
  const queue = [];
  let wake = null;

  const events = {
    push(event) {
      queue.push(event);
      wake?.();
    },
  };

  const ctx = {
    location: { directory },
    options: {},
    storage: {
      get: async (k) => storage.get(k),
      set: async (k, v) => void storage.set(k, v),
      remove: async (k) => void storage.delete(k),
    },
    session: {
      hook: async (name, cb) => {
        hooks.set(name, cb);
        return { dispose: async () => {} };
      },
      prompt: async (input) => void prompts.push(input),
      synthetic: async (input) => void synthetics.push(input),
      interrupt: async (input) => void interrupts.push(input),
    },
    event: {
      subscribe({ signal }) {
        return {
          async *[Symbol.asyncIterator]() {
            while (!signal.aborted) {
              if (queue.length === 0) await new Promise((r) => { wake = r; signal.addEventListener("abort", r, { once: true }); });
              while (queue.length > 0) yield queue.shift();
            }
          },
        };
      },
    },
    tool: {
      transform: async (cb) => {
        cb({ add: (t) => tools.set(t.name, t) });
        return { dispose: async () => {} };
      },
    },
    skill: {
      transform: async (cb) => {
        cb({ get: (id) => skills.get(id), add: (s) => skills.set(s.id, s) });
        return { dispose: async () => {} };
      },
    },
    command: {
      transform: async (cb) => {
        cb({ add: (c) => commands.set(c.name, c) });
        return { dispose: async () => {} };
      },
    },
  };

  const cleanup = await plugin.setup(ctx);
  const toolCtx = (sessionID) => ({ sessionID, signal: new AbortController().signal, progress: async () => {} });

  return {
    hooks, tools, skills, commands, storage, prompts, synthetics, interrupts, events, cleanup,
    async context(sessionID) {
      const event = { sessionID, system: [], tools: Object.fromEntries(TOOLS.concat("bash").map((n) => [n, {}])) };
      await hooks.get("context")(event);
      return event;
    },
    call: (name, input, sessionID = "s1") => tools.get(name).execute(input, toolCtx(sessionID)),
    command: (text, sessionID = "s1") =>
      commands.get("autoresearch").execute({ sessionID, prompt: { text }, delivery: "queue" }),
  };
}

function gitRepo() {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "oc-autoresearch-"));
  const git = (...args) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  fs.writeFileSync(path.join(dir, "work.txt"), "v1\n");
  git("add", "-A");
  git("commit", "-qm", "init");
  return { dir, git };
}

test("registers tools, bundled skills, and the /autoresearch command", async () => {
  const h = await createHarness(gitRepo().dir);
  assert.deepEqual([...h.tools.keys()].sort(), [...TOOLS].sort());
  assert.deepEqual([...h.skills.keys()].sort(), ["autoresearch-create", "autoresearch-finalize", "autoresearch-hooks"]);
  assert.ok(h.commands.has("autoresearch"));
  assert.ok(!h.skills.get("autoresearch-finalize").content.includes("<SKILL_DIR>"), "SKILL_DIR placeholder expanded");
  await h.cleanup();
});

test("tools are hidden, registered outside Code Mode, and refuse to run while inactive", async () => {
  const { dir } = gitRepo();
  const h = await createHarness(dir);
  const event = await h.context("s1");
  assert.deepEqual(Object.keys(event.tools), ["bash"]);
  assert.equal(event.system.length, 0);
  // Code Mode catalogs every tool in the system prompt, so gating needs direct tools.
  for (const name of TOOLS) assert.equal(h.tools.get(name).options?.codemode, false, name);
  const res = await h.call("init_experiment", { name: "x", metric_name: "m" });
  assert.match(res.content, /not active/);
  assert.equal(fs.existsSync(path.join(dir, ".auto/log.jsonl")), false);
  await h.cleanup();
});

test("full loop: init → run → keep commits, discard reverts, turn end auto-resumes", async () => {
  const { dir, git } = gitRepo();
  fs.mkdirSync(path.join(dir, ".auto"));
  fs.writeFileSync(path.join(dir, ".auto/prompt.md"), "# Autoresearch: test\n");
  fs.writeFileSync(path.join(dir, ".auto/measure.sh"), "#!/bin/bash\necho 'METRIC total_ms=42'\necho 'METRIC mem_kb=7'\n", { mode: 0o755 });
  const h = await createHarness(dir);

  await h.command("/autoresearch make it fast");
  assert.equal(h.prompts.at(-1).text.includes("Autoresearch mode active. make it fast"), true);
  const active = await h.context("s1");
  assert.ok(TOOLS.every((t) => t in active.tools));
  assert.match(active.system[0].text, /Autoresearch Mode \(ACTIVE\)/);

  const init = await h.call("init_experiment", { name: "speed", metric_name: "total_ms", metric_unit: "ms" });
  assert.match(init.content, /Experiment initialized/);

  const blocked = await h.call("run_experiment", { command: "echo hi" });
  assert.match(blocked.content, /you must run it/);

  const run = await h.call("run_experiment", { command: "./.auto/measure.sh" });
  assert.match(run.content, /PASSED/);
  assert.equal(run.metadata.parsedPrimary, 42);

  h.events.push({ type: "session.execution.started", data: { sessionID: "s1" } });
  await sleep(20);

  fs.writeFileSync(path.join(dir, "work.txt"), "v2\n");
  const keep = await h.call("log_experiment", {
    commit: "0000000", metric: 42, status: "keep", description: "baseline", metrics: { mem_kb: 7 }, asi: { hypothesis: "b" },
  });
  assert.match(keep.content, /Git: committed/);
  assert.equal(git("log", "-1", "--format=%s").toString().trim(), "baseline");

  fs.writeFileSync(path.join(dir, "work.txt"), "v3\n");
  const missing = await h.call("log_experiment", { commit: "x", metric: 50, status: "discard", description: "worse" });
  assert.match(missing.content, /Missing secondary metrics: mem_kb/);
  const discard = await h.call("log_experiment", {
    commit: "x", metric: 50, status: "discard", description: "worse", metrics: { mem_kb: 8 }, asi: { revisits_run: 1 },
  });
  assert.match(discard.content, /reverted changes/);
  assert.match(discard.content, /Revisiting #1/);
  assert.equal(fs.readFileSync(path.join(dir, "work.txt"), "utf-8"), "v2\n");

  const log = fs.readFileSync(path.join(dir, ".auto/log.jsonl"), "utf-8").trim().split("\n").map(JSON.parse);
  assert.equal(log[0].type, "config");
  assert.deepEqual(log.slice(1).map((e) => e.status), ["keep", "discard"]);

  const promptsBefore = h.prompts.length;
  // OpenCode 2 ends a turn with execution.succeeded (no session.idle). A duplicate
  // end event must not schedule a second resume.
  h.events.push({ type: "session.execution.succeeded", data: { sessionID: "s1" } });
  h.events.push({ type: "session.idle", data: { sessionID: "s1" } });
  await sleep(1000);
  assert.equal(h.prompts.length, promptsBefore + 1);
  assert.match(h.prompts.at(-1).text, /Run the next iteration now/);

  const compaction = { sessionID: "s1", system: [], tools: {} };
  await h.hooks.get("compaction")(compaction);
  assert.match(compaction.result.summary, /speed/);

  await h.command("dashboard");
  assert.match(h.synthetics.at(-1).text, /\| 2 \| — \| 50ms/);

  await h.command("off");
  assert.equal((await h.context("s1")).system.length, 0);
  await h.cleanup();
});

test("a chat-only turn does not auto-resume", async () => {
  const { dir } = gitRepo();
  fs.mkdirSync(path.join(dir, ".auto"));
  fs.writeFileSync(path.join(dir, ".auto/log.jsonl"), JSON.stringify({ type: "config", name: "x", metricName: "m" }) + "\n");
  const h = await createHarness(dir);
  // Existing log in the same cwd auto-activates.
  assert.ok("run_experiment" in (await h.context("s1")).tools);
  h.events.push({ type: "session.execution.started", data: { sessionID: "s1" } });
  h.events.push({ type: "session.execution.succeeded", data: { sessionID: "s1" } });
  h.events.push({ type: "session.execution.started", data: { sessionID: "s1" } });
  h.events.push({ type: "session.execution.failed", data: { sessionID: "s1" } });
  await sleep(1000);
  assert.equal(h.prompts.length, 0);
  await h.cleanup();
});

test("a manual off persists for the session across plugin reloads", async () => {
  const { dir } = gitRepo();
  fs.mkdirSync(path.join(dir, ".auto"));
  fs.writeFileSync(path.join(dir, ".auto/log.jsonl"), JSON.stringify({ type: "config", name: "x", metricName: "m" }) + "\n");
  const h = await createHarness(dir);
  await h.context("s1");
  await h.command("off");
  const stored = new Map(h.storage);
  await h.cleanup();

  const h2 = await createHarness(dir);
  for (const [k, v] of stored) h2.storage.set(k, v);
  assert.equal("run_experiment" in (await h2.context("s1")).tools, false);
  assert.equal("run_experiment" in (await h2.context("other")).tools, true);
  await h2.cleanup();
});

test("a user interrupt cancels auto-resume; a failed turn that logged a run resumes once", async () => {
  const { dir } = gitRepo();
  fs.mkdirSync(path.join(dir, ".auto"));
  fs.writeFileSync(path.join(dir, ".auto/log.jsonl"), JSON.stringify({ type: "config", name: "x", metricName: "m" }) + "\n");
  const h = await createHarness(dir);
  await h.context("s1");
  const log = () => h.call("log_experiment", { commit: "x", metric: 1, status: "crash", description: "c" });

  h.events.push({ type: "session.execution.started", data: { sessionID: "s1" } });
  await sleep(20);
  await log();
  h.events.push({ type: "session.execution.interrupted", data: { sessionID: "s1", reason: "user" } });
  h.events.push({ type: "session.execution.succeeded", data: { sessionID: "s1" } });
  await sleep(1000);
  assert.equal(h.prompts.length, 0, "no resume after a user interrupt");

  h.events.push({ type: "session.execution.started", data: { sessionID: "s1" } });
  await sleep(20);
  await log();
  h.events.push({ type: "session.execution.failed", data: { sessionID: "s1" } });
  await sleep(1000);
  assert.equal(h.prompts.length, 1);
  assert.match(h.prompts[0].text, /Run the next iteration now/);
  await h.cleanup();
});

test("compaction while idle schedules the compaction resume message", async () => {
  const { dir } = gitRepo();
  fs.mkdirSync(path.join(dir, ".auto"));
  fs.writeFileSync(path.join(dir, ".auto/log.jsonl"), JSON.stringify({ type: "config", name: "x", metricName: "m" }) + "\n");
  const h = await createHarness(dir);
  await h.context("s1");
  h.events.push({ type: "session.compaction.ended", data: { sessionID: "s1", reason: "manual" } });
  await sleep(1000);
  assert.equal(h.prompts.length, 1);
  assert.match(h.prompts[0].text, /compaction summary already contains them/);
  await h.cleanup();
});
