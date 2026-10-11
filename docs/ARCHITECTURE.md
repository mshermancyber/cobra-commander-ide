# Cobra Commander Architecture

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        CLI (src/cli.ts)                         │
│              Commander.js REPL + CLI options                    │
└───────────────────┬─────────────────────────────────────────┬───┘
                    │                                         │
                    ▼                                         ▼
┌───────────────────────────────┐  ┌──────────────────────────────┐
│       Orchestrator            │  │         Worker Pool          │
│    (src/core/orchestrator.ts) │  │    (src/core/worker.ts)      │
│                               │  │                              │
│  • Plans & delegates tasks    │  │  • Executes implementation   │
│  • Reviews worker output      │  │  • Reads/writes files        │
│  • Manages conversation flow  │  │  • Runs shell commands       │
│  • your strongest model (default)      │  │  • an OpenAI-compatible model (default)        │
└───────────┬───────────────────┘  └──────────┬───────────────────┘
            │                                  │
            └──────────┬───────────────────────┘
                       ▼
┌─────────────────────────────────────────────────────────────────┐
│                        Tool System                              │
│  (src/tools/, src/tools/shell-tool.ts, src/core/mcp-client.ts)   │
│                                                                  │
│  • File operations (read, write, edit)                          │
│  • Shell commands (with permission system)                      │
│  • Git operations                                               │
│  • MCP server integration                                       │
│  • Custom tools                                                  │
└─────────────────────────────────────────────────────────────────┘
```

## Orchestrator ↔ Worker Flow

```
User Input
    │
    ▼
┌─────────────┐     ┌──────────────────┐     ┌──────────────┐
│ Orchestrator│────▶│  Context Builder │────▶│   Worker     │
│ (Planner)   │     │  (files, deps,   │     │ (Implementer)│
│             │◀────│   git state)     │◀────│              │
└─────────────┘     └──────────────────┘     └──────────────┘
    │                                                │
    ▼                                                ▼
┌─────────────┐                              ┌──────────────┐
│  Response   │                              │  Tool Calls   │
│  to User    │                              │  (file, shell)│
└─────────────┘                              └──────────────┘
```

1. **User provides a task** via the REPL or CLI
2. **Orchestrator** (the orchestrator) analyzes the request, builds context, and creates a plan
3. **Context Builder** gathers relevant files, git state, dependency info
4. **Worker** receives the plan and executes it using tools
5. **Worker** may make multiple tool calls (file reads/writes, shell commands)
6. **Orchestrator** reviews the worker's output and may iterate
7. **Result** is presented to the user

## Tool System

Tools are the mechanism by which workers interact with the codebase. Each tool has:

- **Name** — Unique identifier
- **Description** — What the tool does
- **Parameters** — JSON Schema for input validation
- **Handler** — Async function that executes the tool

### Built-in Tools

| Tool | Description |
|------|-------------|
| `read` | Read file contents |
| `write` | Write content to a file |
| `edit` | Apply a search/replace edit |
| `shell` | Execute a shell command |
| `glob` | Find files matching a pattern |
| `grep` | Search file contents |
| `diff` | Show git diff |
| `ask` | Ask user a question |

### Tool Dispatch Flow

```
Worker requests tool call
        │
        ▼
┌──────────────────┐
│  Tool Validator   │──▶ Check permissions
│  (sandbox.ts)     │──▶ Validate arguments
└────────┬─────────┘──▶ Check shell policy
         │
         ▼
┌──────────────────┐
│  Tool Executor    │──▶ Execute handler
│  (tools/index.ts) │──▶ Capture output
└────────┬─────────┘──▶ Track usage
         │
         ▼
    Return result to worker
