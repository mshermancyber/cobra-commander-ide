# Cobra Commander — Feature Inventory

**260 TypeScript modules | ~83,000 lines | 18 test files | 141 passing tests | 0 compile errors**
*(v0.1.0, measured on the released tree: `find src gui tests -name '*.ts' | wc -l`)*

A self-hosted AI development platform where an orchestrator model plans and delegates, and cheaper
worker models implement.

> **About this document.** This is the running inventory of everything built, kept in the order it was
> built, and it is longer than it is tidy. Entries marked `[ARCHIVED]` reference code that was retired
> to an `archive/` tree which is **not part of the public release** — those entries are history, not
> shipped features. A handful of entries also describe design work that landed in sibling projects.
> For what you can actually run, start with [USER-GUIDE.md](USER-GUIDE.md).

---

## 1. Multi-Model Architecture

### Orchestration Engine
- **Orchestrator model** plans and delegates complex tasks
- **worker** implements code at fraction of the cost
- **Worker pool** with named entries and tier routing (fast/standard/heavy)
- **Cost-aware routing** — automatically select cheapest capable model
- **Cross-model verification** — the orchestrator model reviews the worker's output
- **Fallback chains** — ordered list of models to try on failure
- **Auto-retry** with exponential backoff and intelligent retry strategies

### Self-Orchestration (`orchestrator.ts`, `/orchestrate`)
- The orchestrator model self-orchestrates via OpenAI-compatible API
- Delegation modes: `delegate_to_worker`, `delegate_parallel`, `delegate_chain`, `delegate_swarm`
- Worker tiers: fast (small tasks), standard (normal), heavy (complex)
- Plan mode for decomposition before execution
- Auto-compact context to stay within token limits
- Git snapshot/rollback for safe experimentation
- Progress reporting with token usage tracking

### Model Management (`/model`, `/bench`, `/effort`)
- Switch worker models mid-session
- Performance benchmarks per model
- Effort levels: low (2048 tokens, skip extras), medium (4096), high (8192), max (16384)
- Auto-detect recommended effort from task complexity

### Provider Support
- **Anthropic** (Claude) — alternative orchestrator provider
- **OpenAI-compatible** (the worker model, OpenAI, any compatible API) — workers
- **Claude Code CLI** — can use Claude Code as a provider
- **Local models** — Ollama, LM Studio, llama.cpp auto-detection
- URL validation and SSRF protection on all provider endpoints

---

## 2. Security Integration (the security scanner)

### SAST & Code Review (`/scan`, `/pipeline`)
- Launch SAST scans via the scanner API
- Code review with semantic analysis
- Auto-fix true positive findings
- Full scan + code review pipeline in one command

### DAST & API Scanning (`/dv scan dast|api`)
- DAST scanning against running dev servers
- Auto-detect running servers on common ports (3000, 5173, 8080, etc.)
- Enterprise DAST with browser crawl and WAF evasion
- API protocol scanning: REST, GraphQL, gRPC, WebSocket

### Fuzz Testing (`/dv fuzz`)
- Launch fuzz tests against targets
- Retrieve crash reports
- Feed crashes back to worker for fixing

### Container Security (`/dv scan container`)
- Scan Docker images for vulnerabilities
- Generate container SBOMs

### Dependency Scanning (`/dv scan deps`)
- SCA/dependency vulnerability scanning
- Automatic detection of package.json/requirements.txt/go.mod

### SBOM Generation (`/dv sbom`)
- Generate SBOMs in CycloneDX and SPDX formats
- Download and export SBOMs

### Compliance (`/dv compliance`)
- Compliance reporting: OWASP, PCI-DSS, SOC2, HIPAA
- Project-level compliance summaries

### Automated Remediation (`/dv fix`)
- Get fix suggestions from the scanner AI
- Auto-apply patches
- Export fix patches

### Security Dashboard (`/dv dashboard`, `/dv status`)
- Risk heatmap
- Scan history and finding summaries
- Formatted terminal dashboard

### Report Generation (`/dv report`)
- Generate security reports (PDF/JSON)
- Multiple template types

### Scheduled Scans (`/dv schedule`)
- Create cron-based scan schedules
- Support all scan types

### API Spec Import (`/dv import-api`)
- Import OpenAPI/Swagger/Postman/GraphQL specs
- Auto-discover API specs in project

### Scan-Fix Loop (`scan-fix-loop.ts`, `/scan-fix`)
- Automated scan-and-fix pipeline: scan → fetch results → generate fix tasks → apply fixes → rescan
- Fetches structured JSON from the scanner export endpoints (SAST + code review)
- Groups findings by file, generates targeted Worker fix prompts with full file context
- Severity filtering (`--severity critical,high`), max finding limit (`--max 20`)
- Dry-run mode for reporting without fixing
- Optional post-fix rescan to verify remediation
- Strips Docker scan-mount paths to project-relative paths

### Async the scanner Scanning (`async-scan.ts`)
- Launch scanner scans in background during pipeline implementation phase
- Non-blocking poll in security phase — pipeline does not wait for scan completion
- Pending scan handles stored on orchestrator for later collection
- `collectAsyncScanResults()` surfaces completed results via callbacks
- Supports SAST, code-review, and other scanner scan types

### Real-Time Security Scanning (`realtime-scanner.ts`)
- File watcher with 2-second debounce on src/ directory
- Quick local SAST pattern checks (no the scanner needed)
- Detects: SQL injection, command injection, hardcoded secrets, eval(), innerHTML XSS
- Event-based listener system for UI integration

### Security Hardening (R112)
- All CLI `execSync` calls replaced with `execFileSync` + args arrays (command injection prevention)
- SSRF protection: private IP blocking on all provider/registry/API endpoints
- PII redaction on error logs via `redactPII()`
- Voice input tool allowlist validation
- Debugger input sanitization (strip shell metacharacters)
- Git ref parameter validation against safe patterns

### Credential Management
- API keys stored encrypted in the scanner (AES-256-GCM)
- Runtime key hydration — never stored plaintext on disk
- 5-minute TTL cache for performance
- Falls back to env vars if the scanner unavailable

---

## 3. Code Intelligence

### Repository Map (`repo-map.ts`)
- Full codebase structure analysis
- Symbol extraction and ranking (enhanced with `extractSymbolsFromFile`)
- Cross-file dependency tracking
- Enhanced repo map with function signatures, class hierarchies (`buildEnhancedRepoMap`)

### AST Analysis (`ast-context.ts`, `/goto`, `/refs`)
- TypeScript AST parsing with cyclomatic complexity
- Jump to symbol definition
- Find all references across codebase

### LSP Client (`lsp-client.ts`, `lsp-tool.ts`)
- Language Server Protocol integration for code intelligence
- Go to definition, find references, hover, document/workspace symbols
- Auto-discovers installed language servers (TypeScript, Python, Go, Rust)
- Raw JSON-RPC over stdio — no external dependencies
- Language extension map with 100+ file types (`language-map.ts`)

### Apply Patch Tool (`patch-parser.ts`, `apply-patch-tool.ts`)
- Claude-compatible `*** Begin Patch / *** End Patch` format
- Supports add, delete, update, and move operations
- Fuzzy matching with 4-pass line search (exact, rstrip, trim, unicode-normalized)
- Context-based seeking for precise hunk placement
- Path traversal protection and atomic file operations

### Tree-Sitter Integration (`tree-sitter-parser.ts`, `/treesitter`)
- Multi-language AST parsing
- Grammar management (download/status)

### Semantic Search (`semantic-index.ts`, `/index`)
- TF-IDF keyword-based search
- Build and query semantic index
- Embedding support for vector search

### RAG Pipeline (`rag-pipeline.ts`)
- Retrieval-augmented generation for context
- TF-IDF keyword search without external dependencies

### Knowledge Graph (`knowledge-graph.ts`, `/graph`)
- Persistent codebase relationship graph
- Dependency visualization
- Module/class/call-flow diagrams

### Dependency Graph (`dependency-graph.ts`)
- Import/export resolution
- Circular dependency detection

### Diagram Generation (`diagram-generator.ts`, `/doc diagram`)
- Dependency diagrams
- Class diagrams
- Module diagrams
- Call flow diagrams

### Vector Index (`vector-index.ts`)
- Persistent vector embedding index (JSON-backed)
- Cosine similarity search across file embeddings
- Incremental index building with progress callback
- Automatic file discovery (skips node_modules, .git, dist)

### Context Building (`context-builder.ts`, `/context`)
- Intelligent context assembly from codebase
- Token usage visualization with bar charts
- Context advice for optimization
- Lazy context — skip for simple tasks
- **Semantic context retrieval** (`getSemanticContext`) — TF-IDF matching via vector index

### Context Providers (`context-providers.ts`)
- Extensible pluggable context source system
- Register/unregister/enable/disable providers
- Built-in providers: git-history, package-info, env-vars
- `gatherContext()` collects from all enabled providers

### @-Mentions (`mentions.ts`)
- Parse `@filename` and `@SymbolName` from user input
- Auto-resolve file paths (checks src/, adds .ts extension)
- Path traversal protection
- Build mention context for worker prompts

### Image/Vision Support (`vision.ts`)
- Load images as base64 with MIME type detection
- Build Anthropic vision API content blocks
- Extract image paths from user input
- Support PNG, JPEG, GIF, WebP, SVG

### File Intelligence
- **File preloading** (`file-preloader.ts`, `/preload`) — predictive file loading
- **File cache** (`file-cache.ts`, `/cache`) — LRU cache for frequently accessed files
- **Attachments** (`attachments.ts`, `/attach`) — attach files to messages
- **Context snapshot** (`context-snapshot.ts`) — pre-reads default project files into a shared read-only snapshot before worker dispatch, eliminating redundant per-worker file reads
- **Targeted snapshot** (`createTargetedSnapshot`) — mines file paths from task descriptions and context strings, pre-reads exactly the files each worker batch needs
- **Batched file writes** (`batch-write.ts`, `write_files` tool) — multi-file write in one tool call with BOM preservation, line-ending preservation, file locking, path-permission checks, auto-format, and operation recording per file

---

## 4. Development Workflow

### Session Management
- **Session history** (`session.ts`, `/sessions`) — persistent sessions with message tracking
- **Session export** (`session-export.ts`, `/export`) — text, markdown, JSON formats
- **Session rename** (`/rename`) — descriptive session names
- **Session recap** (`/recap`) — one-line summary of current session
- **Session branch** (`/branch`) — fork conversation for exploration
- **Session compact** (`/compact`) — summarize old messages to save context
- **Session reset** (`/reset`) — clear conversation history
- **Session insights** (`insights.ts`, `/insights`) — usage analytics, error rates, productivity trends

### Planning & Execution
- **Plan mode** (`plan-mode.ts`, `/plan`) — structured step-by-step planning with persistence
- **Goal mode** (`goal-mode.ts`, `/goal`) — autonomous loop until condition met
- **Loop mode** (`loop-runner.ts`, `/loop`) — repeated prompt execution with interval parsing
- **Batch orchestration** (`batch-orchestrator.ts`, `/batch`) — parallel task orchestration with file conflict detection
- **Multi-session** (`multi-session.ts`, `/multi`) — coordinated parallel workers with file locking and progress dashboard
- **Background tasks** (`background-runner.ts`, `/bg`, `/jobs`) — run tasks in background
- **Fast-path** (`fast-path.ts`) — bypass orchestrator for simple tasks
- **Speculative execution** (`speculative-exec.ts`) — pipeline compile gate runs next-phase prep (scan config, diff computation) while tsc compiles; automatically discarded on compile failure
- **Async the scanner verification** (`async-scan.ts`) — launch scanner scans in background during pipeline implementation phase; non-blocking poll in security phase; results collectible later via `collectAsyncScanResults()`

### Git Integration
- **Git tracking** (`git-tracker.ts`) — automatic change tracking with checkpoints
- **Commit generation** (`commit-message.ts`, `/commit`) — AI-generated conventional commits from diffs
- **PR creation** (`/pr`) — GitHub PR with auto-generated description
- **PR review** (`pr-review.ts`, `/review-pr`) — review GitHub PRs via the scanner API
- **Code review** (`/review`) — the orchestrator reviews the current git diff
- **Changelog** (`changelog-generator.ts`, `/changelog`) — generate changelogs from git history
- **Checkpoints** (`checkpoint-browser.ts`, `/checkpoint`) — save/list/restore git checkpoints
- **Undo** (`/undo`) — revert to last checkpoint
- **Diff viewer** (`tui-diff.ts`, `/diff`) — colored terminal diff + side-by-side diff display
- **Git prep** (`git-prep.ts`, `/prepforgit`) — prepare for GitHub (sanitize, docs, license)
- **Dirty repo guard** (`dirty-repo-guard.ts`) — warn on uncommitted changes, auto-stash/unstash
- **Auto-commit** (`auto-commit.ts`) — atomic commits after every file edit, batch commit, undo
- **GitHub integration** (`github-integration.ts`) — auto-generate PR descriptions, review comments, commit history

### Code Generation & Modification
- **Test generation** (`test-generator.ts`, `/test`) — generate tests, run tests, coverage analysis, coverage gaps
- **Documentation** (`doc-generator.ts`, `/doc`) — topic docs, coverage analysis, auto-generation
- **Code transforms** (`code-transform.ts`) — 5 built-in transforms
- **Code migrations** (`code-migrations.ts`) — React class→hooks, CommonJS→ESM, callback→async transforms with preview
- **User guide** (`user-guide.ts`) — auto-generate USER-GUIDE.md

