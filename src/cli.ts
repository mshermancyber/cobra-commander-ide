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
import { Command } from 'commander';
import { spawn } from 'node:child_process';
import { watch } from 'node:fs';
import { resolve, relative, join } from 'node:path';
import { homedir } from 'node:os';
import { shouldIgnore } from './core/ignore-patterns.js';
import chalk from 'chalk';
import { DEFAULT_API_PORT, DEFAULT_REMOTE_PORT, DEFAULT_SUPPORT_PORT } from './core/net-defaults.js';

const program = new Command();

program
  .name('cobra')
  .description('Cobra Commander — multi-model AI coding platform. An orchestrator model plans; worker models implement.')
  .version('0.1.0');

// ──────────────────────────────────────────────
// ide — IDE operations
// ──────────────────────────────────────────────

const ideCommand = new Command('ide')
  .description('IDE operations (run commands, watch files)');

ideCommand
  .command('run')
  .description('Run a shell command in the project directory, optionally watching for changes')
  .argument('<command...>', 'Shell command to execute')
  .option('-w, --on-change', 'Watch for file changes and re-run the command')
  .option('-d, --debounce <ms>', 'Debounce time in milliseconds', '500')
  .option('--work-dir <dir>', 'Working directory', process.cwd())
  .action(async (commandArgs: string[], options: { onChange?: boolean; debounce: string; workDir: string }) => {
    const command = commandArgs.join(' ');
    const workDir = resolve(options.workDir);
    const debounceMs = parseInt(options.debounce, 10);

    if (isNaN(debounceMs) || debounceMs < 0) {
      console.error(chalk.red('Error: --debounce must be a non-negative integer'));
      process.exit(1);
    }

    if (!command.trim()) {
      console.error(chalk.red('Error: command is required'));
      process.exit(1);
    }

    console.log(chalk.cyan(`[ide run] ${command}`));
    console.log(chalk.dim(`[ide run] workdir: ${workDir}`));

    if (options.onChange) {
      console.log(chalk.dim(`[ide run] watching for changes (debounce: ${debounceMs}ms)...`));
    }

    let running = false;
    let pending = false;
    let currentProcess: ReturnType<typeof spawn> | null = null;
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    const runCommand = (): void => {
      if (running) {
        pending = true;
        return;
      }

      pending = false;
      running = true;

      const now = new Date().toLocaleTimeString();
      console.log(chalk.green(`\n[${now}] Running: ${command}`));

      const child = spawn('/bin/sh', ['-c', command], {
        cwd: workDir,
        stdio: 'inherit',
        env: { ...process.env, TERM: 'dumb' },
      });

      currentProcess = child;

      child.on('exit', (code) => {
        running = false;
        currentProcess = null;

        if (code === 0) {
          console.log(chalk.green(`[${new Date().toLocaleTimeString()}] Exit: 0`));
        } else {
          console.log(chalk.red(`[${new Date().toLocaleTimeString()}] Exit: ${code}`));
        }

        if (pending) {
          runCommand();
        }
      });

      child.on('error', (err) => {
        running = false;
        currentProcess = null;
        console.error(chalk.red(`[ide run] Error: ${err.message}`));

        if (pending) {
          runCommand();
        }
      });
    };

    const scheduleRun = (): void => {
      if (debounceTimer) {
        clearTimeout(debounceTimer);
      }

      if (running && currentProcess) {
        pending = true;
        console.log(chalk.yellow(`[ide run] Changes detected, queued for after current run...`));
        return;
      }

      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        runCommand();
      }, debounceMs);
    };

    const isWatched = (filePath: string): boolean => {
      const rel = relative(workDir, filePath);
      if (rel.startsWith('..')) return false;
      return !shouldIgnore(rel);
    };

    // Initial run
    runCommand();

    if (options.onChange) {
      let watcher: ReturnType<typeof watch> | null = null;

      const startWatcher = (): void => {
        try {
          watcher = watch(workDir, { recursive: true }, (eventType, filename) => {
            if (!filename) return;

            const fullPath = join(workDir, filename);

            if (eventType === 'change' || eventType === 'rename') {
              if (isWatched(fullPath)) {
                const rel = relative(workDir, fullPath);
                console.log(chalk.dim(`[ide run] Changed: ${rel}`));
                scheduleRun();
              }
            }
          });

          watcher.on('error', (err) => {
            if ((err as NodeJS.ErrnoException).code === 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM') {
              console.error(chalk.red('[ide run] Recursive watch not supported on this platform. Falling back to non-recursive watch.'));
              watcher?.close();
              watcher = watch(workDir, {}, (eventType, filename) => {
                if (!filename) return;
                const fullPath = join(workDir, filename);
                if (isWatched(fullPath)) {
                  scheduleRun();
                }
              });
            } else {
              console.error(chalk.red(`[ide run] Watcher error: ${(err as Error).message}`));
            }
          });

          console.log(chalk.dim('[ide run] File watcher active'));
        } catch (err) {
          console.error(chalk.red(`[ide run] Failed to start watcher: ${(err as Error).message}`));
        }
      };

      startWatcher();

      const shutdown = (): void => {
        if (debounceTimer) clearTimeout(debounceTimer);
        watcher?.close();
        if (currentProcess) {
          currentProcess.kill('SIGTERM');
        }
        process.exit(0);
      };

      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);

      // Keep process alive (watcher prevents exit, but explicit forever loop for safety)
      process.stdin.resume();
    }
  });

