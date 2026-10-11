#!/usr/bin/env tsx
import { createInterface } from 'node:readline';
import { loadConfig, hydrateWorkerKey } from '../core/config.js';
import { OpenAICompatibleProvider } from '../providers/openai-compatible.js';
import { getAllTools, executeTool } from '../tools/index.js';
import type { ToolDefinition } from '../core/types.js';
import { installRoot } from '../core/env-file.js';

const G = '\x1b[32m';
const D = '\x1b[2m';
const C = '\x1b[36m';
const Y = '\x1b[33m';
const R = '\x1b[31m';
const B = '\x1b[1m';
const X = '\x1b[0m';

const WORK_DIR = installRoot();

const SYSTEM = `You are Head of Engineering, Head of Engineering at Cobra Commander.
Direct interactive session with the CTO. Full tool access.

## Your Role
- Head of Engineering — you own the codebase at ${WORK_DIR}
- Make technical decisions, manage developers, coordinate implementation
- Delegate implementation tasks to workers via build rounds
- Quick lookups and status checks you do directly

## Tools Available
Use your tools for coordination — reading files, checking status, writing task specs.
Run commands to check builds, read logs, verify results.

## Style
- Be concise and executive-level — 1-3 sentences for most answers
- Report outcomes, not process
- If given a task, acknowledge immediately then work
- The CTO built this project — don't explain it back to them`;

interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | null;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

async function main() {
  const config = loadConfig({ workDir: WORK_DIR });
  await hydrateWorkerKey(config);

  if (!config.worker.apiKey) {
    console.error(`${R}No worker API key configured.${X}`);
    process.exit(1);
  }

  const provider = new OpenAICompatibleProvider(config.worker);
  const tools: ToolDefinition[] = getAllTools();
  const messages: Message[] = [];
  let totalIn = 0;
  let totalOut = 0;

  console.log(`
${G}${B}  ╔═══════════════════════════════════════════════╗
  ║  Head of Engineering · Interactive Session    ║
  ╚═══════════════════════════════════════════════╝${X}
  ${D}Model: ${config.worker.model}${X}
  ${D}Tools: ${tools.length} (files, shell, grep, symbols, web)${X}
  ${D}Workdir: ${WORK_DIR}${X}
  ${D}Type 'exit' to disconnect${X}
`);

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: `${G}you>${X} `,
  });

  rl.prompt();

  rl.on('line', async (line) => {
    const input = line.trim();
    if (!input) { rl.prompt(); return; }
    if (input === 'exit' || input === 'quit') { rl.close(); return; }
    if (input === 'tokens') {
      console.log(`${D}Total: ${totalIn} in / ${totalOut} out${X}\n`);
      rl.prompt();
      return;
    }
    if (input === 'clear') {
      messages.length = 0;
      console.log(`${D}Context cleared.${X}\n`);
      rl.prompt();
      return;
    }

    messages.push({ role: 'user', content: input });

    // Agentic loop — the worker model works until no more tool calls
    let turns = 0;
    const maxTurns = 50;

    while (turns < maxTurns) {
      turns++;

      let response;
      try {
        response = await provider.chat(SYSTEM, messages, tools, 16384);
      } catch (e: any) {
        console.error(`\n${R}API error: ${e.message}${X}\n`);
        break;
      }

      totalIn += response.usage.input;
      totalOut += response.usage.output;

      // Show text output
      if (response.text) {
        console.log(`\n${C}openai>${X} ${response.text}\n`);
      }

      // No tool calls = done
      if (!response.toolCalls || response.toolCalls.length === 0) {
        break;
      }

      // Record assistant message with tool calls
      messages.push({
        role: 'assistant',
        content: response.text || null,
        tool_calls: response.toolCalls.map(tc => ({
          id: tc.id,
          type: 'function' as const,
          function: { name: tc.name, arguments: JSON.stringify(tc.input) },
        })),
      });

      // Execute each tool call
      for (const tc of response.toolCalls) {
        const inputSummary = summarizeToolInput(tc.name, tc.input);
        process.stdout.write(`  ${D}[${tc.name}]${X} ${inputSummary}`);

        const result = await executeTool(
          { id: tc.id, name: tc.name, input: tc.input },
          WORK_DIR,
        );

        const status = result.is_error ? `${R}ERR${X}` : `${G}ok${X}`;
        const size = result.content.length;
        console.log(` ${status} ${D}(${size > 1000 ? Math.round(size/1024) + 'KB' : size + 'b'})${X}`);

        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: result.content,
        });
      }
    }

    if (turns >= maxTurns) {
      console.log(`${Y}[max turns reached]${X}\n`);
    }

    console.log(`${D}[${turns} turns, ${totalIn}in/${totalOut}out]${X}\n`);
    rl.prompt();
  });

  rl.on('close', () => {
    console.log(`\n${D}Session ended. ${totalIn} tokens in, ${totalOut} tokens out.${X}`);
    process.exit(0);
  });
}

function summarizeToolInput(name: string, input: Record<string, any>): string {
  switch (name) {
    case 'read_file': return input.path || input.file_path || '';
    case 'write_file': return input.path || input.file_path || '';
    case 'edit_file': return input.path || input.file_path || '';
    case 'patch_file': return input.path || input.file_path || '';
    case 'list_files': return input.path || input.directory || '.';
    case 'run_command': return (input.command || '').slice(0, 80);
    case 'grep_files': return `"${input.pattern}" ${input.path || ''}`;
    case 'find_symbol': return input.name || input.symbol || '';
    case 'diff_changes': return '';
    default: return JSON.stringify(input).slice(0, 60);
  }
}

main().catch(e => { console.error(e.message); process.exit(1); });
