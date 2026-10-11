#!/usr/bin/env tsx
/*
 * Cobra Commander — self-hosted multi-model AI coding platform.
 * Copyright (C) 2026 Mark Sherman
 *
 * This program is free software: you can redistribute it and/or modify it under
 * the terms of the GNU General Public License as published by the Free Software
 * Foundation, either version 3 of the License, or (at your option) any later
 * version.
 *
 * This program is distributed in the hope that it will be useful, but WITHOUT
 * ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS
 * FOR A PARTICULAR PURPOSE. See the GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License along with
 * this program. If not, see <https://www.gnu.org/licenses/>.
 */
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { loadConfig, hydrateWorkerKey } from './src/core/config.js';
import { OpenAICompatibleProvider } from './src/providers/openai-compatible.js';
import { modelsUrl } from './src/core/api-endpoint.js';

const WORK_DIR = process.cwd();

const G = '\x1b[32m';
const C = '\x1b[36m';
const Y = '\x1b[33m';
const R = '\x1b[31m';
const D = '\x1b[2m';
const B = '\x1b[1m';
const X = '\x1b[0m';
const BG_G = '\x1b[42m\x1b[30m';
const BG_R = '\x1b[41m\x1b[37m';
const BG_C = '\x1b[46m\x1b[30m';

function banner() {
  console.log(`
${G}${B}  ╔═══════════════════════════════════════════════════════════╗
  ║                                                           ║
  ║              ▄▄▄   COBRA COMMANDER   ▄▄▄                  ║
  ║             ▀█▀▀▀▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▀▀▀█▀                   ║
  ║                                                           ║
  ║              One orchestrator · many workers              ║
  ║                                                           ║
  ╚═══════════════════════════════════════════════════════════╝${X}
`);
}

function pad(visible: string, width: number): string {
  return visible + ' '.repeat(Math.max(0, width - visible.length));
}

function statusBox(model: string, status: 'ONLINE' | 'OFFLINE', available: string[]) {
  const W = 55;
  const inner = W - 4; // content area between "│  " and "  │"
  const tag = status === 'ONLINE' ? `${BG_G} ● ONLINE ${X}` : `${BG_R} ✗ OFFLINE ${X}`;
  const tagLen = status === 'ONLINE' ? 10 : 10;
  const modelTag = `${BG_C} ${model} ${X}`;
  const modelTagLen = model.length + 2;

  const lines: string[] = [];
  lines.push('┌' + '─'.repeat(W) + '┐');
  lines.push('│' + ' '.repeat(W) + '│');
  lines.push('│  Worker Model:  ' + modelTag + ' '.repeat(W - 17 - modelTagLen) + '│');
  lines.push('│  Status:        ' + tag + ' '.repeat(W - 17 - tagLen) + '│');
  lines.push('│' + ' '.repeat(W) + '│');
  lines.push('│  Available models on this key:' + ' '.repeat(W - 31) + '│');
  for (const m of available) {
    if (m === model) {
      lines.push('│  ' + `${G}${B}▸ ${m}${X}` + ' '.repeat(W - 4 - m.length) + '│');
    } else {
      lines.push('│  ' + `${D}  ${m}${X}` + ' '.repeat(W - 4 - m.length) + '│');
    }
  }
  lines.push('│' + ' '.repeat(W) + '│');
  lines.push('└' + '─'.repeat(W) + '┘');

  console.log('\n  ' + lines.join('\n  ') + '\n');
}