### Verification & Quality
- **Auto-verify** (`auto-verify.ts`) — auto lint/test after file edits with error-specific re-prompting
- **Error parser** (`error-parser.ts`) — parse TSC, ESLint, Jest, generic errors; build targeted fix prompts
- **Verification** (`verification.ts`, `/verify`) — configurable verification commands
- **Review rules** (`review-rules.ts`) — strict/moderate/minimal review profiles
- **Error learning** (`error-learner.ts`, `/errors`) — learn from model errors, preventive prompts

### Project Management
- **Project init** (`project-init.ts`, `/init`) — initialize .cobra-commander/ structure
- **Project runner** (`project-runner.ts`, `/run`) — detect and launch dev servers
- **Project rules** (`project-rules.ts`, `/rules`) — YAML frontmatter markdown rules
- **Config profiles** (`config-profiles.ts`, `/profile`) — named configuration profiles
- **Watch mode** (`watch-mode.ts`, `/watch`) — file change monitoring with debouncing

---

## 5. Tool System

### Built-in Tools (7 tools)
- **Shell tool** (`shell-tool.ts`) — command execution with approval system
- **File tools** (`file-tools.ts`) — read, write, edit, list, patch files
- **Grep tool** (`grep-tool.ts`) — pattern search across files
- **Symbol tool** (`symbol-tool.ts`) — find definitions and references
- **DB tool** (`db-tool.ts`, `/db`) — database query and schema inspection
- **Web tool** (`web-tool.ts`) — web fetching and scraping

### Tool Infrastructure
- **Permission profiles** (`permission-profiles.ts`, `/permission`) — per-tool allow/deny/ask rules with 3 built-in profiles
- **Approval UI** (`approval-ui.ts`) — risk-classified command approval
- **Read-only files** (`read-only-files.ts`) — glob-based file protection
- **Sandbox** (`sandbox.ts`, `/sandbox`) — Docker/firejail/bubblewrap isolation
- **Privacy mode** (`privacy-mode.ts`) — endpoint whitelist

---

## 6. Integration & Infrastructure

### API Server (`api-server/`, `/serve`)
- Built-in HTTP + WebSocket server (28 REST endpoints)
- Bearer token authentication with auto-generated tokens
- CORS for localhost origins only
- Real-time WebSocket event streaming (task progress, file changes, scan events)
- Routes: sessions, tasks, workers, files, security, config, models, git, analytics, search, terminal
- `GET /api/v1/workers` — worker registry enriched with live projector data (id, pid, status, tier, ≤80 char task, logPath, start/finish)
- API key sanitization — never exposes secrets in responses
- Path traversal protection on all file operations
- Foundation for Web UI and Desktop GUI

### MCP (Model Context Protocol) (`/mcp`)
- MCP client for connecting to external tool servers
- MCP server mode — expose cobra-commander as an MCP server
- Connect/disconnect/discover/list tools and resources

### Webhooks (`webhook-server.ts`, `/webhook`)
- Webhook server for receiving events
- Start/stop/status/config management
- Recent events viewer

### Remote Workspace (`remote-workspace.ts`, `/remote`)
- SSHFS mounting for full remote sessions
- SCP/SFTP file transfers
- NFS mount detection
- SSH config parsing (~/.ssh/config)
- Connection management

### Scheduling (`/schedule`)
- Schedule recurring tasks with interval
- Background execution

### Database (`db-tool.ts`, `/db`)
- Database connection management
- SQL query execution
- Schema inspection

---

## 7. UI & Display

### Terminal UI Components (`tui-components.ts`)
- Tables, progress bars, boxes, tree views
- Colored diff display
- Thinking/reasoning display

### Output Control
- **Verbose mode** (`/verbose`) — toggle tool call visibility
- **Focus mode** (`/focus`) — minimal output
- **Token display** (`/tokens`) — token usage breakdown
- **Cost tracking** (`/cost`) — estimated API costs
- **Progress reporting** (`progress-reporter.ts`) — periodic progress updates
- **Status** (`/status`) — project status overview

### Clipboard (`clipboard.ts`, `/copy`, `/paste`)
- System clipboard integration (pbcopy/xclip/clip)

---

## 8. Agent System

### Agent Roles (`agent-roles.ts`, `/roles`)
- Named agent roles with tool restrictions
- Swarm delegation based on role

### Persistent Agents (`persistent-agents.ts`)
- Disk-persisted agent configurations
- Resume agents across sessions

### Agent Memory (`agent-memory.ts`, `/memory`)
- Key-value memory store
- Persistent across sessions

### Side Questions (`/btw`)
- Isolated model calls without polluting session context

### Fork (`/fork`)
- Spawn subagent with current context

### Advisor (`/advisor`)
- Secondary model for review guidance

---

## 9. Advanced Features

### Plugin System (`plugin-loader.ts`)
- Dynamic ESM plugin loading
- Plugin discovery and lifecycle

### Hooks (`hooks-system.ts`)
- Pre/post task hooks from .cobra-commander/hooks.json
- Customizable automation triggers

### Voice Input (`voice-input.ts`)
- Speech-to-text via whisper/whisper.cpp
- Audio recording detection (arecord/sox/ffmpeg)

### Browser Automation (`browser-automation.ts`)
- Playwright/Puppeteer script generation
- Screenshot analysis for UI testing

### Screenshot Analysis (`screenshot-analysis.ts`)
- Vision-based UI analysis

### Task Router (`task-router.ts`)
- Intelligent routing of tasks to appropriate workers

### Extended Thinking (`extended-thinking.ts`)
- Claude extended thinking mode support
- Configurable thinking budget (tokens)
- Extract and display thinking blocks from API responses
- Formatted terminal display with box-drawing characters

### Read-Only Mode (`read-only-mode.ts`)
- Analytics mode — answer questions without modifying files
- Tool whitelist (read_file, list_files, grep_files, find_symbol, find_references, diff_changes)
- Warning messages for blocked write operations

### Map Mode (`map-mode.ts`)
- Generate visual project tree with Unicode box-drawing
- Configurable depth, file extension filter, file size display
- Summary stats (file count, line count)

### Offline Mode (`offline-mode.ts`)
- Zero-network privacy mode — blocks all external API calls
- Allows localhost/LAN only
- Auto-configures Ollama as offline model provider
- URL validation for all outbound requests

### Dirty Repo Guard (`dirty-repo-guard.ts`)
- Detect uncommitted changes before AI edits
- Categorize: staged, unstaged, untracked files
- Auto-stash / auto-stash-pop for safe editing

### Auto-Commit (`auto-commit.ts`)
- Atomic git commits after every file edit
- Batch commit for multi-file changes
- List auto-commits, undo last auto-commit

### Code Migrations (`code-migrations.ts`)
- React class components → hooks
- CommonJS require → ESM import
- Callback-style → async/await
- Preview changes before applying
- Extensible migration rule system

---

## 10. Configuration

### Config Structure (`.cobra-commander/`)
```
.cobra-commander/
├── config.json          # Main configuration
├── hooks.json           # Pre/post task hooks
├── permissions.json     # Per-tool allow/deny rules
├── security.json        # the scanner API config (no plaintext keys)
├── rules/               # Project-specific rules
├── profiles/            # Named config profiles
├── plugins/             # Custom plugins
├── agents/              # Persistent agent configs
├── sessions/            # Session history
└── checkpoints/         # Git checkpoints
```

### Config Commands
- `/config` — view/change configuration
- `/profile` — manage config profiles
- `/init` — initialize project structure
- `/health` — system diagnostics (project, tools, API, disk)
- `/doctor` — self-diagnostic (API keys, tools, network, config)

---

## Architecture

```
┌──────────────────────────────────────────┐
│            Cobra Commander CLI           │
│              90+ commands                │
├──────────────────────────────────────────┤
│  Orchestrator           Worker Pool      │
│  ├─ Plan Mode           ├─ the worker model     │
│  ├─ Goal Mode           ├─ Local/Ollama │
│  ├─ Batch Mode          └─ Fallback     │
│  └─ Multi-Session                       │
├──────────────────────────────────────────┤
│  7 Built-in Tools   │  MCP Client/Srv   │
│  Permission System  │  Plugin System    │
│  Sandbox Policies   │  Webhook Server   │
├──────────────────────────────────────────┤
│          the security scanner API              │
│  SAST │ DAST │ SCA │ Fuzz │ Container   │
│  Code Review │ SBOM │ Compliance        │
│  AI Analysis │ Fix Suggestions          │
│  Encrypted Key Storage (AES-256-GCM)    │
├──────────────────────────────────────────┤
│        Code Intelligence                 │
│  Repo Map │ AST │ Tree-Sitter           │
│  Semantic Index │ RAG │ Knowledge Graph  │
│  Embeddings │ Dependency Graph           │
├──────────────────────────────────────────┤
│        Workflow & Orchestration          │
│  Workflow Engine │ Ultrareview           │
│  Composer │ Cascade Flows │ Cron        │
│  Typed Memory │ Project Instructions     │
│  Org Tuning │ Notifications             │
├──────────────────────────────────────────┤
│        Testing & Documentation           │
│  96 Tests (Vitest) │ 5 Doc Guides       │
│  10 Test Files │ CLI Reference           │
└──────────────────────────────────────────┘
```

---

## 18. Web UI (React SPA)
*(Round 66 — `gui/web/`)*

- **React 18 + Vite 5** — dark theme SPA at localhost
- **13 component files**: App, Sidebar, Header, StatusBar, ChatPanel, FileExplorer, SecurityDashboard, AnalyticsDashboard, SessionList, ConfigPanel, TerminalPanel, GitPanel
- **API client** — typed wrapper for all 28 REST endpoints with Bearer token auth
- **WebSocket hook** — `useWebSocket.ts` for real-time streaming events
- **Vite HMR** — instant dev reload, production build under 200KB

## 19. VS Code Extension
*(Round 67 — `gui/vscode/`)*

- **8 commands**: Open Chat, Ask/Fix/Explain Selection, Generate Tests, Security Scan, Show Diff, Toggle Inline
- **Context menu integration** — right-click on selection for AI actions
- **Activity bar panel** with Chat (webview), Sessions (tree), Security (tree) views
- **Inline code suggestions** via `InlineCompletionItemProvider` with debounce
- **Security scanner** — auto-scan on save, findings as VS Code diagnostics with squiggly underlines
- **CobraClient** — typed API client with WebSocket event subscription
- **esbuild bundle** — single 21KB output file

## 20. Tab Completion
*(Round 68 — `src/core/tab-completion.ts`)*

- **CLI command completion** — all `/` commands with descriptions
- **@-mention file completion** — walks project tree for `@filename` references
- **Language keyword completion** — TypeScript, JavaScript, Python, Go, Rust, Java keywords
- **Completion trigger parser** — extracts prefix from cursor position
- Max 20 suggestions, sorted by priority (commands > files > keywords)

## 21. Session Sync
*(Round 68 — `src/core/session-sync.ts`)*

- **Cross-client session sharing** — CLI, Web, VS Code see the same session in real-time
- **EventEmitter-based** push/subscribe system
- **JSONL persistence** — events written to `~/.cobra-commander/sync/`
- **Client registration/unregistration** with active session tracking

## 22. Terminal Output Integration
*(Round 68 — `src/core/terminal-integration.ts`)*

- **TerminalWatcher** — spawn/monitor shell commands with real-time streaming
- **Auto-detect errors** — 8 regex patterns for TSC, ESLint, Jest, runtime, lint, general errors
- **Auto-fix prompt generation** — `buildAutoFixPrompt()` creates targeted fix prompts from detected errors
- **Process management** — stop individual or all watched processes

## 23. Debugger Integration
*(Round 68 — `src/core/debugger-integration.ts`)*

- **Multi-language debug adapter** — Node.js (inspect), Python (pdb), Go (dlv), Rust (gdb), C/C++ (gdb), Java (jdb)
- **Breakpoint management** — add/remove with conditions
- **Step controls** — continue, step over, step into, step out, evaluate
- **Stack trace analysis** — `analyzeStackTrace()` parses Node.js and Python traces, identifies user vs framework code
- **AI debug prompt** — `buildDebugPrompt()` formats trace + variables for AI analysis

## 24. Audit Logging
*(Round 68 — `src/core/audit-log.ts`)*

- **Structured JSONL audit trail** — daily log files in `~/.cobra-commander/audit/`
- **7 categories**: session, file, command, model, security, config, auth
- **Convenience methods** for common actions (session start/end, file change, command exec, model switch, security scan, config change)
- **Query/filter API** — by date range, category, action, session ID
- **Stats aggregation** — actions per day, failure rate, category breakdown
- **Log pruning** — auto-delete logs older than N days (default 90)

## 25. Cascade Flows (Multi-Step AI Workflows)
*(Round 68 — `src/core/cascade-flows.ts`)*

- **CascadeFlowEngine** — define and execute multi-step AI workflows
- **5 step types**: prompt, command, condition, parallel, loop
- **Condition evaluation** — variable interpolation, numeric comparisons
- **Error handling** — per-step `onError` redirect
- **3 built-in flows**: `review-and-fix`, `security-audit`, `test-driven-fix`
- **EventEmitter events** for flow/step start, complete, error

