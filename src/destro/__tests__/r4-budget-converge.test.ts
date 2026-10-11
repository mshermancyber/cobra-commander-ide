// R4 budget convergence & definitive-result tests
// Budget→verdict, converge injection, settled-assertion re-check.

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { destroAgentLoop } from '../destro-agent.js';
import type { DestroAgentOptions, MockLlmHandler } from '../destro-agent.js';

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────

function makeTempDir(): string {
  const dir = join(tmpdir(), `destro-r4-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeConfig(overrides: Record<string, unknown> = {}) {
  return {
    provider: { apiKey: 'test-key', baseUrl: 'http://localhost:9999', model: 'test-model' },
    workDir: process.cwd(),
    maxTurns: 300,
    commandTimeout: 30,
    verbose: false,
    ...overrides,
  };
}

// ──────────────────────────────────────────────
// Test 1: Budget→verdict — force DESTRO_TOKEN_BUDGET exceed
// ──────────────────────────────────────────────

describe('R4 §1 — Budget→verdict', () => {
  it('forces budget exceed via mock usage and asserts VERDICT in summary', async () => {
    const tmpDir = makeTempDir();
    try {
      let turn = 0;
      const mockLlm: MockLlmHandler = async () => {
        turn++;
        if (turn === 1) {
          // Return huge token usage to blow past DESTRO_TOKEN_BUDGET (4M default)
          return {
            content: 'Investigating the incident — scanning logs and health endpoints.',
            toolCalls: [],
            usage: { total_tokens: 5_000_000, prompt_tokens: 4_000_000, completion_tokens: 1_000_000 },
          } as any;
        }
        // Turn 2: after BUDGET LIMIT injected, respond with VERDICT
        return {
          content: 'VERDICT: PASS\nEVIDENCE: All health checks passed, no error logs.\nRECOMMENDATION: Close incident, no further action.',
          toolCalls: [],
        };
      };

      const config = makeConfig();
      const result = await destroAgentLoop({
        targetDir: tmpDir,
        userMessage: 'Debug production outage in api-gateway',
        config,
        mockLlm,
      });

      assert.ok(result.summary.includes('VERDICT:'), 'summary should contain VERDICT:');
      assert.notEqual(result.status, 'max_turns_exceeded',
        'status should not be max_turns_exceeded when VERDICT was emitted');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ──────────────────────────────────────────────
// Test 2: Converge — force budget-edge trigger, assert injection + VERDICT
// ──────────────────────────────────────────────

describe('R4 §2 — Converge budget-edge trigger', () => {
  it('injects BUDGET LIMIT message at 80% maxTurns and produces VERDICT', async () => {
    const tmpDir = makeTempDir();
    try {
      let turn = 0;
      const mockLlm: MockLlmHandler = async () => {
        turn++;
        if (turn <= 2) {
          return { content: `Turn ${turn}: still investigating...`, toolCalls: [] };
        }
        // Turn 3 (after converge trigger at turn 3): emit VERDICT
        return {
          content: 'VERDICT: FAIL\nEVIDENCE: Port 3000 is not listening, docker container is stopped.\nRECOMMENDATION: Restart docker container and verify health.',
          toolCalls: [],
        };
      };

      // maxTurns=4 → converge triggers at turn 3 (floor(4*0.8)=3)
      const config = makeConfig({ maxTurns: 4 });
      const result = await destroAgentLoop({
        targetDir: tmpDir,
        userMessage: 'Service unreachable — investigate',
        config,
        mockLlm,
      });

      // Assert BUDGET LIMIT was injected into session messages
      const budgetMsg = result.session.messages.find(
        m => m.role === 'user' && typeof m.content === 'string' && m.content.includes('BUDGET LIMIT REACHED'),
      );
      assert.ok(budgetMsg, 'BUDGET LIMIT message should be injected into session');
      assert.ok(budgetMsg!.content.includes('VERDICT: PASS | FAIL | INCONCLUSIVE'),
        'BUDGET LIMIT message should instruct to emit VERDICT');

      // Assert summary has VERDICT
      assert.ok(result.summary.includes('VERDICT:'), 'summary should contain VERDICT:');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ──────────────────────────────────────────────
// Test 3: Definitive-result — settled assertion on 2nd verify-class tool call
// ──────────────────────────────────────────────

describe('R4 §3 — Definitive-result settled assertion', () => {
  it('prepends [ALREADY SETTLED on 2nd verify-class tool call with same key', async () => {
    const tmpDir = makeTempDir();
    try {
      let turn = 0;
      const mockLlm: MockLlmHandler = async () => {
        turn++;
        if (turn === 1) {
          // First verify-class tool call: run_command with http_code trigger
          return {
            content: 'Checking health of the service...',
            toolCalls: [{
              id: 'call-1',
              name: 'run_command',
              input: { command: "echo 'http_code 200'" },
            }],
          };
        }
        if (turn === 2) {
          // Second verify-class tool call: same command → should trigger settled
          return {
            content: 'Re-checking to confirm...',
            toolCalls: [{
              id: 'call-2',
              name: 'run_command',
              input: { command: "echo 'http_code 200'" },
            }],
          };
        }
        if (turn === 3) {
          // One more benign turn without verify tools
          return { content: 'Continuing investigation...', toolCalls: [] };
        }
        // Turn 4: after converge trigger (turn 4 >= floor(5*0.8)=4), emit VERDICT
        return {
          content: 'VERDICT: PASS\nEVIDENCE: Service health confirmed.\nRECOMMENDATION: All clear.',
          toolCalls: [],
        };
      };

      // maxTurns=5 → converge triggers at turn 4
      const config = makeConfig({ maxTurns: 5 });
      const result = await destroAgentLoop({
        targetDir: tmpDir,
        userMessage: 'Investigate service health status',
        config,
        mockLlm,
      });

      // Find tool results containing [ALREADY SETTLED
      const settledMsgs = result.session.messages.filter(
        m => m.role === 'tool' && typeof m.content === 'string' && m.content.includes('[ALREADY SETTLED'),
      );
      assert.ok(settledMsgs.length >= 1,
        `Expected at least 1 tool result with [ALREADY SETTLED, got ${settledMsgs.length}`);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
