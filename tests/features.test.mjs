import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import plugin from "../src/index.ts";
import { createDashboardServer } from "../src/dashboard.ts";

/** Minimal OpenCode 2 plugin context: records prompts and synthetic notes. */
async function harness(directory) {
  const tools = new Map();
  const commands = new Map();
  const hooks = new Map();
  const prompts = [];
  const synthetics = [];
  const storage = new Map();
  const ctx = {
    location: { directory },
    options: {},
    storage: { get: async (k) => storage.get(k), set: async (k, v) => void storage.set(k, v), remove: async () => {} },
    session: {
      hook: async (name, cb) => (hooks.set(name, cb), { dispose: async () => {} }),
      prompt: async (input) => void prompts.push(input),
      synthetic: async (input) => void synthetics.push(input),
      interrupt: async () => {},
    },
    event: {
      subscribe: ({ signal }) => ({
        async *[Symbol.asyncIterator]() {
          await new Promise((r) => signal.addEventListener("abort", r, { once: true }));
        },
      }),
    },
    tool: { transform: async (cb) => (cb({ add: (t) => tools.set(t.name, t) }), { dispose: async () => {} }) },
    skill: { transform: async (cb) => (cb({ get: () => undefined, add: () => {} }), { dispose: async () => {} }) },
    command: { transform: async (cb) => (cb({ add: (c) => commands.set(c.name, c) }), { dispose: async () => {} }) },
  };
  const cleanup = await plugin.setup(ctx);
  const signal = new AbortController().signal;
  return {
    prompts,
    synthetics,
    cleanup,
    context: async () => {
      const event = { sessionID: "s1", system: [], tools: {} };
      await hooks.get("context")(event);
      return event;
    },
    call: (name, input) => tools.get(name).execute(input, { sessionID: "s1", signal, progress: async () => {} }),
    command: (text) => commands.get("autoresearch").execute({ sessionID: "s1", prompt: { text }, delivery: "queue" }),
  };
}

function project(files = {}) {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "oc-autoresearch-feat-"));
  const git = (...args) => execFileSync("git", args, { cwd: dir, stdio: "pipe" }).toString();
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  fs.writeFileSync(path.join(dir, "code.txt"), "v1\n");
  for (const [rel, [content, mode]] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content, { mode: mode ?? 0o644 });
  }
  git("add", "-A");
  git("commit", "-qm", "init");
  return { dir, git };
}

const MEASURE = ["#!/bin/bash\necho 'METRIC ms=10'\n", 0o755];

async function started(h, goal = "go") {
  await h.command(goal);
  await h.call("init_experiment", { name: "t", metric_name: "ms" });
}

test("/autoresearch <goal> without prompt.md attaches the autoresearch-create skill", async () => {
  const { dir } = project();
  const h = await harness(dir);
  await h.command("make it fast");
  const kickoff = h.prompts.at(-1);
  assert.match(kickoff.text, /Set up autoresearch for this goal: make it fast/);
  assert.deepEqual(kickoff.skills, [{ id: "autoresearch-create" }]);
  assert.match(h.synthetics.at(-1).text, /Autoresearch mode ON/);
  await h.command("again");
  assert.match(h.synthetics.at(-1).text, /already active/);
  await h.cleanup();
});

test("failing checks.sh blocks keep and checks_failed reverts", async () => {
  const { dir } = project({
    ".auto/prompt.md": ["# p\n"],
    ".auto/measure.sh": MEASURE,
    ".auto/checks.sh": ["#!/bin/bash\necho 'test_foo FAILED'; exit 1\n", 0o755],
  });
  const h = await harness(dir);
  await started(h);
  assert.match((await h.context()).system[0].text, /Backpressure Checks \(ACTIVE\)/);

  fs.writeFileSync(path.join(dir, "code.txt"), "v2\n");
  const run = await h.call("run_experiment", { command: "./.auto/measure.sh" });
  assert.match(run.content, /CHECKS FAILED/);
  assert.match(run.content, /test_foo FAILED/);
  assert.equal(run.metadata.passed, false);

  const keep = await h.call("log_experiment", { commit: "x", metric: 10, status: "keep", description: "k" });
  assert.match(keep.content, /Cannot keep — .auto\/checks.sh failed/);

  const failed = await h.call("log_experiment", { commit: "x", metric: 10, status: "checks_failed", description: "cf" });
  assert.match(failed.content, /reverted changes \(checks_failed\)/);
  assert.equal(fs.readFileSync(path.join(dir, "code.txt"), "utf-8"), "v1\n");
  await h.cleanup();
});

test("run_experiment times out and kills the process", async () => {
  const { dir } = project({ ".auto/measure.sh": ["#!/bin/bash\nsleep 5\necho 'METRIC ms=1'\n", 0o755] });
  const h = await harness(dir);
  await started(h);
  const t0 = Date.now();
  const run = await h.call("run_experiment", { command: "./.auto/measure.sh", timeout_seconds: 1 });
  assert.match(run.content, /TIMEOUT/);
  assert.ok(Date.now() - t0 < 4000, "killed well before the script finished");
  await h.cleanup();
});