## 26. Cross-Repository Search
*(Round 69 — `src/core/cross-repo-search.ts`)*

- **`searchAcrossRepos()`** — grep across multiple repos simultaneously
- **`findDependencies()`** — track npm dependency links between repos
- **`analyzeImpact()`** — given changed files in one repo, find affected files in dependent repos
- **`batchSearch()`** — run multiple queries across all repos at once

## 27. Code Insights Dashboard
*(Round 69 — `src/core/code-insights.ts`)*

- **`analyzeCodeHealth()`** — file counts, line counts, language breakdown, complexity hotspots, test coverage ratio, dependency count, git churn
- **Complexity estimation** — nesting depth, long lines, branching count
- **Recommendations engine** — actionable suggestions based on metrics
- **Health score** — 0-100 score based on test coverage, complexity, file sizes
- **Insight reports** with timestamp and full metrics snapshot

## 28. Extension Marketplace
*(Round 69 — `src/core/extension-marketplace.ts`)*

- **ExtensionManager** — install/uninstall/enable/disable extensions
- **Extension manifests** with categories (tool, provider, theme, language, integration)
- **Configuration per extension** — schema-driven with defaults
- **Registry search** — query remote extension registry
- **Dynamic loading** — `loadExtension()` imports extension main module at runtime

## 29. Profiler Integration
*(Round 69 — `src/core/profiler-integration.ts`)*

- **CPU profiling** — `profileNodeCPU()` uses `--cpu-prof` for V8 profiles
- **Memory snapshots** — `profileMemory()` captures heap usage
- **Profile reports** — formatted table of top hotspots with function, file, line, time%
- **AI optimization prompts** — `buildOptimizationPrompt()` feeds top-5 hotspots to AI

## [ARCHIVED] 30. AWS Integration
*(Round 69 — `archive/enterprise-cloud/aws-integration.ts`)*

- **Lambda** — list functions, deploy zip, get config
- **S3** — list objects with prefix filtering
- **CloudWatch** — fetch recent logs by log group
- **CloudFormation** — generate templates from resource definitions
- **Auto-detect** — `isAWSConfigured()` checks for valid AWS credentials

## 31. SSO Authentication
*(Round 69 — `src/core/sso-auth.ts`)*

- **OIDC PKCE flow** — full OAuth 2.0 with code challenge (S256)
- **Local callback server** — listens on 127.0.0.1 for redirect
- **Token management** — persistent storage, refresh, expiry tracking
- **Provider support** — SAML, OIDC, GitHub, Google
- **Secure flow state** — per-flow state files with code verifier, auto-cleanup

## [ARCHIVED] 32. Cloud Sync
*(Round 70 — `archive/enterprise-cloud/cloud-sync.ts`)*

- **AES-256-GCM encryption** — all synced data encrypted at rest and in transit
- **Manifest-based reconciliation** — hash comparison, last-writer-wins conflict resolution
- **Sync sessions, config, and memory** across machines
- **Auto-sync timer** — configurable interval
- **Upload/download** individual items or full session directories

## 33. Self-Hosted Deployment
*(Round 70 — `src/core/self-hosted.ts`)*

- **Server config generator** — TLS, auth (token/OIDC/LDAP), storage (SQLite/Postgres), rate limits
- **Docker Compose generator** — complete docker-compose.yml with healthcheck
- **Dockerfile generator** — multi-stage Node 22 production image
- **Helm chart generator** — Chart.yaml, values.yaml, deployment template for Kubernetes

## 34. [ARCHIVED] Team Licensing
*(Round 70 — `src/core/team-licensing.ts`)* — ARCHIVED: SaaS features retired to archive/saas-modules/

- **HMAC-signed licenses** — tamper-proof license verification
- **Seat management** — allocate/deallocate per user, role-based (admin/developer/viewer)
- **Usage reporting** — per-user token and session stats for billing periods
- **Feature gating** — `hasFeature()` checks license for specific capabilities
- **Persistent storage** — license and seat data in `~/.cobra-commander/licensing/`

## 35. Visual Checkpoint Browser
*(Round 70 — `src/core/checkpoint-viewer.ts`)*

- **Timeline view** — Unicode tree visualization of checkpoint history
- **Diff between checkpoints** — unified diff with hunk parsing
- **File change tracking** — created/modified/deleted per checkpoint
- **One-click restore** — `restoreCheckpoint()` with automatic stash

## 36. CodeQL Integration
*(Round 70 — `src/core/codeql-integration.ts`)*

- **Database creation** — `createDatabase()` for any supported language
- **SARIF analysis** — `runAnalysis()` parses SARIF output into structured findings
- **Query suite discovery** — list available CodeQL query suites
- **Formatted reports** — severity icons, CWE tags, file:line locations

## 37. Custom Model Fine-Tuning
*(Round 70 — `src/core/model-tuning.ts`)*

- **Training data collection** — walks source tree, extracts function/class samples
- **Quality scoring** — heuristic quality filter (TODO/FIXME penalty, type annotation bonus)
- **Export formats** — JSONL (OpenAI chat format) and Alpaca format
- **Cost estimation** — tokens, estimated cost per provider, estimated training time

## 38. Embeddings Context Retrieval
*(Round 76 — `src/core/context-builder.ts`)*

- **`getSemanticContext()`** — TF-IDF vector similarity search across codebase files
- **Auto-build vector index** — builds on first query if missing, incremental updates
- **Context injection** — top-K relevant files automatically included in worker prompts
- **Score-ranked results** — returns files ranked by semantic similarity to the task

## 39. Tree-Sitter Repo Map
*(Round 76 — `src/core/repo-map.ts`, `src/core/tree-sitter-parser.ts`)*

- **AST-based symbol extraction** — replaces regex with tree-sitter for accurate parsing
- **Multi-language support** — TypeScript, JavaScript, Python, Java, Go, Rust, C, C++
- **Function signatures** — extract full parameter lists and return types
- **Class hierarchies** — detect inheritance and interface implementations
- **Enhanced repo map** — `buildEnhancedRepoMap()` with tree-sitter-powered symbol ranking

## 40. Automatic Context Compression
*(Round 76 — `src/core/context-compressor.ts`)*

- **Token-aware compression** — summarize conversation when approaching context limits
- **Selective preservation** — keeps recent exchanges intact, summarizes older ones
- **Configurable keep-last** — number of recent exchanges to preserve verbatim
- **Auto-trigger** — compresses automatically between tasks when enabled

## 41. Intelligent Error Recovery
*(Round 77 — `src/core/worker.ts`)*

- **`buildRetryPrompt()`** — parse errors, extract file:line locations, build targeted retry prompts
- **Context-aware retries** — includes ±5 lines around each error location in retry prompt
- **Repeat detection** — if same error appears 2+ times, switches to "try a completely different approach"
- **Structured error extraction** — uses `parseErrors()` for TSC, ESLint, Jest, and generic error formats

## 42. Auto Lint/Test Verification
*(Round 77 — `src/core/auto-verify.ts`)*

- **`autoVerifyAndFix()`** — automatically run linters and tests after every file change
- **Three-stage verification** — TypeScript compilation, ESLint, test runner (vitest/jest/npm test)
- **Targeted fix prompts** — "Fix ONLY these errors, do not change anything else"
- **Retry loop** — up to 3 attempts with re-verification after each fix
- **`VerifyResult`** — tracks attempts, fixed errors, remaining errors, pass/fail status

## 43. Map-Only Mode
*(Round 77 — `src/core/map-mode.ts`)*

- **`showMapOnly()`** — project tree with Unicode box-drawing, optional symbol extraction
- **Exported symbols per file** — functions, classes, interfaces shown inline
- **Summary stats** — "N files, M exports, K classes, J functions"
- **`showMapWithContext()`** — highlight files matching a query with `*` indicators
- **Extension filtering** — show only specific file types

## 44. Workflow Orchestration Engine
*(Round 78 — `src/core/workflow-engine.ts`)*

- **`WorkflowEngine`** — deterministic multi-agent workflow execution
- **4 step types** — `agent` (spawn worker), `parallel` (Promise.all), `pipeline` (sequential with chaining), `condition` (if/else branching)
- **Phase tracking** — progress events when entering new phases
- **`loadWorkflow()`** — load workflow definitions from JSON files
- **`/workflow run <file>`** — execute workflow from definition
- **`/workflow list`** — list saved workflows in `~/.cobra-commander/workflows/`

## 45. Specialized Agent Types
*(Round 78 — `src/core/agent-roles.ts`)*

- **4 predefined agent types** with restricted tool sets:
  - `Explore` — read-only search (read_file, list_files, grep_files, find_symbol, find_references)
  - `Plan` — software architect (read-only tools, no code modification)
  - `Reviewer` — code reviewer (read + diff_changes, no writes)
  - `Implementer` — full tool access (read, write, edit, grep, run_command)
- **`createTypedAgent()`** — spawn a Worker with agent-type-specific system prompt and tools
- **`getAgentType()`** — look up agent type by name

## 46. Git Worktree Isolation
*(Round 78 — `src/core/worktree-manager.ts`)*

- **`createWorktree()`** — `git worktree add` to `/tmp/cobra-worktrees/<branch>-<timestamp>`
- **`removeWorktree()`** — clean removal with dirty-check guard
- **`mergeWorktree()`** — commit pending changes, merge to target branch, report conflicts
- **`listWorktrees()`** — parse `git worktree list --porcelain`
- **`cleanupStaleWorktrees()`** — auto-remove worktrees older than 1 hour with no changes

## 47. Typed Memory System
*(Round 79 — `src/core/agent-memory.ts`)*

- **4 memory types** — `user`, `feedback`, `project`, `reference`
- **YAML frontmatter** — each memory file has name, description, type metadata
- **`TypedMemoryStore`** class — save/load/list/search/delete memories with frontmatter parsing
- **`[[link-name]]` references** — cross-reference related memories
- **`getRelated()`** — follow links to find connected memories
- **`updateIndex()`** — regenerate MEMORY.md index with one-line entries
- **Search** — full-text search across memory content and descriptions

## 48. Hierarchical Project Instructions
*(Round 79 — `src/core/project-instructions.ts`)*

- **3-level instruction hierarchy** — global (`~/.cobra-commander/INSTRUCTIONS.md`), project (`.cobra-commander/INSTRUCTIONS.md`), directory (`INSTRUCTIONS.md`)
- **`loadProjectInstructions()`** — walks directory tree, merges in priority order (directory > project > global)
- **`getInstructionsForContext()`** — returns combined instructions for injection into prompts
- **`createInstructionsFile()`** — write instructions at global or project level
- **`/instructions`** — show merged instructions, edit, or append

## 49. Ultrareview — Multi-Agent Code Review
*(Round 79 — `src/core/ultra-review.ts`)*

- **3-phase review pipeline**:
  - Phase 1 — **Find**: spawn parallel Workers per review dimension (bugs, security, performance, error-handling)
  - Phase 2 — **Verify**: for each finding, spawn a skeptic Worker prompted to refute it
  - Phase 3 — **Synthesize**: collect confirmed findings, deduplicate, sort by severity
- **Adversarial verification** — findings confirmed only if verifier cannot refute them
- **4 default dimensions** — bugs, security, performance, error-handling
- **`/ultrareview`** — run on current git diff, specific files, or selected dimensions

## 50. Web Search Tool
*(Round 80 — `src/core/web-tool.ts`)*

- **`webSearch()`** — structured search via DuckDuckGo HTML endpoint
- **`SearchResult`** interface — title, URL, snippet, source
- **URL validation** — validates all returned URLs
- **`searchAndSummarize()`** — format results as numbered markdown list
- **Configurable max results** — default 5

## 51. Monitor Tool — Process Streaming
*(Round 80 — `src/core/background-runner.ts`)*

- **`monitorProcess()`** — tail background job output, stream lines to callback
- **`until` pattern** — stop when output matches a pattern
- **`timeout` support** — stop after timeout milliseconds
- **`streamCommand()`** — spawn command, stream stdout/stderr in real-time, return exit code
- **`fs.watch()`-based** — detect new output without polling

## 52. Push Notifications
*(Round 80 — `src/core/notification.ts`)*

- **3 notification methods** — terminal bell, desktop notification, webhook POST
- **Cross-platform desktop** — `notify-send` (Linux), `osascript` (macOS), PowerShell (Windows)
- **`NotificationConfig`** — enable/disable methods, webhook URL
- **`notifyTaskComplete()`** — convenience wrapper for task completion notifications
- **Fail-silent** — gracefully handles unavailable notification methods

## 53. Persistent Cron Scheduling
*(Round 80 — `src/core/cron-scheduler.ts`)*

- **`parseCronExpression()`** — standard 5-field cron with `*`, `*/N`, `N-M`, `N,M`
- **`CronScheduler`** class — create/delete/enable/disable/list/getDue/markRun
- **Persistent storage** — JSON file at `~/.cobra-commander/cron-jobs.json`
- **`getDue()`** — find jobs whose nextRun <= now
- **`/cron list|add|remove|enable|disable`** — full CLI management

## 54. Jupyter Notebook Editing
*(Round 81 — `src/core/notebook.ts`)*

- **`readNotebook()`** — parse .ipynb JSON, normalize cell source arrays to strings
- **`writeNotebook()`** — serialize with source as string arrays, 1-space indent (Jupyter standard)
- **`editCell()`** — replace source, auto-clear outputs for code cells
- **`insertCell()`** / **`deleteCell()`** — add/remove cells at index
- **`formatNotebookForDisplay()`** — cell numbers, type indicators, inline outputs, markdown hints

