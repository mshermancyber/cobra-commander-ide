# User Guide

How to actually use Cobra Commander day to day. If you have not installed it yet, start with
[INSTALL.md](INSTALL.md).

- [The mental model](#the-mental-model)
- [Two ways in](#two-ways-in)
- [The CLI](#the-cli)
- [Delegating work](#delegating-work)
- [Writing a good task](#writing-a-good-task)
- [The intake pipeline](#the-intake-pipeline)
- [Delegation strategies](#delegation-strategies)
- [Watching what happens](#watching-what-happens)
- [When a worker goes wrong](#when-a-worker-goes-wrong)
- [The support agent](#the-support-agent)
- [The REST API](#the-rest-api)
- [The web shell](#the-web-shell)
- [Configuration reference](#configuration-reference)
- [Cost control](#cost-control)
- [Good habits](#good-habits)

---

## The mental model

Three roles, and it pays to keep them straight:

| Role | Job | Model |
|------|-----|-------|
| **Intake** | Turns a one-line ask into a reviewable requirements document | cheap is fine |
| **Orchestrator** | Reads the codebase, plans, splits the work, dispatches and judges | your strongest |
| **Workers** | Implement one scoped task each, with file/shell/search tools | cheap and fast |

Around them sits a **harness** that decides whether work actually landed — not the model's own claim
about it. A worker that edits nothing, or reports success without a verification receipt, is failed
loudly rather than accepted. This is the single most important thing to understand about the system: a
"failed" task often means the harness caught a model lying about its own work.

A fourth role, the **support agent**, sits outside that pipeline and diagnoses the system itself.

---

## Two ways in

**Direct delegation** — you know what needs doing, you want it done:

```bash
cobra delegate "add rate limiting to the login route, 5 attempts per minute" \
  --work-dir ~/code/my-api
```

**The pipeline** — a vague ask that needs shaping first: intake expands it into requirements, you edit
and approve, then the orchestrator plans and dispatches. Use this for features, not fixes.

Start with direct delegation. Reach for the pipeline when a task is big enough that you want to argue
with the spec before any code gets written.

---

## The CLI

Run it with `npx tsx src/cli.ts <command>`, or `cobra <command>` after `npm link`.

```
cobra delegate <task>        Delegate one task to a worker (bypasses the orchestrator)
cobra daemon                 Start the daemon: API server, task runner, web shell, support agent
cobra start                  Preflight checks, then launch the daemon
cobra api                    Start just the API server
cobra remote                 Start just the web shell server
cobra ide run <command>      Run a command in the project, optionally re-running on file changes
cobra config show            Show the resolved configuration
cobra config path            Show where config files live
cobra project list|add|remove|switch    Manage registered projects
cobra task list|dispatch|status         Manage the task queue
```

Every command takes `--help`. A few worth knowing:

```bash
# Re-run the tests whenever a file changes
cobra ide run npm test --on-change --debounce 800

# Check what model and key are actually in effect
cobra config show

# Queue work for the daemon to pick up, instead of running it in the foreground
cobra task dispatch "migrate the config loader to zod" --work-dir ~/code/my-api
cobra task list --status active
cobra task status <id>
```

---

## Delegating work

```bash
cobra delegate "<task>" [options]

  -d, --work-dir <dir>    Project directory (default: cwd)
  -m, --model <name>      Model name, or a tier: fast | standard | heavy
  -t, --turns <n>         Max worker turns (default 150)
  -v, --verbose           Show every tool call
```

The worker gets file read/write/edit, patch application, shell, grep and symbol tools, scoped to the
work directory. It runs until the task is done, it hits a guard, or it runs out of turns.

```bash
# A small, cheap job
cobra delegate "fix the typo in the README install section" -m fast

# Something substantial, with the tool calls visible
cobra delegate "extract the retry logic from http-client.ts into its own module with tests" \
  -m heavy --verbose
```

**Always delegate against a clean Git working tree.** The worker's changes are then exactly what
`git diff` shows, and `git checkout .` is your undo.

---

## Writing a good task

This is where most of your leverage is. The failure modes are specific and predictable.

**Give it file paths and interfaces, not an essay.** The orchestrator and workers read code well. They
do not need you to write the code for them in prose, and a long spec crowds out the context they need
for the actual files.

```bash
# Good
cobra delegate "src/auth/session.ts: add refreshSession(token) that rotates the
refresh token and returns the new pair. Mirror the error handling in createSession."

# Worse — over-specified, and now you own the design mistakes
cobra delegate "In src/auth/session.ts write a function refreshSession that takes
a token parameter of type string, then calls verifyToken, then if that returns
null throw an AuthError with code 401, then generate..."
```

**Name the acceptance criteria.** "Done when `npx tsc --noEmit` is clean and `npm test -- session`
passes" gives the harness something to check and the worker something to aim at.

**One concern per task.** Two unrelated changes in one task means a failure in either poisons both.
Split them; they will run in parallel anyway.

**Say what not to touch.** Workers are literal-minded about scope but enthusiastic about adjacent
tidying. "Do not reformat the file" and "do not change the public API" are worth the words.

**Tell it not to scan unless scanning is the job.** A worker with shell access will cheerfully waste
turns trying to authenticate to a security scanner. Add: `Do NOT run security scans.`

---

## The intake pipeline

For work that needs a spec first. Each step is a REST call; the web shell's Intake panel is the same
thing with buttons.

```bash
TOKEN=$(cat ~/.cobra-commander/api-token)
BASE=http://127.0.0.1:4100/api/v1

# 1. Expand a one-liner into a requirements document
curl -s -H "Authorization: Bearer $TOKEN" -X POST "$BASE/intake/expand" \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"add an audit log to the admin panel"}'

# 2. Read what it produced
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/intake/requests/<id>"

# 3. Edit it — this is the point of the step
curl -s -H "Authorization: Bearer $TOKEN" -X PUT "$BASE/intake/requests/<id>" \
  -H 'Content-Type: application/json' \
  -d '{"requirements":"...your edited markdown..."}'

# 4. Approve, then send to the orchestrator
curl -s -H "Authorization: Bearer $TOKEN" -X POST "$BASE/intake/requests/<id>/approve"
curl -s -H "Authorization: Bearer $TOKEN" -X POST "$BASE/intake/requests/<id>/send"
```

Requests move through `draft → expanding → review → approved → sent`. Intake detects whether you are
enhancing a registered project or starting a new one, matches a template (CRUD, dashboard, monitoring,
data pipeline, API service), and for new projects assigns a path and free ports.

Intake writes requirements and nothing else. It does not read your code, run commands or implement
anything — so do not expect its document to be grounded in the codebase. That is the orchestrator's
job, and it is why step 3 exists.

---

## Delegation strategies

The orchestrator picks one of five. You mostly do not choose this directly, but knowing them explains
what you see in the logs.

| Strategy | Shape | Use |
|----------|-------|-----|
| `delegate_to_worker` | one task, one worker | Single tasks, docs, investigations, static sites |
| `delegate_pipeline` | up to 4 tasks → compile gate → scan → fix (max 2 rounds) | **Default for compiled apps.** Not for docs or static HTML |
| `delegate_parallel` | N independent tasks at once | Non-compiled work with no shared files |
| `delegate_chain` | sequential, each depending on the last | Migrations, staged refactors |
| `delegate_swarm` | specialised team: implement + test + review | High-stakes changes |

Four concurrent workers is normal. Parallel workers can be isolated in Git worktrees so they cannot
collide on the same files.

One caveat worth knowing: fan-out on genuinely single-file work tends to thrash — several workers
circling one file, each undoing the last. For a change that lives in one file, prefer a single
`delegate`.

---

## Watching what happens

```bash
# Task queue
cobra task list --status active
cobra task status <id>

# Service logs
journalctl -u cobra-commander -f

# Live worker state
TOKEN=$(cat ~/.cobra-commander/api-token)
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:4100/api/v1/workers
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:4100/api/v1/tasks/counts
```

Per-worker event logs are JSONL under `.worker-store/`. Each worker's turns, tool calls, retries and
doom-loop strikes are there, which is where to look when a task failed and the summary does not explain
why.

The web shell's Workers panel is the same data with a refresh button.

---

## When a worker goes wrong

The harness reports failures with sentinels. They mean specific things:

| Sentinel | Meaning | What to do |
|----------|---------|------------|
| `FAILURE:` | Claimed completion but mutated no files, or an empty completion | Usually the task was ambiguous or the files were not where it looked. Re-scope it |
| `UNVERIFIED:` | Finished without producing a verification receipt | It did not run the checks. Name the verification command in the task |
| `BUDGET_EXCEEDED:` | Hit the token or time budget | Task too big. Split it |
| `INCOMPLETE:` | The orchestrator tried to declare done with directive items unaddressed | Check which numbered item was skipped |
| `[PARTIAL PROGRESS]` | Some work landed before the stop | Read the diff; the partial work may be worth keeping |

Other guards you will see fire:

- **Doom-loop detection** — a worker repeating the same failing action is aborted after two strikes.
- **Repeat-failure breaker** — the same tool failing the same way stops being retried.
- **Per-tool timeout** — a single tool call is capped (120s by default).
- **Compile gate** — if workers report success but the project no longer compiles, the round is not
  accepted.

To stop something that is running:

```bash
curl -H "Authorization: Bearer $TOKEN" -X POST \
  http://127.0.0.1:4100/api/v1/tasks/<id>/cancel
```

After a daemon restart, tasks that were making progress are **requeued and resumed** (up to three
times); tasks that were thrashing with nothing committed are failed loudly. So a task showing `active`
just after a restart may legitimately be resuming — check whether it had produced changes before
assuming it is dead.

### Undo

In order of preference: `git diff` then `git checkout .`; the per-worker Git stash snapshot; the
per-operation undo log in `.worker-store/`. All three are why a clean tree before delegating matters.

---

## The support agent

A separate agent for diagnosis and repair — the thing you talk to when the build system itself is
broken, rather than when you want a feature. It runs on its own daemon so that a crash in it cannot
take the main daemon down, and vice versa.

```bash
./destro-test.sh                      # mock run, no network or keys, ~5s
./destro-test.sh real                 # real read-only session against this repo
./destro-test.sh real ~/code/my-api "the API returns 502 after deploy"
./destro-test.sh api                  # health check through every layer
```

It has three hard rules, enforced in code rather than left to judgment:

1. **Back up before mutating.** Every incident gets `./archive/<incident>/` inside the target project
   before anything is written. This has already prevented one file truncation.
2. **Respect the approval mode.** Interactive (you approve each action) or Auto ("just get it done").
3. **Redact secrets** from everything it reports.

`destro-cli.ts` is **diagnose-only** unless you pass `--allow-mutations`, and asking for a read-only
session is treated as a hard constraint the agent will not talk itself out of. Sessions always end
with a verdict — it is not allowed to run out of budget without concluding.

Proactive monitoring (`src/destro/fleet-watch.json`) is **empty by default and opt-in**. The agent will
not go looking at services you did not point it at.

---

## The REST API

Base `http://127.0.0.1:4100`, bearer token from `~/.cobra-commander/api-token`. Both `/api/v1/...`
(preferred) and legacy `/api/...` paths work.

```bash
TOKEN=$(cat ~/.cobra-commander/api-token)
BASE=http://127.0.0.1:4100/api/v1
AUTH="Authorization: Bearer $TOKEN"
```

| Area | Endpoints |
|------|-----------|
| Health | `GET /health`, `GET /version`, `GET /monitoring`, `GET /circuit-breaker` |
| Files | `GET /files/tree`, `GET /files?path=`, `PUT /files`, `POST /files/upload` |
| Search | `POST /search` |
| Terminal | `POST /terminal/exec` |
| Tasks | `GET /tasks`, `GET /tasks/counts`, `GET /tasks/:id`, `POST /tasks/:id/cancel` |
| Workers | `GET /workers` |
| Git | `GET /git/status|log|diff`, `GET|POST /git/checkpoints` |
| Intake | `POST /intake/expand`, `GET|PUT /intake/requests/:id`, `POST .../approve|reject|send` |
| Security | `POST /security/scan`, `GET /security/findings|dashboard|reviews` |
| Models | `GET /models`, `PUT /models/active` |
| Config | `GET|PUT /config`, `GET /config/profiles` |
| Completions | `POST /completions` |
| Workspace | `GET /workspace`, `POST /workspace/start`, approve/reject/stop/plan/execute |
| Notepads | full CRUD under `/notepads` |
| Templates | `GET /templates`, `POST /templates/render|validate` |
| Support agent | `/destro/*` (proxied to the support daemon) |

Note that tasks are **read-only plus cancel** over HTTP — new work enters through
`POST /intake/expand` and the approve/send chain, or through `cobra task dispatch`.

```bash
# Read a file
curl -s -H "$AUTH" "$BASE/files?path=src/core/config.ts"

# Search
curl -s -H "$AUTH" -X POST "$BASE/search" \
  -H 'Content-Type: application/json' -d '{"query":"hydrateWorkerKey"}'

# Run a command
curl -s -H "$AUTH" -X POST "$BASE/terminal/exec" \
  -H 'Content-Type: application/json' -d '{"command":"npx tsc --noEmit"}'
```

`POST /terminal/exec` runs commands as the daemon's user. That is the whole point, and the reason the
API binds to loopback and requires a token.

---

## The web shell

Opt-in browser UI (see [INSTALL.md](INSTALL.md#the-web-shell-optional)). Sidebar: Chat, Editor,
Terminal, Search, Security, Projects, Workers, Intake, Support agent; tabbed main area with a terminal
drawer. Mobile-first, installable as a PWA.

Two chat channels: `main` is persisted history; `preview` is ephemeral context for file editing. The
chat pane hides tool noise and shows only conclusions; the terminal pane shows full tool activity.

The WebSocket protocol, if you want to drive it yourself:

```
→ { type: "prompt", text: "...", channel: "main"|"preview", chatId?: "..." }
← { type: "connected", sessionId: "..." }
← { type: "text", content: "...", channel: "main" }
← { type: "tool_activity", action: "call"|"result", tool: "...", args: "..." }
← { type: "done", channel: "main" }
→ { type: "cancel", channel: "main" }
→ { type: "set_workdir", path: "/path/to/project" }
→ { type: "clear", channel: "main" }
```

---

## Configuration reference

Two layers. Secrets and deployment settings go in `.env` (install root); behaviour goes in
`~/.cobra-commander/config.json`.

```json
{
  "maxWorkerTurns": 300,
  "maxOrchestratorTurns": 5,
  "maxRetries": 3,
  "commandTimeout": 30,
  "autoScan": false,
  "autoCommitEnabled": false,
  "autoFeatureBranch": false,
  "crossModelVerify": false,
  "costAwareRouting": false,
  "autoRetry": true,
  "autoCompact": true,
  "autoCompactKeepLast": 3,
  "verification": {
    "commands": ["npx tsc --noEmit"],
    "timeout": 60,
    "failOnWarnings": false
  },
  "workerPool": [
    { "name": "cheap",  "tier": "fast",     "provider": { "model": "gpt-5.1-mini" } },
    { "name": "strong", "tier": "heavy",    "provider": { "model": "gpt-5.1" } }
  ]
}
```

API keys are never read from or written to this file — they come from the environment or `.env` only.

`cobra config show` prints what is actually in effect, which is the fastest way to settle an argument
about whether a setting took.

Named profiles let you flip several flags at once. List them with
`curl -H "$AUTH" $BASE/config/profiles`; the definitions live in `src/core/config-profiles.ts`.

---

## Cost control

- **Split the models.** `ORCHESTRATOR_MODEL` strong, `WORKER_MODEL` cheap. This is the main lever.
- **Use tiers.** `-m fast` for mechanical work; save `heavy` for design.
- **Set budgets.** `WORKER_TOKEN_BUDGET` and `WORKER_TIME_BUDGET_MS` cap a runaway worker. A loop you
  do not notice is the expensive failure mode.
- **Keep `autoCompact` on.** Long sessions otherwise resend a growing transcript every turn.
- **Scope tasks tightly.** A task that names three files costs a fraction of one that says "fix the
  app".
- **Rotate keys, don't retry blindly.** A comma-separated `WORKER_API_KEY` round-robins and cools down
  rate-limited keys.

---

## Good habits

1. **Clean tree before delegating.** Non-negotiable. It is your undo.
2. **Read the diff.** Every time. The harness checks that work happened, not that it was wise.
3. **Verification commands in the task.** "Done when X passes" is the difference between a worker that
   checks and one that hopes.
4. **One concern per task.**
5. **Branch for anything substantial.** `autoFeatureBranch` can do it for you.
6. **Trust the sentinels.** A loud failure is the system working. The dangerous outcome is a confident
   success claim, which is exactly what the harness exists to catch.
7. **Never point it at code you cannot afford to lose.** It is a developer tool with shell access, not
   a sandbox.
