# Security Policy

## Reporting a vulnerability

Report security issues through
[GitHub Security Advisories](https://github.com/mshermancyber/cobra-commander-ide/security/advisories/new)
on this repository. Please do not open a public issue for a vulnerability.

Include what you did, what happened, and the version or commit. A proof of concept helps. You can
expect an acknowledgement within a few days; this is a small project, not a vendor with an on-call
rotation.

## Supported versions

| Version | Supported |
|---------|-----------|
| 0.1.x   | yes |

## Threat model — read this first

Cobra Commander **executes model-authored shell commands and file edits on your machine, as the user
that runs it.** That is its purpose, not a flaw. It is a developer tool for code you own and can afford
to lose. It is not a sandbox, and it does not try to be one.

Specifically:

- `POST /api/v1/terminal/exec` runs arbitrary commands as the daemon's user.
- Workers read and write files anywhere path permissions allow.
- The web shell offers an interactive terminal and a file editor in the browser.

Anyone who can reach the API with a valid token, or log into the web shell, can run code on the host.
Treat both as equivalent to shell access.

## What the defaults protect

- **Loopback binding.** The API, web shell and support daemon all bind to `127.0.0.1` unless
  `CC_BIND_HOST` is changed.
- **Token-gated API.** Every `/api/` route requires a bearer token, generated on first run and stored
  at `~/.cobra-commander/api-token`.
- **Web shell off by default**, and it refuses to start in token mode without a configured credential
  rather than listening unauthenticated.
- **Credential hashing.** Web shell passwords are stored as scrypt hashes; comparison is
  constant-time.
- **Path permissions.** Glob-based allow/deny policies constrain where workers may write.
- **Process-tree tracking.** Spawned children are registered and killed as a tree, so nothing is
  orphaned.
- **SSRF guards** on outbound scan requests, including blocked cloud metadata endpoints. The only
  private-address exemption is the scanner host you configured.
- **Secret redaction** in support-agent output.
- **Hardened systemd unit** — `NoNewPrivileges`, `PrivateTmp`, `ProtectSystem=full`,
  `ProtectHome=read-only`, with the install directory as the only writable path.

## Your responsibilities

1. **Keep it on loopback.** If it must be reachable remotely, put it on a private overlay network or
   behind an authenticating TLS reverse proxy. Do not set `REMOTE_BIND=0.0.0.0` and hope.
2. **Protect `.env`.** `chmod 600`. It is git-ignored; keep it that way. Prefer injecting
   `OPENAI_API_KEY` from your own secrets tooling.
3. **Understand the key vault's limits.** Sealing a key with `src/core/key-vault.ts` is encryption at
   rest against casual disclosure. Without `CC_VAULT_PASSPHRASE` the sealing material is derived from
   the host name and user account, which an attacker with host access already has. It is not a secret
   manager.
4. **Run as a dedicated, unprivileged account.** Never as root. Give it the narrowest filesystem access
   that still lets it do its job.
5. **Use Git.** A clean tree before delegating is your rollback, and your audit trail.
6. **Mind what leaves the machine.** Source code, file paths, error output and security findings are
   sent to whichever model gateway you configure. Findings from a secrets scan may contain live
   credentials. Choose the gateway accordingly.
7. **Review the diff.** The harness verifies that work happened and that the project still compiles. It
   does not verify intent.

## Out of scope

- Sandboxing the model's shell access, or constraining what a task may do beyond path permissions.
- Protecting against a malicious model gateway, or prompt injection carried in files the agent is
  pointed at. Treat untrusted code as untrusted input.
- Exposing any component to the public internet. That is unsupported.
