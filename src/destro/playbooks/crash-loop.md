# Playbook: Crash Loop (restarting repeatedly)

**Signature:** `docker ps` shows `Restarting (N) X seconds ago` repeatedly; systemd unit flapping
(`systemctl status` shows activating/auto-restart cycles). The anti-thrash guards (circuit-breaker /
doom-loop) will trip on OUR restarts — a crash loop must be DIAGNOSED, never restart-hammered.

## Diagnose
1. **Stop restarting it. Watch instead**: background-exec `docker logs -f <container>` (or
   `journalctl -fu <unit>`) through one full crash cycle — capture the last 30 lines before death.
2. Exit code from `docker_inspect`:
   - 137 → OOM (go to container-oom.md)
   - 1/2 with a stack trace → app error at startup (config, missing env, bad migration)
   - 126/127 → entrypoint/binary missing (image built wrong — go to build-fails.md)
3. Common causes, in observed order: missing/renamed env var after an edit; dependency not up yet
   (no healthcheck gate); config file syntax broken by a recent change; DB schema mismatch after partial
   migration.
4. Check what changed: recent mtimes in the project dir; incident-memory for this service; a pipeline task
   that "completed" recently is a prime suspect.

## Fix
1. Startup error with clear cause → fix the config/env/code (./archive backup → edit → edit-validator),
   then ONE restart, then watch a full cycle.
2. Dependency ordering → add/repair healthcheck + `depends_on: condition: service_healthy` gate.
3. Bad migration/state → this is a DATA decision (restore vs repair vs roll forward) → escalate with
   options and tradeoffs; do not pick for the operator.
4. If the cause is invisible after 2 watched cycles → escalate with the captured pre-death logs + RCA
   hypotheses (investigation.ts). Never exceed the anti-thrash budget trying.

## Verify
- Container/unit stays up ≥ 5 minutes AND survives one full workload event (a request, a poll cycle) —
  sustained-healthy watch via background-exec, not a single probe.
- Restart counter stops incrementing.

## Record
Append (service, "crash-loop:<exit-code>") → pre-death signature + fix to incident-memory.
