# Cobra Commander

**A self-hosted, multi-model AI coding platform.** One model plans and delegates; cheaper worker models
do the implementation. Everything runs on your own machine, against your own API key, with the
orchestration, verification and safety machinery visible in the repository rather than hidden behind a
service.

```
                  ▄▄▄   COBRA COMMANDER   ▄▄▄
                 ▀█▀▀▀▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▀▀▀█▀
                 One orchestrator · many workers
```

[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](LICENSE)
![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen)
![TypeScript](https://img.shields.io/badge/TypeScript-5.8-blue)

---

## Why

Most coding agents are a single model in a loop. That is expensive at the top end and unreliable at the
bottom: a strong model spends its context on mechanical edits, and a cheap model loses the plot on
anything multi-step.

Cobra Commander splits the job. An **orchestrator** reads the codebase, writes a plan and delegates
discrete pieces of work. **Workers** — which can be a much cheaper model — carry out one scoped task
each. A **harness**, not the model's self-report, decides whether the work actually landed: mutation
tracking, verification receipts, type-check gates, doom-loop detection and token/time budgets. A
separate **support agent** diagnoses and repairs the system when something breaks.

Every model call goes to an OpenAI-compatible endpoint you configure. Point it at the OpenAI API, a
corporate gateway, a router, or a local runtime such as Ollama or vLLM.

---

## How it works

```
   You ──▶ Intake ──▶ review ──▶ Orchestrator ──▶ Workers ──▶ verify ──▶ report
            │                         │               │           │
      expands a one-line        plans, splits,    one scoped   tsc / tests /
      ask into a spec           dispatches        task each    optional scan

   Something broken?  ──▶  Support agent (diagnose → backup → repair → verdict)
```

1. **Intake** turns a short request into a structured requirements document you can edit and approve.
2. The **orchestrator** receives approved requirements, explores the code and breaks the work down.
3. **Workers** implement, each with file, shell, search and patch tools, inside path permissions.
4. The **harness** verifies: did files actually change, does it type-check, did the worker produce a
   verification receipt? A worker that claims success without evidence is failed loud.
5. **Optional security scanning** hands the result to an external AppSec platform and feeds findings
   back for remediation. See [docs/DEEP-VIGILANCE-INTEGRATION.md](docs/DEEP-VIGILANCE-INTEGRATION.md).

---

## Quick start

```bash
git clone https://github.com/mshermancyber/cobra-commander-ide.git
cd cobra-commander-ide
npm install

cp .env.example .env
chmod 600 .env
# edit .env and set OPENAI_API_KEY

npx tsx src/cli.ts delegate "add a health check endpoint" --work-dir /path/to/project
```

Full instructions, including the daemon, the API and the web shell, are in
[INSTALL.md](INSTALL.md). Day-to-day usage is in [USER-GUIDE.md](USER-GUIDE.md).

---

## Interfaces

| Interface | What it is | Entry point |
|-----------|------------|-------------|
| **CLI** | Delegate tasks, manage projects and the task queue, run the daemon | `npx tsx src/cli.ts` |
| **Daemon** | Long-running service: API server, task runner, support agent | `npm run daemon` |
| **REST + WebSocket API** | Files, search, terminal, tasks, git, completions, scans | `http://127.0.0.1:4100` |
| **Web shell** | Browser UI — chat, editor, terminal, tasks, security, support agent | opt-in, see INSTALL.md |

---

## What's in the box

**Orchestration** — plan/delegate loop, five delegation strategies (single, pipeline, parallel, chain,
swarm), run coordination that prevents duplicate dispatch, git-worktree isolation for parallel workers,
done-criteria gating so a plan cannot be declared complete with unaddressed items.

**Worker reliability** — a nine-strategy fuzzy edit chain (exact → trimmed → whitespace → indent →
anchor → escape → Levenshtein → context → multi), line-ending and BOM preservation, formatter
auto-detection, per-operation undo, git-stash snapshots and rollback, cross-process file locking.

**Safety rails** — doom-loop detection with a two-strike abort, context compaction and overflow
detection, per-tool timeouts, repeat-failure breakers, token and time budgets, path permission policies,
process-tree tracking so nothing is orphaned.

**Observability** — a typed event bus with a ring buffer, per-worker JSONL state persistence, an
in-memory projector for instant state queries, and mid-task steering of running workers.

**Support agent** — an independent diagnosis-and-repair agent on its own daemon, with three hard rules
(back up before mutating, respect the operator's approval mode, redact secrets), negative memory of
failed attempts, learned remediations and playbooks. It cannot take the main daemon down with it.

**Optional integrations** — external AppSec scanning (SAST/DAST/SCA/container), webhook triggers,
air-gapped deployment bundles.

The exhaustive list is [FEATURES.md](FEATURES.md).

---

## Configuration

Everything comes from `.env` in the install directory, overridden by real environment variables.
Nothing about a host is baked into the repository: ports, bind addresses, paths and credentials are all
configuration. See [.env.example](.env.example) for the annotated set.

```bash
OPENAI_API_KEY=sk-...
OPENAI_BASE_URL=https://api.openai.com/v1   # any OpenAI-compatible gateway
OPENAI_MODEL=gpt-5.1
```

If you would rather not keep a key in plain text, seal it:

```bash
npx tsx src/core/key-vault.ts sk-...     # writes an encrypted CC_WORKER_KEY to .env
```

---

## Security

Cobra Commander runs model-authored shell commands and file edits on your machine. It is a developer
tool for code you own, not a sandbox.

- Every listener binds to `127.0.0.1` by default.
- The API server is token-gated; the token lives in `~/.cobra-commander/api-token`.
- The web shell is **off** by default and refuses to start without a configured credential.
- Workers are constrained by glob-based path permissions.

Read [SECURITY.md](SECURITY.md) before exposing any of it beyond loopback.

---

## Documentation

| Document | Contents |
|----------|----------|
| [INSTALL.md](INSTALL.md) | Requirements, install, service setup, web shell, upgrades, troubleshooting |
| [USER-GUIDE.md](USER-GUIDE.md) | Daily workflows, CLI reference, delegation strategies, the support agent |
| [docs/DEEP-VIGILANCE-INTEGRATION.md](docs/DEEP-VIGILANCE-INTEGRATION.md) | Wiring Deep Vigilance for SAST/DAST/SCA and findings feedback |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Module layout and data flow |
| [docs/API-GUIDE.md](docs/API-GUIDE.md) | REST and WebSocket API |
| [docs/ORCHESTRATOR.md](docs/ORCHESTRATOR.md) | Context management and delegation internals |
| [DESTRO-AGENT-SPEC.md](DESTRO-AGENT-SPEC.md) | Support agent design contract |
| [FEATURES.md](FEATURES.md) | Full feature manifest |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Development workflow and coding standards |
| [CHANGELOG.md](CHANGELOG.md) | Release history |

---

## Status

**v0.1.0 — first public release.** The platform has been running as a daily-driver build system, but
this is its first release as a standalone, self-contained repository. Expect sharp edges in the parts
that depend on your environment: the web shell, systemd packaging and the optional scanner integration.
Bug reports with logs are welcome.

---

## License

Copyright © 2026 Mark Sherman.

Cobra Commander is free software: you can redistribute it and/or modify it under the terms of the
**GNU General Public License v3.0 or later** as published by the Free Software Foundation. It is
distributed in the hope that it will be useful, but **without any warranty**; without even the implied
warranty of merchantability or fitness for a particular purpose. See [LICENSE](LICENSE) for the full
text.
