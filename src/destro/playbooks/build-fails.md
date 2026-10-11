# Playbook: Build Fails (docker build / next build / tsc)

**Signature:** non-zero exit from `docker compose build`, `next build`, `tsc`, `npm install`.
Parser: destro-error-parser extracts file:line diagnostics where present.

## Diagnose
1. Re-run the SMALLEST failing unit first via background-exec (builds exceed shell timeouts — never run a
   full build in a foreground 300s shell): `tsc --noEmit` before `next build` before `docker compose build`.
2. Read the FIRST error, not the last — cascades lie. destro-error-parser gives file:line.
3. Classify:
   - **Type/syntax error** in project code → recent change broke it (often a pipeline worker's edit).
   - **Missing dep / lockfile drift** → `npm install` / version mismatch.
   - **Docker layer failure** (COPY missing path, base image pull fail, network in build) → Dockerfile/infra.
   - **Resource exhaustion** (OOM during build, disk full) → check `df -h`, free memory; this server runs
     hot — a failed `next build` at high load may just need a retry when quieter.
4. If a pipeline worker "completed" right before the break: diff its touched files (ls -lt for recent
   mtimes) — repairing the factory's output is the primary job.

## Fix
1. Code error → smallest correct fix at file:line (./archive backup → edit → edit-validator/tsc scoped check).
2. Deps → install/pin; if lockfile conflicts, prefer the committed lockfile.
3. Dockerfile/infra → fix the referenced path/base image; validate with `docker compose config -q`.
4. Resources → free disk (old images: `docker image prune` — CONFIRM with operator first), or retry the
   build off-peak via background-exec.

## Verify
- The failing command exits 0 (run the FULL original command via background-exec, not just the sub-step).
- If the artifact deploys (image/container), the service comes up healthy afterwards.

## Record
Append (service, "build-fail:<tool>") → first-error signature + fix to incident-memory.
