# Deep Vigilance Integration Guide

Cobra Commander can hand finished work to [**Deep Vigilance**](https://github.com/mshermancyber/deep-vigilance)
— a self-hosted application-security platform — and feed the findings back into the build loop, so a
worker fixes its own vulnerabilities before the task is accepted.

The integration is **optional and off by default**. With nothing configured, every scanning entry point
returns `null` and the feature stays inert.

- [What the integration does](#what-the-integration-does)
- [Prerequisites](#prerequisites)
- [Configuration](#configuration)
- [Path mapping](#path-mapping-the-one-that-bites)
- [Verifying the connection](#verifying-the-connection)
- [Scan types](#scan-types)
- [The findings feedback loop](#the-findings-feedback-loop)
- [Using it from the API](#using-it-from-the-api)
- [Using it from the orchestrator](#using-it-from-the-orchestrator)
- [Security notes](#security-notes)
- [Troubleshooting](#troubleshooting)
- [Using a different platform](#using-a-different-platform)

---

## What the integration does

```
Worker finishes a task
        │
        ▼
  tsc / tests pass ──▶ launch scans (SAST · SCA · code review)
        │                        │
        │                   poll until complete
        │                        │
        │                   fetch findings
        │                        │
        │              filter to true positives
        │                        │
        ▼                        ▼
  task accepted  ◀────  no critical/high  ──┐
                                            │
                       critical/high found ─┘
                                 │
                                 ▼
                    findings formatted into a
                    remediation task for a worker
                    (bounded: 2 fix rounds)
```

The same machinery is available three ways: automatically after every orchestrator delegation, on
demand through the REST API, and as a built-in stage of the orchestrator's `delegate_pipeline`
strategy.

---

## Prerequisites

1. **A running Deep Vigilance instance** reachable from the Cobra Commander host. Follow the install
   instructions in the [deep-vigilance repository](https://github.com/mshermancyber/deep-vigilance).
2. **An account on it** with permission to create projects and launch scans.
3. **A project** in Deep Vigilance. You can either create one and copy its UUID, or let Cobra Commander
   find-or-create one by name on first scan.
4. **Shared access to the code.** The scanner must be able to read the directory being scanned — a bind
   mount if it runs in a container, or a path both can reach.

---

## Configuration

Two interchangeable ways. Environment variables are simplest; the file is useful when different projects
scan into different Deep Vigilance projects.

### Option A — environment variables

In `.env`:

```bash
# Where Deep Vigilance lives
SCANNER_API_BASE=https://vigilance.internal.example.com

# Credentials for a Deep Vigilance account
SCANNER_EMAIL=ci@example.com
SCANNER_PASSWORD=your-password

# Optional: target a known project instead of find-or-create by name
SCANNER_PROJECT_ID=00000000-0000-0000-0000-000000000000

# Optional: path mapping — see below
SCANNER_HOST_PATH=/srv/projects
SCANNER_CONTAINER_PATH=/scan
```

### Option B — per-project file

Create `.cobra-commander/scanner.json` in the project being built:

```json
{
  "baseUrl": "https://vigilance.internal.example.com",
  "projectId": "00000000-0000-0000-0000-000000000000",
  "projectName": "my-service",
  "email": "ci@example.com",
  "password": "your-password",
  "hostPath": "/srv/projects",
  "containerPath": "/scan"
}
```

Resolution order: the project's own `scanner.json`, then the install root's `scanner.json` (so a shared
credential covers every project you build), then environment variables.

Keep this file out of version control — add `.cobra-commander/scanner.json` to the project's
`.gitignore`, or leave credentials in `.env` and put only `baseUrl` and `projectId` in the file.

### Option C — a container whose address moves

If Deep Vigilance runs in a local container with no stable IP, name the container instead of pinning an
address and the live address is resolved at call time (cached for a minute):

```bash
SCANNER_CONTAINER=deep-vigilance-backend
SCANNER_PORT=3000
```

An explicitly configured `SCANNER_API_BASE` always wins over container discovery.

---

## Path mapping (the one that bites)

If Deep Vigilance runs in a container, it sees your code at a **different path** than the host does. Send
the host path and every scan fails with *"scan path not found"* — and because scans are launched
asynchronously, it fails quietly.

Say the host keeps projects in `/srv/projects` and the scanner mounts that as `/scan`:

```yaml
# deep-vigilance compose
volumes:
  - /srv/projects:/scan:ro
```

Then configure:

```bash
SCANNER_HOST_PATH=/srv/projects
SCANNER_CONTAINER_PATH=/scan
```

Cobra Commander rewrites paths on the way out, so `/srv/projects/my-service/src` is submitted as
`/scan/my-service/src`. The mapping is configuration, never inferred — if you leave it unset, paths are
passed through unchanged, which is correct when the scanner shares the host filesystem.

Confirm the mapping before trusting a clean scan result:

```bash
docker exec deep-vigilance-backend ls /scan/my-service
```

An empty or missing directory means the mount, not the code, is the problem.

---

## Verifying the connection

```bash
# 1. Is it reachable and does it accept the credential?
curl -i -X POST "$SCANNER_API_BASE/api/auth/login" \
  -H 'Content-Type: application/json' \
  -d '{"email":"ci@example.com","password":"your-password"}'
```

Look for a `Set-Cookie: access_token=...` header in the response. The token comes back **in a cookie
header, not in the JSON body**.

> **Cookie gotcha.** Deep Vigilance marks the session cookie `Secure`. Over plain HTTP, `curl -c`
> silently drops it and your next call is unauthenticated — which looks like a permissions problem
> rather than a cookie problem. Several cookies can also arrive merged into one header value.
> Cobra Commander handles this in `src/core/scanner-auth.ts` by reading the individual cookie strings
> with `headers.getSetCookie()` and sending the token as both `Authorization: Bearer` and `Cookie`.
> Always go through `scannerLogin()` / `scannerHeaders()` rather than rolling your own auth.

Then confirm Cobra Commander agrees:

```bash
TOKEN=$(cat ~/.cobra-commander/api-token)
curl -H "Authorization: Bearer $TOKEN" \
  "http://127.0.0.1:4100/api/v1/security/findings"
```

A `503 Security scanner not configured` means Cobra Commander did not find your configuration — check
that `.env` is in the install root and that the daemon was restarted after you edited it.

---

## Scan types

| Type | Endpoint used | What it covers | Needs a path |
|------|---------------|----------------|--------------|
| `sast` | `POST /api/scans/launch` | Static analysis of source | yes |
| `sca` | `POST /api/scans/launch` | Dependency / supply-chain | no |
| `code-review` | `POST /api/code-review/reviews/launch` | Security-focused review of a folder | yes |
| `full` | all of the above | Launched concurrently | yes |

Scan status is polled at `GET /api/scans/:id` and findings are read from
`GET /api/scans/:id/findings`; code-review findings come from
`GET /api/code-review/findings?reviewId=:id`.

Deep Vigilance also offers DAST, container and fuzz scanning. Those are reachable through the same
authenticated client — see `src/core/security-scanner.ts` for the pattern to add one.

---

## The findings feedback loop

Findings are not fed back raw. Two things happen first:

1. **Filtering** (`filterTruePositives`) drops anything Deep Vigilance has marked `false_positive` or
   `closed`, and drops `info` severity. What remains is open findings at **medium and above** — those
   are what trigger a fix round.
2. **Formatting for a worker** (`formatFindingsForWorker`) renders each finding as title, severity,
   CWE, file and line, description and code snippet. A worker handed a raw JSON dump tends to reformat
   the dump instead of fixing the bug.

Fix rounds are capped at **two** (`MAX_FIX_ROUNDS`). A finding that survives both is surfaced in the
task report rather than looped on forever.

### When scans run

| Path | Trigger | Notes |
|------|---------|-------|
| Orchestrator pipeline | Automatic in `delegate_pipeline`, after the compile gate | Runs whenever a scanner config resolves; skipped with a note if not |
| Post-delegation auto-scan | `config.autoScan` | Forced on for orchestrator-launched builds; opt out with `CC_AUTO_SCAN=0` |
| Manual | REST API or the web shell's security panel | On demand, any scan type |

To enable the post-delegation scan for your own orchestrator runs, set it in
`~/.cobra-commander/config.json`:

```json
{
  "autoScan": true,
  "verification": {
    "commands": ["npx tsc --noEmit", "npm test"],
    "timeout": 120
  }
}
```

---

## Using it from the API

```bash
TOKEN=$(cat ~/.cobra-commander/api-token)
BASE=http://127.0.0.1:4100

# Launch a scan
curl -H "Authorization: Bearer $TOKEN" -X POST "$BASE/api/v1/security/scan" \
  -H 'Content-Type: application/json' \
  -d '{"type":"sast","targetPath":"/srv/projects/my-service/src"}'

# Fetch findings
curl -H "Authorization: Bearer $TOKEN" "$BASE/api/v1/security/findings"
```

`type` accepts `sast`, `sca`, `code-review` or `full`; `targetPath` is a host path and is translated
for you. Omit it and the project's `src/` directory is used.

> **Payload gotcha.** For scan launches the target path belongs in `options.targetPath`, not at the top
> level of the request. A misplaced path is not rejected — the scan runs against the scanner's default
> root instead, which on a shared mount can mean scanning *every* project and returning a confusing
> pile of unrelated findings. The API route and `security-scanner.ts` already place it correctly; keep
> that shape if you add scan types.

---

## Using it from the orchestrator

`delegate_pipeline` — the default strategy for compiled web applications — has scanning built into its
sequence:

```
up to 4 implementation tasks → compile (tsc) → scan (SAST + SCA) → fix findings (max 2 rounds)
```

Nothing extra to call: if the scanner is configured, the pipeline uses it; if it is not, the pipeline
skips the scan stage and says so in the report.

When writing task descriptions by hand, note that models given filesystem access will happily burn turns
trying to authenticate to the scanner with `curl` and getting defeated by the `Secure` cookie. Unless
scanning *is* the task, add a line to the task description:

```
Do NOT run security scans. The harness runs them after you finish.
```

---

## Security notes

- The scanner credential grants scan and project creation rights on your Deep Vigilance instance. Give
  Cobra Commander a dedicated service account, not an admin one.
- Prefer `SCANNER_HOST_PATH` mounted **read-only** into the scanner.
- Scan launches are exempt from the SSRF private-address guard, because a self-hosted scanner
  legitimately lives on a private address. That exemption applies **only** to the configured scanner
  host — untrusted scan targets are still blocked, as are cloud metadata endpoints.
- Findings can quote vulnerable source. They flow into model prompts during fix rounds, so treat the
  gateway you send them to as in-scope for your data policy.
- Secrets-scanning findings in particular may contain real credentials. The support agent redacts
  secrets in its output; your own scripts should too.

---

## Troubleshooting

**`503 Security scanner not configured`**
Configuration was not found. `.env` must be in the install root; restart the daemon after editing it.
With `scanner.json`, both `baseUrl` and `projectId` are required.

**Login returns 200 but every later call is 401**
The `Secure` cookie was dropped. Use `scannerLogin()`/`scannerHeaders()`, or run Deep Vigilance behind
TLS.

**`Scan path not found`**
Path mapping. Set `SCANNER_HOST_PATH` / `SCANNER_CONTAINER_PATH` and verify the mount from inside the
container with `docker exec … ls <container path>`.

**The scan returns findings from projects you did not scan**
The target path did not reach the scanner, so it scanned its whole root. Check that the path is in
`options.targetPath` and that it exists inside the container.

**Scans launch but never complete**
Check the Deep Vigilance worker logs. Cobra Commander polls with a timeout and reports the scan as
incomplete rather than hanging the task.

**`Failed to find or create project`**
The account lacks project-creation rights. Create the project by hand and pin it with
`SCANNER_PROJECT_ID`.

**Container discovery fails**
`SCANNER_CONTAINER` requires a reachable Docker socket from the Cobra Commander process. Under systemd
with `ProtectSystem=full` the socket may not be visible — pin `SCANNER_API_BASE` instead.

---

## Using a different platform

The integration is deliberately not Deep Vigilance specific. `src/core/scanner-auth.ts` holds auth and
path translation; `src/core/security-scanner.ts` holds scan launching, polling and findings retrieval.
A platform that offers cookie or bearer authentication, a scan-launch endpoint and a findings endpoint
can be supported by reimplementing those two modules' calls — the orchestrator-side contract
(`loadScanConfig`, `runSecurityScan`, `filterTruePositives`, `formatFindingsForWorker`) stays the same.