program.addCommand(ideCommand);

// ──────────────────────────────────────────────
// delegate — one-shot worker task
// ──────────────────────────────────────────────

program
  .command('delegate')
  .description('Delegate a task directly to a worker (one-shot, bypasses orchestrator)')
  .argument('<task>', 'Task description for the worker')
  .option('-d, --work-dir <dir>', 'Working directory', process.cwd())
  .option('-m, --model <name>', 'Worker model name or tier (fast/standard/heavy)')
  .option('-t, --turns <n>', 'Max worker turns', '150')
  .option('-v, --verbose', 'Verbose tool output')
  .action(async (task: string, options: { workDir: string; model?: string; turns: string; verbose?: boolean }) => {
    const workDir = resolve(options.workDir);
    const maxTurns = parseInt(options.turns, 10);

    if (isNaN(maxTurns) || maxTurns < 1) {
      console.error(chalk.red('Error: --turns must be a positive integer'));
      process.exit(1);
    }

    console.log(chalk.cyan(`\n  ${chalk.bold('Cobra Commander — Delegate')}`));
    console.log(chalk.dim(`  WorkDir: ${workDir}`));
    console.log(chalk.dim(`  Task:    ${task.slice(0, 120)}`));
    if (options.model) console.log(chalk.dim(`  Model:   ${options.model}`));
    console.log();

    try {
      const { loadConfig, hydrateWorkerKey } = await import('./core/config.js');
      const { Worker } = await import('./core/worker.js');
      const { randomBytes } = await import('node:crypto');

      let config = loadConfig({ workDir });
      config = await hydrateWorkerKey(config);
      config.maxWorkerTurns = maxTurns;

      if (!config.worker.apiKey) {
        console.error(chalk.red('Error: No worker API key configured.'));
        console.error(chalk.dim('  Set WORKER_API_KEY env var or configure ~/.cobra-commander/config.json'));
        process.exit(1);
      }

      const workerId = `w-${randomBytes(4).toString('hex')}`;

      const worker = new Worker(config, {
        onText: (t) => {
          if (options.verbose) console.log(chalk.white(t.slice(0, 2000)));
        },
        onToolCall: (n, i) => {
          const s = n === 'run_command'
            ? `$ ${(i.command as string).slice(0, 120)}`
            : n === 'write_file' || n === 'write_files'
              ? `write ${(i.path || (Array.isArray((i as { files?: Array<{ path: string }> }).files) ? (i as { files: Array<{ path: string }> }).files.map((f: { path: string }) => f.path).join(', ') : ''))}`
              : n === 'read_file' ? `read ${i.path}`
                : n === 'edit_file' ? `edit ${i.path}`
                  : n === 'grep_files' ? `grep ${i.pattern}`
                    : n === 'patch_file' ? `patch ${i.path}`
                      : n === 'apply_patch' ? `apply_patch`
                        : n === 'apply_unified_diff' ? `apply_diff ${i.file_path}`
                          : n;
          console.log(chalk.dim(`  [tool] ${s}`));
        },
        onToolResult: (n, r, e) => {
          if (e) console.log(chalk.red(`  [ERR] ${n}: ${r.slice(0, 500)}`));
          else if (options.verbose) console.log(chalk.dim(`  [ok]  ${n} (${r.length} chars)`));
        },
        onTokenUsage: (i, o) => {
          console.log(chalk.dim(`  [tokens] in:${i} out:${o}`));
        },
      }, options.model, undefined, workerId);

      const context = [
        `Working directory: ${workDir}`,
        'ESM TypeScript, Node 22, 2-space indent, single quotes, .js imports.',
        'Read existing files first. Match patterns. Run npx tsc --noEmit when done if you modified .ts files.',
        `Worker ID: ${workerId}.`,
      ].join('\n');

      const criteria = [
        'Task completed as described',
        'No type errors (tsc --noEmit passes if code was changed)',
      ];

      console.log(chalk.bold(`\n  === Task [${workerId}] ===\n`));

      const result = await worker.executeTask(task, context, criteria);

      console.log(chalk.green('\n  === RESULT ==='));
      console.log(result);
      process.exit(0);
    } catch (err) {
      console.error(chalk.red(`\n  === FAILED ===`));
      console.error(chalk.red((err as Error).message));
      process.exit(1);
    }
  });