async function preflight(): Promise<boolean> {
  // 1. Resolve the model API key from the environment, .env or the sealed vault
  process.stdout.write(`  ${D}[1/4]${X} Resolving model API key... `);
  const config = loadConfig({ workDir: WORK_DIR });
  await hydrateWorkerKey(config);

  if (!config.worker.apiKey) {
    console.log(`${R}FAILED${X}`);
    console.log(`\n  ${R}No model API key found.${X}`);
    console.log(`  ${D}Set OPENAI_API_KEY in .env, or seal a key with:${X}`);
    console.log(`  ${D}  npx tsx src/core/key-vault.ts <api-key>${X}\n`);
    return false;
  }
  console.log(`${G}OK${X}`);

  // 2. Verify the gateway answers and the configured model is reachable
  process.stdout.write(`  ${D}[2/4]${X} Reaching model gateway... `);
  const activeModel = config.worker.model;
  let available: string[] = [];

  try {
    try {
      const modelsResp = await fetch(modelsUrl(config.worker.baseUrl || ''), {
        headers: { Authorization: `Bearer ${config.worker.apiKey}` },
      });
      if (modelsResp.ok) {
        const modelsData = (await modelsResp.json()) as { data?: Array<{ id: string }> };
        available = modelsData.data?.map(m => m.id) || [];
      }
    } catch { /* listing is optional — some gateways don't expose it */ }

    const provider = new OpenAICompatibleProvider(config.worker);
    const resp = await provider.chat(
      'You are a build agent reporting readiness. Answer in one short sentence.',
      [{ role: 'user', content: 'Reply with the model you are and that you are ready.' }],
      undefined,
      128,
    );
    const answer = resp.text?.trim();
    if (!answer) throw new Error('Empty response from model');

    console.log(`${G}OK${X} ${D}(${resp.usage.input} in / ${resp.usage.output} out)${X}`);
    statusBox(activeModel, 'ONLINE', available);

    console.log(`  ${C}${B}Model says:${X}`);
    for (const line of answer.split('\n').filter(l => l.trim())) {
      console.log(`  ${D}│${X} ${line}`);
    }
    console.log();

    if (available.length > 0 && !available.includes(activeModel)) {
      console.log(`  ${Y}⚠ "${activeModel}" is not in the gateway's model list.${X}`);
      console.log(`  ${Y}  It may be an alias — the test request succeeded.${X}\n`);
    }
  } catch (err) {
    console.log(`${R}FAILED${X}`);
    statusBox(activeModel, 'OFFLINE', available);
    console.log(`  ${R}${(err as Error).message}${X}\n`);
    return false;
  }

  // 3. Check the orchestrator key (may differ from the worker key)
  process.stdout.write(`  ${D}[3/4]${X} Orchestrator key... `);
  if (config.orchestrator.apiKey) {
    console.log(`${G}OK${X} ${D}(${config.orchestrator.model})${X}`);
  } else {
    console.log(`${Y}NOT SET${X} ${D}(worker-only mode)${X}`);
  }

  // 4. Remote control web shell — opt-in via REMOTE_ENABLED in .env
  process.stdout.write(`  ${D}[4/4]${X} Remote control... `);
  if (process.env.REMOTE_ENABLED === 'true') {
    try {
      const { DEFAULT_REMOTE_PORT } = await import('./src/core/net-defaults.js');
      const { startRemoteServer } = await import('./src/remote/server.js');
      // Start asynchronously — don't block launch.
      startRemoteServer({ port: DEFAULT_REMOTE_PORT, workDir: WORK_DIR })
        .then(started => {
          if (!started) console.log(`${Y}not started${X} ${D}(check credentials in .env)${X}`);
        })
        .catch(() => {});
      console.log(`${G}starting${X} ${D}(port ${DEFAULT_REMOTE_PORT})${X}`);
    } catch {
      console.log(`${Y}disabled${X} ${D}(module missing)${X}`);
    }
  } else {
    console.log(`${D}disabled (set REMOTE_ENABLED=true)${X}`);
  }

  return true;
}

async function main() {
  banner();

  const ok = await preflight();
  if (!ok) process.exit(1);

  console.log(`\n  ${G}${B}All systems go.${X} Launching cobra-commander...\n`);
  console.log(`  ${D}${'━'.repeat(57)}${X}\n`);

  const child = spawn(
    process.execPath,
    ['--import', 'tsx', join(WORK_DIR, 'src/cli.ts')],
    {
      cwd: WORK_DIR,
      stdio: 'inherit',
      env: {
        ...process.env,
        WORKER_API_KEY: process.env.WORKER_API_KEY || '',
      },
    },
  );

  child.on('exit', (code) => process.exit(code ?? 0));
}

main().catch(err => {
  console.error(`${R}Startup error: ${err.message}${X}`);
  process.exit(1);
});
