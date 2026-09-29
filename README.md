# autoresearch-opencode2

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![OpenCode 2](https://img.shields.io/badge/OpenCode-2.x-4A90D9)](https://opencode.ai/v2/docs/)

Autonomous experiment loop for [OpenCode 2](https://opencode.ai/v2/docs/): try an idea, measure it, keep it if the metric improved, revert it if not, repeat. It's a port of [pi-autoresearch](https://github.com/davebcn87/pi-autoresearch) (tracking v1.8.1) as a native OpenCode 2 plugin.

## Requirements

- OpenCode **2.x** (`opencode --version`). OpenCode 1.x is not supported; the v1 plugin API is gone.
- `git` and `bash`. Experiments auto-commit and auto-revert.

## Install

```bash
git clone https://github.com/kyeshmz/autoresearch-opencode2.git
cd autoresearch-opencode2
./scripts/install.sh
opencode service restart   # if you use the background service
```

`install.sh` writes `~/.config/opencode/plugins/autoresearch.ts`, a one-line entrypoint that re-exports this checkout's `src/index.ts`. `git pull` updates the plugin in place. `./scripts/uninstall.sh` removes it.

To enable it for a single project, put the same one-liner in `<project>/.opencode/plugins/autoresearch.ts`:

```ts
export { default } from "/path/to/autoresearch-opencode2/src/index.ts"
```

## Usage

```
/autoresearch optimize unit test runtime, monitor correctness
```

- `/autoresearch <goal>`: enter autoresearch mode. If `.auto/prompt.md` doesn't exist, the `autoresearch-create` skill sets up the session (branch, `.auto/prompt.md`, `.auto/measure.sh`, baseline) and starts looping. Otherwise the loop resumes from the saved state.
- `/autoresearch off`: leave autoresearch mode and stop the current run.
- `/autoresearch clear`: delete `.auto/log.jsonl` and turn the mode off.
- `/autoresearch dashboard`: post the full results table into the session.
- `/autoresearch export`: open a live browser dashboard (localhost, updates on every logged run).

Ask for `autoresearch-finalize` to split a finished session into clean, independent review branches. Ask for `autoresearch-hooks` to add before/after iteration hooks (research fetching, notifications, anti-thrash, and so on).

## How it works

| Piece | What it does |
|---|---|
| `init_experiment` | Writes the session config header (name, metric, unit, direction) to `.auto/log.jsonl`. Calling it again starts a new segment with a fresh baseline. |
| `run_experiment` | Runs `.auto/measure.sh` with a timeout, parses `METRIC name=value` lines, then runs `.auto/checks.sh` if the benchmark passed. |
| `log_experiment` | Records the result. `keep` runs `git add -A && git commit`. `discard`, `crash`, and `checks_failed` revert code changes but leave `.auto/` alone. It also enforces secondary-metric consistency and reports a MAD-based confidence score. |
| Tool gating | The three tools are registered as direct tools (outside Code Mode, whose catalog is always in the system prompt) and are only visible to the model while autoresearch mode is active for that session. If one is reached anyway, it refuses to run. |
| System prompt | While active, adds loop rules plus pointers to `.auto/prompt.md`, the ideas backlog, and checks. |
| Compaction | While active, replaces the LLM compaction summary with a deterministic one built from `.auto/` state: rules, ideas, and the last 50 runs. |
| Auto-resume | When a turn ends (`session.execution.succeeded`/`failed`) after logging at least one experiment, and after compaction, the plugin prompts the agent to run the next iteration. It stops after 200 auto-resumes, after more than 20 consecutive discards/crashes, or when you interrupt. |
| Hooks | Optional `.auto/hooks/before.sh` and `after.sh`. Their stdout is steered into the running turn. |

### Session files

All under `.auto/` in the project (or in `workingDir` from `.auto/config.json`):

| File | Purpose |
|---|---|
| `prompt.md` | The playbook a fresh agent reads to continue the loop |
| `measure.sh` | Benchmark; prints `METRIC name=value` lines |
| `log.jsonl` | Append-only config headers and run results (source of truth) |
| `ideas.md` | Deferred ideas backlog (optional) |
| `checks.sh` | Correctness gate run after passing benchmarks (optional) |
| `config.json` | `{ "maxIterations": 50, "workingDir": "..." }` (optional) |
| `hooks/{before,after}.sh` | Lifecycle hooks (optional) |

Legacy flat files (`autoresearch.md`, `autoresearch.jsonl`, `autoresearch.sh`, …) from older sessions are still read.

## Differences from pi-autoresearch

- **No TUI widget or fullscreen overlay.** OpenCode 2 server plugins have no UI surface. Use `/autoresearch dashboard` or `/autoresearch export` instead.
- **Status notes are queued.** Messages like "Autoresearch mode OFF" or the no-argument help are posted as synthetic session notes. They show up with the next turn, not immediately.
- **No keyboard shortcuts.**
- **Activation is stored per session** in plugin storage, not as a session entry. A manual `/autoresearch off` still survives compaction and restarts.

## Development

```bash
npm install
npm run typecheck   # against @opencode/plugin 2.0.18 types
npm test            # unit tests, plugin harness tests, finalize.sh tests
```

`src/index.ts` is the plugin entrypoint. The rest of `src/` is host-agnostic logic ported from pi-autoresearch: `experiment.ts`, `jsonl.ts`, `compaction.ts`, `hooks.ts`, `paths.ts`, `runner.ts`, and `dashboard.ts`.

## License

MIT. See [LICENSE](LICENSE). Contains code ported from pi-autoresearch (MIT, © Tobi Lutke, David Cortés).