// ──────────────────────────────────────────────
// daemon — start the full daemon service
// ──────────────────────────────────────────────

program
  .command('daemon')
  .description('Start the Cobra Commander daemon (API server + task runner + web shell + support agent)')
  .option('-d, --work-dir <dir>', 'Working directory', process.cwd())
  .option('--api-port <port>', 'API server port', String(DEFAULT_API_PORT))
  .option('--remote-port <port>', 'Remote control port', String(DEFAULT_REMOTE_PORT))
  .option('--destro-port <port>', 'Support agent daemon port', String(DEFAULT_SUPPORT_PORT))
  .option('--no-destro', 'Disable Destro daemon')
  .option('--no-remote', 'Disable remote control server')
  .action(async (options: { workDir: string; apiPort: string; remotePort: string; destroPort: string; noDestro?: boolean; noRemote?: boolean }) => {
    const workDir = resolve(options.workDir);
    process.env.COBRA_WORK_DIR = workDir;
    if (!process.env.CC_HOME) process.env.CC_HOME = workDir;
    process.env.API_PORT = options.apiPort;
    process.env.REMOTE_PORT = options.remotePort;
    process.env.DESTRO_PORT = options.destroPort;
    if (options.noDestro) process.env.DESTRO_DISABLED = '1';
    if (options.noRemote) process.env.REMOTE_ENABLED = 'false';

    console.log(chalk.cyan(`\n  ${chalk.bold('Cobra Commander Daemon')}`));
    console.log(chalk.dim(`  WorkDir: ${workDir}`));
    console.log(chalk.dim(`  API:     port ${options.apiPort}`));
    if (!options.noRemote) console.log(chalk.dim(`  Remote:  port ${options.remotePort}`));
    if (!options.noDestro) console.log(chalk.dim(`  Destro:  port ${options.destroPort}`));
    console.log();

    // daemon.ts auto-starts on import (module-level startDaemon() call).
    // We set env vars above, then import to trigger.
    try {
      await import('./daemon.js');
    } catch (err) {
      console.error(chalk.red(`Daemon error: ${(err as Error).message}`));
      process.exit(1);
    }
  });

// ──────────────────────────────────────────────
// start — preflight check + launch daemon
// ──────────────────────────────────────────────

