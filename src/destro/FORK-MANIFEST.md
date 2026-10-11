# Destro Fork Manifest

Every file in `src/destro/` that is a fork (or a new module with no core origin) is tracked here.
**All forks are DOWNSTREAM-only — do not backport to core.**

## Fork Table

| # | Fork (relative path) | Origin (core path or N/A) | Forked Date | Security-Critical? | Notes |
|---|---|---|---|---|---|
| 1 | `destro-circuit-breaker.ts` | `core/circuit-breaker.ts` | 2026-07-04 | No | DOWNSTREAM-only |
| 2 | `destro-doom-loop-detector.ts` | `core/doom-loop-detector.ts` | 2026-07-04 | No | DOWNSTREAM-only |
| 3 | `destro-retry.ts` | `core/retry-strategy.ts` | 2026-07-04 | No | DOWNSTREAM-only |
| 4 | `destro-error-classifier.ts` | `core/error-classifier.ts` | 2026-07-04 | No | DOWNSTREAM-only; extended with container signatures (image-pull-backoff, port-already-allocated, unhealthy-healthcheck, exited(1)) |
| 5 | `destro-error-parser.ts` | `core/error-parser.ts` | 2026-07-04 | No | DOWNSTREAM-only |
| 6 | `destro-tool-output.ts` | `core/tool-output-truncation.ts` | 2026-07-04 | No | DOWNSTREAM-only; extended: byte-clamp of previews, temp-dir reaper |
| 7 | `destro-context.ts` | Extracted from `core/orchestrator.ts` (compaction/ledger helpers) | 2026-07-04 | No | DOWNSTREAM-only; renamed for Destro: collapse session to [incident summary + actions ledger + last N turns] |
| 8 | `destro-session-store.ts` | `core/task-store.ts` (rekeyed task→session/incident) | 2026-07-04 | No | DOWNSTREAM-only; heartbeat includes pid, incident ledger, actions-taken; reconcile-resume on restart |
| 9 | `destro-shell.ts` | `tools/shell-tool.ts` | 2026-07-04 | **YES** | **SECURITY-CRITICAL** — port core safety fixes down promptly. Command execution fork from the project shell tool. |
| 10 | `ops-tools.ts` | N/A (new, no core origin) | 2026-07-04 | No | Destro-specific: docker_ps, docker_inspect, docker_logs, journalctl_tail, docker_restart, docker_compose_up, systemctl_status, systemctl_restart, http_health_probe, port_check |
| 11 | `web-tools.ts` | N/A (new, no core origin) | 2026-07-04 | No | Destro-specific: search_web + fetch_url via SearXNG |
| 12 | `background-exec.ts` | N/A (new, no core origin) | 2026-07-04 | No | Destro-specific: detached long-running commands with ring-buffer streaming and wake conditions |
| 13 | `destro-runner.ts` | `core/task-runner.ts` | 2026-07-04 | No | **DOWNSTREAM fork** — loop skeleton for proactive daemon; renamed task→incident concepts; not wired yet |

## Summary

- **Total files in `src/destro/`**: 13
- **Forked from core**: 7 (circuit-breaker, doom-loop-detector, retry-strategy, error-classifier, error-parser, session-store, task-runner)
- **Forked from tools**: 1 (shell-tool → destro-shell; **security-critical**)
- **Extracted from core/orchestrator.ts**: 1 (destro-context)
- **Extracted from core/tool-output-truncation.ts**: 1 (destro-tool-output)
- **New (no core origin)**: 3 (ops-tools, web-tools, background-exec)

## Drift Check

Run `check-fork-drift.ts` (once created) to diff each fork against its origin and produce a divergence report:

```bash
npx tsx src/destro/check-fork-drift.ts
```

The script:
1. Parses this manifest (`FORK-MANIFEST.md`) to extract fork→origin mappings.
2. For each entry with a core origin (not N/A), reads both the fork file and its origin file.
3. Computes a line-count diff and first-line comparison.
4. Prints a divergence report for each fork: `FORK | ORIGIN | lines_in_fork | lines_in_origin | first_line_match`.

This is **report-only** — check-fork-drift never auto-merges or modifies files. It is designed to run in CI or via `destro doctor` so you know when a core module has diverged from its fork, especially `destro-shell.ts` where core safety fixes must be ported down promptly.

> **Note**: `destro-shell.ts` is flagged as security-critical. The drift checker highlights it first in the report so core shell-tool safety fixes are never missed.
