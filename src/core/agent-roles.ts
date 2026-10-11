import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ToolDefinition } from './types.js';
import type { Config } from './config.js';
import { Worker } from './worker.js';

export interface AgentRole {
  name: string;
  description: string;
  systemPromptOverlay: string;
  allowedTools?: string[];  // if set, worker only gets these tools
}

// ---------------------------------------------------------------------------
// Specialized Agent Types (BL-204)
// ---------------------------------------------------------------------------

export interface AgentType {
  name: string;
  description: string;
  tools: string[];
  systemPrompt: string;
}

export const AGENT_TYPES: Record<string, AgentType> = {
  explore: {
    name: 'Explore',
    description: 'Fast read-only search agent',
    tools: ['read_file', 'list_files', 'grep_files', 'find_symbol', 'diff_changes'],
    systemPrompt: 'You are a search agent. Find information quickly. Do NOT modify any files.',
  },
  plan: {
    name: 'Plan',
    description: 'Software architect for designing implementation plans',
    tools: ['read_file', 'list_files', 'grep_files', 'find_symbol'],
    systemPrompt: 'You are a software architect. Design implementation plans. Do NOT write code or modify files.',
  },
  reviewer: {
    name: 'Reviewer',
    description: 'Code reviewer that analyzes changes for bugs, security, and quality',
    tools: ['read_file', 'list_files', 'grep_files', 'diff_changes'],
    systemPrompt: 'You are a code reviewer. Analyze code for bugs, security issues, and quality. Provide specific, actionable feedback.',
  },
  implementer: {
    name: 'Implementer',
    description: 'Code implementer that writes and modifies files',
    tools: ['read_file', 'write_file', 'edit_file', 'list_files', 'grep_files', 'run_command'],
    systemPrompt: 'You are a code implementer. Write clean, correct code. Follow the project style guide.',
  },
};

export function createTypedAgent(type: string, config: Config): Worker {
  const agentType = AGENT_TYPES[type];
  if (!agentType) {
    throw new Error(`Unknown agent type: ${type}. Available: ${Object.keys(AGENT_TYPES).join(', ')}`);
  }
  const role: AgentRole = {
    name: agentType.name,
    description: agentType.description,
    systemPromptOverlay: agentType.systemPrompt,
    allowedTools: agentType.tools,
  };
  return new Worker(config, {
    onText: () => {},
    onToolCall: () => {},
    onToolResult: () => {},
    onTokenUsage: () => {},
  }, undefined, role);
}

export function getAgentType(name: string): AgentType | undefined {
  const lower = name.toLowerCase();
  for (const key of Object.keys(AGENT_TYPES)) {
    const at = AGENT_TYPES[key];
    if (at.name.toLowerCase() === lower || key === lower) {
      return at;
    }
  }
  return undefined;
}

export const BUILT_IN_ROLES: Record<string, AgentRole> = {
  implementer: {
    name: 'implementer',
    description: 'Writes production code. Has access to all tools.',
    systemPromptOverlay: `You are a senior software engineer focused on writing clean, correct implementation code.
Focus on:
- Reading existing code before modifying
- Following existing patterns and conventions
- Writing complete implementations, not stubs
- Handling edge cases`,
  },
  tester: {
    name: 'tester',
    description: 'Writes tests. Focused on coverage and edge cases.',
    systemPromptOverlay: `You are a QA engineer focused on writing thorough tests.
Focus on:
- Writing unit tests that cover happy paths AND edge cases
- Testing error conditions and boundary values
- Following existing test patterns in the project
- Verifying test output with a test runner if available
You should NOT modify production code — only create/modify test files.`,
    allowedTools: ['read_file', 'write_file', 'edit_file', 'list_files', 'run_command', 'grep_files', 'find_symbol', 'diff_changes'],
  },
  reviewer: {
    name: 'reviewer',
    description: 'Reviews code changes. Read-only, reports issues.',
    systemPromptOverlay: `You are a senior code reviewer. Your job is to review changes and report issues.
Focus on:
- Correctness: does the code do what it claims?
- Security: any injection, path traversal, or auth issues?
- Performance: any obvious N+1 queries, unbounded loops, or memory leaks?
- Style: does it match project conventions?
You MUST NOT modify any files. Only read and report.`,
    allowedTools: ['read_file', 'list_files', 'run_command', 'grep_files', 'find_symbol', 'diff_changes'],
  },
  refactorer: {
    name: 'refactorer',
    description: 'Refactors existing code. Improves structure without changing behavior.',
    systemPromptOverlay: `You are a refactoring specialist. Improve code structure without changing behavior.
Focus on:
- Reducing duplication
- Improving naming and readability
- Extracting functions/modules where appropriate
- Maintaining all existing tests passing`,
  },
  documenter: {
    name: 'documenter',
    description: 'Writes documentation, comments, and README updates.',
    systemPromptOverlay: `You are a technical writer. Document code, APIs, and architecture.
Focus on:
- Clear, concise documentation
- Usage examples
- API reference documentation
- Architecture decision records when appropriate
You should NOT modify source code logic — only documentation files, comments, and READMEs.`,
    allowedTools: ['read_file', 'write_file', 'edit_file', 'list_files', 'grep_files', 'find_symbol'],
  },
};

export function loadCustomRoles(workDir: string): AgentRole[] {
  const rolesDir = join(workDir, '.cobra-commander', 'roles');
  if (!existsSync(rolesDir)) return [];

  const customRoles: AgentRole[] = [];
  try {
    const files = readdirSync(rolesDir).filter(f => f.endsWith('.json'));
    for (const file of files) {
      try {
        const raw = JSON.parse(readFileSync(join(rolesDir, file), 'utf-8'));
        if (raw.name && raw.description && raw.systemPromptOverlay) {
          customRoles.push({
            name: raw.name,
            description: raw.description,
            systemPromptOverlay: raw.systemPromptOverlay,
            allowedTools: raw.allowedTools,
          });
        }
      } catch { /* skip bad files */ }
    }
  } catch { /* skip if dir unreadable */ }
  return customRoles;
}

export function getRole(name: string, workDir?: string): AgentRole {
  const builtin = BUILT_IN_ROLES[name];
  if (builtin) return builtin;

  if (workDir) {
    const custom = loadCustomRoles(workDir);
    const found = custom.find(r => r.name === name);
    if (found) return found;
  }

  return BUILT_IN_ROLES['implementer']; // fallback to implementer
}

export function listRoles(workDir?: string): AgentRole[] {
  const builtinList = Object.values(BUILT_IN_ROLES);
  const custom = workDir ? loadCustomRoles(workDir) : [];
  return [...builtinList, ...custom];
}

export function filterToolsForRole(allTools: ToolDefinition[], role: AgentRole): ToolDefinition[] {
  if (!role.allowedTools) return allTools;
  return allTools.filter(t => role.allowedTools!.includes(t.name));
}