program
  .command('start')
  .description('Run preflight checks and launch the Cobra Commander daemon')
  .option('-d, --work-dir <dir>', 'Working directory', process.cwd())
  .option('--api-port <port>', 'API server port', String(DEFAULT_API_PORT))
  .option('--remote-port <port>', 'Remote control port', String(DEFAULT_REMOTE_PORT))
  .action(async (options: { workDir: string; apiPort: string; remotePort: string }) => {
    const workDir = resolve(options.workDir);

    console.log(chalk.green(chalk.bold(`
  ╔═══════════════════════════════════════════════════════════╗
  ║                                                           ║
  ║              ▄▄▄   COBRA COMMANDER   ▄▄▄                  ║
  ║             ▀█▀▀▀▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▀▀▀█▀                   ║
  ║                                                           ║
  ║              One orchestrator · many workers              ║
  ║                                                           ║
  ╚═══════════════════════════════════════════════════════════╝
    `)));

    try {
      // Preflight: check config and API key (separate import before daemon)
      console.log(chalk.dim('  Running preflight checks...\n'));

      const { loadConfig, hydrateWorkerKey } = await import('./core/config.js');

      const config = loadConfig({ workDir });
      await hydrateWorkerKey(config);

      if (!config.worker.apiKey) {
        console.log(chalk.red('  ✗ No worker API key found.'));
        console.log(chalk.dim('    Set WORKER_API_KEY env var or configure ~/.cobra-commander/config.json'));
        console.log(chalk.dim('    Or run: npx cobra config show'));
        process.exit(1);
      }
      console.log(chalk.green(`  ✓ Worker key resolved (${config.worker.model})`));

      if (config.orchestrator.apiKey) {
        console.log(chalk.green(`  ✓ Orchestrator key resolved (${config.orchestrator.model})`));
      } else {
        console.log(chalk.yellow(`  ⚠ Orchestrator key not set (worker-only mode)`));
      }

      console.log(chalk.green(`\n  ✓ Preflight passed. Starting daemon...\n`));
      console.log(chalk.dim('  ' + '━'.repeat(57) + '\n'));

      // Set env and import daemon (auto-starts on import)
      process.env.COBRA_WORK_DIR = workDir;
      if (!process.env.CC_HOME) process.env.CC_HOME = workDir;
      process.env.API_PORT = options.apiPort;
      process.env.REMOTE_PORT = options.remotePort;
      await import('./daemon.js');
    } catch (err) {
      console.error(chalk.red(`\n  Preflight/startup error: ${(err as Error).message}`));
      process.exit(1);
    }
  });

// ──────────────────────────────────────────────
// config — configuration management
// ──────────────────────────────────────────────

const configCommand = new Command('config')
  .description('Manage Cobra Commander configuration');

configCommand
  .command('show')
  .description('Show current configuration')
  .option('-d, --work-dir <dir>', 'Working directory', process.cwd())
  .action(async (options: { workDir: string }) => {
    const workDir = resolve(options.workDir);

    try {
      const { loadConfig, hydrateWorkerKey } = await import('./core/config.js');
      const config = loadConfig({ workDir });
      await hydrateWorkerKey(config);

      console.log(chalk.cyan(chalk.bold('\n  Configuration')));
      console.log(chalk.dim('  ' + '─'.repeat(50)));

      const maskKey = (k: string) => k ? `${k.slice(0, 8)}...${k.slice(-4)}` : chalk.dim('(not set)');

      console.log(`  ${chalk.bold('Orchestrator')}`);
      console.log(`    Model:   ${chalk.green(config.orchestrator.model)}`);
      console.log(`    Base URL: ${chalk.dim(config.orchestrator.baseUrl)}`);
      console.log(`    API Key:  ${maskKey(config.orchestrator.apiKey)}`);

      console.log(`\n  ${chalk.bold('Worker')}`);
      console.log(`    Model:   ${chalk.green(config.worker.model)}`);
      console.log(`    Base URL: ${chalk.dim(config.worker.baseUrl)}`);
      console.log(`    API Key:  ${maskKey(config.worker.apiKey)}`);

      console.log(`\n  ${chalk.bold('Settings')}`);
      console.log(`    Home Dir:       ${chalk.dim(config.homeDir)}`);
      console.log(`    Work Dir:       ${chalk.dim(config.workDir)}`);
      console.log(`    Max Turns:      ${config.maxWorkerTurns}`);
      console.log(`    Max Retries:    ${config.maxRetries}`);
      console.log(`    Command Timeout: ${config.commandTimeout}s`);
      console.log(`    Auto Scan:      ${config.autoScan ? chalk.green('on') : chalk.dim('off')}`);
      console.log(`    Auto Commit:    ${config.autoCommitEnabled ? chalk.green('on') : chalk.dim('off')}`);
      console.log(`    Auto Retry:     ${config.autoRetry ? chalk.green('on') : chalk.dim('off')}`);
      console.log(`    Verbose:        ${config.verbose ? chalk.green('on') : chalk.dim('off')}`);

      if (config.verification?.commands?.length) {
        console.log(`\n  ${chalk.bold('Verification Commands')}`);
        for (const cmd of config.verification.commands) {
          console.log(`    ${chalk.dim('$')} ${cmd}`);
        }
      }

      if (config.workerPool.length > 1) {
        console.log(`\n  ${chalk.bold('Worker Pool')}`);
        for (const w of config.workerPool) {
          console.log(`    ${chalk.green(w.name)} — ${w.tier} (${w.provider.model})`);
        }
      }

      console.log();
    } catch (err) {
      console.error(chalk.red(`Config error: ${(err as Error).message}`));
      process.exit(1);
    }
  });

