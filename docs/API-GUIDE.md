# Cobra Commander — API Guide

This guide covers how to use Cobra Commander programmatically in your own Node.js applications.

## Installation

```bash
npm install cobra-commander
```

## Key Classes

### `Worker`

The `Worker` class executes tasks using a language model. It handles tool calling, file operations, and shell commands.

```typescript
import { Worker } from 'cobra-commander-ide/core/worker';
import type { Config, ProviderConfig } from 'cobra-commander-ide/core/config';
import type { WorkerCallbacks } from 'cobra-commander-ide/core/worker';

const provider: ProviderConfig = {
  apiKey: process.env.OPENAI_API_KEY!,
  model: 'gpt-5.1-mini',
  baseUrl: 'https://api.openai.com/v1',
};

const config: Config = {
  orchestrator: { apiKey: process.env.OPENAI_API_KEY!, model: 'gpt-5.1' },
  worker: provider,
  workerPool: [{ name: 'default', provider, tier: 'standard' }],
  workDir: process.cwd(),
  additionalDirs: [],
  maxWorkerTurns: 25,
  maxOrchestratorTurns: 5,
  maxRetries: 3,
  commandTimeout: 30,
  verbose: false,
};

const callbacks: WorkerCallbacks = {
  onText: (text) => console.log('Worker:', text),
  onToolCall: (name, input) => console.log(`Tool: ${name}`, input),
  onToolResult: (name, result, isError) => console.log(`Result:`, result),
  onTokenUsage: (input, output) => console.log(`Tokens: ${input} in / ${output} out`),
};

const worker = new Worker(config, callbacks);
```

### `Orchestrator`

The `Orchestrator` class plans tasks and delegates them to workers. It manages the conversation flow and reviews worker output.

```typescript
import { Orchestrator } from 'cobra-commander-ide/core/orchestrator';
import type { OrchestratorCallbacks } from 'cobra-commander-ide/core/orchestrator';
import type { Config } from 'cobra-commander-ide/core/config';

const orchestratorCallbacks: OrchestratorCallbacks = {
  onOrchestratorThinking: (text) => console.log('the orchestrator:', text),
  onOrchestratorExploring: (tool, summary) => console.log(`Exploring: ${summary}`),
  onDelegating: (task, model) => console.log(`Delegating to ${model || 'default'}: ${task}`),
  onParallelDelegating: (count) => console.log(`Parallel: ${count} tasks`),
  onWorkerUpdate: (text) => process.stdout.write(text),
  onWorkerToolCall: (name, input) => console.log(`[${name}]`),
  onWorkerToolResult: (name, result, isError) => {},
  onReviewing: (diffSummary) => console.log(`Reviewing diff: ${diffSummary}`),
  onRetrying: (task, attempt) => console.log(`Retry ${attempt}: ${task}`),
  onTokenUsage: (role, input, output) => console.log(`Tokens (${role}): ${input}/${output}`),
};

// Worker runner — bridges orchestrator to a Worker instance
const workerRunner = async (
  task: string,
  context: string,
  criteria: string[],
  modelName?: string,
) => {
  const worker = new Worker(config, callbacks, modelName);
  return worker.executeTask(task, context, criteria);
};

const orchestrator = new Orchestrator(config, orchestratorCallbacks, workerRunner);
```

### `SessionManager`

The `SessionManager` class persists conversation history to disk.

```typescript
import { SessionManager } from 'cobra-commander-ide/core/session';

const sessions = new SessionManager('/path/to/project');

// Start a new session
const sessionId = sessions.startNew();

// Save messages
sessions.saveMessages([
  { role: 'user', content: 'Add a function' },
  { role: 'assistant', content: 'Done' },
]);

// Load messages
const messages = sessions.loadMessages();

// List all sessions
const allSessions = sessions.listSessions();

// Resume a session
sessions.resume(sessionId);

// Branch a session
const branchId = sessions.branchSession(messages);
```

## Executing Tasks

### Basic Task Execution

