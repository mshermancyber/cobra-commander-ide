# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — 2026-10-11

First public release.

Cobra Commander has been running as a working build system; this is its first release as a
self-contained, portable repository. Everything host-specific has been replaced with configuration.

### Added

- **Orchestrator / worker architecture** — an orchestrator model plans and delegates; worker models
  implement. Five delegation strategies: single, pipeline, parallel, chain and swarm.
- **Harness-decided outcomes** — mutation tracking, verification receipts, empty-completion rejection,
  compile gating and done-criteria auditing, so success is measured rather than self-reported.
- **Worker safety rails** — doom-loop detection with a two-strike abort, repeat-failure breakers,
  per-tool timeouts, token and time budgets, context compaction and overflow detection.
- **Edit reliability** — a nine-strategy fuzzy edit chain, line-ending and BOM preservation, formatter
  auto-detection, per-operation undo and git-stash snapshots.
- **Observability** — a typed event bus with a ring buffer, per-worker JSONL persistence, an in-memory
  state projector and mid-task worker steering.
- **Resume-aware startup reconciliation** — orphaned tasks that were progressing are requeued and
  resumed (capped at three); tasks that were thrashing are failed loudly instead of revived.
- **Intake pipeline** — expands a short request into a reviewable requirements document, with
  templates, project detection and port assignment.
- **Support agent** — an independent diagnosis-and-repair agent on its own daemon, with mandatory
  pre-mutation backups, operator approval modes, secret redaction, negative memory, learned
  remediations and playbooks. Read-only sessions are enforced in code.
- **REST + WebSocket API** — files, search, terminal, tasks, workers, git, intake, security, models,
  config, completions, workspace, notepads and templates. Token-gated, loopback-bound.
- **Web shell** — opt-in browser UI with chat, editor, terminal, search, security, projects, workers,
  intake and support-agent panes. Mobile-first PWA.
- **CLI** — task delegation, project registry, task queue, daemon and standalone servers.
- **Pluggable web-shell auth** — a portable scrypt-hashed token provider (new default), plus PAM and
  interactive CLI providers.
- **Optional security scanning** — integration with a self-hosted AppSec platform for SAST, SCA and
  code review, with true-positive filtering and bounded fix rounds. See
  [docs/DEEP-VIGILANCE-INTEGRATION.md](docs/DEEP-VIGILANCE-INTEGRATION.md).
- **Local key vault** — optional AES-256-GCM sealing of the API key at rest in `.env`.
- **Documentation** — install guide, user guide, Deep Vigilance integration guide, architecture, API
  guide, orchestrator internals, support-agent spec and a full feature manifest.
- **GPL-3.0-or-later licensing.**

### Configuration

- Model access is configured entirely through `.env`: `OPENAI_API_KEY`, `OPENAI_BASE_URL` and
  `OPENAI_MODEL`, with per-role overrides. Any OpenAI-compatible gateway works — the hosted API, a
  corporate proxy, a router, or a local runtime.
- Endpoint construction normalises gateway URLs, so a base URL with or without a `/v1` suffix behaves
  the same.
- Install paths resolve from the package location (`CC_HOME` to override). No absolute paths are baked
  into the source.
- Default ports are 4100 (API), 4101 (web shell) and 4102 (support agent), all overridable, all bound
  to loopback unless `CC_BIND_HOST` says otherwise.

### Security

- Every listener binds to `127.0.0.1` by default.
- The web shell is disabled by default and **refuses to start** without a configured credential.
- Tailscale peer authentication now fails closed for non-peer addresses.
- The systemd unit template ships with `NoNewPrivileges`, `PrivateTmp`, `ProtectSystem=full` and
  `ProtectHome=read-only`.
- The SSRF guard on scan launches exempts only the configured scanner host; cloud metadata endpoints
  stay blocked.

### Known limitations

- The web shell, systemd packaging and the scanner integration are the parts most dependent on your
  environment, and the least exercised outside the author's.
- PAM authentication is Linux-only and needs `pamtester` or `su`.
- Fan-out delegation thrashes on work that genuinely lives in a single file; use a single delegation
  there.
- `node-pty` needs a C/C++ toolchain; without it the terminal features are unavailable.

[0.1.0]: https://github.com/mshermancyber/cobra-commander-ide/releases/tag/v0.1.0