configCommand
  .command('path')
  .description('Show config file paths')
  .action(() => {
    const configDir = join(homedir(), '.cobra-commander');
    console.log(chalk.cyan('\n  Config file paths:'));
    console.log(chalk.dim(`    Config:     ${join(configDir, 'config.json')}`));
    console.log(chalk.dim(`    Projects:   ${join(configDir, 'projects.json')}`));
    console.log(chalk.dim(`    Security:   ${join(configDir, 'security.json')}`));
    console.log(chalk.dim(`    Context:    ${join(configDir, 'context.md')}`));
    console.log(chalk.dim(`    Vault:      ${join(configDir, '.env')}`));
    console.log();
  });

program.addCommand(configCommand);

// ──────────────────────────────────────────────
// project — multi-project management
// ──────────────────────────────────────────────

const projectCommand = new Command('project')
  .description('Manage registered projects');

projectCommand
  .command('list')
  .description('List all registered projects')
  .action(async () => {
    try {
      const { listProjects, getActiveProject } = await import('./core/config.js');
      const projects = listProjects();
      const active = getActiveProject();

      if (projects.length === 0) {
        console.log(chalk.dim('\n  No projects registered.'));
        console.log(chalk.dim('  Use: cobra project add <name> <path>\n'));
        return;
      }

      console.log(chalk.cyan(chalk.bold('\n  Registered Projects')));
      console.log(chalk.dim('  ' + '─'.repeat(60)));

      for (const p of projects) {
        const marker = active && p.name === active.name ? chalk.green('★') : ' ';
        console.log(`  ${marker} ${chalk.bold(p.name)}`);
        console.log(`    Path:  ${chalk.dim(p.path)}`);
        if (p.lastUsedAt) {
          console.log(`    Last:  ${chalk.dim(new Date(p.lastUsedAt).toLocaleString())}`);
        }
      }
      console.log();
    } catch (err) {
      console.error(chalk.red(`Error: ${(err as Error).message}`));
      process.exit(1);
    }
  });

projectCommand
  .command('add')
  .description('Register a new project')
  .argument('<name>', 'Project name')
  .argument('<path>', 'Project root path')
  .action(async (name: string, path: string) => {
    try {
      const { addProject } = await import('./core/config.js');
      const absPath = resolve(path);
      const result = addProject(name, absPath);
      console.log(chalk.green(`\n  ✓ Project "${name}" registered at ${absPath}`));
      if (result.activeProject === name) {
        console.log(chalk.dim('    Set as active project.\n'));
      }
    } catch (err) {
      console.error(chalk.red(`Error: ${(err as Error).message}`));
      process.exit(1);
    }
  });

