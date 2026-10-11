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
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { initReactiveBus } from './core/reactive-bus.js';
import { installRoot } from './core/env-file.js';
import { DEFAULT_API_PORT, DEFAULT_REMOTE_PORT, DEFAULT_SUPPORT_PORT } from './core/net-defaults.js';

const WORK_DIR = process.env.COBRA_WORK_DIR || installRoot();
if (!process.env.CC_HOME) process.env.CC_HOME = WORK_DIR;

function loadEnvFile(path: string): void {
  try {
    const content = readFileSync(path, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx < 1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
      if (!process.env[key]) {
        process.env[key] = val;
      }
    }
  } catch { /* .env may not exist in all installs */ }
}

async function startDaemon(): Promise<void> {
  const envPath = join(WORK_DIR, '.env');
  loadEnvFile(envPath);

  process.chdir(WORK_DIR);

  const nodeBin = join(process.execPath, '..');
  if (!process.env.PATH?.includes(nodeBin)) {
    process.env.PATH = `${nodeBin}:${process.env.PATH}`;
  }

  console.log(`[daemon] Cobra Commander starting`);
  console.log(`[daemon] workdir: ${WORK_DIR}`);
  console.log(`[daemon] node: ${process.execPath}`);
  console.log(`[daemon] pid: ${process.pid}`);

  // Resume-aware boot reconcile: any task left "active" by a prior process
  // (crash/kill/reboot) is an orphan. Instead of discarding it, requeue it for
  // resume from its persisted ledger — the task-runner will pick it up. Tasks
  // that have exhausted their resume budget are failed loud.
  try {
    const { reconcileActiveTasksForResume } = await import('./core/task-store.js');
    const { resumed, failed } = reconcileActiveTasksForResume();
    console.log(`[daemon] Task reconciliation: ${resumed} requeued for resume, ${failed} failed-loud`);
  } catch (err) {
    console.error(`[daemon] Task reconciliation failed:`, err);
  }

  // Durable task executor + crash-resume watchdog. The daemon (a persistent
  // systemd service) now OWNS orchestrator execution: dispatch drops a pending
  // task, the runner executes it here and resumes it if the process dies.
  let teardownTaskRunner: (() => void) | undefined;
  try {
    const { startTaskRunner } = await import('./core/task-runner.js');
    teardownTaskRunner = startTaskRunner();
    console.log(`[daemon] Task runner: active`);
  } catch (e: any) {
    console.error(`[daemon] Task runner failed: ${e.message}`);
  }

  let apiClose: (() => void) | undefined;
  let remoteClose: (() => void) | undefined;

  // Start API server (localhost-bound)
  try {
    const { startApiServer } = await import('./api-server/server.js');
    const api = await startApiServer({
      port: DEFAULT_API_PORT,
      host: process.env.API_HOST || '127.0.0.1',
      workDir: WORK_DIR,
    });
    apiClose = api.close;
    console.log(`[daemon] API server: http://127.0.0.1:${api.port}`);
  } catch (e: any) {
    console.error(`[daemon] API server failed: ${e.message}`);
  }

  // Start remote control server in background (waits for Tailscale, doesn't block daemon)
  const remoteReady = (async () => {
    try {
      const { startRemoteServer } = await import('./remote/server.js');
      const remote = await startRemoteServer({
        port: DEFAULT_REMOTE_PORT,
        workDir: WORK_DIR,
      });
      if (remote) {
        remoteClose = remote.close;
        console.log(`[daemon] Remote server: port ${remote.port}`);
      } else {
        console.log(`[daemon] Remote server: disabled`);
      }
    } catch (e: any) {
      console.error(`[daemon] Remote server failed: ${e.message}`);
    }
  })();

  const teardownReactiveBus = initReactiveBus();
  console.log(`[daemon] Reactive event bus: active`);

  // Start scan scheduler (hourly OSINT org scans with inline triage)
  let teardownScheduler: (() => void) | undefined;
  try {
    const { startScanScheduler } = await import('./core/scan-scheduler.js');
    teardownScheduler = startScanScheduler();
    console.log(`[daemon] Scan scheduler: active`);
  } catch (e: any) {
    console.error(`[daemon] Scan scheduler failed: ${e.message}`);
  }

  // Start Destro daemon (support/troubleshooting agent) as supervised child process
  let destroChild: import('node:child_process').ChildProcess | null = null;
  let destroRestarts = 0;
  const DESTRO_MAX_RESTARTS = 5;
  const DESTRO_RESTART_WINDOW_MS = 60 * 60 * 1000; // 1 hour
  let destroWindowStart = Date.now();

  async function startDestroDaemon(): Promise<void> {
    const destroPort = String(DEFAULT_SUPPORT_PORT);
    try {
      // ESM: no global require under the tsx loader — use dynamic import.
      const { fork } = await import('node:child_process');
      // Use tsx to run the TypeScript directly (same as CC daemon itself).
      // Resolve the tsx loader by absolute path — bare '--import tsx' resolution
      // is cwd-dependent and fragile under systemd.
      const tsxLoader = join(WORK_DIR, 'node_modules/tsx/dist/loader.mjs');
      const child = fork(
        join(WORK_DIR, 'src/destro/destro-daemon.ts'),
        [],
        {
          execArgv: ['--import', `file://${tsxLoader}`],
          env: { ...process.env, DESTRO_PORT: destroPort },
          stdio: 'pipe',
          silent: true,
        },
      );
      child.stdout?.on('data', (d: Buffer) => process.stdout.write(`[destro] ${d}`));
      child.stderr?.on('data', (d: Buffer) => process.stderr.write(`[destro-err] ${d}`));
      child.on('exit', (code: number | null, signal: string | null) => {
        console.log(`[daemon] Destro daemon exited (code=${code}, signal=${signal})`);
        destroChild = null;
        // Restart with backoff, max 5/hr
        const now = Date.now();
        if (now - destroWindowStart > DESTRO_RESTART_WINDOW_MS) {
          destroRestarts = 0;
          destroWindowStart = now;
        }
        if (destroRestarts < DESTRO_MAX_RESTARTS) {
          destroRestarts++;
          const delay = Math.min(1000 * Math.pow(2, destroRestarts), 30000);
          console.log(`[daemon] Restarting Destro in ${delay}ms (attempt ${destroRestarts}/${DESTRO_MAX_RESTARTS})`);
          setTimeout(() => { void startDestroDaemon(); }, delay);
        } else {
          console.error(`[daemon] Destro exceeded max restarts (${DESTRO_MAX_RESTARTS}/hr) — NOT restarting`);
        }
      });
      destroChild = child;
      console.log(`[daemon] Destro daemon forked (pid=${child.pid}, port=${destroPort})`);
    } catch (e: any) {
      console.error(`[daemon] Destro daemon failed to start: ${e.message}`);
    }
  }

  void startDestroDaemon();

  console.log(`[daemon] Ready`);

  const shutdown = async () => {
    console.log(`[daemon] Shutting down...`);
    teardownTaskRunner?.();
    teardownScheduler?.();
    teardownReactiveBus();
    apiClose?.();
    await remoteReady;
    remoteClose?.();
    if (destroChild) { destroChild.kill('SIGTERM'); destroChild = null; }
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
}

export { startDaemon };

startDaemon().catch(e => {
  console.error(`[daemon] Fatal: ${e.message}`);
  process.exit(1);
});