## 55. Composer Mode — Multi-File Editing
*(Round 81 — `src/core/composer.ts`)*

- **`Composer`** class — multi-file editing with cross-file awareness
- **Auto-detect files** — use prompt + grep to find relevant files if not specified
- **Cross-file context** — sends all files to worker simultaneously
- **`preview()`** — unified diff with color (green additions, red deletions)
- **`apply()`** — write all edits to disk
- **`revert()`** — restore original content
- **`/compose <prompt>`** — start, preview, apply, or revert multi-file edits

## 56. Side-by-Side Visual Diff
*(Round 81 — `src/core/tui-diff.ts`)*

- **`sideBySideDiff()`** — split terminal width, show original and modified side by side
- **ANSI colors** — red background for deletions (left), green for additions (right)
- **Line numbers** on both sides
- **Line sync** — unchanged lines appear at same height
- **Line wrapping** — handles lines longer than half-width
- **`fileDiffSideBySide()`** — read file, diff against new content with file path labels

## 57. Language Version Migrations
*(Round 81 — `src/core/code-migrations.ts`)*

- **Python 2→3** — `print "x"` → `print("x")`, `raw_input` → `input`, `unicode` → `str`, `xrange` → `range`, `dict.has_key()` → `in`, `except Exception, e` → `except Exception as e`
- **Java 8→17** — anonymous classes → lambdas, `Optional.get()` → pattern matching, text blocks, records, `var` for locals
- **Node.js CommonJS→ESM** — `require()` → `import`, `module.exports` → `export`, `__dirname` → `import.meta.dirname`, `__filename` → `import.meta.filename`
- **`listMigrations()`** — enumerate all available migration definitions
- **Preview and apply** — see what would change before committing

## 58. Cascade Flow Polish
*(Round 82 — `src/core/cascade-flows.ts`)*

- **`CascadeStepStatus`** — per-step tracking (pending/running/completed/failed/skipped) with timing
- **`CascadeProgress`** — overall flow progress with step history and time estimates
- **`formatCascadeProgress()`** — visual progress bar `[████████░░░░░░░░] 50%`, status icons (✓/▸/○/✗/⊘), elapsed/estimated time
- **`recoverFromFailure()`** — recommends retry, skip, or abort based on retry count and dependencies
- **`formatStepTimeline()`** — Gantt-like timeline with Unicode block characters

## 59. Organization Model Customization
*(Round 82 — `src/core/model-tuning.ts`)*

- **`ModelTuner`** class — manage organizational coding profiles
- **`analyzeCodebase()`** — auto-detect naming conventions (camelCase/snake_case/PascalCase), indentation, import style, tech stack
- **`OrgProfile`** — patterns, style guide, tech stack, conventions
- **`tunePrompt()`** — inject organizational patterns as few-shot guidance into worker prompts
- **`/tune analyze|list|apply|show|delete`** — CLI management for org profiles

## 60. Sandbox Tightening
*(Round 82 — `src/core/sandbox.ts`)*

- **`SandboxPolicy`** — fine-grained: allowNetwork, allowFileWrite/Read, allowExec, writable/readable paths, allowed/blocked commands, maxProcesses, maxMemoryMB, timeoutSeconds
- **3 predefined policies** — `strict` (read-only, no exec), `standard` (write+exec, whitelisted commands), `permissive` (full access, minimal blocks)
- **`validateCommand()`** — blocked commands deny-first, path traversal detection, dangerous pattern detection (eval, backticks, pipe-to-shell)
- **`validateFileAccess()`** — path resolution, sensitive file blocking (.env, credentials, id_rsa, *.pem, *.key)
- **`createSandboxedRunner()`** — returns runner that validates every command and file access
- **`formatPolicyReport()`** — color-coded capability summary

## 61. Comprehensive Test Suite
*(Round 83 — `tests/`)*

- **96 tests across 10 test files** — all passing
- **Vitest framework** — globals enabled, `tests/**/*.test.ts` pattern
- **Test coverage**:
  - `config.test.ts` (7) — loadConfig defaults, worker pool, env vars, overrides
  - `session.test.ts` (7) — SessionManager lifecycle, save/load, branch
  - `error-parser.test.ts` (11) — TSC, ESLint, test, generic error parsing, fix prompts
  - `git-tracker.test.ts` (7) — dirty detection, checkpoints, change summary
  - `agent-memory.test.ts` (8) — simple + typed memory, YAML frontmatter, search
  - `notebook.test.ts` (9) — read/write/edit/insert/delete .ipynb
  - `code-migrations.test.ts` (13) — Python 2→3, Node CJS→ESM migrations
  - `cron-scheduler.test.ts` (10) — cron expression parsing, scheduler CRUD
  - `sandbox.test.ts` (13) — command validation, file access, sensitive file blocking
  - `composer.test.ts` (8) — compose, preview, apply, revert, status tracking

## 62. Documentation & Onboarding
*(Round 83 — `docs/`)*

- **`GETTING-STARTED.md`** — prerequisites, installation, config, API key setup, first delegation walkthrough
- **`ARCHITECTURE.md`** — ASCII diagrams, orchestrator↔worker flow, tool system, 60+ module descriptions, security model
- **`CLI-REFERENCE.md`** — complete command reference grouped by category (Session, Code, Git, Security, Tools, Config, Advanced)
- **`API-GUIDE.md`** — programmatic usage: Worker, Orchestrator, SessionManager classes, callbacks, custom tools, MCP
- **`EXAMPLES.md`** — 10 real-world usage examples with full command and expected output

## 63. Project Knowledge Persistence (R85)
`src/core/project-knowledge.ts` — learns codebase patterns over time and injects them into prompts.
- **`KnowledgeStore`** class — stores patterns in `.cobra-commander/knowledge.json`
- **`analyze()`** — scans codebase to detect naming, imports, testing, architecture, error handling, types patterns
- **`learn(filePath, content)`** — extract patterns from a single file, update confidence scores
- **`getPromptContext()`** — format learned patterns as worker prompt instructions
- Commands: `/knowledge analyze`, `/knowledge show`, `/knowledge reset`, `/knowledge inject`

## 64. Cross-File Refactoring Engine (R85)
`src/core/refactor-engine.ts` — safe rename and refactoring across files.
- **`findSymbolReferences()`** — grep + context to find all references, distinguishes definition/import/usage/type ref
- **`renameSymbol()`** — rename across all files with dry-run support, handles variables, functions, classes, interfaces, types
- **`previewRefactor()`** — colored diff preview of all changes
- Commands: `/refactor rename <old> <new> [--dry-run]`, `/refactor find <symbol>`

## 65. Automated Test Debugging (R85)
`src/core/test-debugger.ts` — run failing tests, analyze failures, auto-fix.
- **`runTests()`** — auto-detect vitest/jest/mocha/npm-test, run with verbose output
- **`parseTestFailures()`** — parse test output to extract test name, file, error, expected/actual, stack trace
- **`debugAndFix()`** — iterative fix loop: run → parse → build targeted fix prompt → worker fix → re-run (up to maxAttempts)
- Commands: `/test-debug`, `/test-debug --dry-run`

## 66. Enhanced Per-Directory Instructions (R85)
`src/core/project-instructions.ts` — per-directory and per-file instruction support (extends existing module).
- **`findDirectoryInstructions()`** — walk from file's directory up to workDir, collect `INSTRUCTIONS.md`/`.cobra-instructions`
- **`findFileInstructions()`** — check for `<filename>.instructions` next to target file
- **`getContextualInstructions()`** — merge global + project + directory + per-file instructions with dedup
- **`createDirectoryInstructions()`** — write `INSTRUCTIONS.md` in a given directory

## 67. Automated PR Review on GitHub (R86)
`src/core/auto-pr-review.ts` — automatically review PRs and post comments on GitHub.
- **`getPRDiff()`** — fetch PR diff via `gh api`
- **`reviewPR()`** — send diff to worker for multi-dimension review (bugs, security, perf, style), determine verdict
- **`postPRReview()`** — post review with inline comments via `gh api`
- **`setupPRWebhook()`** — create GitHub webhook config for `pull_request` events
- Commands: `/pr-review <number> [--dry-run]`, `/pr-review setup`

## 68. Dependency Update Automation (R86)
`src/core/dependency-updater.ts` — automated dependency updates with PR creation.
- **`checkOutdated()`** — runs `npm outdated --json`, `pip list --outdated`, `go list -m -u all`
- **`updateDependency()`** / **`updateAll()`** — update deps, skip breaking, rollback on test failure
- **`createUpdatePR()`** — create branch, commit, push, PR via `gh pr create`
- Commands: `/deps check`, `/deps update [--all] [--pr] [--dry-run]`

## 69. One-Click Deployer (R86)
`src/core/deployer.ts` — deploy apps to various targets.
- **`detectDeployTarget()`** — auto-detect from vercel.json, netlify.toml, Dockerfile, fly.toml, railway.toml
- **`deploy()`** — run appropriate deploy command per target (Vercel, Netlify, Docker, Fly, Railway, AWS Lambda)
- **`createDeployConfig()`** — generate config files with sensible defaults
- Commands: `/deploy [target]`, `/deploy init <target>`, `/deploy --status`

## 70. Cross-Repo Search Integration (R86)
`src/core/cross-repo-search.ts` — enhanced integration into main workflow (extends existing module).
- **`autoDiscoverRepos()`** — walk parent/sibling directories, find `.git/` directories
- **`formatCrossSearchResults()`** — results grouped by repo with colored output
- Commands: `/cross-search <query> [--repos dir1,dir2]`, `/cross-impact <file>`, `/cross-deps`

## 71. UI Code Generation from Screenshots (R87)
`src/core/ui-generator.ts` — generate UI code from screenshots or mockup descriptions.
- **`generateUIFromDescription()`** — build framework/styling-aware prompt, parse worker response to extract component files
- **`generateUIFromScreenshot()`** — read image as base64, build vision prompt, extract components
- **`scaffoldComponent()`** — generate boilerplate for React, Vue, Svelte, or HTML
- Commands: `/ui generate <description>`, `/ui screenshot <path>`, `/ui scaffold <name>` with `--framework` and `--styling` options

## 72. Database Schema Visualization (R87)
`src/core/db-visualizer.ts` — visualize database schemas in the terminal.
- **`introspectSchema()`** — connect to PostgreSQL via `psql`, query `information_schema` for tables, columns, foreign keys
- **`formatSchemaASCII()`** — Unicode box-drawing tables with colored PKs (cyan), FKs (yellow), nullable (dim)
- **`formatSchemaERD()`** — Mermaid-compatible `erDiagram` syntax
- **`generateMigration()`** — diff two schemas, generate ALTER TABLE statements
- Commands: `/db schema [--format ascii|mermaid] [--connection <url>]`, `/db migrate-diff`

## 73. API Endpoint Testing (R87)
`src/core/api-tester.ts` — interactive API endpoint testing from the CLI.
- **`testEndpoint()`** — send HTTP request, measure response time, compare to expected status
- **`runTestSuite()`** — run all tests sequentially with variable interpolation (`{{response.id}}`)
- **`generateTestSuite()`** — scan for route files/OpenAPI specs, have worker generate test requests
- **`formatTestResults()`** — show each test with ✓/✗, status code, duration, body preview
- Commands: `/api-test <url>`, `/api-test run <suite-file>`, `/api-test generate` with `--method`, `--body`, `--header`

## 74. Natural Language to SQL (R87)
`src/core/nl-to-sql.ts` — generate SQL queries from natural language.
- **`getSchemaContext()`** — detect Prisma/TypeORM/Drizzle/Sequelize/Knex/Mongoose schemas or parse SQL migrations
- **`nlToSQL()`** — send NL query with schema context to worker, extract SQL + explanation + confidence
- **`executeAndFormat()`** — execute SQL and format as terminal table
- Commands: `/ask-db <question> [--run] [--explain]`

## 75. Code Review Checklist Automation (R88)
`src/core/review-checklist.ts` — automated code review checklists based on project standards.
- Built-in templates: `default`, `security` (OWASP top 10), `frontend` (a11y, responsive), `api` (validation, versioning)
- **`generateChecklist()`** — run autoCheck functions against diff/files, calculate score (0-100)
- **`formatChecklist()`** — terminal checklist with `[✓]` passed, `[✗]` failed, `[ ]` unchecked, colored by severity
- Commands: `/checklist [--template security|frontend|api]`, `/checklist create <name>`

## 76. Performance Regression Detection (R88)
`src/core/perf-regression.ts` — detect performance regressions in code changes.
- **`analyzeComplexity()`** — parse functions, calculate cyclomatic complexity, loop depth, allocations, async ops
- **`saveBaseline()`** / **`detectRegressions()`** — save/compare baselines, flag >50% critical, >25% warning, >10% info
- **`formatPerfReport()`** — regressions in red, improvements in green, overall score bar
- Commands: `/perf baseline`, `/perf check`, `/perf report`

