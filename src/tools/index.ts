import { fileTools, executeFileTool } from './file-tools.js';
import { shellTool, executeShellTool } from './shell-tool.js';
import { grepTool, executeGrepTool } from './grep-tool.js';
import { symbolTool, executeSymbolTool } from './symbol-tool.js';
import { webTool, executeWebTool } from './web-tool.js';
import { createDbTools, executeDbTool } from './db-tool.js';
import { workerStatusTool, executeWorkerStatusTool } from './worker-status-tool.js';
import { similarCodeTool, executeSimilarCodeTool } from './similar-code-tool.js';
import { astContextTool, executeAstContextTool } from './ast-context-tool.js';
import { useTemplateTool, executeUseTemplate } from './use-template.js';
import { searchKnowledgeTool, executeSearchKnowledge } from './search-knowledge.js';
import { webSearchTool, executeWebSearchTool } from './web-search-tool.js';
import { applyPatchTool, executeApplyPatchTool } from './apply-patch-tool.js';
import { unifiedDiffTool, executeUnifiedDiffTool } from './unified-diff-tool.js';
import { lspTool, executeLspTool } from './lsp-tool.js';
import type { ToolDefinition, ToolCall, ToolResult } from '../core/types.js';

// External MCP tools that can be added dynamically
let externalTools: ToolDefinition[] = [];

export function addExternalTools(tools: ToolDefinition[]): void {
  externalTools = tools;
}

export function getExternalTools(): ToolDefinition[] {
  return [...externalTools];
}

// Database/API tools — loaded conditionally
let dbTools: ToolDefinition[] = [];

export function initDbTools(workDir: string): void {
  dbTools = createDbTools(workDir);
}

export const allTools: ToolDefinition[] = [...fileTools, shellTool, grepTool, symbolTool, webTool, workerStatusTool, similarCodeTool, astContextTool, useTemplateTool, searchKnowledgeTool, webSearchTool, applyPatchTool, unifiedDiffTool, lspTool];

export function getAllTools(): ToolDefinition[] {
  return [...allTools, ...dbTools, ...externalTools];
}

export async function executeTool(
  call: ToolCall, workDir: string, additionalDirs?: string[], ctx?: { workerId?: string },
): Promise<ToolResult> {
  let result: { result: string; is_error: boolean };

  try {
    if (call.name === 'run_command') {
      result = await executeShellTool(call.input, workDir, ctx?.workerId
        ? { workerId: ctx.workerId, allowedDirs: [workDir, ...(additionalDirs || [])] }
        : undefined);
    } else if (call.name === 'grep_files') {
      result = executeGrepTool(call.input, workDir);
    } else if (call.name === 'find_symbol') {
      result = executeSymbolTool(call.input, workDir);
    } else if (call.name === 'web_fetch') {
      result = executeWebTool(call.input);
    } else if (call.name === 'worker_status') {
      result = executeWorkerStatusTool(call.input);
    } else if (call.name === 'analyze_code') {
      result = executeAstContextTool(call.input);
    } else if (call.name === 'find_similar_code') {
      result = executeSimilarCodeTool(call.input, workDir);
    } else if (call.name === 'query_database' || call.name === 'http_request') {
      result = executeDbTool(call.name, call.input, workDir);
    } else if (call.name === 'use_template') {
      result = executeUseTemplate(call.input);
    } else if (call.name === 'search_knowledge') {
      result = await executeSearchKnowledge(call.input);
    } else if (call.name === 'web_search') {
      result = executeWebSearchTool(call.input);
    } else if (call.name === 'apply_patch') {
      result = { result: executeApplyPatchTool(call.input as { patch: string; workDir?: string }), is_error: false };
    } else if (call.name === 'apply_unified_diff') {
      result = executeUnifiedDiffTool(call.input as { file_path: string; patch: string }, workDir);
    } else if (call.name === 'lsp') {
      result = await executeLspTool(call.input as { operation: string; filePath: string; line?: number; character?: number; query?: string }, workDir);
    } else {
      result = await executeFileTool(call.name, call.input, workDir, additionalDirs);
    }
  } catch (err) {
    // A throwing tool must surface as a tool error, not abort the whole worker attempt.
    result = { result: `Error in ${call.name}: ${(err as Error)?.message ?? String(err)}`, is_error: true };
  }

  return {
    tool_use_id: call.id,
    content: result.result,
    is_error: result.is_error,
  };
}
