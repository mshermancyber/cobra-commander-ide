# Destro — Support / Troubleshooting Agent (4th archetype)

**Status:** implemented and shipping in v0.1.0. This document is the design contract the code is held
to — `src/destro/dispatch.ts` references it by name — and it is kept in its original design-document
voice rather than rewritten as user documentation. For how to *use* the support agent, see
[USER-GUIDE.md](./USER-GUIDE.md#the-support-agent).

An earlier operator-agent design laid out four placement options (A separate project / B peer agent /
C intake-router / D expand-workers). This spec chose a **fifth, cleaner shape**: a distinct agent,
**Destro**, that lives as a *parallel lane* to the coder pipeline — reached directly from the web UI,
bypassing intake, never routed through the orchestrator.

---

## 1. The decision in one paragraph

CC today is a **coder**: `intake → orchestrator → worker`, request-driven, output = shipped code.
**Destro is a support engineer**: reached directly (WebUI or the proactive daemon loop), signal/
conversation-driven, output = *a healthy fleet + fixed runtime*. It is a **separate archetype**, not a
modification of the worker — **the worker stays a pure developer and its code is not touched.** Destro
runs on the worker model, has a full troubleshooting toolset + hooks, and is grounded with one hard rule:
**back up to `./archive/` before it changes anything.**

Why a separate agent instead of "expand workers" (the original Option D): putting host-level ops tools
and a troubleshoot-and-mutate mindset *inside* the code-editing worker would (a) enlarge every worker's
blast radius, (b) change the worker hot path we just hardened, and (c) blur "build a feature" with "fix a
running thing." Keeping Destro separate means **the coder pipeline is untouched** and the ops blast-radius
is quarantined in one archetype with its own guardrails.

---

## 1.5 Destro's mandate — a free thinker, not an assembly line

**The build pipeline is a factory assembly line; Destro is a free thinker.** Intake → orchestrator → worker
is a rigid line: fixed stages, one-shot ephemeral workers, structured hand-offs, each worker boxed to a
single spec. Those are *pipeline* restrictions — they exist to make mass code production predictable.
**Destro operates WITHOUT any of them.** He is not one-shot, not boxed to a spec, not staged; he is a
persistent, free-roaming senior engineer.

- **His primary job: instruct and repair — especially issues *caused by* the assembly line.** This is
  essentially *what we are doing right now in this session* — diagnosing, reasoning across the whole system,
  and fixing what the factory got wrong or left broken. Destro is the free-thinking mind that oversees the
  factory's output and repairs its defects.
- **The pipeline's limits do NOT apply to Destro.** He is *not* restricted to "surgical fixes only," *not*
  required to hand feature-sized repairs back to intake, *not* single-threaded if parallel investigation
  helps. If the right fix is large, he makes it. If diagnosing means probing ten things at once, he does.
- **What still binds him is SAFETY, not pipeline structure.** The rails that remain — `./archive` backup
  before any change, interactive approval (with an auto-mode to just get it done), and secret redaction —
  are *safety* hooks (the same posture as Claude Code's permission model), not the assembly line's *structural*
  constraints. Freedom of thought and scope; discipline of safety.

So earlier phrasings in this doc that boxed Destro ("surgical fixes only," "escalate feature work to
intake," "strictly single-agent") are **superseded by this mandate** — they were the assembly line's rules
leaking onto a free thinker. Where they conflict, §1.5 wins.

---

## 2. Two lanes (the mental model)

```
CODER LANE (unchanged)                       SUPPORT LANE (new — Destro)
─────────────────────                        ───────────────────────────
WebUI ─talk→ Intake                          WebUI ─talk→ Destro ⇄ (streaming chat)
              │ expands prompt                             │
              ▼                                             ├─ read/grep/shell/docker/systemctl/logs
        Orchestrator (CTO)                                  ├─ http health probe / port check
              │ plans, splits, delegates                    ├─ edit/write/patch  ── wrapped by ──▶ ./archive backup hook
              ▼                                             ├─ ops/investigation.ts  (RCA brain)
          Worker(s) — developers                            └─ escalation → user (WebUI)
              │ implement code
              ▼                              DAEMON LANE (new — Destro proactive)
         durable tasks  ◀──── WebUI shows ──  startDestro() health loop (peer to task-runner)
         (READ-ONLY in WebUI)                  probe fleet → diagnose → heal → verify → escalate
```

Two things cross between lanes, both **one-directional and read-only from the WebUI's side**:
- The WebUI **displays** worker/orchestrator task state (from the durable task store) — *view only*.
- Destro may **read** a project's source/logs to diagnose — and per §15 he may also **dispatch work INTO
  the pipeline** (intake request / orchestrator task / spin up a worker) as its foreman.

The orchestrator never delegates to Destro, and Destro never hijacks a worker *mid-task under the
orchestrator* (he spawns/commands his own, §15 — the lanes don't
entangle at runtime). But per §1.5 Destro is **not** limited to "escalate and wait" — he freely repairs
whatever the pipeline produced, including large fixes, on the artifacts and runtime directly. He escalates
to the human when a *decision* is genuinely the user's (not because a fix is "too big"). New feature work
still originates at intake; *repairing what the factory built or broke* is Destro's own job.

---

## 2.5 Code isolation + Claude-Code-shaped agent (CTO constraints)

**Constraint A — Destro's codebase is isolated from worker and orchestrator.** Destro lives in its own
module tree (`src/destro/**`). The isolation that matters is at the level of **internals**: Destro's
agent-loop and resilience code are **private forks** (§5.5), sharing no implementation with the
worker/orchestrator, and the worker/orchestrator never import Destro. Consequence: a change to Destro's loop
*cannot* break the coder pipeline's loop, and vice-versa — the two engines' brains are decoupled.

**But isolation of internals ≠ a ban on commanding subordinates (corrected 2026-07-04).** As the foreman
(§15), Destro *may* instantiate and steer a real `Worker` or the orchestrator through their existing public
interface — `new Worker(...).executeTask(...)` + `worker-steering`, the same seam `tasks.ts`, `workspace.ts`,
`orchestrator-launcher.ts`, and `delegate.ts` already use. That's a shallow, intended dependency on a
subordinate's *command surface*, not a sharing of Destro's *implementation*. The rule, precisely: **don't
copy-merge agent internals across lanes (fork them); do let Destro command the real workers/orchestrator as
subordinates.** (An earlier draft over-stated this as "zero cross-imports, dispatch only via the queue" —
that was wrong; the CTO has spun up and controlled workers in-memory directly, and Destro can too.)

**Honest scoping of "isolation" (two different axes — don't conflate them):**
- **Code isolation (real, and the point of the forks):** Destro's forked copies (§5.5) are separate files,
  so a *code change* to the worker's compaction/retry can't alter Destro's, and vice-versa. This is what
  "absolute failure isolation" in the copy-rename sense means, and it holds.
- **Runtime fault isolation (NOT absolute when he commands in-process):** if Destro runs `new Worker(...)`
  *inside his own process*, a crash/OOM/throw in that Worker **can** take Destro down — same fault domain.
  So don't claim runtime isolation for the in-memory path. Two honest options, Destro's choice per task:
  **(a) in-memory command** = tight control + steering, *shared* fault domain (fine for a small supervised
  fix); **(b) out-of-process** via `createTask`→daemon (or a subprocess) = *isolated* fault domain, looser
  control (right for anything heavy or crash-prone). Where the wording elsewhere says "absolute failure
  isolation," read it as **code** isolation; **runtime** isolation is option (b).

**Constraint B — Destro functions very closely to Claude Code.** Destro *is* a single autonomous agentic
loop with a rich toolset — not a plan/split/delegate orchestrator, not a one-shot worker. Shape:

```
system prompt (support-engineer persona)
  └─ loop: LLM turn → tool calls → results → LLM turn → … until resolved or escalated
       tools: read, write, edit, apply_patch, grep, glob, bash(shell-tool),
              docker_*, systemctl_*, journalctl_tail, http_health_probe, port_check
       every tool call passes through Destro's minimal safety floor (§6): ./archive backup,
              your approval mode (interactive or auto), secret redaction — then verify + audit
       streaming reasoning + actions to the WebUI (like Claude Code's live tool trace)
```

This is exactly the Claude-Code interaction model: one agent, many tools, an autonomous read→act→observe
loop, permission/hook gating, streamed to the user. It's the *right* shape for troubleshooting (open-ended,
signal-driven) and it's **structurally different from both the orchestrator (which delegates) and the
worker (which is one-shot/ephemeral)** — which is *why* it earns its own isolated codebase rather than
being a mode of either.

### Isolation + reuse: copy, rename, keep separate (CTO decision)

There is **no tension** — the resolution is **copy-and-rename**, not share. Destro gets its **own forked
copies** of every CC primitive it needs (compaction/ledger, error-recovery, retry, circuit-breaker,
durable-resume), copied into `src/destro/**` and renamed into Destro's namespace. **No shared modules, no
common layer, zero cross-imports** between Destro and worker/orchestrator.

- `orchestrator.ts` and `worker.ts` are **literally untouched** — nothing is extracted from them.
- Destro's copies live only under `src/destro/**` (e.g. `destro/destro-context.ts`, `destro/destro-retry.ts`,
  `destro/destro-circuit-breaker.ts`, `destro/destro-session-store.ts`).
- Consequence: **absolute CODE isolation.** A change (or bug) in Destro's copy can never alter the coder
  pipeline's code, and vice-versa — the two lanes share no code at all. (*Runtime* fault isolation is a
  separate axis — it holds when Destro runs out-of-process, which is the build decision in §7.)

The accepted cost is **duplication** (the same logic exists twice) and **drift** (a fix to one copy isn't
auto-applied to the other). Where blast-radius isolation matters more than DRY, that's the
right trade — and it's the CTO's explicit call: *"isolate, copy and rename the code, keep separate."*
Mitigation for drift: tag each copied file with a header comment noting its CC origin
(`// forked from core/circuit-breaker.ts @ 2026-07-04`) so a future audit can diff them.

---

## 3. WebUI access-control model (exactly what's reachable)

The user's requirement: the WebUI is a **non-developer** surface. It talks to the two *front doors* and
*observes* the rest. Concretely:

| Surface | WebUI can… | Rationale |
|---|---|---|
| **Intake** | talk (start new projects, expand prompts) | front door of the coder lane |
| **Destro** | talk (troubleshoot, ask, approve escalations), stream responses | front door of the support lane |
| **Worker tasks** | **view only** — list, status, ledger, logs, produced changes | observability, no steering |
| **Orchestrator** | **no interaction** — not talkable, not steerable from WebUI | it runs autonomously under the daemon |
| **Worker** | **no interaction** — not talkable, not steerable from WebUI | it's a dev, driven only by its orchestrator |

Implementation note: the current WebUI already exposes `routes/workers.ts` and `routes/tasks.ts`. For this
model those must be **demoted to read-only** in the WebUI (GET list/detail/logs only) — any steer/abort/
delegate/retry control is removed from the non-developer surface (it can stay available to the CLI/daemon,
just not wired into the WebUI). Add a new **Destro route set** (`routes/destro.ts`) for the talk surface.

---

## 4. Bypasses intake — why, and what that implies

Intake's whole job is to **expand a rough build prompt into detailed requirements**. Troubleshooting has
nothing to expand — "the API is 502ing" is a *signal*, not a spec. Routing it through intake would burn a
context-expansion on a non-buildable prompt and manufacture a fake "requirement." So Destro is reached
**directly**.

That means Destro needs its **own conversational session store**, separate from the requirements/task
ledger the coder lane uses:
- `core/destro-session.ts` — per-conversation message history, its own compaction (reuse the
  compact-on-tool-result discipline from the orchestrator fix so **Destro can't run out of context** either
  — same principle: cap tool outputs, summarize old turns, keep an incident ledger of what it changed).
- Sessions are durable (file-backed like tasks) so a daemon restart doesn't drop an in-flight incident.

**Context safety (carry the orchestrator lesson forward):** Destro reads logs — which are *huge*. Every
log/inspect/journalctl result MUST route through `tool-output-truncation` with a **byte clamp** (see
stability gap #5), and Destro's session compacts to `[incident summary + actions-taken ledger + last N
turns]`. Same failure mode as the orchestrator overflow; same fix, applied up front.

---

## 5. Toolset — mostly reuse, small net-new "hands"

**Reuse as-is (the brain + safety):**
- `ops/investigation.ts` — **fully built, currently ORPHANED.** `LogAggregator`, `MetricAnomalyDetector`,
  `RootCauseAnalyzer` (`KNOWN_PATTERNS` maps OOM / conn-refused / rate-limit → remediation),
  `OperationalInvestigator`, incident timelines. **Destro is the thing that finally wires this.**
- `core/error-classifier.ts` (already catches exit 137 / OOMKilled), `core/error-parser.ts`,
  `core/circuit-breaker.ts`, `core/doom-loop-detector.ts`, `core/retry-strategy.ts` — anti-flap/anti-thrash
  around restarts.
- `tools/shell-tool.ts` `executeShellTool` — the safe-shell harness (timeout, SIGTERM→SIGKILL, output cap,
  risk classifier that already tags `docker rm`/`systemctl` as moderate). **Every Destro action routes
  through this.**
- `core/port-scanner.ts`, `core/system-health.ts`, `escalation.ts`, the `task-runner.ts` loop skeleton
  (clone for the health daemon), the the worker model/vault/provider plumbing.

**Net-new (the "hands" — small, all through `executeShellTool`):**
`docker_ps`, `docker_inspect`, `docker_logs`, `journalctl_tail`, `docker_restart`,
`docker_compose_up`, `systemctl_status`, `systemctl_restart`, `http_health_probe`, `port_check`.

**Web (the "eyes on the world" — §14.1):** `search_web` + `fetch_url` backed by a SearXNG instance the
operator supplies (`SEARXNG_URLS`, comma-separated, tried in order; unset means web search is off) —
look up error strings, CVEs, image/config issues.

**Mutation tools (with the `./archive` backup hook wrapped around them):** `read`, `grep`, `edit`, `write`,
`apply_patch`. Per §1.5 Destro is a **free thinker — no "surgical only" limit**: he makes code/config
repairs of *any* size to fix what the pipeline produced or broke. New *feature* origination still starts at
intake; repairing the factory's output is Destro's own domain. Every mutation still passes the safety chain
(backup → your approval mode → verify).

---

## 5.5 Reuse CC's autocompacting + error-recovery (the CTO's hard requirement)

Destro must inherit **all** the context-management and resilience machinery we built into Cobra Commander —
it's a long-running agent chewing on huge logs, so it needs it *more* than the worker does. Per §2.5 it
gets these as **copied-and-renamed forks under `src/destro/**`**, never by importing the shared/agent code.
Inventory of what to fork:

**Autocompacting / never-run-out-of-context (fork of the orchestrator-overflow fix):**
- **Compact-on-tool-result + ledger** → `destro/destro-context.ts` (copied from the helpers embedded in
  `orchestrator.ts` — `estimateMessagesChars`, `capForOrchestrator`, `collapseToLedger`, `renderLedger`,
  etc., renamed for Destro). Collapses session history to `[incident summary + actions-taken ledger +
  last N turns]`. Destro's ledger = the incident timeline (probed / changed / still-open).
- **Byte-clamped tool-output truncation** → `destro/destro-tool-output.ts` (copied from
  `tool-output-truncation.ts`, **with the byte-clamp of gap #5 and the temp-dir-reaper of gap #1 applied in
  the copy** — Destro is the longest-lived agent and would leak `/tmp/tool-output-*` fastest). Every
  `docker logs` / `journalctl` / `inspect` result routes through it.
- **Model-aware compaction budget** — the copy uses `compactByTokenBudget` wired to the worker model's real
  context limit (gap #6), not a hardcoded truncate.

**Error recovery (fork each into Destro's tree):**
- `destro/destro-circuit-breaker.ts`, `destro/destro-doom-loop-detector.ts`, `destro/destro-retry.ts` —
  copies of `circuit-breaker.ts` / `doom-loop-detector.ts` / `retry-strategy.ts`; anti-flap on restarts *and*
  anti-thrash on Destro's own agentic retries.
- `destro/destro-error-classifier.ts` / `destro-error-parser.ts` — copies, extended with container
  signatures (image-pull-backoff, port-already-allocated, unhealthy healthcheck, exited(1)).
- The **escalating agentic retry ladder** (ErrorFocused → Simplified → ModelFallback → CleanSlate),
  multi-key rotation with per-key 429 cooldown, and model quarantine/tiered failover — copied into Destro's
  own provider-call path so it does not share the coder's provider code.
- **Retry/backoff in the provider call** — the CC copy Destro forks must be the one *with* retry/
  `Retry-After`/429 handling (gap #3: today that lives only in the openai-compatible provider). Bake the
  bounded-retry into Destro's forked provider path from the start.

**Durable crash-resume (fork of the watchdog/heartbeat/resume machinery):**
- `destro/destro-session-store.ts` + `destro/destro-runner.ts` — copies of the `task-store.ts` /
  `task-runner.ts` durability shape, keyed to a *session/incident* instead of a coder *task*. Heartbeat
  `{pid, incident ledger, actions-taken}` to a file; on daemon restart, reconcile-resume an in-flight
  incident from its ledger with a **fail-loud cap** (like `MAX_RESUMES`) so a wedged incident escalates
  instead of looping.

**Net effect:** Destro is as crash-durable and context-safe as the coder pipeline, sharing **no code** with
it — every resilience primitive is a private, renamed copy inside `src/destro/**`.

---

## 5.6 Drift safety — copies will diverge, and that must never *break* things

Copy-and-rename means Destro's forks and the worker/orchestrator originals **will drift over time.** The
CTO's requirement: *drift must not break things.* Isolation already buys most of this; three layers finish
the job.

**Layer 0 — isolation makes drift non-contagious (this is the whole point).** Because the lanes share **no
code**, a change to the worker's copy **cannot** break Destro's code, and a Destro change **cannot** break
the worker's — *by construction*. "Worker and Destro drift apart" is the *expected, safe* state, not a
hazard: it is precisely why we copied instead of shared. The only thing drift can cost you is a *good fix*
not propagating — which the next two layers make visible and non-fatal. (*Code* isolation; *runtime* fault
isolation comes from Destro running out-of-process, §7.)

**Layer 1 — drift is *visible*, never silent — and porting is ONE-DIRECTIONAL (downstream only).** A fix
landing in one copy and not the other can't hide, *and* Destro's own improvements can never leak upstream
into the worker:
- **Direction rule (hard):** the fork flow is **`core/*` → `destro/*` ONLY.** CC-core is the *upstream*
  source; Destro is a *downstream* fork. A bug fix in CC-core *may* be ported **down** into Destro's copy.
  A change Destro makes to its own copy — a smarter recovery heuristic, a better compaction, a sharper
  error classifier — **is NEVER ported back up into the worker/orchestrator.** *"I don't want to
  unintentionally make the worker smarter"* is the governing constraint: the worker's capability profile is
  frozen relative to Destro's evolution. Destro getting better at troubleshooting must not silently upgrade
  the developer.
- Every forked file carries a provenance header naming its upstream origin **and** the direction:
  `// forked from core/circuit-breaker.ts @ <commit/date> — DOWNSTREAM fork, do not backport to core`.
- `src/destro/FORK-MANIFEST.md` maps each fork ↔ its CC origin and marks it downstream-only.
- The `check-fork-drift` script (CI step or `destro doctor`) diffs each fork against its named origin and
  **reports** divergence in one framing only: *"CC-core changed — review whether to port the fix DOWN into
  Destro."* It never suggests, and CI should **block**, the reverse (a Destro→core/worker port). It does not
  auto-merge in either direction (that would re-couple the lanes) — a human decides on downstream ports.

**Layer 2 — *behavior* is pinned per-lane, so *breaking* drift is caught in its own lane.** The thing that
must not break is behavior, not line-identical code. Destro ships its **own** contract-test suite
(`src/destro/__tests__/`) that pins the guarantees it depends on, independent of the worker's tests:
- compaction keeps the window under budget even on a pathological single-line log,
- retry honors `Retry-After` / backs off on 429,
- a session resumes from its ledger after a kill, and fails loud after the resume cap,
- the `./archive` backup precondition holds (no backup ⇒ mutation refused).
If Destro's copy drifts in a *breaking* way, **Destro's own tests go red** — the worker's suite is
irrelevant and untouched. Drift that *doesn't* break these guarantees is, by definition, harmless.

**Layer 3 — runtime fails *safe*, so even undetected drift degrades gracefully.** Destro's forked
context/recovery code is written to fail toward "escalate to human," never "crash the daemon or wedge":
hard-cap the context window even if compaction miscomputes; on a malformed resume ledger, escalate rather
than crash-loop; the fail-loud resume cap already bounds any loop. So the worst a drifted Destro copy can
do is **escalate**, never take down its own daemon — and never the coder lane, which shares nothing with it.

**Summary:** you don't prevent drift, you make it *safe*: isolation stops it spreading (Layer 0), the
manifest+checker stops it hiding (Layer 1), per-lane contract tests catch the breaking kind (Layer 2), and
fail-safe runtime bounds the blast radius of any that slips through (Layer 3).

---

## 6. The hooks — ONLY what the CTO asked for (Destro is as unrestricted as Claude Code)

**Design correction 2026-07-04:** an earlier draft imported a sysadmin control-plane (fleet allowlist,
autonomy tiers, diagnose-only) from the *old* operator-agent design. That contradicts the mandate —
**Destro is as capable as Claude Code, a free thinker with no artificial limits.** Claude Code has no
allowlist and no autonomy tiers; its safety is the *user's permission model* (approve, or run in an
auto-accept mode). Destro is identical. The control-plane is **removed.** Only three hard rules remain —
the three the CTO explicitly named:

1. **`./archive` backup (MANDATORY — the grounded rule).** Before *any* mutation (file edit/write/patch or
   a config change) Destro copies the target(s) into `<projectWorkDir>/archive/<incidentId>-<timestamp>/`,
   preserving relative path. No backup written ⇒ the mutation is refused. The one hard precondition, in
   code — *"backup before making changes."* One `./archive` per project touched; one subfolder per incident.
2. **Permission model = approval WITH an auto-mode (this IS Claude Code's model).** Two user-chosen modes,
   per session: **interactive** ("Destro wants to run X — Allow / Allow-for-incident / Deny," with
   "always-allow this pattern" grants) and **auto** ("just get it done" — Destro runs unattended). The
   *user* is the safety valve, exactly like Claude Code's default-ask vs. accept-all. No hardcoded tiers,
   no per-service authorization — the mode is the control, and the operator sets it.
3. **Secret redaction (safety).** Never print/echo secrets (redact in tool output, audit log, and the WebUI
   stream); pull the the worker model key from the key vault, never plaintext.

**The rest are capabilities Destro *has*, not gates that *restrict* him:**
- **Verify + self-correct** — after a change, check it worked (health-probe for runtime, validation/
  diagnostics for edits — §14); if worse, auto-revert from `./archive`/git and re-try. A capability, not a
  permission gate.
- **Audit/incident log** — every action recorded to the durable incident timeline (shown in the WebUI). For
  visibility, not authorization.
- **Escalate when the decision is genuinely yours** — push the RCA + options to the WebUI and wait. Because
  it's *your* call, not because a tier forbids him.
- **Anti-thrash stability** (circuit-breaker / doom-loop) stays — but as *stability* (don't restart the same
  thing in a tight loop), the same loop-guards Claude Code has, **not** as a capability limit.

---

## 7. Where it plugs into the running system

- **Daemon (`src/daemon.ts`):** add `startDestro()` alongside `startTaskRunner()` and
  `startScanScheduler()` — a ~60s health loop (Loop 1 below), with the same fail-loud/budget discipline as
  the task-runner. Teardown wired into the existing shutdown block.
  **Process-isolation honesty (audit fix) — CTO decision: SEPARATE DAEMON, SAME WEBUI.**
  `startTaskRunner()` runs in the CC daemon *in-process*, so an in-process `startDestro()` would share a
  fault domain with the coder lane — a hard crash/OOM in Destro could kill the task-runner. So Destro runs
  as his **own daemon process** (`destro-daemon.ts` — forked child of `daemon.ts` auto-restarted on exit,
  or its own systemd user service; either satisfies the decision). Runtime isolation becomes real in both
  directions: Destro can't take down the factory, the factory can't take down Destro.
  **The WebUI stays ONE UI:** the existing api-server remains the single front door — `routes/destro.ts`
  lives there and **bridges** to the Destro daemon over local IPC (unix socket / localhost port), proxying
  the SSE chat stream, approvals, steering, and incident data. The operator sees one WebUI with a Destro
  pane; the separation is purely process-level, invisible at the UI.
- **API server (`src/api-server/`):** new `routes/destro.ts` — `POST /api/destro/chat` (SSE stream),
  `GET /api/destro/incidents`, `GET /api/destro/fleet`, `POST /api/destro/approve/{incidentId}`. Register
  in `server.ts` next to `createIntakeRoutes()`. Demote `workers.ts` / `tasks.ts` WebUI surface to GET-only.
- **WebUI frontend:** add a **Destro** pane (streaming chat + incident timeline + fleet health tiles);
  keep the **Intake** pane; make the **Tasks** pane read-only; remove any orchestrator/worker control
  affordances from the non-developer surface. (Current WebUI candidates live under `archive/react-webui`
  and the served static bundle — confirm the live one before wiring.)

### Loop 1 — Proactive health daemon (`startDestro()`, clone `task-runner.ts`)
```
every ~60s, for each fleet service:
  probe (http / container-health / systemd)
  if down / unhealthy / crash-looping:
    diagnose → investigation.ts RootCauseAnalyzer over docker logs / journalctl
    heal     → restart (anti-thrash: circuit-breaker + doom-loop-detector)
    verify   → re-probe; healthy ⇒ log recovery
    else     → escalation.ts with the RCA (never restart-storm)
```
Rollout is **your choice** (not a mandated gate): you can let the proactive loop auto-heal from the start,
or run it diagnose-only first and flip on auto-heal once its diagnoses look right. Same auto-vs-interactive
control as everywhere else — just applied to the always-on loop.

### Loop 2 — Reactive troubleshooting (WebUI chat, direct)
Human talks to Destro: "stock-trading frontend won't come up." Destro runs the diagnose → (backup) →
fix → verify loop conversationally, streaming its reasoning + actions, and reports. No intake, no
orchestrator, no worker.

---

## 8. Fleet watch-list (what the proactive loop MONITORS — NOT an authorization boundary)

This is **not an allowlist** and does **not** limit what Destro can touch (he's unrestricted, §6). It's
just the list of services the *proactive* daemon (Loop 1) probes on its own, so it knows where to look
without being asked. In reactive mode Destro acts on anything you point him at, declared or not.

**Scope correction (CTO, 2026-07-04): EMPTY BY DEFAULT — strictly opt-in.** Destro is part of Cobra
Commander. Other services running on the same host are
**independent projects that merely share the server** — they are NOT CC's to monitor by default, and an
earlier draft's pre-seeded fleet list wrongly conflated "runs on this box" with "belongs to CC." The
operator adds entries deliberately, one at a time. (Noted for the operator's judgment only: security-scanner
is a runtime *dependency* of CC — the key vault supplies the LLM key — so it's the one external service
worth *considering*; still opt-in.)

`fleet-watch.json` entry shape:
```jsonc
{
  "name": "my-service",
  "kind": "docker-compose",              // docker-compose | docker | systemd | process
  "path": "/srv/projects/my-service",
  "containers": ["my-service-api-1", "my-service-web-1"],
  "health": { "type": "http", "url": "http://127.0.0.1:8080/health" },
  "watch": true
}
```
**One common-sense caution (stability, not a permission tier):** Destro shouldn't kill the CC daemon he
runs *inside* — that's suicide, not policy. A simple self-process guard, not an authorization system.

---

## 9. Safety — the Claude-Code posture (user is the valve, not a policy engine)

Destro's blast radius is real, but so is Claude Code's — and Claude Code's answer is **the user's permission
model**, not a hardcoded restriction lattice. Destro matches that. The *entire* safety model is:

- **`./archive` backup before every mutation** — nothing changes un-backed-up; the universal revert floor.
- **Approval with an auto-mode** (§6.2) — you choose interactive (approve/deny per action, with pattern
  grants) or auto ("just get it done"). **This is the control.** Same as Claude Code's ask vs. accept-all.
- **Secret redaction** — never echo secrets; key from key vault.
- **Anti-thrash stability** — circuit-breaker + doom-loop so a *bug* doesn't restart-storm; a stability
  guard (Claude Code has loop-guards too), not a capability limit.
- **Self-process guard** — don't kill the CC daemon he lives in (suicide, not policy).

**Removed (were never asked for, contradicted the mandate):** the fleet allowlist, autonomy tiers
(`restart=auto`/`recreate=confirm`/`readonly=diagnose-only`), diagnose-only-for-undeclared, per-service
grant scoping, and the proposed file-mutation authorization tier. Destro can touch anything, at any size,
like Claude Code — bounded only by *your* approval mode and the backup floor.

---

## 10. Model — independently configurable (CTO addition 2026-07-04)

**Destro has its OWN model config, separate from the other three agents.** Default and override:
- **Default (now):** the worker model via the **key vault** the worker model key — same source as intake/orchestrator/
  worker (vault-fetched at runtime, never stored locally). Diagnosis benefits from a reasoning model.
- **`.env` override (for a smarter Destro whenever you want):** a dedicated `DESTRO_*` block, read at
  startup, that overrides *only Destro's* model without touching the pipeline's model:
  ```
  DESTRO_PROVIDER=      # e.g. anthropic | openai | openai   (default: openai)
  DESTRO_MODEL=         # e.g. claude-opus-4-8                 (default: the worker model)
  DESTRO_API_KEY=       # optional; if unset, falls back to the the scanner-vault the worker model key
  DESTRO_BASE_URL=      # optional; provider endpoint override
  DESTRO_FALLBACK_MODEL=/DESTRO_FALLBACK_PROVIDER=   # optional secondary in Destro's own chain
  ```
  Resolution order: `DESTRO_*` env → else the shared the worker model/the scanner-vault default. Because Destro's codebase is
  isolated (§2.5), this lives in its own `destro/destro-config.ts` — the pipeline's model config is
  untouched, and vice-versa.

**Why this matters (ties to §14):** the the worker model ceiling — no vision, weaker tool-calling — is exactly what
this override buys back. Drop `DESTRO_MODEL=claude-opus-4-8` into `.env` and Destro gains vision (real
screenshot reading) + more reliable tool-calls, closing most of the "as capable as Claude Code" gap for the
one agent where troubleshooting quality matters most — while the factory keeps running cheap the worker model.

**Reasoning-model caveat (applies while on the worker model):** `max_tokens` is shared between reasoning + output —
give Destro generous caps + the empty-response guard/retry, or a tight cap yields silent no-ops. Cap
agentic turns so a reasoning spiral doesn't burn the window. (A non-reasoning override model sidesteps this.)

---

## 11. What changes in CC vs. what stays untouched

**Untouched (the whole point — no code extracted, nothing made "smarter"):**
- `worker.ts` — the developer worker's code does not change, and no Destro improvement is ever ported into it.
- `orchestrator.ts`, `intake-agent.ts` — coder pipeline logic unchanged; nothing lifted out (we *copy*, not extract).
- The durable task-runner / watchdog / resume machinery — Destro gets its own forked copy, the originals stand.

**New — everything Destro lives in its own isolated tree `src/destro/**` (zero cross-imports):**
- Agent core: `destro/destro-agent.ts` (Claude-Code-style loop + tool wrapper + hook chain),
  `destro/destro-session.ts`, `destro/destro-hooks.ts` (backup + approval-mode + secret-redaction + verify/audit).
- **Forked resilience copies** (§5.5, downstream-only, provenance-headed): `destro/destro-context.ts`,
  `destro/destro-tool-output.ts`, `destro/destro-retry.ts`, `destro/destro-circuit-breaker.ts`,
  `destro/destro-doom-loop-detector.ts`, `destro/destro-error-classifier.ts`,
  `destro/destro-session-store.ts`, `destro/destro-runner.ts`.
- Tools: `destro/ops-tools.ts` (docker/systemctl/journalctl/http-probe — each shells out via its own copy of
  the shell-tool safety harness, or the existing `executeShellTool` if you accept that one shared low-level
  primitive — see §13.4); `destro/web-tools.ts` (`search_web`/`fetch_url` via SearXNG, §14.1).
- `destro/investigation.ts` — the orphaned `ops/investigation.ts` **adopted** into Destro (nothing else
  imports it today, so moving it in couples nothing).
- Model + dispatch: `destro/destro-config.ts` (own `DESTRO_*` model override → the scanner-vault the worker model default,
  §10); `destro/dispatch.ts` (the §15 router — routes to intake request store / `createTask` / an in-memory
  Worker). Per §15's isolation refinement, dispatch **may** instantiate + steer a real `Worker`/orchestrator
  (the same public interface `tasks.ts` uses) — Destro's *internals* stay isolated forks, his *command
  surface* commands real subordinates.
- Capability modules (§14): `destro/system-prompt.md`, `destro/playbooks/`, `destro/tool-validator.ts`
  (tool-call schema-validate + repair loop — NOT the same thing as edit validation), `destro/web-tools.ts`
  (SearXNG), approval-channel + interrupt/steer wiring on the session.
- **Parity modules (§16 — audit found these missing from this inventory; each now has a home):**
  - `destro/background-exec.ts` — background/long-running execution + monitor loop (§16.4): spawn detached,
    stream/poll output, wake on exit / log-pattern / sustained-healthy-for-N-min. Replaces the 300s cap for
    builds, `logs -f`, `journalctl -f`, crash-loop observation. **Also what the anti-thrash guards observe.**
  - `destro/incident-memory.ts` + a `learned_remediations` store (§16.1): `(service, failure-signature) →
    diagnosis, fix, outcome`, consulted at incident start, appended on confirmed fix; auto-grows playbooks.
  - `destro/edit-validator.ts` (§16.2): per-filetype validate-before-apply (`docker compose config`,
    `nginx -t`, `systemd-analyze verify`, `tsc --noEmit`, JSON/YAML parse) + diagnostics-after-edit. A
    self-check capability, never an authorization gate.
  - `destro/verify.ts` (§16.5): re-drive-the-failing-flow verification (replay request / run project
    healthcheck script), feeding the self-correct loop a true better/worse signal.
  - Git persistence (§16.3): in `destro-hooks.ts` — for git-tracked targets, checkpoint before + **commit
    the repair with an incident-referencing message after** (so pipeline rebuilds can't clobber it);
    `./archive` stays the universal floor for non-git files.
  - Plan-preview + structured escalation (§16.6/7): in `routes/destro.ts` + the WebUI pane — "approve this
    N-step plan" and options-with-tradeoffs prompts.
- Drift governance: `destro/FORK-MANIFEST.md` + `check-fork-drift` (`destro doctor`).
- Process isolation (§7 build decision): `destro/destro-daemon.ts` — Destro's loop as a supervised **child
  process**; `daemon.ts` keeps a thin forker/restarter + API bridge.
- Wiring only: `daemon.ts` gains `startDestro()`; `api-server/routes/destro.ts` new; `workers.ts`/`tasks.ts`
  WebUI surface demoted to GET-only; `fleet-watch.json` new (monitor list, not an allowlist); WebUI gains the Destro pane.

**No net-new pipeline plumbing required for dispatch (corrected):** in-memory single-Worker control already
exists (`new Worker(...).executeTask(...)` + `worker-steering`, used by `tasks.ts`/`workspace.ts`/
`delegate.ts`), and orchestrator/intake dispatch reuse `createTask`/`expandPrompt` as-is. An optional
`createTask` `mode:'single-worker'` convenience for *durable* fire-and-forget single-worker runs is a nice-
to-have, not a prerequisite.

---

## 12. Build sequence (for LATER — nothing built now) — §14 AND §16 fully folded in (audit fix)

Small waves, each independently verifiable. This sequence is the build contract: **everything approved in
§14 and §16 appears in a wave below** — nothing is left to be discovered in prose.

1. **Scaffold `src/destro/**` + fork the resilience copies** (§5.5): copy-and-rename context/retry/
   circuit-breaker/doom-loop/error-classifier/tool-output/session-store/runner, each with its
   provenance header; write `FORK-MANIFEST.md` + `check-fork-drift`. Adopt `investigation.ts` into the tree
   and extend its classifier with container signatures. Contract-test suite (§5.6 Layer 2) lands here.
   `destro/destro-config.ts` (own `DESTRO_*` model override → the scanner-vault default, §10) lands here too.
2. **Ops toolset + execution backbone**: `destro/ops-tools.ts` (docker/systemctl/journalctl/probes) through
   the shell-safety harness; `destro/web-tools.ts` (SearXNG search+fetch, §14.1);
   **`destro/background-exec.ts` (§16.4)** — background/long-running exec + monitor loop (exit / log-pattern
   / sustained-healthy triggers). Built THIS early because verify, anti-thrash observation, and builds all
   depend on it.
3. **Safety floor + edit correctness** (`destro-hooks.ts`): `./archive` backup precondition (the grounded
   rule, before any mutation tool is exposed); **git checkpoint-before + commit-after for git-tracked
   targets (§16.3)**; **`destro/edit-validator.ts` (§16.2)** validate-before-apply + diagnostics-after-edit;
   secret redaction (§14.8).
4. **The agent**: `destro-agent.ts` (Claude-Code-style loop) + `destro-session.ts` (durable, autocompacting)
   + `destro/tool-validator.ts` (the worker model tool-call repair) + `destro/system-prompt.md` (§14.9, encoding the
   §1.5 free-thinker mandate) + project-context ingestion (§14.4) + **`destro/verify.ts` (§16.5)**
   re-drive-the-failing-flow verification wired into the self-correct loop (§14.10) + **`destro/
   incident-memory.ts` + `learned_remediations` store (§16.1)** consulted at incident start, written on
   confirmed fix + playbooks library (§14.5).
5. **Same WebUI, separate daemon**: `destro-daemon.ts` as its own supervised process (§7 decision);
   `routes/destro.ts` in the existing api-server bridging over local IPC — SSE chat, **interactive approval
   + auto-mode toggle (§14.2)**, **interrupt/steer (§14.3)**, **plan-preview (§16.6)**, **structured
   escalation options (§16.7)**, incident step-checklist (§14.11); Destro pane in the WebUI; demote
   Tasks/Workers views to read-only.
6. **Foreman routing (§15)**: `destro/dispatch.ts` — route to intake / orchestrator (`createTask`) / spin up
   + steer a Worker (in-memory or out-of-process per §2.5).
7. **Proactive loop**: fleet watch-list + the ~60s health loop in Destro's daemon (auto-heal or
   diagnose-only first — your choice, §7); parallel investigation/repair fan-out (§14.6) once the single
   loop is proven.

**Deferred consciously (not forgotten):** vision stays model-gated — screenshot-reading works when
`DESTRO_MODEL` is set to a vision model (§10/§16.8); no OCR tool in v1.

---

## 13. Open forks (my calls — override as you like)

1. **Ship reactive-first, proactive-later.** The WebUI support-worker conversation (Loop 2) is the heart of
   your ask; the always-on health daemon (Loop 1) is higher blast-radius. **Rec:** build waves 1–5
   (reactive Destro) first, prove it, then add the daemon loop (waves 6–7) in dry-run. You get the
   troubleshooter you asked for without the always-on risk on day one.
2. **Destro's mutation scope — RESOLVED (§1.5): unrestricted repair.** No longer a fork. Destro is a free
   thinker exempt from the assembly line's limits — he owns config/runtime/infra *and* makes code repairs of
   any size to fix what the pipeline produced/broke. He does not need to hand large repairs back to intake.
   He escalates only when a *decision* is the user's. New *feature* origination still starts at intake.
3. **`./archive` location.** One `./archive/` inside *each project Destro touches*, one subfolder per
   incident. Decided (not central), matches "the task he is working on."
4. **The one gray-area primitive: `shell-tool.ts`.** Everything else is cleanly copied. The shell-safety
   harness is the one low-level primitive where copying has a real downside — a *security* fix to the
   command risk-classifier is exactly the kind of thing you'd want in *both* lanes, and a Destro copy that
   drifts *behind* on safety is worse than one that drifts on a heuristic. **Rec:** copy it too (full
   isolation, consistent with your directive) **but** tag it in `FORK-MANIFEST.md` as *security-critical —
   port CC-core safety fixes down promptly*, so `check-fork-drift` flags it loudest. If you'd rather, this
   single file is the one I'd consider leaving shared — your call; default is copy.

**Decided by your constraints (no longer forks):** separate archetype (not "expand workers"); copy-and-
rename with zero shared code; one-directional downstream porting (never make the worker smarter); Claude-
Code-shaped agentic loop; full autocompact + error-recovery + durable-resume via private forks; free-thinker
mandate — pipeline restrictions removed, unrestricted repair, safety hooks retained (§1.5); all §14
capabilities approved (SearXNG search, approval-with-auto-mode, interrupt/steer, project-context ingestion,
playbooks, git-checkpoint, secret redaction, system prompt, self-correct, step-checklist, parallel repair).

---

## 14. Capability-gap audit vs. Claude Code (what §1–13 was still missing)

Goal restated: *as capable as Claude Code, without the build-pipeline structure, on the worker model, in the WebUI.*
The prior sections nailed the loop + tools + resilience but left real Claude-Code capabilities on the table.
Ranked by how much they close the gap:

### The deepest gap: the model is the capability ceiling (the worker model ≠ Claude)
"As capable as Claude Code" is *partly the harness and partly the model.* Claude Code is strong because
Claude is reliable at tool-calling, instruction-following, vision, and long context. the worker model is a
**reasoning** model with quirks we've already been bitten by. Destro's harness must **compensate** for each,
or it will feel markedly weaker than Claude Code:
- **Tool-call reliability** — the worker model emits malformed / hallucinated tool calls more often than Claude
  (and `response_format` is incompatible with tool use — a lesson learned the hard way). Destro needs a
  **tool-call validator + repair loop**: schema-validate every call, and on malformed output, reprompt with
  the error (bounded) instead of crashing. This is net-new and *essential* to feeling Claude-Code-like.
- **No native vision** — the worker model V4 is text-only (vision is a separate the worker model-VL line). So Destro
  **cannot "look at" a screenshot** the way Claude Code can. Compensate: for WebUI/service verification use
  **DOM-scrape + HTTP/health probes + log parse**, and if a visual check is truly needed, run it through an
  **OCR/DOM-to-text step** rather than feeding an image. Be honest in the UI that Destro verifies by
  signals, not sight.
- **Smaller context window** (~128K vs Claude's 200K+) → the autocompact of §5.5 matters *more*, and its
  byte-clamp on logs is non-negotiable.
- **Shared reasoning+output `max_tokens`** (§10) → generous caps + the empty-response guard/retry, or you
  get silent no-ops. Also cap agentic turns so a reasoning spiral doesn't burn the window.
- **JSON/format discipline** — prompt-enforced, validated, repaired — because you can't lean on
  `response_format` alongside tools.

**Bottom line:** the harness can get Destro *most* of the way to Claude Code, but tool-call reliability and
vision are hard model limits — the spec should promise "Claude-Code-shaped and nearly as capable *for
troubleshooting*," not literal parity.

### Missing tools/capabilities — ALL APPROVED by CTO 2026-07-04 (build them in)
1. **Web search + fetch — APPROVED.** Add `search_web` + `fetch_url` backed by an operator-supplied
   **SearXNG** instance (`SEARXNG_URLS`, comma-separated, tried in order; unset means off — the same instances another tool
   tool-uses). A troubleshooter that can look up an error string / CVE / image issue is far stronger. Route
   through the tool-call validator; cap rounds like triage does.
2. **Interactive per-action approval — APPROVED, WITH AN AUTO-MODE.** Two modes, user-selectable per
   session in the WebUI:
   - **Interactive mode** — inline **"Destro wants to run `docker compose down` — Allow / Allow-for-this-
     incident / Deny"** with "always allow this pattern" grants. Wire `shell-tool`'s (currently unwired)
     `approvalHandler` + `grantPermission` to a WebUI approval channel.
   - **Auto mode ("just get it done")** — Destro runs fully unattended, exactly like Claude Code's
     accept-all. No tiers, no per-action pauses. The only thing that still runs is the `./archive` backup
     (so anything he does stays revertable) and secret redaction. If you want confirmations, use interactive
     mode — the *mode* is the control, and it's yours to set.
3. **Interrupt / steer mid-incident — APPROVED.** WebUI can **stop Destro mid-loop or inject** "no, don't
   restart that, check X first." Cooperative abort signal threaded through the loop (also stability gap #2)
   + a steer-message channel on the SSE session.
4. **Project-context ingestion — APPROVED.** On touching a project, Destro **auto-reads that project's
   `CLAUDE.md`/README/compose/`.env.example`** into context — your projects already document their own
   gotchas (ports, restart quirks, "frontend is a built image"). Generic ops → project-aware ops.
5. **Reusable troubleshooting playbooks — APPROVED.** A **runbook library** (`destro/playbooks/`): "container
   OOMing," "port already allocated," "healthcheck failing," "build fails" → known diagnose+fix steps
   (the RCA engine's `KNOWN_PATTERNS` half-encodes these). Fast, consistent, and directly extensible by you.
6. **Parallel investigation & repair — APPROVED as UNRESTRICTED (per §1.5).** The earlier "read-only only /
   maybe single-threaded" framing was an assembly-line limit leaking onto a free thinker — **removed.**
   Destro may fan out helpers for **investigation *and* repair** as he sees fit (probe many services, grep
   many logs, drive parallel fixes) — these are *his* ephemeral sub-tasks, not delegated pipeline workers,
   so they add capability without adding pipeline structure. The only thing wrapping each sub-action is the
   same minimal safety floor (`./archive` backup + your approval mode) — no allowlist, no tiers.
7. **Git-aware checkpoint (complements `./archive`) — APPROVED.** For git-tracked targets, a `git stash`/
   commit checkpoint is a more precise revert. Keep `./archive` as the universal floor (works on non-git
   config too); add git-checkpoint when the target is a repo.
8. **Secret hygiene — APPROVED (safety, non-negotiable).** Destro reads `.env`, logs, vault material. It must
   **never print/echo secrets** (redact in tool output + audit log + the WebUI stream), and pull the the worker model
   key from the **key vault**, never plaintext — same rule as the rest of the fleet.

### First-class deliverables — APPROVED
9. **System prompt as a real artifact — APPROVED.** `destro/system-prompt.md`, versioned: the free-thinker
   mandate (§1.5), diagnose→hypothesize→act→verify discipline, when to escalate vs. just fix, the `./archive`
   rule, "you verify by signals not sight," secret hygiene. Much of Claude Code's capability *is* its prompt.
10. **Verify-and-self-correct loop — APPROVED.** Full loop first-class: fix → verify → if worse,
    **auto-revert from `./archive`/git** → re-diagnose → retry (bounded) → escalate.
11. **In-incident task tracking — APPROVED.** Surface the incident ledger as a visible **step checklist** in
    the WebUI so a multi-step remediation is legible.

### Deliberately OUT (per §1.5 these would re-import the assembly line — keep excluded)
- No rigid plan→split→delegate orchestration *of Destro's own work*, no one-shot/ephemeral-worker box, no
  mandatory intake expansion before Destro can act. Note the distinction from #6: Destro spawning *his own*
  ephemeral helpers to think/repair in parallel is **free-thinker capability**; being *forced through* the
  pipeline's stages is the **assembly-line restriction** he's exempt from. New *feature* work still
  originates at intake — repairing what the factory produced is Destro's own domain.

**Build order:** every item above is wave-assigned in **§12** (the build contract) — see there; don't
re-derive from this section.

---

## 15. Destro is pipeline-aware — the 4-tier routing decision (CTO addition 2026-07-04)

Destro **knows the other three levels exist** and decides, per piece of work, how much of the factory to
spin up. He is the **foreman above the assembly line**: the human talks to him in plain terms, and *he*
routes. This is not the pipeline driving Destro — it's Destro **commanding** the pipeline.

| Signal | Route | Mechanism |
|---|---|---|
| Runtime/config/infra broken, or a repair he can just make | **Do it himself** (his own hands) | direct tools (§5), `./archive` + safety chain |
| **New** project/capability, or a vague ask that needs framework aggregation + prompt expansion | **→ Intake** | create an intake request (`expandPrompt`/`saveRequest`) — the full front door |
| **Existing** project, multi-step/multi-file, needs a plan + parallel workers, and the requirement is already clear | **→ Orchestrator (directly, bypass intake)** | `createTask(requirement, context, projectPath)` → pending; the daemon task-runner runs the orchestrator |
| **Small**, single-concern, few-file code change where planning overhead isn't worth it | **→ one Worker** | instantiate a Worker **in-memory** and command it directly — `new Worker(cfg, cb, model, role, id).executeTask(...)` with mid-task steering (`worker-steering`), exactly as `tasks.ts`/`workspace.ts` and `delegate.ts` already do; OR `createTask` → pending for fire-and-forget |

**Decision heuristics (encode in his system prompt):**
- **New vs existing?** A net-new project/feature → Intake (it aggregates your framework + expands the
  prompt). An existing project → orchestrator / worker / himself.
- **Does the ask need expanding, or is it already crisp?** Vague human ask → Intake expands it. Crisp
  requirement → Destro is a free thinker who can *author the spec himself* and go **straight to the
  orchestrator**, skipping intake's expansion (exactly what today's `dispatch-*.ts` scripts do by hand).
- **How big?** Trivial + runtime → himself. Small single-concern code → one worker. Large / multi-part /
  needs parallelism → orchestrator. He spins up **only as much machinery as the task needs.**

**Two dispatch styles, both already existing (nothing net-new here — corrected):**
- **In-memory direct control** — Destro instantiates a Worker (or the orchestrator) and drives it
  synchronously: `new Worker(...).executeTask(...)`, watching events and injecting `[STEERING]` messages via
  `worker-steering`. This is a real, existing capability — `tasks.ts`, `workspace.ts`, and
  `orchestrator-launcher.ts` all `new Worker(...)` today, and `delegate.ts` is the reference script for
  exactly this. Best when Destro wants to *supervise* a small fix inline (steer it, get the result directly).
- **Queue dispatch** — `createTask(...)` → pending → the daemon's task-runner runs it durably
  (fire-and-forget, crash-resumable). Best for larger orchestrator work Destro doesn't need to babysit. The
  intake front door works the same way via its request store (`expandPrompt`/`saveRequest`).

**Isolation, corrected (§2.5 refinement):** the isolation that matters is that Destro's *own* agent-loop and
resilience internals are **private forks** (§5.5) — so a change to the worker's loop can't break Destro's
loop, and vice-versa. It was **wrong** to also forbid Destro from *commanding* a Worker: instantiating and
steering a subordinate is his foreman's job, and it's the same public interface (`new Worker`/`executeTask`/
steering) the orchestrator and the API routes already depend on. So: **Destro's internals stay isolated
copies; his command surface may instantiate + steer real subordinates** (Worker/orchestrator) or enqueue
tasks. Commanding a subordinate ≠ sharing your own implementation with it.

**WebUI stays coherent:** the human still only *talks to* Intake + Destro and *views* tasks read-only
(§3). Destro's dispatches simply appear in that read-only task view. The non-developer never has to know
the three levels exist — they describe the problem to Destro, and Destro decides "repair this myself, and
route the new-dashboard request to intake." Destro is the smart front-of-house over the whole factory.

**Supersedes:** the earlier "Destro never delegates to a worker" line (§2) and the "no delegated workers /
no intake expansion" bullet (§14 Deliberately-OUT) — those described a Destro *walled off* from the
pipeline. The correct model is a Destro who **commands** the pipeline at the right level. What remains OUT
is only the *reverse*: the pipeline never drives Destro, and Destro is never *forced through* its stages.

---

## 16. Capability parity — the reconciled Claude-Code gaps (APPROVED, all *capabilities*, no limits)

Second independent audit (post limit-removal) surfaced capabilities Claude Code has that Destro lacked.
These are **abilities Destro gains**, not restrictions — they're the "as capable as Claude Code" half of the
mandate. All approved:

1. **Cross-incident learning (a memory that grows).** Claude Code persists learned context; Destro must too.
   A **learned-remediation store** keyed by `(service, failure-signature) → what fixed it`, consulted first
   and appended on every confirmed fix — auto-growing the playbooks (§14.5). Infrastructure failures
   recur; he should recognize "seen this, here's what worked," not re-derive from scratch. (The same
   write-back pattern false-positive learning uses.) *Highest-leverage for a troubleshooter.*
2. **Validate-before-apply + diagnostics-after-edit (a self-check, not a gate).** Destro checks his own
   change is well-formed *before* restarting anything: per-filetype `docker compose config`, `nginx -t`,
   `systemd-analyze verify`, `tsc --noEmit`, JSON/YAML parse — and reads code diagnostics (LSP/tsc/lint)
   after an edit. This is a *capability* (catch your own typo, like Claude Code's post-edit diagnostics),
   NOT an authorization tier — it never blocks him, it informs him. Replaces "restart and see if it broke."
3. **Persist the fix so the pipeline can't clobber it.** A live file-patch that isn't committed is erased by
   the next worker rebuild / `git pull`, and the bug returns with runtime now diverging from the repo. For
   git-tracked targets Destro **commits** his repair (incident-referencing message); git-checkpoint becomes
   the *primary* precise revert for repos, with `./archive` the universal floor for non-git config.
4. **Background / long-running execution + live monitoring.** The 300s shell cap is shorter than your
   frontend build. Destro needs `run_in_background` + a monitor loop: kick off a build/`logs -f`/`journalctl
   -f`, watch until it exits / a pattern hits / a service holds healthy for N minutes, and react. Core to ops
   (crash-loops, memory creep, post-fix stabilization are all *temporal*) and what the anti-thrash guards
   need to actually observe. Claude Code has this; Destro must.
5. **Real verification (re-drive the failing flow, not just a liveness ping).** A green `/health` routinely
   coexists with the actual bug. Verify by exercising the symptom the operator described — replay the failing
   request, run the project's own test/healthcheck script — so the self-correct loop has a true better/worse
   signal.
6. **Plan-preview for multi-step fixes.** Claude Code's plan mode: show the full remediation plan, get one
   approval, then execute. For a non-developer this is more legible than N blind per-action prompts — and it
   catches a bad approach before any mutation. (Complements, doesn't replace, the auto/interactive modes.)
7. **Structured escalation (options, not freeform).** When a decision is genuinely yours, offer the choices
   with tradeoffs ("restore-from-backup, lose 2h / repair, risky / leave down") — an AskUserQuestion-style
   prompt, not a wall-of-text notification. Faster and safer for the non-dev operator.
8. **Vision — honest about where it lives.** Text-only the worker model can't read a pasted screenshot. Either add a
   DOM-scrape/OCR-to-text tool, or (simpler) state plainly that screenshot-reading requires the §10 override
   (`DESTRO_MODEL=claude-opus-4-8`), which *does* give real vision. Don't claim vision on stock the worker model.

**None of these is a limit.** They make Destro *more* capable — parity with Claude Code — while §6/§9 keep
his only constraints the three you asked for (`./archive` backup, your approval mode, secret redaction).

---

*This is design only. Nothing has been shipped to Cobra Commander to build.*
