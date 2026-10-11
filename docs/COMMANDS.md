# Cobra Commander — Command Reference

> **Status note for v0.1.0.** This document describes the **interactive slash-command surface**, which
> is *not wired up in this release*. The commands below are design reference, not a working API — none
> of them are registered in the shipped CLI. For what you can actually run today, see
> [../USER-GUIDE.md](../USER-GUIDE.md) and `npx tsx src/cli.ts --help`.

> **Note:** This is a condensed quick-reference. For detailed descriptions, sub-commands, and usage examples for every command, see [CLI-REFERENCE.md](./CLI-REFERENCE.md).

All slash commands available in the Cobra Commander REPL.

---

## Session

### `/reset`
Reset the current session — clears conversation history and starts fresh.
```
/reset
```

### `/history`
Show delegation history with status, token usage, and timestamps.
```
/history
```

### `/sessions`
List recent sessions with message count, age, and model info.
```
/sessions
/sessions --all
```

### `/export`
Export the current session to markdown or JSON format.
```
/export
/export ./my-session.md
/export --format json
```

### `/rename`
Rename the current session for easier identification.
```
/rename my-feature-implementation
```

### `/recap`
Show a summary of the current session — key decisions, files changed, and outcomes.
```
/recap
```

### `/compact`
Compact conversation history by summarizing old messages. Keeps recent exchanges intact.
```
/compact
/compact --keep 5
```

### `/branch`
Fork the current conversation into a new branch. The original conversation continues.
```
/branch
/branch explore-alternative-approach
```

---

## Security

### `/scan`
Run a SAST security scan via the security scanner against the current codebase.
```
/scan
```

### `/scan fix`
Run a SAST scan, filter true positives, and auto-fix findings via a worker.
```
/scan fix
```

### `/dv`
Full the security scanner API integration — launch scans, get SBOMs, run compliance checks.
```
/dv dashboard
/dv dast http://localhost:3000
/dv container ./Dockerfile
/dv sbom
/dv compliance
/dv schedule daily
/dv report
```

### `/pipeline`
Run a full security pipeline: SAST scan → code review → report.
```
/pipeline
```

### `/review`
Code review — the orchestrator reviews the current git diff and provides feedback.
```
/review
/review --focus security
```

### `/review-pr`
Review a GitHub pull request via the security scanner integration.
```
/review-pr 42
/review-pr https://github.com/owner/repo/pull/42
```

---

## Development

### `/plan`
Toggle plan mode. In plan mode, the orchestrator explores and plans without delegating any work to workers.
```
/plan
/plan on
/plan off
```

### `/goal`
Set a goal with acceptance criteria. Cobra Commander iterates until criteria are met.
```
/goal "All tests pass with >80% coverage"
/goal status
/goal cancel
```

### `/loop`
Run a task in a loop with convergence checking. The task repeats until the output stabilizes.
```
/loop "Refactor the auth module"
/loop status
/loop stop
```

### `/batch`
Run multiple tasks sequentially with shared context. Each task sees the output of previous tasks.
```
/batch "Add types, implement service, write tests"
/batch status
```

### `/multi`
Multi-session orchestration — run independent sessions in parallel with a shared dashboard.
```
/multi start "Refactor auth, Add tests, Update docs"
/multi status
/multi summary
```

### `/run`
Detect project commands (dev server, tests, build) and run them.
```
/run
/run dev
/run test
/run build
```

### `/init`
Initialize the `.cobra-commander/` directory structure with default configuration files.
```
/init
```

### `/watch`
Watch files for changes and auto-trigger tasks when files are modified.
```
/watch src/
/watch stop
```

### `/doctor`
Run diagnostics on configuration, environment, API keys, and tool availability.
```
/doctor
```

### `/verify`
Cross-model verification — a second model reviews worker changes for quality.
```
/verify
```

---

## Code Intelligence

### `/diff`
Show git diff in various formats.
```
/diff stat
/diff files
/diff full
/diff summary
```

### `/graph`
Show dependency graph or generate architecture diagrams.
```
/graph
/graph deps
/graph class src/core/orchestrator.ts
/graph module src/core/
/graph call src/core/worker.ts
```

### `/goto`
Navigate to a symbol definition — opens the file at the correct line.
```
/goto Orchestrator
/goto buildSystemPrompt
```

### `/refs`
Find all references to a symbol across the codebase.
```
/refs executeTool
/refs loadConfig
```

### `/doc`
Documentation coverage analysis and JSDoc generation.
```
/doc coverage
/doc gen src/core/worker.ts
/doc gen all
```

### `/context`
Show context usage, token estimates, and context bar visualization.
```
/context
/context table
/context advice
```

### `/index`
Build or query the semantic search index.
```
/index build
/index query "authentication middleware"
/index status
```

### `/simplify`
Review recent changes and suggest simplifications.
```
/simplify
```

---

## Git

### `/commit`
Auto-commit with a generated message from the git diff. Optionally provide a custom message.
```
/commit
/commit "Add user authentication middleware"
```

### `/pr`
Create a GitHub pull request from the current branch.
```
/pr
/pr "Add user authentication"
```

