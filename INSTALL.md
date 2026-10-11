# Installation Guide

Cobra Commander is a Node.js application you run on your own machine. There is no hosted component and
no telemetry on by default. This guide covers a working install, the optional long-running service, and
the optional browser UI.

- [Requirements](#requirements)
- [1. Get the code](#1-get-the-code)
- [2. Install dependencies](#2-install-dependencies)
- [3. Configure](#3-configure)
- [4. Verify](#4-verify)
- [5. First task](#5-first-task)
- [Running as a service](#running-as-a-service)
- [The web shell](#the-web-shell-optional)
- [Optional: security scanning](#optional-security-scanning)
- [Upgrading](#upgrading)
- [Uninstalling](#uninstalling)
- [Troubleshooting](#troubleshooting)

---

## Requirements

| | Requirement | Notes |
|---|---|---|
| **Node.js** | 22.0 or newer | Uses modern ESM, `node:` built-ins and `getSetCookie()` |
| **npm** | 10 or newer | Ships with Node 22 |
| **Git** | any recent version | Used for diffs, snapshots, worktree isolation and rollback |
| **OS** | Linux, macOS, WSL2 | The PAM auth mode and systemd packaging are Linux-only; everything else is portable |
| **Build tools** | a C/C++ toolchain | `node-pty` compiles a native addon for the terminal. On Debian/Ubuntu: `build-essential python3`. On Fedora: `gcc-c++ make python3`. On macOS: Xcode command line tools |
| **An API key** | an OpenAI-compatible key | Or a gateway/router/local runtime that speaks `POST /v1/chat/completions` |

Check your versions:

```bash
node --version    # v22.x or later
npm --version     # 10.x or later
git --version
```

If Node is not on your `PATH` — for example installed under `~/.local` — either add it to your profile
or set the full path in the service unit later. The installer resolves it for you.

---

## 1. Get the code

```bash
git clone https://github.com/mshermancyber/cobra-commander-ide.git
cd cobra-commander-ide
```

## 2. Install dependencies

```bash
npm install
```

This pulls Playwright, `node-pty` and a TypeScript toolchain, so the first install is not small. If
`node-pty` fails to build, install the build tools listed above and re-run `npm install`.

You do not need a build step to run the backend — it executes TypeScript directly through `tsx`. A
compiled build is available if you want one:

```bash
npm run build        # emits dist/
npm run typecheck    # tsc --noEmit, expect zero errors
```

## 3. Configure

```bash
cp .env.example .env
chmod 600 .env
```

Open `.env` and set at minimum:

```bash
OPENAI_API_KEY=sk-your-key-here
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=gpt-5.1
```

`.env` lives in the install directory and is git-ignored. Real environment variables always take
precedence over the file, so a shell export or a systemd `Environment=` line wins — useful when a
secrets manager injects the key at runtime.

### Pointing at a different gateway

`OPENAI_BASE_URL` accepts any endpoint that implements the Chat Completions API. The URL is normalised,
so both `https://host/v1` and `https://host` work.

```bash
# OpenAI
OPENAI_BASE_URL=https://api.openai.com/v1

# Azure OpenAI / corporate gateway
OPENAI_BASE_URL=https://your-gateway.example.com/v1

# Local runtime (Ollama)
OPENAI_BASE_URL=http://127.0.0.1:11434/v1
OPENAI_MODEL=qwen2.5-coder:32b
```

### Splitting orchestrator and worker models

The orchestrator plans; workers implement. Giving the orchestrator a stronger model and workers a
cheaper one is the point of the architecture:

```bash
ORCHESTRATOR_MODEL=gpt-5.1
WORKER_MODEL=gpt-5.1-mini
```

Each role also accepts its own `*_API_KEY` and `*_BASE_URL` if they live on different gateways.

### Keeping the key out of plain text

```bash
npx tsx src/core/key-vault.ts sk-your-key-here
```

This writes an encrypted `CC_WORKER_KEY` (AES-256-GCM) into `.env` and prints a confirmation. Set
`CC_VAULT_PASSPHRASE` **before** sealing to use a passphrase; without one the seal is derived from the
host name and user account, which means it will not decrypt on another machine or as another user.

Remove the plaintext `OPENAI_API_KEY` line afterwards — it takes precedence over the sealed value.

This is encryption at rest against casual disclosure, not a secret manager. For anything serious,
inject `OPENAI_API_KEY` from your existing secrets tooling.

## 4. Verify

```bash
npm run typecheck
npm test
```

Then check that the model is actually reachable with your key:

```bash
npx tsx start.ts
```

The preflight resolves your key, calls the gateway, prints the model's reply and reports which of the
four subsystems came up. If the key or gateway is wrong, this is where you find out.

## 5. First task

Delegate a single scoped task to a worker, pointed at a project directory:

```bash
npx tsx src/cli.ts delegate "add a /healthz endpoint that returns 200 and the build version" \
  --work-dir /path/to/your/project
```

Install the `cobra` command globally if you prefer:

```bash
npm link
cobra delegate "..." --work-dir /path/to/project
```

Workers write files, run commands and search the project directory. Point them at a Git repository with
a clean working tree so you can read the diff and roll back.

---

## Running as a service

The daemon runs the API server, the task-queue runner and the support-agent child process.

Run it in the foreground first:

```bash
npm run daemon
```

To install it as a systemd service, with the user, install directory and Node location resolved from
your environment:

```bash
sudo ./install-service.sh
```

Pass `--user <account>` to run it as a different account. The script refuses to install if `npm install`
has not been run or `.env` is missing, writes `/etc/systemd/system/cobra-commander.service` from the
template in this repository, enables it and prints the API address.

```bash
systemctl status cobra-commander
systemctl restart cobra-commander
journalctl -u cobra-commander -f
```

Source changes take effect on restart — there is no build step for the backend.

The unit template is hardened with `NoNewPrivileges`, `PrivateTmp`, `ProtectSystem=full` and
`ProtectHome=read-only`, with the install directory as the only writable path. If your workers need to
write to project directories elsewhere, add them to `ReadWritePaths=` in the installed unit.

### The API token

The API server generates a bearer token on first run and stores it at
`~/.cobra-commander/api-token`. Every `/api/` route requires it:

```bash
TOKEN=$(cat ~/.cobra-commander/api-token)
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:4100/api/v1/health
```

A smoke test exercises health, auth, CORS and latency:

```bash
npm run smoke
```

### Ports

| Service | Default | Variable |
|---------|---------|----------|
| REST + WebSocket API | 4100 | `API_PORT` |
| Remote web shell | 4101 | `REMOTE_PORT` |
| Support agent daemon | 4102 | `DESTRO_PORT` |

All three bind to `127.0.0.1` unless you change `CC_BIND_HOST`. Pick ports that are free on your host;
nothing depends on these specific numbers.

---

## The web shell (optional)

A browser UI with chat, an editor, a terminal, task and worker views, a security panel and the support
agent. It is **disabled by default** and should stay that way unless you need it.

It serves a terminal and an unsandboxed file editor. Treat exposing it as equivalent to exposing an SSH
session.

**1. Build the front end:**

```bash
npm --prefix gui/webshell install
npm run build:webshell
```

**2. Create a credential:**

```bash
npx tsx src/remote/auth-providers/token.ts 'your-strong-password'
# prints: REMOTE_AUTH_PASSWORD_HASH=scrypt$...
```

Paste that line into `.env`.

**3. Enable it in `.env`:**

```bash
REMOTE_ENABLED=true
REMOTE_AUTH_MODE=token          # token | pam | cli
REMOTE_AUTH_USER=operator
REMOTE_AUTH_PASSWORD_HASH=scrypt$...
REMOTE_BIND=localhost           # localhost | tailscale | 0.0.0.0 | explicit address
```

**4. Restart** and open `http://127.0.0.1:4101`.

The server refuses to start in token mode without a credential configured — it will log the reason
rather than listen without auth.

### Auth modes

| Mode | Behaviour | When to use |
|------|-----------|-------------|
| `token` | One operator credential from `.env`, scrypt-hashed | Default. Portable, no system accounts |
| `pam` | Authenticates against local system accounts via PAM | Linux hosts where web logins should match real users. Requires `pamtester` or `su` |
| `cli` | Interactive prompt on the controlling terminal | Development |

### Exposing it beyond loopback

If the UI must be reachable from another device, do not simply set `REMOTE_BIND=0.0.0.0`:

- Prefer a private overlay network. `REMOTE_BIND=tailscale` binds to the host's Tailscale address and
  waits for the interface to come up.
- Or terminate TLS in a reverse proxy (nginx, Caddy) and proxy to `127.0.0.1:4101`. The server speaks
  plain HTTP; it expects something in front of it to handle certificates.
- Either way, keep the credential strong and set `REMOTE_LOGIN_MAX_ATTEMPTS` low.

---

## Optional: security scanning

Cobra Commander can hand finished work to an external application-security platform and feed the
findings back to the orchestrator for remediation. Nothing is enabled until you configure it.

See **[docs/DEEP-VIGILANCE-INTEGRATION.md](docs/DEEP-VIGILANCE-INTEGRATION.md)** for the full setup,
including path mapping, scan types and the findings loop.

---

## Upgrading

```bash
cd cobra-commander-ide
git pull
npm install
npm run typecheck
sudo systemctl restart cobra-commander    # if installed as a service
```

Your `.env`, `~/.cobra-commander/` state and task history are untouched by an upgrade. Check
[CHANGELOG.md](CHANGELOG.md) for anything that needs manual attention.

---

## Uninstalling

```bash
sudo systemctl disable --now cobra-commander
sudo rm /etc/systemd/system/cobra-commander.service
sudo systemctl daemon-reload
rm -rf ~/.cobra-commander        # config, API token, local state
```

Then delete the clone. Nothing is installed outside the clone, `~/.cobra-commander` and the service
unit.

---

## Troubleshooting

**`No model API key found`**
`.env` is missing, unreadable, or in the wrong directory. It must sit next to `package.json` in the
install root. Confirm with `npx tsx start.ts`, which prints how far resolution got. If you sealed a key,
make sure you are the same user on the same host, or that `CC_VAULT_PASSPHRASE` is set.

**401 from the gateway**
The key is wrong, revoked or belongs to a different gateway than `OPENAI_BASE_URL` points at.

**404 or "model not found"**
Your account may not have access to `OPENAI_MODEL`. Set it to a model the gateway lists:
`curl -H "Authorization: Bearer $OPENAI_API_KEY" $OPENAI_BASE_URL/models`.

**`node-pty` fails to build**
Install a C/C++ toolchain and Python 3, then `rm -rf node_modules && npm install`. Without it the
terminal features are unavailable; the rest still works.

**Port already in use**
Change `API_PORT`, `REMOTE_PORT` or `DESTRO_PORT` in `.env` and restart. Find the squatter with
`ss -ltnp | grep <port>`.

**The daemon starts, then a task sits in `active` forever**
On startup the daemon reconciles orphaned tasks: tasks that were making progress are requeued and
resumed (up to three times), while tasks that were thrashing with nothing committed are failed loudly.
A task that is `active` shortly after a restart may legitimately be resuming. Cancel a stuck one with:

```bash
curl -H "Authorization: Bearer $TOKEN" -X POST \
  http://127.0.0.1:4100/api/v1/tasks/<id>/cancel
```

**The web shell shows a login page but rejects the password**
In `token` mode the username must match `REMOTE_AUTH_USER` (default `operator`) exactly. Re-generate the
hash and confirm there is no trailing whitespace in `.env`.

**Everything typechecks but a worker does nothing**
That is usually the harness working as intended: a worker that produced no file mutations or no
verification receipt is failed rather than reported as success. Check the task's report for a
`FAILURE:`, `UNVERIFIED:` or `BUDGET_EXCEEDED:` sentinel, and look at `.worker-store/` for its event
log.
