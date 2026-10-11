#!/usr/bin/env tsx
/**
 * Destro CLI smoke entry.
 *
 * Usage:
 *   npx tsx src/destro/destro-cli.ts --target <dir> [--mock-llm] [--message "<ask>"]
 *
 * With --mock-llm this runs WITHOUT network or API keys: a scripted LLM handler
 * exercises a small diagnose-only session (list containers → read project context
 * → summarize) to prove the loop + tools + hooks wire up end to end.
 */
import { destroAgentLoop, type DestroAgentOptions, type MockLlmHandler } from './destro-agent.js';
import { loadDestroConfig } from './destro-config.js';

function parseArgs(argv: string[]): { target: string; mock: boolean; message: string; allowMutations: boolean } {
  let target = '';
  let mock = false;
  let allowMutations = false;
  let message = 'Diagnose the current state of this project. Read-only — do not change anything.';
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--target' && argv[i + 1]) target = argv[++i];
    else if (argv[i] === '--mock-llm') mock = true;
    else if (argv[i] === '--allow-mutations') allowMutations = true;
    else if (argv[i] === '--message' && argv[i + 1]) message = argv[++i];
  }
  if (!target) {
    console.error('Usage: destro-cli --target <dir> [--mock-llm] [--allow-mutations] [--message "<ask>"]');
    process.exit(2);
  }
  return { target, mock, message, allowMutations };
}

/** Scripted mock LLM: turn 1 lists containers, turn 2 checks a port, turn 3 resolves. */
function makeMockLlm(): MockLlmHandler {
  let turn = 0;
  return async (_messages, tools) => {
    turn++;
    const has = (n: string) => tools.some(t => t.name === n);
    if (turn === 1 && has('docker_ps')) {
      return {
        content: 'Diagnosing: first, what containers are running?',
        toolCalls: [{ id: 'mock-1', name: 'docker_ps', input: {} }],
      };
    }
    if (turn === 2 && has('port_check')) {
      return {
        content: 'Now checking whether the gateway port is listening.',
        toolCalls: [{ id: 'mock-2', name: 'port_check', input: { port: 21001 } }],
      };
    }
    return {
      content:
        'Diagnosis complete (mock). Containers enumerated and port probed; no mutations attempted. ' +
        'Incident resolved.',
      toolCalls: [],
    };
  };
}

async function main(): Promise<void> {
  const { target, mock, message, allowMutations } = parseArgs(process.argv.slice(2));
  if (mock) {
    // Mock mode must run keyless/offline: DESTRO_API_KEY is first in the resolution
    // chain, so setting it short-circuits the key-vault lookup entirely.
    process.env.DESTRO_API_KEY = process.env.DESTRO_API_KEY || 'mock-key-no-network';
  }
  const config = await loadDestroConfig({ workDir: target });

  const options: DestroAgentOptions = {
    targetDir: target,
    userMessage: message,
    config,
    // CLI has no interactive approval channel → mutations are OFF unless
    // explicitly enabled (Claude-Code posture: default-ask; can't ask ⇒ deny).
    readOnly: !allowMutations,
    mockLlm: mock ? makeMockLlm() : undefined,
    onToolCall: (name, input) =>
      console.log(`  [tool] ${name} ${JSON.stringify(input).slice(0, 120)}`),
    onTurn: (n, status) => console.log(`[turn ${n}] ${status}`),
  };

  console.log(`Destro CLI — target=${target} mock=${mock}`);
  const result = await destroAgentLoop(options);

  console.log('\n=== RESULT ===');
  console.log(`status : ${result.status}`);
  console.log(`summary: ${result.summary.slice(0, 500)}`);
  console.log('\n=== INCIDENT LEDGER ===');
  if (result.actionsLedger.length === 0) {
    console.log('(no actions recorded)');
  }
  for (const a of result.actionsLedger) {
    console.log(`- ${new Date(a.ts).toISOString()} ${a.tool} :: ${a.args.slice(0, 100)} → ${a.outcome.slice(0, 120)}`);
  }

  process.exit(result.status === 'resolved' || result.status === 'escalated' ? 0 : 1);
}

main().catch(err => {
  console.error('destro-cli fatal:', err);
  process.exit(1);
});
