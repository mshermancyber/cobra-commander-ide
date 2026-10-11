# Playbook: Healthcheck Failing / Container Unhealthy

**Signature:** `docker ps` shows `(unhealthy)`; compose `depends_on: condition: service_healthy` blocks
dependents; http_health_probe non-2xx or timeout. Classifier pattern `unhealthy-healthcheck`.

## Diagnose
1. `docker_inspect <container>` → `.State.Health`: failing streak, last 3 probe outputs (the actual error
   text is here — read it, don't guess).
2. Distinguish the three shapes:
   - **App genuinely down** inside the container (probe hits it, app 500s/refuses) → app problem.
   - **Probe wrong** (bad URL/port/tool missing in image — e.g. curl not installed) → healthcheck problem.
   - **Too slow to start** (fails during warmup then would pass) → timing problem.
3. `docker_logs` (tail 200) → startup errors, migrations hanging, dependency waits (db not ready).
4. Check its dependencies first: if postgres/redis it depends on is down, fix THAT (walk the chain).

## Fix
1. **App down** → follow the app's own error (this often chains into crash-loop.md or build-fails.md).
2. **Probe wrong** → correct the healthcheck (URL/port/binary) in compose; backup, edit, compose up.
3. **Warmup too short** → raise `start_period`/`retries` in the healthcheck block.
4. **Dependency down** → recurse on the dependency, then re-verify this service without touching it.

## Verify
- `docker ps` shows `(healthy)`; sustained for 3 consecutive probe intervals (background-exec watch).
- Dependents that were blocked on service_healthy have started.

## Record
Append (service, "healthcheck") → root shape (app|probe|timing|dependency) + fix to incident-memory.
