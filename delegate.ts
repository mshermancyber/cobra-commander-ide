#!/usr/bin/env node
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
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { loadConfig, hydrateWorkerKey } from './src/core/config.js';
import { Worker } from './src/core/worker.js';
import { registerWorker, completeWorker } from './src/core/worker-registry.js';
import { randomBytes } from 'node:crypto';

const taskDesc = process.argv[2];
const workDir = process.argv[3] || process.cwd();
const parentId = process.argv[4] || null;
const spawner = (process.argv[5] as any) || 'delegate';

if (!taskDesc) {
  console.error('Usage: npx tsx delegate.ts "task description" [workDir] [parentId] [spawner]');
  process.exit(1);
}

const workerId = `w-${randomBytes(4).toString('hex')}`;
const logFile = `/tmp/worker-${workerId}.log`;

registerWorker({
  id: workerId,
  pid: process.pid,
  parentId,
  spawner,
  task: taskDesc.slice(0, 200),
  workDir,
  logFile,
});

console.log(`[worker:${workerId}] registered (parent=${parentId || 'root'}, spawner=${spawner})`);

let config = loadConfig({ workDir });
config = await hydrateWorkerKey(config);
config.maxWorkerTurns = 150;

const worker = new Worker(config, {
  onText: (t) => console.log(`[text] ${t.slice(0, 2000)}`),
  onToolCall: (n, i) => {
    const s = n === 'run_command' ? `$ ${(i.command as string).slice(0, 120)}` :
              n === 'write_file' ? `write ${i.path}` : n === 'read_file' ? `read ${i.path}` :
              n === 'edit_file' ? `edit ${i.path}` : n === 'grep_files' ? `grep ${i.pattern}` :
              n === 'patch_file' ? `patch ${i.path}` : n;
    console.log(`[tool] ${n}: ${s}`);
  },
  onToolResult: (n, r, e) => { if (e) console.log(`[ERR] ${n}: ${r.slice(0, 500)}`); else console.log(`[ok] ${n} (${r.length} chars)`); },
  onTokenUsage: (i, o) => console.log(`[tokens] in:${i} out:${o}`),
});

const context = `Working directory: ${workDir}. ESM TypeScript, Node 22, 2-space indent, single quotes, .js imports.
Node 22+ must be on PATH.
Read existing files first. Match patterns. Run npx tsc --noEmit when done if you modified .ts files.
Worker ID: ${workerId}. Parent: ${parentId || 'none'}.`;

const criteria = ['Task completed as described', 'No type errors (tsc --noEmit passes if code was changed)'];

console.log(`\n=== Delegated Task [${workerId}] ===`);
console.log(`WorkDir: ${workDir}`);
console.log(`Task: ${taskDesc}\n`);

worker.executeTask(taskDesc, context, criteria).then(r => {
  console.log('\n=== DONE ===\n' + r);
  completeWorker(workerId, 'done', r);
  process.exit(0);
}).catch(e => {
  console.error('\n=== FAILED ===\n' + e.message);
  completeWorker(workerId, 'failed', e.message);
  process.exit(1);
});