## 77. Accessibility Audit (R88)
`src/core/a11y-audit.ts` — automated accessibility checking of UI code.
- 10 built-in rules: img-alt, button-text, form-label, heading-order, color-contrast, focus-visible, aria-valid, link-text, lang-attr, tabindex
- **`auditFile()`** / **`auditProject()`** — scan HTML/JSX/TSX/Vue/Svelte files, calculate score with penalties
- **`formatA11yReport()`** — issues grouped by impact level with fix suggestions
- Commands: `/a11y [<file>] [--fix]`

## 78. License Compliance Checking (R88)
`src/core/license-checker.ts` — check licenses of dependencies for compliance.
- Default policy: MIT, Apache-2.0, BSD, ISC allowed; GPL-3.0, AGPL denied; LGPL, MPL need review
- **`scanLicenses()`** — read `node_modules/*/package.json` and `LICENSE*` files, support Python via pip
- **`checkCompliance()`** — check each dep against policy, mark compatible/incompatible/needs-review/unknown
- Commands: `/license check`, `/license report`, `/license policy`

## 79. CI Code Review Service (R89)
`src/core/ci-review.ts` — run code review as a CI pipeline step.
- **`runCIReview()`** — get git diff, run review dimensions (bugs, security, performance), determine exit code
- **`generateSARIF()`** — SARIF v2.1.0 compliant output for GitHub Code Scanning integration
- **`formatCIOutput()`** — machine-readable CI log format with severity counts
- **`generateGitHubAction()`** — generate `.github/workflows/cobra-review.yml` workflow file
- Commands: `/ci-review [--sarif]`, `/ci-review init`

## 80. Documentation Site Generator (R89)
`src/core/doc-site-gen.ts` — generate documentation sites from code.
- **`generateDocSite()`** — scan `docs/` for markdown, parse titles/order, build page tree, auto-gen API reference
- **`renderToHTML()`** — convert markdown to HTML with navigation sidebar, responsive CSS, dark mode support
- **`buildDocSite()`** — full build pipeline: config → render → write to `docs-site/`
- Commands: `/doc-site build`, `/doc-site preview`, `/doc-site config`

## 81. Automated CI Changelog (R89)
`src/core/auto-changelog.ts` — automated changelog from conventional commits.
- **`parseConventionalCommits()`** — parse `git log`, extract type(scope): description, detect BREAKING CHANGE
- **`determineNextVersion()`** — semver: breaking → major, feat → minor, else → patch
- **`formatChangelogMarkdown()`** — standard CHANGELOG.md format with type headers and commit hash links
- Commands: `/auto-changelog [--save] [--bump]`

## 82. Search Preview (R89)
`src/core/search-preview.ts` — code search with visual match preview.
- **`searchWithPreview()`** — grep with 2-line context before/after, highlight matches, group by file
- **`formatSearchPreview()`** — file headers in cyan, matches highlighted in yellow, context in dim
- **`searchAndReplace()`** — find-and-replace with dry-run mode, show preview of changes
- Commands: `/search <query> [--regex]`, `/search-replace <find> <replace> [--dry-run]`

## 83. AI Pair Programming Mode (R89)
`src/core/collab-mode.ts` — AI pair programming with shared context.
- **`startCollabSession()`** — create session with unique ID and project context
- **`shareFile()`** — read file content, add to shared context
- **`suggestChange()`** — send shared context + description to worker, return suggestion with diff preview
- **`applyCollabChange()`** — write file, log change in session messages
- Commands: `/collab start`, `/collab share <file>`, `/collab suggest <description>`, `/collab apply`, `/collab end`

---

## 84. JetBrains Extension (R91)
`gui/jetbrains/` — Kotlin IntelliJ Platform plugin for IntelliJ IDEA, PyCharm, WebStorm.
- **CobraClient** — OkHttp HTTP + WebSocket client to API server with auto-reconnect
- **CobraToolWindow** — right-panel chat UI with streaming response display
- **CobraAction** — 5 editor context menu actions: Explain, Refactor, Fix Bug, Security Scan, Open Chat
- **CobraInlineProvider** — inline completion provider connected to tab-completion endpoint
- **CobraSettings** — configurable API URL, auth token, model selection, auto-scan toggle
- **StatusWidget** — status bar widget showing connection status + active model
- **FindingsPanel** — security findings table with refresh from the scanner
- **CobraNotifier** — IDE notification integration for scan results and task completion
- Targets IntelliJ Platform 2024.1+ (Community Edition for broadest compatibility)

## 85. Real-Time Security Scanning (R91)
`src/core/realtime-scanner.ts` — incremental the scanner SAST scanning on file save.
- **`DVRealtimeScanner`** — connects to the scanner API for incremental SAST on individual files
- **File watcher** — `fs.watch` recursive on `src/` with 2-second debounce
- **Dual-mode scanning** — local pattern checks (instant) + the scanner API scan (async), results merged
- **Cache** — results cached by file path + mtime, avoids re-scanning unchanged files
- **scanner auth** — JWT token cached for 5 minutes, auto-refresh
- **60-second summary** — periodic display of files scanned, findings by severity
- Command: `/watch-security [start|stop|status]`
- Config: `autoSecurityScan` flag auto-starts when `--watch` is active

## 86. Batch Multi-Repo Changes (R91)
`src/core/batch-repo-changes.ts` — apply the same change across multiple repositories.
- **`BatchRepoChanger`** — orchestrates changes across repos sequentially
- **Workflow per repo**: checkout branch → delegate change to worker → tsc build → scanner scan → commit → push → create PR via `gh`
- **Dry-run mode** — preview which repos would be affected without making changes
- **Result tracking** — status per repo (success/failed/skipped), PR URLs, finding counts
- Commands: `batch-repo apply --repos <paths> --prompt "<change>" [--pr] [--scan] [--dry-run]`, `batch-repo status`

## 87. Cross-Repo Dependency Graph (R93)
`src/core/cross-repo-search.ts` — deep dependency tracking across repositories.
- **`DependencyGraph`** class with nodes, edges, serialization
- **6-phase scanner**: npm package deps, cross-repo imports, API endpoint detection (Express/Fastify routes + consumers), Docker Compose `depends_on`/`links`, shared TypeScript type imports
- **`analyzeImpact()`** — walks graph from changed repo outward, finds direct + transitive dependents, assesses risk level (low/medium/high/critical)
- **`visualizeGraph()`** — ASCII tree visualization with colored relationship arrows
- **`detectCircularDeps()`** — DFS-based cycle detection
- **Cache** — persists to `.multi-ide/dep-graph.json` with mtime-based invalidation
- Commands: `cross-deps graph`, `cross-deps impact <repo> [file]`, `cross-deps circular`, `cross-deps refresh`

## 88. Browser-Based Autonomous Dev Environment (R93)
`gui/web/src/components/workspace/` — full in-browser development workspace.
- **WorkspaceView** — 4-panel layout: file tree + plan, editor/diff, AI chat stream, terminal
- **TaskPlanner** — text input for task description, AI generates step-by-step plan, user can edit/reorder before executing
- **FileChangeReview** — per-file diff review with accept/reject/edit buttons, tracks accepted vs rejected changes
- **LiveTerminal** — xterm.js terminal with command execution and live output from AI-run commands
- **PlanProgress** — visual step tracker with progress bar, status dots, expandable details per step
- **useWorkspace hook** — manages workspace state, WebSocket subscriptions for real-time updates
- **10 API endpoints** in `src/api-server/routes/workspace.ts`: start, get state, approve, reject, stop, list changes, edit
- Sidebar navigation item added to App.tsx

## 89. Electron Desktop App (R94)
`gui/electron/` — native desktop application wrapping Web UI.
- **Main process** — starts API server in-process, creates BrowserWindow
- **System tray** — status indicator (green/yellow/red), right-click menu (Show/Hide, New Task, Quit)
- **Native menu** — File, Edit, View, Tasks, Security, Help
- **Global shortcuts** — Cmd/Ctrl+Shift+C to focus window, Cmd/Ctrl+Shift+T for new task
- **Preload bridge** — contextBridge exposing getApiPort, openFileDialog, saveFileDialog, showNotification, openExternal, getSystemTheme
- **Auto-updater** — electron-updater with GitHub Releases as source
- **Window state** — persist size/position via electron-store
- Ships as .dmg (macOS), .exe (Windows), .AppImage/.deb (Linux)

## 90. Tauri Desktop App (R94)
`gui/tauri/` — lightweight Rust-based alternative to Electron.
- **Process manager** — spawns cobra-commander API server as child Node.js process, max 3 auto-restarts, graceful shutdown
- **API bridge** — health-check polling for API server readiness
- **Tauri commands** — get_api_url, open_file_dialog, save_file_dialog, show_notification, get_platform, restart_server, get_server_status
- **System tray + native menu** — same UX as Electron version
- **Global shortcuts** — registered via tauri-plugin-global-shortcut
- ~10MB binary vs Electron's ~150MB, ~50MB RAM vs ~300MB
- Ships as .app/.dmg (macOS), .exe/.msi (Windows), .AppImage/.deb (Linux)

## 91. Neovim Extension (R94)
`gui/neovim/` — Lua-based Neovim plugin.
- **client.lua** — HTTP client to API server via plenary.curl or vim.system, WebSocket via vim.loop
- **chat.lua** — floating window chat UI with streaming response display
- **actions.lua** — code actions: explain selection, refactor, fix bug, security scan on current file
- **completion.lua** — nvim-cmp source for inline AI completions
- **telescope.lua** — telescope.nvim picker for sessions, findings, models
- **status.lua** — lualine component showing connection status + model name
- **findings.lua** — the scanner findings as vim diagnostics (signs, virtual text)
- Commands: `:CobraChat`, `:CobraExplain`, `:CobraRefactor`, `:CobraFix`, `:CobraScan`, `:CobraStatus`
- Install via lazy.nvim or packer

## 92. Visual Studio Extension (R94)
`gui/visual-studio/` — C# VSIX extension for Visual Studio 2022+.
- **CobraPackage** — AsyncPackage entry point with service registration
- **CobraClient** — HttpClient + WebSocket client to API server
- **ChatToolWindow** — WPF-based chat panel with XAML layout
- **FindingsToolWindow** — security findings table panel
- **Commands** — ExplainCommand, RefactorCommand, ScanCommand as editor context menu items
- **CobraSettings** — options page for API URL, model, auth token
- **CobraStatusBar** — status bar widget showing connection + model

## 93. Xcode Extension (R94)
`gui/xcode/` — Swift XcodeKit source editor extension.
- **CobraExtension** — XcodeKit SourceEditorExtension entry point
- **CobraCommand** — SourceEditorCommand with explain, refactor, fix, scan actions
- **CobraClient** — URLSession HTTP client to API server
- **CobraMenu** — editor menu items for all actions

## 94. Eclipse Extension (R94)
`gui/eclipse/` — Java Eclipse plugin with OSGi bundle.
- **CobraPlugin** — plugin activator
- **CobraClient** — HttpClient to API server
- **ChatView** — SWT chat view with send/receive
- **FindingsView** — findings table view
- **Command handlers** — ExplainHandler, RefactorHandler, ScanHandler
- **CobraPreferencePage** — settings page for API URL, model, token
- Built with Maven/Tycho, plugin.xml declares extension points

## 95. Previously Undocumented Features

Discovered during R95 competitive review — these modules exist and work but were missing from the manifest.

- **`api-tester.ts`** (404L) — API endpoint testing client with request builder, response validation, test suites
- **`deployer.ts`** (451L) — Multi-platform deploy: auto-detect target, deploy to Vercel/Netlify/Docker/Fly/Railway
- **`db-visualizer.ts`** — Database schema visualization, ASCII/Mermaid ERD generation
- **`nl-to-sql.ts`** — Natural language to SQL query conversion
- **`perf-regression.ts`** (463L) — Performance regression detection with complexity analysis and baselines
- **`a11y-audit.ts`** — Accessibility audit for UI code
- **`license-checker.ts`** — License compliance checking across dependencies
- **`notebook.ts`** — Jupyter-style notebook code execution
- **`project-runner.ts`** — Auto-detect and run project commands (build, test, lint, start)
- **`webhook-server.ts`** — Webhook server for CI integration
- **`doctor.ts`** — System diagnostics and health checks
- **`screenshot-analysis.ts`** (149L) — Screenshot analysis for UI verification
- **`thinking-display.ts`** (156L) — ANSI-formatted thinking/reasoning display
- **`ci-review.ts`** — CI-based code review with SARIF output
- **`project-init.ts`** — Project initialization wizard
- **`clipboard.ts`** — Cross-platform clipboard integration

## 96–111. R96–R98 Features (Complete)