```

## File Structure

### `src/core/` — Core Modules

| Module | Description |
|--------|-------------|
| `orchestrator.ts` | Task planning, delegation, and review |
| `worker.ts` | Task execution with tool calling |
| `session.ts` | Conversation persistence and management |
| `config.ts` | Configuration loading and merging |
| `config-profiles.ts` | Named configuration profiles |
| `agent-roles.ts` | Role definitions for swarm delegation |
| `agent-memory.ts` | Persistent key-value and typed memory |
| `error-parser.ts` | Parse compiler/linter/test errors |
| `error-learner.ts` | Track recurring errors and solutions |
| `git-tracker.ts` | Git operations: diff, commit, checkpoint |
| `sandbox.ts` | Sandbox policies and command validation |
| `composer.ts` | Multi-file composition and editing |
| `notebook.ts` | Jupyter notebook (.ipynb) manipulation |
| `code-migrations.ts` | Language migration patterns |
| `cron-scheduler.ts` | Recurring task scheduling |
| `background-runner.ts` | Background job execution |
| `batch-orchestrator.ts` | Sequential batch task execution |
| `goal-mode.ts` | Iterative goal-driven execution |
| `loop-runner.ts` | Convergence-checking loops |
| `watch-mode.ts` | File watching and auto-trigger |
| `project-runner.ts` | Detect and run project commands |
| `project-init.ts` | Initialize project structure |
| `security-scanner.ts` | SAST security scanning |
| `dv-full-integration.ts` | the security scanner API integration |
| `scan-fix-loop.ts` | Auto-fix security findings |
| `test-generator.ts` | Test generation and coverage analysis |
| `doc-generator.ts` | Documentation coverage and generation |
| `changelog-generator.ts` | Changelog from git history |
| `diagram-generator.ts` | Architecture diagram generation |
| `dependency-graph.ts` | Module dependency analysis |
| `semantic-index.ts` | Semantic search index |
| `file-cache.ts` | File content caching |
| `file-preloader.ts` | Smart file preloading |
| `fast-path.ts` | Optimized path for simple tasks |
| `context-builder.ts` | Build context for workers |
| `context-compressor.ts` | Compress conversation history |
| `context-visualizer.ts` | Token usage visualization |
| `mcp-client.ts` | MCP protocol client |
| `mcp-server.ts` | MCP protocol server |
| `webhook-server.ts` | Webhook server for events |
| `web-tool.ts` | Web search and summarization |
| `clipboard.ts` | System clipboard integration |
| `notification.ts` | Desktop notifications |
| `doctor.ts` | System diagnostics |
| `insights.ts` | Session history analysis |
| `effort-levels.ts` | Worker effort configuration |
| `multi-session.ts` | Parallel session orchestration |
| `remote-workspace.ts` | SSHFS remote workspace |
| `workflow-engine.ts` | Custom workflow definitions |
| `ultra-review.ts` | Deep code review |
| `project-instructions.ts` | Project-level instructions |
| `hooks-system.ts` | Event hooks and callbacks |
| `plugin-loader.ts` | Plugin system |
| `types.ts` | Shared type definitions |

### `src/tools/` — Tool Implementations

| File | Description |
|------|-------------|
| `index.ts` | Tool registration and dispatch |
| `shell-tool.ts` | Shell command execution with permissions |
| `db-tool.ts` | Database query tool |

### `src/` — Entry Points

| File | Description |
|------|-------------|
| `cli.ts` | Main CLI entry point with REPL |
| `index.ts` | Programmatic API entry point |

## Configuration System

```
~/.cobra-commander/config.json
         │
         ▼
    loadConfig(overrides)
         │
         ├── Read file config
         ├── Apply environment variables
         ├── Apply CLI overrides
         ├── Resolve paths
         └── Apply profile (if specified)
         │
         ▼
    Runtime Config object
```

The configuration is merged from multiple sources (in order of precedence):

1. **CLI flags** (highest priority)
2. **Environment variables**
3. **Config file** (`~/.cobra-commander/config.json`)
4. **Config profiles** (applied after merge)
5. **Defaults** (lowest priority)

## Session Management

Sessions persist conversation history to disk:

```
.cobra-commander/sessions/
├── a1b2c3d4/
│   ├── meta.json        # Session metadata
│   └── messages.json    # Conversation messages
├── e5f6g7h8/
│   ├── meta.json
│   └── messages.json
└── ...
```

- `startNew()` — Creates a new session directory
- `saveMessages()` — Persists messages to disk
- `loadMessages()` — Restores messages from disk
- `resume()` — Loads a specific session
- `branchSession()` — Forks the conversation
- `compactMessages()` — Summarizes old messages to save context

## Security Model

### Shell Permissions

The shell tool uses a three-tier permission system:

- **allow-all** — All commands are allowed
- **deny-dangerous** (default) — Blocks dangerous patterns (rm -rf /, dd, mkfs, etc.)
- **ask-all** — Every command requires user approval

### Sandbox Policies

Three built-in sandbox profiles:

| Policy | Network | File Write | File Read | Exec | Use Case |
|--------|---------|------------|-----------|------|----------|
| **strict** | No | No | Yes | No | Code review only |
| **standard** | No | Yes | Yes | Yes | Normal development |
| **permissive** | Yes | Yes | Yes | Yes | Full access needed |

### Sensitive File Protection

Access to files matching sensitive patterns (`.env`, `*.pem`, `*.key`, `credentials.json`, etc.) is blocked regardless of policy.

## Extension Points

### Custom Agent Roles

Define custom roles in `~/.cobra-commander/roles/`:

```json
{
  "name": "security-auditor",
  "description": "Specializes in security code review",
  "model": "gpt-5.1-mini",
  "systemPrompt": "You are a security expert..."
}
```

### MCP Servers

Connect external tool servers via the Model Context Protocol:

```
/mcp add my-server npx @my-org/mcp-server
```

### Plugins

Plugins can register custom tools, commands, and hooks. Place them in `~/.cobra-commander/plugins/`.

### Workflow Engine

Define custom multi-step workflows in YAML:

```yaml
name: "security-review"
steps:
  - run: /scan
  - run: /review --focus security
  - run: /doc coverage
```