```typescript
import { Worker } from 'cobra-commander-ide/core/worker';
import { loadConfig } from 'cobra-commander-ide/core/config';
import type { WorkerCallbacks } from 'cobra-commander-ide/core/worker';

const config = loadConfig({ workDir: process.cwd(), maxWorkerTurns: 25 });

const callbacks: WorkerCallbacks = {
  onText: (text) => process.stdout.write(text),
  onToolCall: (name, input) => console.log(`\n[${name}]`),
  onToolResult: (name, result, isError) => {},
  onTokenUsage: (input, output) => {},
};

const worker = new Worker(config, callbacks);

// Execute a task with context and acceptance criteria
const result = await worker.executeTask(
  'Add a greet function to src/utils.ts',
  'The file currently exports a formatDate function. Keep the same code style.',
  ['Function must be exported', 'Must include JSDoc', 'Must handle empty string input'],
);

console.log('Result:', result);

// With automatic retry on verification failure
const retryResult = await worker.executeTaskWithRetry(
  'Refactor the auth module',
  'The module is at src/auth.ts',
  ['All existing tests pass', 'No breaking API changes'],
  3, // max retries
);
```

### With Custom Tools

```typescript
import { addExternalTools } from 'cobra-commander/tools';
import type { ToolDefinition } from 'cobra-commander-ide/core/types';

// Register custom tools
addExternalTools([
  {
    name: 'my_custom_tool',
    description: 'Does something custom',
    input_schema: {
      type: 'object',
      properties: {
        input: { type: 'string' },
      },
      required: ['input'],
    },
  },
]);
```

Note: Custom tool handlers are registered separately via the tool execution system.

## Config Object Reference

```typescript
interface Config {
  orchestrator: ProviderConfig;
  worker: ProviderConfig;
  workerPool: WorkerPoolEntry[];
  workDir: string;
  additionalDirs: string[];
  maxWorkerTurns: number;
  maxOrchestratorTurns: number;
  maxRetries: number;
  commandTimeout: number;
  verbose: boolean;
  autoScan?: boolean;
  autoCommitEnabled?: boolean;
  autoFeatureBranch?: boolean;
  crossModelVerify?: boolean;
  costAwareRouting?: boolean;
  autoRetry?: boolean;
  verification?: VerificationConfig;
  fallbackChain?: string[];         // ordered model names to try on failure
  profile?: string;                 // named config profile to apply
  progressReportInterval?: number;
  progressReportEnabled?: boolean;
  autoCompact?: boolean;
  autoCompactKeepLast?: number;
  autoSecurityScan?: boolean;
  webhook?: WebhookConfig;
}

interface ProviderConfig {
  apiKey: string;
  baseUrl?: string;
  model: string;
}

interface WorkerPoolEntry {
  name: string;
  provider: ProviderConfig;
  tier: 'fast' | 'standard' | 'heavy';
}

interface VerificationConfig {
  commands?: string[];       // e.g., ['npx tsc --noEmit', 'npm run lint']
  timeout?: number;          // seconds, default 60
  failOnWarnings?: boolean;  // default false
  skipPatterns?: string[];   // regex patterns to ignore in output
}
```

## Worker Callbacks

```typescript
interface WorkerCallbacks {
  onText: (text: string) => void;
  onToolCall: (name: string, input: Record<string, unknown>) => void;
  onToolResult: (name: string, result: string, isError: boolean) => void;
  onTokenUsage: (input: number, output: number) => void;
  onRetryStrategy?: (strategyName: string, attempt: number) => void;
  onProgressReport?: (report: ProgressReport) => void;
  onAskClarification?: (question: string, context: string, options: string[]) => Promise<string>;
  onPauseRequest?: (question: string, config: ClarificationConfig) => Promise<string>;
}
```

## Orchestrator Callbacks

```typescript
interface OrchestratorCallbacks {
  onOrchestratorThinking: (text: string) => void;
  onOrchestratorExploring: (toolName: string, summary: string) => void;
  onDelegating: (task: string, model?: string) => void;
  onParallelDelegating: (count: number) => void;
  onWorkerUpdate: (text: string) => void;
  onWorkerToolCall: (name: string, input: Record<string, unknown>) => void;
  onWorkerToolResult: (name: string, result: string, isError: boolean) => void;
  onReviewing: (diffSummary?: string) => void;
  onRetrying: (task: string, attempt: number) => void;
  onTokenUsage: (role: 'orchestrator' | 'worker', input: number, output: number) => void;
  onDelegationComplete?: (task: string, status: 'completed' | 'failed', files: string[]) => void;
  onSwarmPhase?: (phaseName: string, phaseNum: number, totalPhases: number) => void;
  onSecurityScan?: (msg: string) => void;
  onAutoCommit?: (hash: string, message: string) => void;
  onVerifying?: (msg: string) => void;
}
```

