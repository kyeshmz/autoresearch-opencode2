# Changelog

## [2.0.0] - 2026-09-28

Rewritten as a native OpenCode 2 plugin, ported from [pi-autoresearch](https://github.com/davebcn87/pi-autoresearch) v1.8.1 (`939ede8`). This replaces the previous skill-only port, which had the agent write JSONL by hand from shell snippets.

### Added

- `init_experiment`, `run_experiment`, `log_experiment` tools, visible only while autoresearch mode is active for the session. They are direct tools (`codemode: false`) because the Code Mode catalog is always in the system prompt, and they refuse to run while the mode is off.
- `.auto/` session layout (`prompt.md`, `measure.sh`, `log.jsonl`, `ideas.md`, `checks.sh`, `config.json`, `hooks/`), with fallback reads of legacy `autoresearch.*` files.
- Backpressure checks (`.auto/checks.sh`) and the `checks_failed` status.
- Confidence score (best improvement ÷ MAD noise floor) after 3+ runs.
- Actionable Side Information (`asi`) on every run, including `asi.revisits_run` for intentional retries of earlier discards, and a prompt after each log to reconsider discards whose assumptions changed.
- Secondary-metric consistency enforcement (`force: true` to add a new one).
- `maxIterations` and `workingDir` in `.auto/config.json`.
- Deterministic compaction summary built from persisted state.
- Auto-resume when a turn that logged a run ends (`session.execution.succeeded`/`failed` — OpenCode 2 does not emit `session.idle`) and after compaction (200-turn ceiling; stops after more than 20 consecutive discards/crashes).
- Before/after lifecycle hooks (`.auto/hooks/*.sh`) with the `autoresearch-hooks` skill and example scripts.
- `autoresearch-finalize` skill and `finalize.sh` to split a session into independent review branches.
- `/autoresearch off|clear|dashboard|export|<goal>`; `export` serves a live browser dashboard.

### Removed

- OpenCode 1.x support and the `experimental.chat.system.transform` plugin.
- The `autoresearch` skill, `commands/autoresearch.md`, backup scripts, and the example BogoSort session files.
