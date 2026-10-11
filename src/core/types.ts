export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResult {
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

export interface Message {
  role: 'user' | 'assistant';
  content: string | ContentBlock[];
}

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };

export interface TaskDirective {
  task: string;
  context: string;
  constraints: string[];
  files_to_read?: string[];
  files_to_modify?: string[];
  acceptance_criteria: string[];
}

export interface WorkerReport {
  status: 'completed' | 'blocked' | 'failed';
  summary: string;
  files_changed: string[];
  issues?: string[];
}

export type OrchestratorAction =
  | { type: 'delegate'; directive: TaskDirective }
  | { type: 'respond'; message: string }
  | { type: 'revise'; feedback: string; directive: TaskDirective }
  | { type: 'done'; summary: string };