## Tool Definitions

Tools are defined with a name, description, parameter schema. They are registered via `addExternalTools`:

```typescript
import { addExternalTools } from 'cobra-commander/tools';
import type { ToolDefinition } from 'cobra-commander-ide/core/types';

const myTool: ToolDefinition = {
  name: 'analyze_code',
  description: 'Analyze code quality metrics for a file',
  input_schema: {
    type: 'object',
    properties: {
      filePath: {
        type: 'string',
        description: 'Path to the file to analyze',
      },
      metrics: {
        type: 'array',
        items: { type: 'string', enum: ['complexity', 'duplication', 'maintainability'] },
        description: 'Metrics to compute',
      },
    },
    required: ['filePath'],
  },
};

addExternalTools([myTool]);
```

## MCP Integration

Cobra Commander supports the Model Context Protocol (MCP) for connecting external tool servers.

### Connecting to an MCP Server

```typescript
import { MCPClient, mcpToolsToToolDefinitions } from 'cobra-commander-ide/core/mcp-client';
import { addExternalTools } from 'cobra-commander/tools';

const mcpClient = new MCPClient({
  command: 'npx',
  args: ['@modelcontextprotocol/server-filesystem', '/path/to/project'],
});

await mcpClient.connect();

// Convert MCP tools to Cobra Commander tool definitions
const tools = mcpToolsToToolDefinitions(mcpClient);

// Register them
addExternalTools(tools);

// Later, disconnect
await mcpClient.disconnect();
```

### Starting as an MCP Server

```bash
cobra-commander --serve-mcp
```

This starts Cobra Commander as a JSON-RPC MCP server over stdio, allowing other MCP-compatible tools to connect to it.

## Complete Example

```typescript
import { Worker } from 'cobra-commander-ide/core/worker';
import { Orchestrator } from 'cobra-commander-ide/core/orchestrator';
import { SessionManager } from 'cobra-commander-ide/core/session';
import { loadConfig } from 'cobra-commander-ide/core/config';
import type { WorkerCallbacks } from 'cobra-commander-ide/core/worker';
import type { OrchestratorCallbacks } from 'cobra-commander-ide/core/orchestrator';

async function main() {
  // Load configuration
  const config = loadConfig({
    workDir: process.cwd(),
    maxWorkerTurns: 50,
  });

  // Worker callbacks
  const workerCallbacks: WorkerCallbacks = {
    onText: (text) => process.stdout.write(text),
    onToolCall: (name, input) => console.log(`\n[${name}]`, JSON.stringify(input).slice(0, 200)),
    onToolResult: () => {},
    onTokenUsage: () => {},
  };

  // Create worker runner for the orchestrator
  const workerRunner = async (
    task: string,
    context: string,
    criteria: string[],
    modelName?: string,
  ) => {
    const worker = new Worker(config, workerCallbacks, modelName);
    return worker.executeTask(task, context, criteria);
  };

  // Orchestrator callbacks
  const orchestratorCallbacks: OrchestratorCallbacks = {
    onOrchestratorThinking: (text) => console.log('\nOpus:', text),
    onOrchestratorExploring: (tool, summary) => console.log(`  Exploring: ${summary}`),
    onDelegating: (task, model) => console.log(`  → Worker (${model || 'default'}): ${task}`),
    onParallelDelegating: (count) => console.log(`  → ${count} parallel tasks`),
    onWorkerUpdate: (text) => process.stdout.write(text),
    onWorkerToolCall: () => {},
    onWorkerToolResult: () => {},
    onReviewing: (diffSummary) => console.log(`  Reviewing: ${diffSummary}`),
    onRetrying: (task, attempt) => console.log(`  Retry ${attempt}: ${task}`),
    onTokenUsage: (role, input, output) => console.log(`  Tokens (${role}): ${input}/${output}`),
  };

  // Create orchestrator
  const orchestrator = new Orchestrator(config, orchestratorCallbacks, workerRunner);

  // Create session
  const sessions = new SessionManager(config.workDir);
  sessions.startNew();

  // Execute a task via the orchestrator
  const messages = await orchestrator.run('Add input validation to the API routes');
  console.log('Done — messages:', messages.length);

  // Save session
  sessions.saveMessages(orchestrator.getMessages());
}

main().catch(console.error);
```