test("before/after hooks steer the running turn and are logged", async () => {
  const { dir } = project({
    ".auto/measure.sh": MEASURE,
    ".auto/hooks/after.sh": ["#!/bin/bash\nrun=$(jq -r .run_entry.run 2>/dev/null || cat >/dev/null)\necho \"AFTER-STEER\"\n", 0o755],
    ".auto/hooks/before.sh": ["#!/bin/bash\ncat >/dev/null\necho \"BEFORE-STEER\"\n", 0o755],
  });
  const h = await harness(dir);
  await started(h);
  await h.call("run_experiment", { command: "./.auto/measure.sh" });
  await h.call("log_experiment", { commit: "x", metric: 10, status: "keep", description: "k" });
  await new Promise((r) => setTimeout(r, 50));
  const steers = h.prompts.filter((p) => p.delivery === "steer").map((p) => p.text);
  assert.ok(steers.includes("AFTER-STEER"), JSON.stringify(steers));
  assert.ok(steers.includes("BEFORE-STEER"), JSON.stringify(steers));
  const entries = fs.readFileSync(path.join(dir, ".auto/log.jsonl"), "utf-8").trim().split("\n").map(JSON.parse);
  assert.deepEqual(entries.filter((e) => e.type === "hook").map((e) => e.stage).sort(), ["after", "before"]);
  await h.cleanup();
});

test("secondary metrics: new metric needs force", async () => {
  const { dir } = project({ ".auto/measure.sh": MEASURE });
  const h = await harness(dir);
  await started(h);
  await h.call("log_experiment", { commit: "x", metric: 10, status: "discard", description: "a", metrics: { mem: 1 } });
  const added = await h.call("log_experiment", { commit: "x", metric: 9, status: "discard", description: "b", metrics: { mem: 1, cpu: 2 } });
  assert.match(added.content, /New secondary metric not previously tracked: cpu/);
  const forced = await h.call("log_experiment", {
    commit: "x", metric: 9, status: "discard", description: "b", metrics: { mem: 1, cpu: 2 }, force: true,
  });
  assert.match(forced.content, /Logged #2/);
  await h.cleanup();
});

test("maxIterations stops the loop and turns the mode off", async () => {
  const { dir } = project({ ".auto/measure.sh": MEASURE, ".auto/config.json": ['{ "maxIterations": 1 }\n'] });
  const h = await harness(dir);
  await started(h);
  const log = await h.call("log_experiment", { commit: "x", metric: 10, status: "keep", description: "k" });
  assert.match(log.content, /Maximum experiments reached \(1\)/);
  const after = await h.context();
  assert.equal(after.system.length, 0, "mode off after the cap");
  assert.match((await h.call("run_experiment", { command: "./.auto/measure.sh" })).content, /not active/);
  await h.cleanup();
});

test("workingDir redirects files, commands, and git; a missing workingDir errors", async () => {
  const { dir } = project({ "sub/.keep": [""], ".auto/config.json": ['{ "workingDir": "sub" }\n'] });
  const h = await harness(dir);
  await h.command("go");
  const init = await h.call("init_experiment", { name: "t", metric_name: "ms" });
  assert.match(init.content, /Working directory: .*sub/);
  assert.ok(fs.existsSync(path.join(dir, "sub/.auto/log.jsonl")));
  const run = await h.call("run_experiment", { command: "pwd" });
  assert.match(run.content, /\/sub\b/);

  fs.writeFileSync(path.join(dir, ".auto/config.json"), '{ "workingDir": "missing" }\n');
  assert.match((await h.call("run_experiment", { command: "pwd" })).content, /does not exist/);
  await h.cleanup();
});

test("/autoresearch clear deletes the log and turns the mode off", async () => {
  const { dir } = project({ ".auto/measure.sh": MEASURE });
  const h = await harness(dir);
  await started(h);
  await h.command("clear");
  assert.equal(fs.existsSync(path.join(dir, ".auto/log.jsonl")), false);
  assert.match(h.synthetics.at(-1).text, /Deleted .auto\/log.jsonl and turned autoresearch mode OFF/);
  assert.equal((await h.context()).system.length, 0);
  await h.cleanup();
});

test("export dashboard serves the page, the log, and live updates", async () => {
  const { dir } = project();
  fs.mkdirSync(path.join(dir, ".auto"));
  fs.writeFileSync(path.join(dir, ".auto/log.jsonl"), JSON.stringify({ type: "config", name: "<My Session>", metricName: "ms" }) + "\n");
  const server = createDashboardServer();
  try {
    const url = await server.open(dir, false);
    const html = await (await fetch(url)).text();
    assert.match(html, /&lt;My Session&gt;/, "title injected and escaped");
    assert.match(html, /data:image\/webp;base64,/, "logo inlined");
    assert.match(await (await fetch(`${url}/autoresearch.jsonl`)).text(), /My Session/);
    assert.equal((await fetch(`${url}/nope`)).status, 404);

    const res = await fetch(`${url}/events`);
    const reader = res.body.getReader();
    await reader.read(); // retry preamble
    server.broadcast(path.resolve(dir));
    const { value } = await reader.read();
    assert.match(new TextDecoder().decode(value), /event: jsonl-updated/);
    await reader.cancel();
  } finally {
    server.stop();
  }
});

test("a log in the project auto-activates; a log only in a redirected workingDir does not", async () => {
  const log = JSON.stringify({ type: "config", name: "x", metricName: "ms" }) + "\n";
  const same = project({ ".auto/log.jsonl": [log] });
  const h1 = await harness(same.dir);
  assert.match((await h1.context()).system[0]?.text ?? "", /Autoresearch Mode \(ACTIVE\)/);
  await h1.cleanup();

  const redirected = project({ "sub/.auto/log.jsonl": [log], ".auto/config.json": ['{ "workingDir": "sub" }\n'] });
  const h2 = await harness(redirected.dir);
  assert.equal((await h2.context()).system.length, 0);
  await h2.cleanup();
});
