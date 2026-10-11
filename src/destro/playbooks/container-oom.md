# Playbook: Container OOM (exit 137 / OOMKilled)

**Signature:** container exits with code 137; `docker inspect` shows `OOMKilled: true`; classifier
pattern `oom` / `exit 137` (see destro-error-classifier.ts).

## Diagnose
1. `docker_inspect <container>` → confirm `State.OOMKilled`, note `HostConfig.Memory` (limit, 0 = none).
2. `docker_logs <container>` (tail 200) → what was it doing when killed (import? build? query burst?).
3. Host pressure: `free -m`; swap usage near 100% means host-level pressure, not just a container limit.
4. Recurrence: check incident-memory for this service — repeated OOM at similar times ⇒ workload pattern
   (cron, ingest burst), not a leak.

## Fix (in order of preference)
1. **Limit too low for real workload** → raise `mem_limit`/`deploy.resources.limits.memory` in compose
   (backup via ./archive hook first), then `docker_compose_up` the one service.
2. **Leak (usage climbs monotonically between restarts)** → restart now to restore service
   (`docker_restart`), then read app logs for the leaking path; escalate a code-fix task if it's in a
   /data project.
3. **Host memory pressure** (many services, swap full) → identify the top consumers
   (`docker stats --no-stream`), recommend which service(s) to stop/trim; do NOT silently kill others —
   escalate the choice.

## Verify
- Container running ≥ 5 min without restart (background-exec sustained-healthy watch).
- `docker_inspect` shows OOMKilled false since restart; memory usage plateaus below the limit.

## Record
Append (service, "oom") → what the actual fix was to incident-memory.