### `/changelog`
Generate a changelog from git history between tags or commits.
```
/changelog
/changelog v0.1.0..HEAD
/changelog --format json
```

### `/checkpoint`
Save, list, or restore git checkpoints.
```
/checkpoint save
/checkpoint list
/checkpoint restore <id>
```

### `/undo`
Undo the last delegation by rolling back the git changes.
```
/undo
```

### `/prepforgit`
Prepare the codebase for a git commit — cleanup, formatting, and organization.
```
/prepforgit
```

---

## Configuration

### `/config`
View or edit the current configuration.
```
/config
/config show
/config set worker.model gpt-5.1-mini
```

### `/model`
Switch the worker model at runtime.
```
/model fast
/model gpt-5.1-mini
/model list
```

### `/effort`
Set the effort level for worker tasks. Controls how thorough workers are.
```
/effort
/effort low
/effort medium
/effort high
/effort custom
```

### `/permission`
Manage shell command permissions — allow, deny, or ask for approval.
```
/permission list
/permission grant npm
/permission revoke rm
/permission allow-read
/permission allow-write
```

### `/profile`
Apply a named config profile (security, fast, thorough, review, or custom).
```
/profile
/profile security
/profile fast
/profile list
/profile save my-profile
/profile delete my-profile
```

### `/rules`
View or edit project rules stored in `.cobra-commander/rules/`.
```
/rules
/rules edit
/rules add "Always use async/await"
```

### `/focus`
Focus the worker on specific files or directories. Limits file operations to the focused scope.
```
/focus src/core/
/focus src/core/orchestrator.ts
/focus clear
```

### `/verbose`
Toggle verbose output — shows detailed tool calls and responses.
```
/verbose
/verbose on
/verbose off
```

---

## Tools & Infrastructure

### `/remote`
Manage remote workspaces via SSHFS mount, SCP transfer, or NFS detection.
```
/remote mount user@host:/path
/remote unmount
/remote scp ./file user@host:/path
/remote list
/remote status
```

### `/sandbox`
Create and manage sandboxed environments for safe task execution.
```
/sandbox start
/sandbox apply
/sandbox discard
/sandbox status
```

### `/mcp`
Configure and query MCP (Model Context Protocol) servers.
```
/mcp list
/mcp add server-name command args...
/mcp remove server-name
/mcp status
```

### `/webhook`
Start or stop a webhook server for receiving the security scanner scan completion events.
```
/webhook start
/webhook start --port 8080
/webhook stop
/webhook events
```

### `/schedule`
Schedule recurring tasks to run at specified intervals.
```
/schedule 30 "run tests"
/schedule list
/schedule remove <id>
```

### `/bg`
Run a task in the background. Continues working while you interact with the REPL.
```
/bg "Refactor the utils module"
/bg status
```

### `/jobs`
List background jobs with their status and results.
```
/jobs
/jobs clear
```

### `/fork`
Fork the current conversation into a branch (like git branch for conversations).
```
/fork
/fork explore-alternative-approach
```

### `/btw`
Send a side-channel message to the orchestrator without interrupting the main conversation.
```
/btw "Remember to use the singleton pattern"
```

### `/copy`
Copy content to the system clipboard.
```
/copy "const x = 42;"
```

### `/paste`
Paste content from the system clipboard into the conversation.
```
/paste
```

---

## Other

### `/save`
Save a note to project memory. Stored in `.cobra-commander/context.md`.
```
/save "Use repository pattern for data access"
```

### `/notepad`
Open a persistent notepad for taking notes during a session.
```
/notepad
/notepad list
/notepad show work-notes
```

### `/memory`
View or edit agent memory — persistent knowledge that carries across sessions.
```
/memory
/memory set "project uses Express.js"
/memory clear
```

### `/attach`
Attach files or images to the conversation for context.
```
/attach ./screenshot.png
/attach ./config.json
/attach list
/attach clear
```

### `/errors`
View learned error patterns — the system tracks recurring errors and their solutions.
```
/errors
/errors clear
/errors weaknesses
/errors reliability
```

### `/cache`
Manage the file cache — view stats, clear, or warm the cache.
```
/cache
/cache stats
/cache clear
/cache warm
```

### `/preload`
Manage file preloading statistics — view accuracy, suggestions, and reset stats.
```
/preload
/preload stats
/preload suggestions
/preload reset
```

### `/advisor`
Enable or disable a secondary model that provides review guidance during sessions.
```
/advisor
/advisor on
/advisor off
```

### `/insights`
Analyze session history for patterns — common errors, frequently changed files, delegation effectiveness.
```
/insights
/insights report
```

### `/health`
System health check — verify API keys, configuration, and tool availability.
```
/health
```

### `/cost`
Show estimated API cost for the current session.
```
/cost
```

### `/tokens`
Show token usage breakdown for orchestrator and workers.
```
/tokens
```

### `/status`
Show project status: git branch state, worker pool, session statistics.
```
/status
```

### `/roles`
List available agent roles for swarm delegation (implementer, tester, reviewer, refactorer, documenter).
```
/roles
```

### `/help`
Show the help menu with all available commands.
```
/help
/help delegation
/help roles
/help config
```

### `/exit`
Exit the Cobra Commander REPL.
```
/exit
```
