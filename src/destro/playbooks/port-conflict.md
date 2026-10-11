# Playbook: Port Already Allocated / Address In Use

**Signature:** `Bind for 0.0.0.0:<port> failed: port is already allocated` (docker) or
`EADDRINUSE` / `address already in use` (node/python/systemd). Classifier pattern `port-already-allocated`.

## Diagnose
1. `port_check <port>` → confirm it is actually in use.
2. Who owns it: `ss -tlnp | grep :<port>` (via destro-shell) → pid + process name.
3. Classify the owner:
   - **The same service, half-dead** (previous container/process didn't release) → stale instance.
   - **A different legitimate service** → real conflict (two services configured for one port).
   - **Unknown process** → investigate before touching (could be anything on this shared server).

## Fix
1. **Stale same-service instance** → stop/remove the stale container (`docker ps -a` → `docker rm -f <old>`),
   or kill the orphan pid; then start the service normally.
2. **Real config conflict** → remap the NEW service's host port in compose/.env (a busy host already uses
   remaps like 5432→15432, 6379→16379 — follow that pattern; backup first, then edit + compose up). Never
   steal a port from a running production service.
3. **Unknown owner** → escalate with the pid/process details; do not kill unidentified processes.

## Verify
- `port_check` shows the intended owner listening; service health probe green.
- The displaced/old process is gone (`ss` clean).

## Record
Append (service, "port-conflict:<port>") → resolution to incident-memory.