projectCommand
  .command('remove')
  .description('Remove a registered project')
  .argument('<name>', 'Project name')
  .action(async (name: string) => {
    try {
      const { removeProject } = await import('./core/config.js');
      removeProject(name);
      console.log(chalk.green(`\n  ✓ Project "${name}" removed.\n`));
    } catch (err) {
      console.error(chalk.red(`Error: ${(err as Error).message}`));
      process.exit(1);
    }
  });

projectCommand
  .command('switch')
  .description('Switch active project')
  .argument('<name>', 'Project name')
  .action(async (name: string) => {
    try {
      const { switchProject } = await import('./core/config.js');
      const project = switchProject(name);

      if (project) {
        console.log(chalk.green(`\n  ✓ Switched to "${name}" at ${project.path}\n`));
      } else {
        console.error(chalk.red(`\n  ✗ Project "${name}" not found.\n`));
        process.exit(1);
      }
    } catch (err) {
      console.error(chalk.red(`Error: ${(err as Error).message}`));
      process.exit(1);
    }
  });

program.addCommand(projectCommand);

// ──────────────────────────────────────────────
// task — task management
// ──────────────────────────────────────────────

const taskCommand = new Command('task')
  .description('Manage tasks in the Cobra Commander task queue');

taskCommand
  .command('list')
  .description('List tasks by status')
  .option('-s, --status <status>', 'Filter by status (pending/active/completed/failed/all)', 'all')
  .option('-n, --limit <n>', 'Max tasks to show', '20')
  .action(async (options: { status: string; limit: string }) => {
    const limit = parseInt(options.limit, 10);
    try {
      const { listTasks } = await import('./core/task-store.js');
      const tasks = listTasks(
        options.status === 'all' ? undefined : options.status as 'pending' | 'active' | 'completed' | 'failed',
      ).slice(0, limit);

      if (tasks.length === 0) {
        console.log(chalk.dim(`\n  No ${options.status === 'all' ? '' : options.status + ' '}tasks found.\n`));
        return;
      }

      console.log(chalk.cyan(chalk.bold(`\n  Tasks (${options.status})`)));
      console.log(chalk.dim('  ' + '─'.repeat(70)));

      for (const t of tasks) {
        const statusColor = t.status === 'completed' ? chalk.green :
          t.status === 'failed' ? chalk.red :
            t.status === 'active' ? chalk.yellow : chalk.dim;
        console.log(`  ${chalk.bold(t.id)}  ${statusColor(t.status.padEnd(10))}  ${t.task.slice(0, 60)}`);
        if (t.workDir) console.log(chalk.dim(`    workDir: ${t.workDir}`));
        if (t.result) console.log(chalk.dim(`    result:  ${t.result.slice(0, 80)}`));
      }
      console.log();
    } catch (err) {
      console.error(chalk.red(`Error: ${(err as Error).message}`));
      process.exit(1);
    }
  });

taskCommand
  .command('dispatch')
  .description('Dispatch a new task to the queue (will be picked up by daemon)')
  .argument('<description>', 'Task description')
  .option('-d, --work-dir <dir>', 'Working directory', process.cwd())
  .option('-c, --context <text>', 'Additional context for the task')
  .action(async (description: string, options: { workDir: string; context?: string }) => {
    try {
      const { createTask } = await import('./core/task-store.js');
      const record = createTask(description, options.context, resolve(options.workDir));
      console.log(chalk.green(`\n  ✓ Task dispatched: ${chalk.bold(record.id)}`));
      console.log(chalk.dim(`    Status:  pending`));
      console.log(chalk.dim(`    WorkDir: ${record.workDir}`));
      console.log(chalk.dim(`\n  The daemon's task-runner will pick this up.`));
      console.log(chalk.dim(`  Monitor with: cobra task status ${record.id}\n`));
    } catch (err) {
      console.error(chalk.red(`Dispatch error: ${(err as Error).message}`));
      process.exit(1);
    }
  });

