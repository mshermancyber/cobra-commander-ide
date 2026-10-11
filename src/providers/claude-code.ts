import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { AnthropicResponse } from './anthropic.js';
import type { ToolDefinition } from '../core/types.js';

const RELAY_CWD = join(homedir(), '.local', 'share', 'cobra-commander', 'relay-cwd');

export interface ClaudeCodeCallbacks {
  onToolCall?: (name: string, input: Record<string, unknown>) => void;
  onToolResult?: (name: string, output: string, isError: boolean) => void;
  onThinking?: (text: string) => void;
}

export class ClaudeCodeProvider {
  private model: string;
  private binary: string;
  private workDir: string;
  private maxTurns: number;
  private sessionId: string | null = null;
  private callbacks: ClaudeCodeCallbacks;

  constructor(
    model: string,
    workDir: string,
    maxTurns = 5,
    callbacks: ClaudeCodeCallbacks = {},
    binary = 'claude',
  ) {
    this.model = model;
    this.binary = binary;
    this.workDir = workDir;
    this.maxTurns = maxTurns;
    this.callbacks = callbacks;

    if (!existsSync(RELAY_CWD)) {
      mkdirSync(RELAY_CWD, { recursive: true });
    }
  }

  async chat(
    system: string,
    messages: Array<{ role: 'user' | 'assistant'; content: unknown }>,
    tools?: ToolDefinition[],
    _maxTokens = 8192,
  ): Promise<AnthropicResponse> {
    const prompt = this.buildPrompt(system, messages, tools);

    return new Promise((resolve, reject) => {
      const args = [
        '-p', prompt,
        '--output-format', 'stream-json',
        '--verbose',
        '--model', this.model,
        '--max-turns', String(this.maxTurns),
        '--add-dir', this.workDir,
        '--disable-slash-commands',
      ];

      if (system) {
        args.push('--append-system-prompt', system);
      }

      if (this.sessionId) {
        args.push('--resume', this.sessionId);
      }

      const proc = spawn(this.binary, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd: RELAY_CWD,
        env: process.env,
      });

      const textParts: string[] = [];
      const nativeToolCalls: Array<{
        type: 'tool_use';
        id: string;
        name: string;
        input: Record<string, unknown>;
      }> = [];
      let usage = { input_tokens: 0, output_tokens: 0 };
      let stopReason = 'end_turn';
      let stderr = '';

      const rl = createInterface({ input: proc.stdout! });

      rl.on('line', (line) => {
        if (!line.trim()) return;

        let event: any;
        try {
          event = JSON.parse(line);
        } catch {
          return;
        }

        if (event.type === 'system' && event.subtype === 'init' && event.session_id) {
          this.sessionId = event.session_id;
        } else if (event.type === 'result') {
          if (event.is_error && event.subtype !== 'error_max_turns') {
            const errMsg = event.error || event.result || event.errors?.join('; ') || JSON.stringify(event);
            reject(new Error(`Claude Code error: ${errMsg}`));
            return;
          }
          if (event.usage) {
            usage = {
              input_tokens: event.usage.input_tokens || 0,
              output_tokens: event.usage.output_tokens || 0,
            };
          }
          stopReason = event.stop_reason || 'end_turn';
        } else if (event.type === 'assistant') {
          const msg = event.message;
          if (msg?.content && Array.isArray(msg.content)) {
            for (const block of msg.content) {
              if (block.type === 'text' && block.text) {
                textParts.push(block.text);
              } else if (block.type === 'tool_use') {
                this.callbacks.onToolCall?.(block.name, block.input || {});
                nativeToolCalls.push({
                  type: 'tool_use',
                  id: block.id,
                  name: block.name,
                  input: block.input,
                });
              }
            }
          }
        }
      });

      proc.stderr!.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      proc.on('close', (code) => {
        if (code !== 0 && textParts.length === 0 && nativeToolCalls.length === 0) {
          reject(new Error(`claude exited with code ${code}: ${stderr.slice(0, 500)}`));
          return;
        }

        const fullText = textParts.join('');
        const parsed = this.parseToolCalls(fullText);
        const content: AnthropicResponse['content'] = [];

        if (parsed.text.trim()) {
          content.push({ type: 'text', text: parsed.text.trim() });
        }

        for (const tc of parsed.toolCalls) {
          content.push(tc);
        }

        if (content.length === 0) {
          content.push({ type: 'text', text: '(no response)' });
        }

        resolve({
          content,
          stop_reason: parsed.toolCalls.length > 0 ? 'tool_use' : stopReason,
          usage,
        });
      });

      proc.on('error', (err) => {
        reject(new Error(`Failed to spawn claude: ${err.message}`));
      });
    });
  }

  resetSession() {
    this.sessionId = null;
  }

  private parseToolCalls(text: string): {
    text: string;
    toolCalls: Array<{ type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }>;
  } {
    const toolCalls: Array<{ type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }> = [];
    let cleanText = text;
    const regex = /<tool_call>([\s\S]*?)<\/tool_call>/g;
    let match;
    let counter = 0;

    while ((match = regex.exec(text)) !== null) {
      try {
        const parsed = JSON.parse(match[1].trim());
        toolCalls.push({
          type: 'tool_use',
          id: `tc_${Date.now()}_${counter++}`,
          name: parsed.name,
          input: parsed.input || {},
        });
      } catch {
        // malformed — leave in text
      }
    }

    if (toolCalls.length > 0) {
      cleanText = text.replace(regex, '').trim();
    }

    return { text: cleanText, toolCalls };
  }

  private buildPrompt(
    _system: string,
    messages: Array<{ role: 'user' | 'assistant'; content: unknown }>,
    tools?: ToolDefinition[],
  ): string {
    const parts: string[] = [];

    parts.push(`You are working on a project at: ${this.workDir}\n`);
    parts.push('You can use your built-in tools (Read, Bash, etc.) to explore the project before making decisions.\n');

    if (tools?.length) {
      parts.push('In addition to your built-in tools, you have these CUSTOM tools for orchestration.');
      parts.push('To invoke a custom tool, output a JSON block wrapped in <tool_call> tags.');
      parts.push('Format: <tool_call>{"name": "tool_name", "input": {...}}</tool_call>');
      parts.push('You may include text before/after tool calls. You may invoke multiple custom tools.\n');
      for (const tool of tools) {
        parts.push(`### ${tool.name}\n${tool.description}\nInput schema: ${JSON.stringify(tool.input_schema)}\n`);
      }
      parts.push('IMPORTANT: Use your built-in tools (Read, Bash, grep) to explore the codebase BEFORE delegating work.');
      parts.push('Only use <tool_call> for the custom tools listed above, not for file reading or commands.\n---\n');
    }

    if (this.sessionId) {
      const lastUserMsg = [...messages].reverse().find((m: { role: string }) => m.role === 'user');
      if (lastUserMsg) {
        const content = lastUserMsg.content;
        if (typeof content === 'string') {
          parts.push(content);
        } else if (Array.isArray(content)) {
          for (const block of content as any[]) {
            if (block.type === 'text') parts.push(block.text);
            else if (block.type === 'tool_result') {
              parts.push(`[Tool result for ${block.tool_use_id}]:\n${block.content}`);
            }
          }
        }
      }
    } else {
      for (const msg of messages) {
        const content = msg.content;
        if (msg.role === 'assistant') {
          if (typeof content === 'string') {
            parts.push(`[Previous assistant response]: ${content}`);
          } else if (Array.isArray(content)) {
            const textBlocks = (content as any[]).filter(b => b.type === 'text').map(b => b.text);
            if (textBlocks.length) {
              parts.push(`[Previous assistant response]: ${textBlocks.join('\n')}`);
            }
          }
          continue;
        }
        if (typeof content === 'string') {
          parts.push(content);
        } else if (Array.isArray(content)) {
          for (const block of content as any[]) {
            if (block.type === 'text') parts.push(block.text);
            else if (block.type === 'tool_result') {
              parts.push(`[Tool result for ${block.tool_use_id}]:\n${block.content}`);
            }
          }
        }
      }
    }

    return parts.join('\n');
  }
}