- **96. Xcode Extension Expansion** — full extension with UI, settings, findings display
- **[ARCHIVED] 97. AWS SDK Integration** — real AWS SDK v3 replacing CLI wrapper (→ archive/enterprise-cloud/)
- **98. Offline Mode Hardening** — real network isolation, auto-configure local models
- **99. GitHub API Integration** — Octokit-based issues, PRs, Actions, review comments
- **100. Browser Automation** — Playwright-based real browser interaction
- **101. Enhanced @mentions** — @doc, @web, @git, @terminal, @pr mention types
- **102. CodeQL Integration Expansion** — SARIF parsing, CI workflow generation, baseline management
- **103. Extension Marketplace** — real local registry with install/update/search
- **104. Production Sandbox** — Docker isolation with network policies, resource limits, cleanup
- **105. AI Inline Code Completion** — FIM via the worker model, debounce, caching, API endpoint
- **106. Custom Slash Commands** — user-defined .cobra-commander/commands/*.md
- **107. Tab Completion AI Mode** — real AI code suggestions for IDE extensions
- **108. Web UI Production** — multi-tab editor, git panel, split panes, themes
- **109. VS Code Extension Depth** — inline diff, agent panel, security sidebar
- **110. Issue-to-PR Automation** — GitHub issue → branch → implement → PR
- **111. Streaming UI Polish** — spinners, progress bars, colored badges, boxed summaries

## 112–137. R104–R112 Features (Complete)

### Intelligence & Editing
- **112. Smart Apply** (`smart-apply.ts`, 473 lines) — Levenshtein fuzzy edit matching, SEARCH/REPLACE parser, applies LLM edits even when line numbers shift
- **113. Inline Diff Accept/Reject** (`inline-diff.ts`, 519 lines) — per-hunk accept/reject UI for IDE extensions
- **114. Tab Prediction** (`tab-predict.ts`, 502 lines) — AST-based next-edit prediction, suggests what to type next
- **115. Edit Block Parser** (`edit-block.ts`, 383 lines) — SEARCH/REPLACE block format parser for structured code edits
- **116. Diff Editor** (`diff-editor.ts`, 540 lines) — unified diff review with inline annotations

### Search & Context
- **117. Prompt Caching** (`prompt-cache.ts`, 496 lines) — Anthropic cache_control support, caches repeated context across calls (~50% cost reduction)
- **118. Embedding Search** (`embedding-search.ts`, 689 lines) — cosine similarity search, file chunking, codebase-wide semantic retrieval
- **119. Shadow Workspace** (`shadow-workspace.ts`, 599 lines) — temp directory fork for safe edits, tsc verify before applying
- **120. Code Graph** (`code-graph.ts`, 526 lines) — LSIF/SCIP index for cross-file go-to-definition, find-references

### Infrastructure as Code
- **121. IaC Generator** (`iac-generator.ts`, 919 lines) — Terraform + AWS CDK generation from natural language descriptions

### Code Transforms & Migrations
- **122. Code Transforms** (`code-transform.ts`, 413 lines) — tree-sitter AST-based transforms (rename, extract, inline, reorder)
- **123. Code Migrations** (`code-migrations.ts`, 657 lines) — AST-based language version migrations with preview and rollback
- **124. Workflow Flows** (`workflow-flows.ts`, 973 lines) — multi-step workflow cascades with progress visualization

### Security & Auth
- **125. SSO Auth** (`sso-auth.ts`, 250 lines) — OIDC PKCE flow for enterprise SSO integration
- **126. the scanner Auth Module** (`dv-auth.ts`) — unified the security scanner authentication, JWT extraction from Set-Cookie, token caching with TTL
- **127. the scanner Scan Runner SDK** (`dv-scan-runner.ts`, 314 lines) — high-level `runSASTScan()`, `runCodeReview()`, `getFindings()` with auto path translation

### Orchestration & Agents
- **128. the worker model Self-Orchestrator** (`orchestrator.ts`, 939 lines) — full multi-agent orchestration: `delegate_to_worker`, `delegate_parallel`, `delegate_chain`, `delegate_swarm`. Worker pool tiers (fast/standard/heavy), agent roles (implementer, tester, reviewer, refactorer, documenter), git tracking, retry logic
- **129. Agent Dashboard** (`agent-dashboard.ts`, 574 lines) — multi-agent progress tracking, real-time status, worker stats
- **130. Workflow Engine** (`workflow-engine.ts`, 441 lines) — deterministic workflow execution with retry, timeout, validation

### Benchmarks & Verification
- **131. SWE-Bench Harness** (`swe-bench.ts`, 472 lines) — automated benchmark task runner for evaluating code generation quality

### Protocol & Integration
- **132. MCP Client** (`mcp-client.ts`) — Model Context Protocol client for connecting to external tool servers
- **133. MCP Server** (`mcp-server.ts`) — expose cobra-commander as an MCP server for other tools to consume
- **134. Tree-sitter Parser** (`tree-sitter-parser.ts`, 757 lines) — multi-language AST parsing, symbol extraction, scope analysis

### Platform
- **135. Stub Scanner** (`stub-scanner.ts`) — scores modules for stub patterns, generates the worker model expansion task lists (`/stubfind`)
- **136. Scanner Path Translation** — auto-translates host paths to the paths a containerised scanner sees (e.g. host `/srv/projects/app` → container `/scan/app`)
- **137. Remediation Pipeline** — gates on both SAST + code review completing, trusts the scanner's the worker model-powered FP triage, queues true positives to worker

## 138–167. Sprint 1 — Worker Infrastructure & Reliability
*(Session 2026-06-22 — 30 new modules)*

### Observability & Worker State
- **Event Bus** (`event-bus.ts`) — singleton `workerEvents` with 12 event types (task.started, tool.called, tool.completed, turn.completed, compaction.triggered, doom.detected, task.completed, steering.injected, run.acquired, run.released, retry.waiting, retry.exhausted). 1000-event ring buffer with emit/on/history.
- **Worker Store** (`worker-store.ts`) — `WorkerStore` class with JSONL-based per-worker state persistence in `.worker-store/`. Tracks all lifecycle points: append, getWorkerState, getLatestEntry, getActiveWorkers, getWorkerSummary (turns, tools, errors, status), prune.
- **Worker Projector** (`worker-projector.ts`) — in-memory `Map<workerId, WorkerProjection>` refreshed from event bus. Fields: status, currentTool, turnsCompleted, lastActivity, totalTokens, errors. Exports `getWorkerProjection()`, `getAllProjections()`, `getWorkersByStatus()`.

### Worker Lifecycle & Safety
- **Worker Steering** (`worker-steering.ts`) — mid-task message injection: `steerWorker(workerId, message)` queues, `consumeSteerMessages(workerId)` drains each turn.
- **Worker Snapshot** (`worker-snapshot.ts`) — `createWorkerSnapshot()` via `git stash push` with `cc-snapshot` tag. `rollbackWorkerSnapshot()` pops matching stash. `listSnapshots()` and `cleanupSnapshot()`.
- **Worktree Isolation** (`worktree.ts`) — `createWorkerWorktree()` via `git worktree add` to `/tmp/cc-worktree-{id}`. `mergeWorktree()` merges worker branch, `cleanupWorktree()` removes worktree + branch. `listWorktrees()` parses porcelain output.
- **Doom Loop Detector** (`doom-loop-detector.ts`) — `DoomLoopDetector` class tracks last 6 tool calls, detects 3x identical (tool+input) combos, ignores `run_command`. 2-strike hard abort wired into worker.ts via `record()` returning `{ isDoom, count }`.
- **Cascading Cancel** — when doom detected: abort current worker → cancel siblings → propagate to orchestrator.
- **MAX_STEPS_PROMPT** — hard limit on worker turns with informative abort message.
- **Concurrency** (`concurrency.ts`) — `boundedParallel(items, fn, concurrency)` runs at most N concurrent promises, preserves input order.
- **File Lock** (`file-lock.ts`) — `withFileLock(path, fn)` provides cross-process file locking via mkdir with exclusive flag, PID+timestamp owner file, retry up to 50x at 100ms intervals, auto-cleanup on release.
- **Timeout** (`timeout.ts`) — `withTimeout(promise, ms, message?)` races promise against timer, rejects on timeout, cleans up on resolution.

### Context Management
- **Context Compaction** (`context-compaction.ts`) — `shouldCompact()` estimates tokens (chars/4), triggers at >80% of max. `compactMessages()` walks backwards, protects last 3 turns, truncates old tool outputs >2000 chars. `compactWithSummary()` does LLM-based compaction: splits head/tail, calls summarize callback using structured template. `handleOverflowError()` auto-compacts on detected overflow.
- **Context Overflow Detection** (`context-overflow.ts`) — `isContextOverflow(errorMessage)` tests against 14 regex patterns across Anthropic, OpenAI, the worker model, and generic providers.
- **Compaction Template** (`compaction-template.ts`) — structured template: Goal, Progress (Done/In Progress/Blocked), Key Decisions, Critical Context, Next Steps. `buildCompactionPrompt()` formats messages as truncated transcript.

### File Safety & Editing
- **Fuzzy Replacer** (`fuzzy-replacer.ts`) — `fuzzyReplace()` with 9-strategy chain: exact, trimmed, whitespace-normalized, indentation-flexible, line-anchor, escape-normalized, block-anchor (Levenshtein 0.6), context-aware (first/last 2 lines), multi-occurrence. Safety checks: 3x line ratio, 4x char ratio.
- **Tool Output Truncation** (`tool-output-truncation.ts`) — `truncateToolOutput()` saves full output to temp file, returns head+tail preview with path. `truncateShellOutput()` is tail-first variant: last 50 lines + first 20 (errors at end).
- **Path Guard** (`path-guard.ts`) — `resolveSafePath(root, filePath)` normalizes + resolves, verifies result stays within root, throws on traversal.
- **Ignore Patterns** (`ignore-patterns.ts`) — `IGNORE_DIRS` (14 directories: node_modules, .git, dist, etc.), `IGNORE_EXTENSIONS` (7 extensions: .log, .lock, .map, etc.). `shouldIgnore()` checks path segments and extension. Wired into grep-tool.ts.
- **Sampled Checksum** (`sampled-checksum.ts`) — `sampledChecksum(content)` does full SHA-256 (16-char hex) for <500K strings, 5-point sampled hash for larger.
- **Binary Detect** (`binary-detect.ts`) — `BINARY_EXTENSIONS` set of 28 binary extensions. `isBinaryFile()` checks extension then scans first 8KB for null bytes.
- **Bounded Fetch** (`bounded-fetch.ts`) — `collectBoundedBody()` reads response body, truncates at 500KB with marker. `boundText()` truncates raw text at limit.
- **MIME Detect** (`mime-detect.ts`) — `detectMimeFromBytes(buffer)` magic byte detection for 8 formats: PNG, JPEG, GIF, PDF, ZIP, GZIP, WebP, BMP.
- **BOM** (`bom.ts`) — `hasBom()`, `stripBom()`, `addBom()`, `preserveBom(original, modified)` ensures BOM consistency.

### Core Utilities
- **Command Arity** (`command-arity.ts`) — `COMMAND_ARITY` dictionary of 30+ commands with token arity (npm=2, curl=1, git=2, etc.). `extractCommandPrefix()` strips env vars/paths, looks up arity, returns command prefix.
- **Find Up** (`find-up.ts`) — `findUp(filename, startDir)` walks up directory tree looking for a file.
- **Async Queue** (`async-queue.ts`) — `AsyncQueue<T>` class with push/end/[Symbol.asyncIterator], buffer+waiters pattern for async iterable consumption.
- **Sanitize Surrogates** (`sanitize-surrogates.ts`) — `sanitizeSurrogates(text)` replaces unpaired UTF-16 surrogates with U+FFFD.
- **Lazy** (`lazy.ts`) — `lazy(factory)` returns `{ get(), reset(), loaded() }` with lazy-init and cache invalidation.
- **Monotonic ID** (`monotonic-id.ts`) — `monotonicId()` generates 26-char lexicographically sortable ID: base36 timestamp + counter + random.
- **Formatter Detect** (`formatter-detect.ts`) — `detectFormatter(workDir)` checks for prettier/biome/clang-format/rustfmt configs, returns `{ name, command, args }` or null.

---

## 168–179. Sprint 2 — Manager & Worker Polish
*(Session 2026-06-22 — 12 new/updated modules)*

### Orchestration Safety
- **Run Coordinator** (`run-coordinator.ts`) — `RunCoordinator` singleton prevents duplicate worker dispatch for same task key. `acquireRun()`/`releaseRun()`, `queueFollowUp()`/`drainFollowUps()`, `getActiveRuns()`, `isRunning()`. Emits `run.acquired`/`run.released` events on bus.
- **Process Registry** (`process-registry.ts`) — `ProcessRegistry` singleton tracks parent→child process trees. `registerProcess(parentPid, childPid, command)`, `unregisterProcess()`, `getChildren()` (direct), `getDescendants()` (BFS), `killTree(rootPid)` — SIGTERM all descendants depth-first, 2s grace, SIGKILL survivors. `cleanupDead()` removes dead PIDs.
- **Path Permissions** (`path-permissions.ts`) — `PathPolicy` with `allowed`/`denied` glob patterns. `checkPathPermission(filePath, policy)` — denied takes precedence, supports `**`, `*`, prefix matching. Whitelist mode: if `allowed` specified, only those paths permitted.

### File Operations Polish
- **Line Endings** (`line-endings.ts`) — `detectLineEnding(content)` counts `\r\n` vs `\n`, returns majority. `normalizeForMatching()` replaces all `\r\n` with `\n`. `restoreLineEndings(content, ending)` normalizes then converts to target. Wired into edit flow.
- **Operation Revert** (`operation-revert.ts`) — per-operation undo via JSONL patch tracking in `.worker-store/{workerId}-patches.jsonl`. `recordOperation(workerId, opIndex, patches)`, `revertOperation()` applies reverse patches (only if current matches after), `listOperations()`.
- **Auto-Format Wiring** (`file-tools.ts` updated) — `autoFormat(filePath, workDir)` invoked post-edit/write via `detectFormatter()`, non-fatal on failure.
- **"Did You Mean?" Suggestions** (`file-tools.ts` updated) — `suggestSimilarFiles(dir, target)` — Levenshtein ≤2 + prefix match, top-3 suggestions on ENOENT.
- **BOM Preservation Wiring** (`file-tools.ts` updated) — `writeBomAware(filePath, content, originalContent)` preserves BOM using `preserveBom()` from bom.ts.
- **LSP Diagnostics Wiring** — LSP diagnostics run after edits via `autoFormat()` pipeline, reported back to worker.

### Context & Observability Extensions
- **Token-Budget Compaction** (`context-compaction.ts` updated) — `compactByTokenBudget(messages, summarize, tailBudgetTokens?)` — token-aware split (estimates tokens as chars/4), walks backwards to fill 8K tail budget, pulls error messages into tail, only compacts if freeing >5K tokens.
- **Retry Events on Bus** (`event-bus.ts` + `providers/openai-compatible.ts` updated) — 4 new event types: `run.acquired`, `run.released`, `retry.waiting`, `retry.exhausted`. `RetryHook` interface wired into retry paths (network errors + HTTP 429/5xx). Callers connect to event bus for orchestrator visibility.

---

## Feature Backlog — Competitive Parity & Beyond

### Tier 1 — Critical (directly affects output quality)

| # | Feature | Source | Module | Status |
|---|---------|--------|--------|--------|
| BL-101 | Embeddings context retrieval — wire vector-index.ts into context-builder.ts | Cursor, Windsurf, Cody | `context-builder.ts` | Done (R76) |
| BL-102 | Intelligent error recovery — parse errors, modify retry prompts with targeted fixes | Claude Code, Cursor, Aider | `worker.ts`, `verification.ts` | Done (R77) |
| BL-103 | Tree-sitter repo map — replace regex symbol extraction with tree-sitter AST | Aider | `repo-map.ts`, `tree-sitter-parser.ts` | Done (R76) |
| BL-104 | Auto lint/test verification — run linters+tests after every change, auto-fix on failure | Aider | `auto-verify.ts`, `error-parser.ts` | Done (R77) |
| BL-105 | Automatic context compression — summarize conversation when approaching context limits | Claude Code | `session.ts`, `orchestrator.ts` | Done (R76) |
| BL-106 | Workflow orchestration engine — deterministic multi-agent scripts with pipeline/parallel/phase/schema output | Claude Code | `workflow-engine.ts` (new) | Done (R78) |

### Tier 2 — High (competitive differentiation)

| # | Feature | Source | Module | Status |
|---|---------|--------|--------|--------|
| BL-201 | Typed memory system — user/feedback/project/reference memories with frontmatter, [[links]], MEMORY.md index | Claude Code | `agent-memory.ts` | Done (R79) |
| BL-202 | Hierarchical project instructions — CLAUDE.md-style config files (repo root, subdirs, user-level) | Claude Code | `project-instructions.ts` (new) | Done (R79) |
| BL-203 | Ultrareview — multi-agent code review with parallel dimension reviewers + adversarial verification | Claude Code | `ultra-review.ts` (new) | Done (R79) |
| BL-204 | Specialized agent types — typed subagents (Explore, Plan, Reviewer) with restricted tool sets | Claude Code | `agent-roles.ts` | Done (R78) |
| BL-205 | Git worktree isolation — temporary worktrees for parallel agent editing without conflicts | Claude Code | `worktree-manager.ts` (new) | Done (R78) |
| BL-206 | Composer mode — multi-file editing with cross-file awareness and visual diff | Cursor | `composer.ts` (new) | Done (R81) |
| BL-207 | Side-by-side visual diff — rich terminal diff with side-by-side columns | Cursor, Windsurf, Aider | `tui-diff.ts` | Done (R81) |
| BL-208 | Map-only mode — show repo map for context without acting | Aider | `map-mode.ts` | Done (R77) |

### Tier 3 — Medium (ecosystem & polish)

| # | Feature | Source | Module | Status |
|---|---------|--------|--------|--------|
| BL-301 | Web search tool — structured search (not just fetch) | Claude Code, Codex CLI | `web-tool.ts` | Done (R80) |
| BL-302 | Monitor tool — stream stdout from background processes as live events | Claude Code | `background-runner.ts` | Done (R80) |
| BL-303 | Push notifications — notify mobile/desktop when background work completes | Claude Code | `notification.ts` (new) | Done (R80) |
| BL-304 | Persistent cron scheduling — cron tasks that survive session restarts | Claude Code | `cron-scheduler.ts` (new) | Done (R80) |
| BL-305 | Jupyter notebook editing — native .ipynb cell read/edit/execute | Claude Code | `notebook.ts` (new) | Done (R81) |
| BL-306 | Language version migrations — Java 8→17, .NET Framework→Core, Python 2→3 | Amazon Q | `code-migrations.ts` | Done (R81) |
| BL-307 | Cascade flow polish — better step visualization, progress UI, error recovery | Windsurf | `cascade-flows.ts` | Done (R82) |
| BL-308 | Organization model customization — fine-tune on org codebase patterns | Amazon Q | `model-tuning.ts` | Done (R82) |
| BL-309 | Sandbox tightening — default sandboxed execution with opt-out | Codex CLI | `sandbox.ts` | Done (R82) |
| BL-310 | Comprehensive test suite — unit tests for all core modules | Internal | `tests/` | Done (R83) |
| BL-311 | Documentation & onboarding — getting-started guide, API docs, examples | Internal | `docs/` | Done (R83) |

### Tier 4 — Competitive Review Gap Closure (R84 analysis)

| # | Feature | Source | Module | Status |
|---|---------|--------|--------|--------|
| G-01 | Inline code completion — real-time autocomplete as you type | Copilot, Cursor, Tabnine | — | Excluded (IDE feature) |
| G-02 | IDE agent bridge — protocol for VS Code/JetBrains integration | Continue, Cline, Copilot | — | Excluded (IDE feature) |
| G-03 | Project knowledge persistence — learn codebase patterns over time | Cursor, Windsurf | `project-knowledge.ts` | Done (R85) |
| G-04 | Cross-file refactoring engine — safe rename across all files | JetBrains AI, Cursor | `refactor-engine.ts` | Done (R85) |
| G-05 | Automated PR review on GitHub — review PRs and post comments | Codex CLI, Copilot | `auto-pr-review.ts` | Done (R86) |
| G-06 | Per-directory custom instructions — INSTRUCTIONS.md per folder/file | Claude Code | `project-instructions.ts` | Done (R85) |
| G-07 | UI code generation from screenshots — generate components from images | Cursor, v0 | `ui-generator.ts` | Done (R87) |
| G-08 | Automated test debugging — run failing tests, analyze, auto-fix | Cursor, Aider | `test-debugger.ts` | Done (R85) |
| G-09 | Dependency update automation — outdated checks + PR creation | Dependabot, Renovate | `dependency-updater.ts` | Done (R86) |
| G-10 | Cross-repo search integration — search across multiple repos | Cody, Copilot Workspace | `cross-repo-search.ts` | Done (R86) |
| G-11 | Voice-to-code improvement — voice input for commands | — | — | Excluded (hardware feature) |
| G-12 | Browser-based coding — web IDE interface | Cursor, Windsurf | — | Excluded (different product) |
| G-13 | One-click deployer — deploy to Vercel/Netlify/Docker/Fly/Railway | — | `deployer.ts` | Done (R86) |
| G-14 | Database schema visualization — terminal ASCII/Mermaid ERD | — | `db-visualizer.ts` | Done (R87) |
| G-15 | API endpoint testing — interactive HTTP testing from CLI | — | `api-tester.ts` | Done (R87) |
| G-16 | Natural language to SQL — convert questions to SQL queries | — | `nl-to-sql.ts` | Done (R87) |
| G-17 | Code review checklist automation — automated checklists with templates | — | `review-checklist.ts` | Done (R88) |
| G-18 | Performance regression detection — complexity analysis + baselines | — | `perf-regression.ts` | Done (R88) |
| G-19 | Accessibility audit — automated a11y checking of UI code | — | `a11y-audit.ts` | Done (R88) |
| G-20 | License compliance checking — scan deps for license policy violations | — | `license-checker.ts` | Done (R88) |
| G-21 | AI pair programming mode — shared context collaboration | — | `collab-mode.ts` | Done (R89) |
| G-22 | CI code review service — review as CI step with SARIF output | — | `ci-review.ts` | Done (R89) |
| G-23 | Documentation site generator — generate HTML doc sites from markdown | — | `doc-site-gen.ts` | Done (R89) |
| G-24 | Automated CI changelog — changelog from conventional commits | — | `auto-changelog.ts` | Done (R89) |
| G-25 | Search preview — code search with visual match preview | — | `search-preview.ts` | Done (R89) |

---

## Competitors

For reference, the primary competitors in this space:

1. **Claude Code** (Anthropic) — CLI AI coding, premium pricing
2. **Cursor** — IDE with AI, subscription model
3. **Aider** — open source CLI AI coding
4. **Continue** — open source IDE extension
5. **Cline** — VS Code AI extension
6. **Windsurf** — AI-native IDE
7. **Amazon Q Developer** — AWS AI coding
8. **GitHub Copilot** — code completion + chat
9. **Codex CLI** (OpenAI) — CLI AI coding
10. **JetBrains AI** — IDE-integrated AI
11. **Tabnine** — AI code completion
12. **Sourcegraph Cody** — code intelligence + AI

### Unique differentiators:
- **Self-auditing AI loop** — the worker model writes code, the scanner (powered by the worker model) scans it, findings feed back for the worker model to fix
- **the worker model self-orchestration** — the worker model can split tasks, spawn child workers, monitor progress, retry failures
- **Multi-model cost optimization** — a strong model orchestrates while cheaper workers implement, with up to 6 parallel workers
- **Integrated security scanning** — no competitor has built-in SAST/DAST/SCA/fuzz/container/SBOM/compliance
- **Real-time security scanning** — incremental the scanner SAST on every file save with debounce
- **Build-scan-fix loop** — autonomous security remediation with the scanner-powered FP triage
- **9-strategy fuzzy edit engine** — cascading match from exact to Levenshtein block-anchor, surpasses Cursor/Aider
- **12-event worker observability** — real-time event bus, per-worker JSONL persistence, in-memory projections
- **Mid-task worker steering** — inject instructions into running workers without restart or context loss
- **Doom loop 2-strike kill** — detect repetitive tool calls, redirect once, hard-abort on second offense
- **Per-operation undo** — revert individual file edits without rolling back entire worker output
- **Run coordinator** — prevent duplicate worker dispatch, queue follow-up work for busy task keys
- **Process tree kill** — track spawned processes, SIGTERM→SIGKILL cascading cleanup on cancel
- **Token-budget context compaction** — LLM-summarized context with structured template, auto on overflow
- **Path-based worker permissions** — glob-based allowed/denied policies enforced at tool layer
- **Git worktree isolation** — parallel workers get isolated worktrees, auto-merge on success
- **Prompt caching** — ~50% cost reduction via Anthropic cache_control
- **Cross-repo dependency graph** — 6-phase scanner, impact analysis, circular dep detection
- **Batch multi-repo changes** — apply same change across repos with auto-PR creation
- **Browser-based autonomous workspace** — full dev environment in browser with task planning, file review, live terminal
- **7 IDE extensions** — VS Code, JetBrains, Neovim, Visual Studio, Xcode, Eclipse (all connect to shared API server)
- **2 desktop apps** — Electron (full-featured) and Tauri (lightweight ~10MB)
- **Workflow orchestration engine** — deterministic multi-agent scripts with pipeline/parallel/condition
- **Ultrareview** — adversarial multi-agent code review (find → verify → synthesize)
- **Composer mode** — cross-file-aware multi-file editing with preview/apply/revert
- **Encrypted credential vault** — machine-locked AES-256-GCM with auto-refresh from the scanner
- **Full DevOps toolkit** — deploy, deps update, license compliance, perf regression, a11y audit, API testing
- **An IDE for AI, not for humans** — designed for autonomous agent workflows, not human typing

### Service Daemon & API
- systemd service daemon — auto-starts on boot, restarts on failure, graceful shutdown
- Loopback-bound API server — configurable port (default 4100), token-gated, Bearer auth on all /api/ routes
- API token generation — random 256-bit hex, stored in .env + ~/.cobra-commander/api-token
- Full REST API — files, terminal/exec, search, tasks, completions, git, security, models, generation
- Smoke test suite — health, auth gate (401 without token), CORS, latency (<200ms)
- Install script — `sudo ./install-service.sh` for system-level, user-mode fallback
- the worker model direct agent session — web shell spawns full agentic REPL (not a chat relay)

### Remote Control & Distribution (R122-R125)
- Remote control server — opt-in WebSocket server (default port 4101), binds to loopback, Tailscale or an explicit address
- PTY bridge — the worker model tech lead terminal (assistant-repl.ts), full agentic session with tool access
- Web shell SPA — xterm.js terminal + chat panel, mobile-first iPhone UI, PWA installable
- Chat bridge — direct the worker model tech lead session (no Worker pipeline), tool noise suppressed, user sees only final responses
- PAM authentication gate — login page, session cookies, rate limiting, auth middleware
- Pluggable auth providers — PAM, database (SQLite/Postgres), OIDC, custom webhook, configurable via .env
- Remote control .env configuration — REMOTE_ENABLED, REMOTE_BIND, REMOTE_AUTH_MODE, all settings in env
- Install script (install.sh) — curl-pipeable, OS detection, prerequisites check, clone + setup
- Configuration wizard — interactive CLI first-run: provider selection, API keys, worker config, the scanner toggle, telemetry
- Opt-in telemetry — anonymous usage stats, no code/prompts/PII, disabled by default

### AI Performance & Code Generation (R126-R127)
- Local completion model — ONNX Runtime integration, quantized INT8 loader, FIM fill-in-middle, <50ms latency target
- Fine-tuning framework — dataset builder from codebase history, LoRA config generator, training job scheduler
- Training pipeline — HuggingFace export, Axolotl/Llama-Factory config, eval harness (pass@k), checkpoint registry
- Full app generation — project scaffold from prompt, incremental file generation, iterate-until-done loop
- [ARCHIVED] Real-time multiplayer coding — CRDT-based shared editing (Yjs), WebRTC signaling, cursor presence/awareness — retired to archive/saas-modules/
- Air-gap deployment — offline bundle builder, private registry push, K8s NetworkPolicy templates, offline JWT license activation
- API integration tests — health, completions, file ops, search, sessions (node:test + fetch)

---

## 138–169. Worker Intelligence & Orchestration Platform (Sprint 1 + Sprint 2)

### Worker Edit Intelligence
- **138. 9-Strategy Fuzzy Edit Engine** (`fuzzy-replacer.ts`) — cascading edit matching: exact → trimmed → whitespace-normalized → indentation-flexible → line-anchor → escape-normalized → block-anchor (Levenshtein 0.6 threshold) → context-aware (first/last 2 lines) → multi-occurrence. Safety: 3x line ratio + 4x char ratio guards prevent catastrophic edits.
- **139. Auto-Format After Edits** (`file-tools.ts`) — every successful write/edit automatically runs the detected project formatter (prettier, biome, clang-format, rustfmt). Non-fatal — never blocks a good edit. Eliminates format-related CI failures.
- **140. Line Ending Preservation** (`line-endings.ts`) — detects \r\n vs \n, normalizes for matching, restores original endings post-edit. Prevents silent file corruption in cross-platform repos.
- **141. BOM-Aware File Writing** (`file-tools.ts`) — detects and preserves UTF-8 BOM during edits. Workers never corrupt BOM-prefixed files.
- **142. "Did You Mean?" File Suggestions** (`file-tools.ts`) — on ENOENT, scans directory for similar filenames (Levenshtein ≤ 2 + prefix match), returns top-3 suggestions. Saves workers 1 turn per wrong path.
- **143. Intelligent Tool Output Truncation** (`tool-output-truncation.ts`) — tail-first shell output (errors are at the bottom), head+tail for general output. Full output saved to temp file with path reference.

### Worker Observability & Control
- **144. Real-Time Worker Event Bus** (`event-bus.ts`) — 12 typed event types (task/tool/turn/compaction/doom/steering/retry/run lifecycle), 1000-event ring buffer, subscribe/emit/history API. Foundation for all observability.
- **145. Per-Worker State Persistence** (`worker-store.ts`) — JSONL append-only per-worker state in `.worker-store/`. Track starts, turns, tools, errors, compactions, steers, completions. Query active workers, get summaries.
- **146. Mid-Task Worker Steering** (`worker-steering.ts`) — inject messages into running workers without restart. Orchestrator can redirect approach, add constraints, or provide hints mid-execution.
- **147. Worker Projector** (`worker-projector.ts`) — in-memory event-driven state materializer. Subscribes to event bus, maintains current projection per worker (status, currentTool, turns, tokens, errors). Instant queries without JSONL scanning.
- **148. MAX_STEPS_PROMPT Injection** (`worker.ts`) — at 90% of turn limit, injects "summarize and wrap up" prompt. Workers finish gracefully instead of dying mid-thought.

### Worker Safety & Recovery
- **149. Doom Loop 2-Strike Hard Abort** (`doom-loop-detector.ts` + `worker.ts`) — detects 3x identical tool calls, first strike redirects ("try a completely different approach"), second strike hard-kills the worker. No more infinite loops burning tokens.
- **150. Per-Operation Revert** (`operation-revert.ts`) — records file patches per tool call in JSONL. Revert individual operations without rolling back an entire worker's output. Enables "accept 90% of worker's work."
- **151. Git Snapshot Rollback** (`worker-snapshot.ts`) — git stash-based snapshots at worker start. Full rollback if a worker goes off the rails.
- **152. Git Worktree Isolation** (`worktree.ts`) — parallel workers get isolated git worktrees. No file conflicts between concurrent workers. Auto-merge on success, auto-cleanup on failure.
- **153. Cascading Cancellation** (`worker.ts`) — cancel a worker and all its child processes die too. Clean resource reclamation.

### Orchestrator Intelligence
- **154. Run Coordinator** (`run-coordinator.ts`) — prevents duplicate worker dispatch for the same task. Acquire/release/queue follow-ups. Emits run.acquired/run.released events. No more two workers fixing the same bug.
- **155. Process Registry** (`process-registry.ts`) — tracks parent→child PID trees. `killTree()` does SIGTERM depth-first, 2-second grace, then SIGKILL survivors. No orphaned tsc/node processes after worker kill.
- **156. Path-Based Permissions** (`path-permissions.ts`) — glob-based allowed/denied path policies. Orchestrator can restrict workers to specific directories. Denied takes precedence. Enforced in file-tools before every write.
- **157. Retry Event Visibility** (`openai-compatible.ts` + `event-bus.ts`) — RetryHook emits retry.waiting and retry.exhausted events. Orchestrator can distinguish "worker waiting on rate limit" from "worker stuck in loop."
- **158. Stale Worker Detection** (`worker-projector.ts`) — `getStaleWorkers(thresholdMs)` finds workers with no activity for >N minutes. Wired into orchestrator dispatch — warns before spawning new work if workers are stuck.
- **159. Reactive Event Bus Wiring** (`reactive-bus.ts` + `orchestrator.ts`) — `initReactiveBus()` wires retry.exhausted→escalation.triggered, doom.detected→doom.cancelled, task.completed→run release. Orchestrator subscribes to escalation.triggered (log + re-dispatch to heavy tier) and doom.cancelled (mark task failed). Called at daemon startup.
- **160. Circuit Breaker Integration** (`circuit-breaker.ts` + `orchestrator.ts`) — CircuitBreaker monitors retry.exhausted events on the event bus; 3 consecutive failures opens breaker (5min cooldown, half-open probe). `circuitBreaker.recordSuccess()` called after every successful delegation (parallel/chain/pipeline). `circuitBreaker.isOpen()` checked before dispatch. `GET /api/v1/circuit-breaker` exposes state and failure count.

### Context Management
- **159. LLM-Based Context Compaction** (`context-compaction.ts`) — summarizes older conversation via LLM callback, preserves recent messages verbatim. Structured template: Goal, Progress, Key Decisions, Critical Context, Next Steps.
- **160. Token-Budget Compaction Split** (`context-compaction.ts`) — walks backwards filling an 8K token tail budget, sends everything above to summarizer. Protects error messages in tail. Only fires if freeing >5K tokens.
- **161. Context Overflow Detection** (`context-overflow.ts`) — 14 regex patterns detecting overflow errors across Anthropic, OpenAI, the worker model, and generic providers. Auto-triggers compaction on detection.

### Infrastructure Utilities
- **162. Cross-Process File Locking** (`file-lock.ts`) — mkdir with exclusive flag, PID+timestamp owner file, 50 retries at 100ms. Safe for multiple concurrent workers on the same filesystem.
- **163. Binary File Detection** (`binary-detect.ts`) — 28-extension set + null-byte scan of first 8KB. Prevents workers from reading/editing binary files.
- **164. Bounded HTTP Fetch** (`bounded-fetch.ts`) — truncates response bodies at 500KB with marker. Prevents OOM from large responses.
- **165. Path Traversal Guard** (`path-guard.ts`) — normalize+resolve, verify stays within root. Throws on any traversal attempt.
- **166. Promise Timeout Wrapper** (`timeout.ts`) — race any promise against a timer, reject on timeout, cleanup on resolution.
- **167. Sampled Checksum** (`sampled-checksum.ts`) — full SHA-256 for <500K, 5-point sampled hash for larger strings. Fast integrity checks.
- **168. Monotonic IDs** (`monotonic-id.ts`) — 26-char lexicographically sortable IDs: base36 timestamp + counter + random. No UUIDs needed.
- **169. Bounded Concurrency Pool** (`concurrency.ts`) — `boundedParallel(items, fn, concurrency)` — async worker pool, preserves order, limits active promises.

---

## 170–176. Sprint 3 — Final Polish & Throughput
*(Session 2026-06-22 — 7 modules)*

### Snapshot & Editing
- **170. Shadow Git Snapshots** (`shadow-snapshot.ts`) — uses separate `--git-dir` in `.worker-store/shadow.git` instead of polluting the project's git stash. Parallel workers' snapshots never conflict. File-locked via `withFileLock()`.
- **171. Apply Unified Diff Tool** (`apply-patch.ts`) — accepts unified diff text, parses hunks with `@@` markers, applies sequentially with line offset tracking. Atomic: all hunks succeed or all revert. Registered as `apply_unified_diff` worker tool with path-permissions + operation-revert + auto-format.

### Orchestration
- **172. Worker Job Bridge** (`worker-jobs.ts`) — links `process-registry` PIDs to worker semantics. `registerWorkerJob(workerId, pid, jobType, command)`, `cancelJobType(workerId, type)`, `getWorkerJobs(workerId)`. Auto-detects job type (tsc/dv-scan/shell) on spawn.
- **173. Steer Ordering & Priority** (`worker-steering.ts` updated) — sequence numbers + priority field (`immediate` | `queued`). `consumeSteerMessages()` returns immediate-first, then queued by sequence. Prevents contradictory steer collisions.

### Throughput
- **174. Multi-Key API Rotation** (`key-rotator.ts`) — `KeyRotator` class round-robins across multiple API keys. 60-second cooldown on 429'd keys. Wired into config: comma-separated `WORKER_API_KEY` values auto-enable rotation.
- **175. Incremental TypeScript Checking** (`shell-tool.ts` updated) — automatically adds `--incremental` when workers run `tsc --noEmit`. 5-10x faster on subsequent checks. `.tsbuildinfo` managed automatically.
- **176. Generic Work Pool** (`work-pool.ts`) — `workPool<T,R>(items, concurrency, fn): Promise<R[]>` — bounded parallel execution with preserved order. 20 LOC utility used by orchestrator internals.

---

## 177. 2026-07-05 — Support Agent Hardening

### Destro Agent Hardening
- **177. System-Critical Path Guardrails** (`destro-shell.ts`, `destro-agent.ts`) — hard block on writes to 22 system-critical paths (`/etc/docker/`, `/etc/systemd/`, `/etc/nginx/`, `/etc/ssh/`, etc.) via any mechanism (sudo tee/cp/mv, sed -i, redirects, install). Read access remains allowed. Defense-in-depth check at both shell and agent-loop levels. Shared-stack awareness table in system prompt covers Docker daemon, Node/npm, Redis, PostgreSQL, nginx, Python, ports, networks, and system packages — Destro must ask "what else uses this?" before any shared infrastructure change.

## Archived Features (archive/saas-modules/)

The following SaaS/commercial features have been retired. Code is preserved in `archive/saas-modules/` and can be restored.

| Module | Lines | What It Was |
|--------|-------|-------------|
| pricing-page.ts | 385 | Pricing tiers (free/pro/team/enterprise), seat billing, feature matrices |
| support-ticketing.ts | 487 | Support ticket system, SLA tiers, escalation chains, auto-triage |
| procurement-billing.ts | 496 | Enterprise procurement, POs, invoices, quote generation |
| free-trial.ts | 291 | 14-day pro trial, token budgets, feature gating, graceful downgrade |
| multiplayer-coding.ts | 650 | OT-based collaborative editing, cursor tracking, shared sessions |
| community-edition.ts | — | Community edition feature gating |
| routes/pricing.ts | — | API route for pricing page |
| routes/support.ts | — | API route for support tickets |
| routes/billing.ts | — | API route for billing/procurement |
| routes/collaboration.ts | — | API route for multiplayer sessions |
| src/pricing/ | — | Pricing module directory |
| src/support/ | — | Support module directory |
| src/billing/ | — | Billing module directory |
| src/tiers/ | — | Tier/trial module directory |

## Archived Features (archive/enterprise-cloud/)

Enterprise cloud integrations retired. Code preserved in `archive/enterprise-cloud/` for future restoration.

| Module | Lines | What It Was |
|--------|-------|-------------|
| aws-integration.ts | 881 | Lambda, S3, CloudWatch, CloudFormation, credential detection |
| azure-integration.ts | 767 | Azure resource groups, App Service, Functions, Blob Storage |
| gcp-integration.ts | 519 | GCP Cloud Functions, Cloud Storage, Cloud Run |
| cloud-vm.ts | 996 | Docker-based cloud VM management, container orchestration |
| cloud-sync.ts | 266 | AES-256-GCM encrypted sync across machines |
| cloud-agents.ts | 1161 | Multi-agent cloud orchestration, container spawning |
| cloud-agent.ts | 585 | Single cloud agent manager, container build-in |
| cloud-sdk.ts | 671 | Unified cloud SDK abstraction layer |