taskCommand
  .command('status')
  .description('Show status of a specific task')
  .argument('<id>', 'Task ID')
  .action(async (id: string) => {
    try {
      const { getTask } = await import('./core/task-store.js');
      const task = getTask(id);

      if (!task) {
        console.error(chalk.red(`\n  ✗ Task "${id}" not found.\n`));
        process.exit(1);
      }

      const statusColor = task.status === 'completed' ? chalk.green :
        task.status === 'failed' ? chalk.red :
          task.status === 'active' ? chalk.yellow : chalk.dim;

      console.log(chalk.cyan(chalk.bold(`\n  Task ${task.id}`)));
      console.log(chalk.dim('  ' + '─'.repeat(60)));
      console.log(`  Status:    ${statusColor(task.status)}`);
      console.log(`  Task:      ${task.task}`);
      console.log(`  WorkDir:   ${chalk.dim(task.workDir)}`);
      if (task.context) console.log(`  Context:   ${chalk.dim(task.context.slice(0, 200))}`);
      if (task.assignedWorker) console.log(`  Worker:    ${task.assignedWorker}`);
      if (task.result) console.log(`  Result:    ${task.result.slice(0, 500)}`);
      if (task.error) console.log(`  ${chalk.red('Error:')}     ${task.error.slice(0, 500)}`);
      console.log(`  Created:   ${new Date(task.createdAt).toLocaleString()}`);
      if (task.completedAt) console.log(`  Completed: ${new Date(task.completedAt).toLocaleString()}`);
      console.log();
    } catch (err) {
      console.error(chalk.red(`Error: ${(err as Error).message}`));
      process.exit(1);
    }
  });

program.addCommand(taskCommand);

// ──────────────────────────────────────────────
// api — standalone API server
// ──────────────────────────────────────────────

program
  .command('api')
  .description('Start the API server standalone (no daemon)')
  .option('-p, --port <port>', 'Port to listen on', String(DEFAULT_API_PORT))
  .option('-h, --host <host>', 'Host to bind to', '127.0.0.1')
  .option('-d, --work-dir <dir>', 'Working directory', process.cwd())
  .action(async (options: { port: string; host: string; workDir: string }) => {
    const port = parseInt(options.port, 10);
    const host = options.host;
    const workDir = resolve(options.workDir);

    console.log(chalk.cyan(`\n  Starting API server on ${host}:${port}...`));

    try {
      const { startApiServer } = await import('./api-server/server.js');
      const api = await startApiServer({ port, host, workDir });
      console.log(chalk.green(`  ✓ API server listening on http://${host}:${api.port}`));
      console.log(chalk.dim(`    Token: ${api.token.slice(0, 16)}...`));
      console.log(chalk.dim(`    Press Ctrl+C to stop.\n`));

      const shutdown = () => {
        console.log(chalk.dim('\n  Shutting down API server...'));
        api.close();
        process.exit(0);
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
    } catch (err) {
      console.error(chalk.red(`API server error: ${(err as Error).message}`));
      process.exit(1);
    }
  });

// ──────────────────────────────────────────────
// remote — standalone remote control server
// ──────────────────────────────────────────────

program
  .command('remote')
  .description('Start the remote control web shell server standalone')
  .option('-p, --port <port>', 'Port to listen on', String(DEFAULT_REMOTE_PORT))
  .option('-d, --work-dir <dir>', 'Working directory', process.cwd())
  .action(async (options: { port: string; workDir: string }) => {
    const port = parseInt(options.port, 10);
    const workDir = resolve(options.workDir);

    console.log(chalk.cyan(`\n  Starting remote control server...`));

    try {
      const { startRemoteServer } = await import('./remote/server.js');
      const remote = await startRemoteServer({ port, workDir });

      if (!remote) {
        console.log(chalk.yellow('  Remote server: disabled or Tailscale not available.'));
        process.exit(0);
      }

      console.log(chalk.green(`  ✓ Remote server listening on port ${remote.port}`));
      console.log(chalk.dim(`    Press Ctrl+C to stop.\n`));

      const shutdown = () => {
        console.log(chalk.dim('\n  Shutting down remote server...'));
        remote.close();
        process.exit(0);
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
    } catch (err) {
      console.error(chalk.red(`Remote server error: ${(err as Error).message}`));
      process.exit(1);
    }
  });

// ──────────────────────────────────────────────
// Parse
// ──────────────────────────────────────────────

program.parse(process.argv);
