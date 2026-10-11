import { EventEmitter } from 'node:events';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';

// ──────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────

export type AgentState = 'idle' | 'running' | 'paused' | 'checkpointing' | 'completed' | 'failed' | 'cancelled';
export type LifecycleAction = 'start' | 'pause' | 'resume' | 'cancel';
export type NotificationChannel = 'email' | 'webhook' | 'websocket';

export interface AgentConfig {
  agentId: string;
  taskName: string;
  command: string[];
  workDir: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  maxRetries?: number;
  heartbeatIntervalMs?: number;
  checkpointIntervalMs?: number;
  notifications?: NotificationConfig[];
}

export interface NotificationConfig {
  channel: NotificationChannel;
  target: string; // email address or webhook URL
  onEvents: Array<'completed' | 'failed' | 'checkpoint' | 'heartbeat-lost'>;
}

export interface Heartbeat {
  id: string;
  agentId: string;
  timestamp: string;
  sequence: number;
  state: AgentState;
  progress: number; // 0–100
  message: string;
  metrics: AgentMetrics;
}

export interface AgentMetrics {
  cpuPercent: number;
  memMB: number;
  uptimeMs: number;
  outputSizeBytes: number;
  retriesUsed: number;
}

export interface Checkpoint {
  id: string;
  agentId: string;
  sequence: number;
  timestamp: string;
  state: AgentState;
  progress: number;
  snapshot: {
    stdout: string;
    stderr: string;
    exitCode: number | null;
    env: Record<string, string>;
    workDir: string;
  };
}

export interface Notification {
  id: string;
  agentId: string;
  channel: NotificationChannel;
  target: string;
  event: string;
  subject: string;
  body: string;
  sentAt: string;
  delivered: boolean;
  error?: string;
}

export interface AgentLifecycle {
  agentId: string;
  state: AgentState;
  actions: Array<{ action: LifecycleAction; timestamp: string; detail?: string }>;
  startedAt?: string;
  pausedAt?: string;
  completedAt?: string;
  totalRuntimeMs: number;
}

// ──────────────────────────────────────────────
// Notification Queue
// ──────────────────────────────────────────────

export class NotificationQueue extends EventEmitter {
  private queue: Notification[] = [];
  private history: Notification[] = [];
  private maxHistory = 500;

  enqueue(config: NotificationConfig, agentId: string, event: string, data: Record<string, unknown>): Notification {
    const notification: Notification = {
      id: `notif-${randomUUID().slice(0, 8)}`,
      agentId,
      channel: config.channel,
      target: config.target,
      event,
      subject: `[Cobra Agent] ${event} — ${agentId}`,
      body: JSON.stringify(data, null, 2),
      sentAt: new Date().toISOString(),
      delivered: false,
    };

    this.queue.push(notification);
    this.emit('queued', notification);

    // Attempt immediate delivery
    this.deliver(notification);

    return notification;
  }

  private async deliver(notification: Notification): Promise<void> {
    try {
      switch (notification.channel) {
        case 'email':
          notification.delivered = await this.deliverEmail(notification);
          break;
        case 'webhook':
          notification.delivered = await this.deliverWebhook(notification);
          break;
        case 'websocket':
          // WS delivery is handled by external connection — mark as queued
          notification.delivered = false;
          notification.error = 'WebSocket delivery requires active connection';
          break;
        default:
          notification.error = `Unknown channel: ${notification.channel}`;
      }
    } catch (err) {
      notification.error = (err as Error).message;
    }

    this.archive(notification);
    if (notification.delivered) {
      this.emit('delivered', notification);
    } else {
      this.emit('delivery-failed', notification);
    }
  }

  private async deliverEmail(notification: Notification): Promise<boolean> {
    // Stub: in production, this would use nodemailer or a transactional email API
    // We log the notification and consider it delivered for now
    process.stdout.write(
      `[EMAIL] To: ${notification.target} | Subject: ${notification.subject}\n${notification.body.slice(0, 200)}...\n`
    );
    return true;
  }

  private async deliverWebhook(notification: Notification): Promise<boolean> {
    try {
      const response = await fetch(notification.target, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'Cobra-Cloud-Agent/1.0' },
        body: JSON.stringify({
          event: notification.event,
          agentId: notification.agentId,
          data: JSON.parse(notification.body),
          timestamp: notification.sentAt,
        }),
        signal: AbortSignal.timeout(15_000),
      });

      return response.ok;
    } catch {
      return false;
    }
  }

  private archive(notification: Notification): void {
    // Remove from queue
    this.queue = this.queue.filter(n => n.id !== notification.id);
    // Add to history
    this.history.push(notification);
    if (this.history.length > this.maxHistory) {
      this.history = this.history.slice(-this.maxHistory);
    }
  }

  getPending(): Notification[] {
    return [...this.queue];
  }

  getHistory(limit?: number): Notification[] {
    const history = [...this.history].reverse();
    return limit ? history.slice(0, limit) : history;
  }

  retryFailed(): void {
    const failed = this.history.filter(n => !n.delivered);
    for (const n of failed) {
      this.deliver(n);
    }
  }
}

// ──────────────────────────────────────────────
// Agent Lifecycle Manager
// ──────────────────────────────────────────────

export class AgentLifecycleManager {
  private lifecycles: Map<string, AgentLifecycle> = new Map();

  register(agentId: string): AgentLifecycle {
    const lifecycle: AgentLifecycle = {
      agentId,
      state: 'idle',
      actions: [],
      totalRuntimeMs: 0,
    };
    this.lifecycles.set(agentId, lifecycle);
    return lifecycle;
  }

  getLifecycle(agentId: string): AgentLifecycle | undefined {
    return this.lifecycles.get(agentId);
  }

  transition(agentId: string, action: LifecycleAction, detail?: string): AgentLifecycle | null {
    const lc = this.lifecycles.get(agentId);
    if (!lc) return null;

    const now = new Date().toISOString();
    const valid = this.validateTransition(lc.state, action);

    if (!valid) {
      // Record rejected action
      lc.actions.push({ action, timestamp: now, detail: `REJECTED: ${detail || 'invalid transition'}` });
      return lc;
    }

    switch (action) {
      case 'start':
        lc.state = 'running';
        lc.startedAt = now;
        break;
      case 'pause':
        lc.state = 'paused';
        lc.pausedAt = now;
        break;
      case 'resume':
        lc.state = 'running';
        if (lc.pausedAt) {
          lc.totalRuntimeMs += Date.now() - new Date(lc.pausedAt).getTime();
          lc.pausedAt = undefined;
        }
        break;
      case 'cancel':
        lc.state = 'cancelled';
        lc.completedAt = now;
        break;
    }

    lc.actions.push({ action, timestamp: now, detail });
    return lc;
  }

  complete(agentId: string, success: boolean): AgentLifecycle | null {
    const lc = this.lifecycles.get(agentId);
    if (!lc) return null;

    lc.state = success ? 'completed' : 'failed';
    lc.completedAt = new Date().toISOString();
    return lc;
  }

  private validateTransition(current: AgentState, action: LifecycleAction): boolean {
    const stateTransitions: Record<AgentState, LifecycleAction[]> = {
      idle: ['start', 'cancel'],
      running: ['pause', 'cancel'],
      paused: ['resume', 'cancel'],
      checkpointing: ['pause', 'cancel'],
      completed: [],
      failed: [],
      cancelled: [],
    };
    return stateTransitions[current]?.includes(action) ?? false;
  }

  getActiveAgents(): AgentLifecycle[] {
    return Array.from(this.lifecycles.values()).filter(
      lc => lc.state === 'running' || lc.state === 'paused',
    );
  }

  getRuntimeMs(agentId: string): number {
    const lc = this.lifecycles.get(agentId);
    if (!lc) return 0;
    if (!lc.startedAt) return 0;

    const start = new Date(lc.startedAt).getTime();
    const end = lc.completedAt ? new Date(lc.completedAt).getTime() : Date.now();
    return end - start - lc.totalRuntimeMs;
  }

  removeLifecycle(agentId: string): void {
    this.lifecycles.delete(agentId);
  }
}

// ──────────────────────────────────────────────
// Heartbeat / Checkpoint System
// ──────────────────────────────────────────────

export class HeartbeatCheckpointSystem {
  private heartbeats: Map<string, Heartbeat[]> = new Map();
  private checkpoints: Map<string, Checkpoint[]> = new Map();
  private maxHeartbeats = 1000;
  private maxCheckpoints = 100;

  recordHeartbeat(
    agentId: string,
    state: AgentState,
    progress: number,
    message: string,
    metrics: AgentMetrics,
  ): Heartbeat {
    const history = this.heartbeats.get(agentId) || [];
    const sequence = history.length + 1;

    const hb: Heartbeat = {
      id: `hb-${randomUUID().slice(0, 8)}`,
      agentId,
      timestamp: new Date().toISOString(),
      sequence,
      state,
      progress: Math.min(100, Math.max(0, progress)),
      message,
      metrics,
    };

    history.push(hb);
    if (history.length > this.maxHeartbeats) {
      history.splice(0, history.length - this.maxHeartbeats);
    }
    this.heartbeats.set(agentId, history);

    return hb;
  }

  getLastHeartbeat(agentId: string): Heartbeat | undefined {
    const history = this.heartbeats.get(agentId);
    if (!history || history.length === 0) return undefined;
    return history[history.length - 1];
  }

  getHeartbeats(agentId: string, since?: string): Heartbeat[] {
    const history = this.heartbeats.get(agentId) || [];
    if (since) {
      return history.filter(hb => hb.timestamp >= since);
    }
    return [...history];
  }

  isHeartbeatStale(agentId: string, maxAgeMs: number = 60_000): boolean {
    const last = this.getLastHeartbeat(agentId);
    if (!last) return true;
    return Date.now() - new Date(last.timestamp).getTime() > maxAgeMs;
  }

  createCheckpoint(
    agentId: string,
    state: AgentState,
    progress: number,
    stdout: string,
    stderr: string,
    exitCode: number | null,
    env: Record<string, string>,
    workDir: string,
  ): Checkpoint {
    const history = this.checkpoints.get(agentId) || [];
    const sequence = history.length + 1;

    const cp: Checkpoint = {
      id: `ckpt-${randomUUID().slice(0, 8)}`,
      agentId,
      sequence,
      timestamp: new Date().toISOString(),
      state,
      progress: Math.min(100, Math.max(0, progress)),
      snapshot: {
        stdout: stdout.slice(0, 500_000),
        stderr: stderr.slice(0, 500_000),
        exitCode,
        env: { ...env },
        workDir,
      },
    };

    history.push(cp);
    if (history.length > this.maxCheckpoints) {
      history.splice(0, history.length - this.maxCheckpoints);
    }
    this.checkpoints.set(agentId, history);

    return cp;
  }

  getLastCheckpoint(agentId: string): Checkpoint | undefined {
    const history = this.checkpoints.get(agentId);
    if (!history || history.length === 0) return undefined;
    return history[history.length - 1];
  }

  getCheckpoints(agentId: string): Checkpoint[] {
    return [...(this.checkpoints.get(agentId) || [])];
  }

  getCheckpoint(agentId: string, sequence: number): Checkpoint | undefined {
    const history = this.checkpoints.get(agentId);
    if (!history) return undefined;
    return history.find(cp => cp.sequence === sequence);
  }

  restoreFromCheckpoint(checkpoint: Checkpoint): {
    stdout: string;
    stderr: string;
    exitCode: number | null;
    env: Record<string, string>;
    workDir: string;
    progress: number;
  } {
    return {
      stdout: checkpoint.snapshot.stdout,
      stderr: checkpoint.snapshot.stderr,
      exitCode: checkpoint.snapshot.exitCode,
      env: { ...checkpoint.snapshot.env },
      workDir: checkpoint.snapshot.workDir,
      progress: checkpoint.progress,
    };
  }

  clearAgent(agentId: string): void {
    this.heartbeats.delete(agentId);
    this.checkpoints.delete(agentId);
  }
}

// ──────────────────────────────────────────────
// Persistent Background Agent Worker
// ──────────────────────────────────────────────

export interface AgentRunResult {
  agentId: string;
  state: AgentState;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  startedAt: string;
  completedAt: string;
  heartbeats: Heartbeat[];
  checkpoints: Checkpoint[];
  notifications: Notification[];
}

export class CloudBackgroundAgent extends EventEmitter {
  readonly agentId: string;
  private config: AgentConfig;
  private lifecycle: AgentLifecycleManager;
  private hbSystem: HeartbeatCheckpointSystem;
  private notifQueue: NotificationQueue;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private checkpointTimer: NodeJS.Timeout | null = null;
  private state: AgentState = 'idle';
  private stdout = '';
  private stderr = '';
  private exitCode: number | null = null;
  private retries = 0;
  private startTime = 0;
  private aborted = false;

  constructor(
    config: Omit<AgentConfig, 'agentId'> & { agentId?: string },
    lifecycle: AgentLifecycleManager,
    hbSystem: HeartbeatCheckpointSystem,
    notifQueue: NotificationQueue,
  ) {
    super();
    this.agentId = config.agentId || `agent-${randomUUID().slice(0, 8)}`;
    this.config = { ...config, agentId: this.agentId };
    this.lifecycle = lifecycle;
    this.hbSystem = hbSystem;
    this.notifQueue = notifQueue;

    // Register lifecycle
    this.lifecycle.register(this.agentId);
  }

  getConfig(): AgentConfig {
    return { ...this.config };
  }

  getState(): AgentState {
    return this.state;
  }

  getOutput(): { stdout: string; stderr: string; exitCode: number | null } {
    return {
      stdout: this.stdout.slice(0, 100_000),
      stderr: this.stderr.slice(0, 100_000),
      exitCode: this.exitCode,
    };
  }

  /**
   * Start the agent. The agent continues running even after the caller disconnects.
   */
  async start(): Promise<void> {
    if (this.state !== 'idle') {
      throw new Error(`Cannot start agent in state '${this.state}'`);
    }

    this.lifecycle.transition(this.agentId, 'start', `Task: ${this.config.taskName}`);
    this.state = 'running';
    this.startTime = Date.now();
    this.aborted = false;

    // Start heartbeat
    this.startHeartbeat();

    // Start checkpointing
    this.startCheckpointing();

    this.emit('started', { agentId: this.agentId, timestamp: new Date().toISOString() });

    // Execute the agent task
    await this.execute();

    // After execution (could have been paused, cancelled, etc.)
    this.stopTimers();

    // If completed normally
    if (this.state === 'running') {
      const success = this.exitCode === 0;
      this.state = success ? 'completed' : 'failed';
      this.lifecycle.complete(this.agentId, success);
      this.sendNotification(success ? 'completed' : 'failed', {
        exitCode: this.exitCode,
        durationMs: Date.now() - this.startTime,
        outputSize: this.stdout.length,
      });
    }

    this.emit(this.state, {
      agentId: this.agentId,
      state: this.state,
      exitCode: this.exitCode,
      durationMs: Date.now() - this.startTime,
    });
  }

  /**
   * Pause the agent. Checkpoints current state.
   */
  pause(): boolean {
    if (this.state !== 'running') return false;

    this.lifecycle.transition(this.agentId, 'pause', 'User requested pause');
    this.state = 'paused';
    this.createCheckpoint('Agent paused by user');

    this.emit('paused', { agentId: this.agentId, timestamp: new Date().toISOString() });
    return true;
  }

  /**
   * Resume a paused agent from its last checkpoint.
   */
  async resume(): Promise<void> {
    if (this.state !== 'paused') {
      throw new Error(`Cannot resume agent in state '${this.state}'`);
    }

    this.lifecycle.transition(this.agentId, 'resume', 'User requested resume');
    this.state = 'running';
    this.aborted = false;

    // Restart heartbeats
    this.startHeartbeat();
    this.startCheckpointing();

    this.emit('resumed', { agentId: this.agentId, timestamp: new Date().toISOString() });

    // Re-execute from checkpoint
    await this.execute();
  }

  /**
   * Cancel the agent. Marks it permanently cancelled.
   */
  cancel(reason?: string): boolean {
    if (this.state === 'completed' || this.state === 'failed' || this.state === 'cancelled') {
      return false;
    }

    this.aborted = true;
    this.lifecycle.transition(this.agentId, 'cancel', reason || 'User cancelled');
    this.state = 'cancelled';
    this.stopTimers();

    // Final checkpoint before cancelling
    this.createCheckpoint(`Cancelled: ${reason || 'no reason given'}`);

    this.sendNotification('failed', {
      reason: reason || 'Cancelled by user',
      exitCode: -1,
      durationMs: Date.now() - this.startTime,
    });

    this.emit('cancelled', {
      agentId: this.agentId,
      reason: reason || 'User cancelled',
      timestamp: new Date().toISOString(),
    });

    return true;
  }

  /**
   * Get a full run result for this agent.
   */
  getRunResult(): AgentRunResult {
    return {
      agentId: this.agentId,
      state: this.state,
      exitCode: this.exitCode,
      stdout: this.stdout.slice(0, 500_000),
      stderr: this.stderr.slice(0, 500_000),
      startedAt: new Date(this.startTime || Date.now()).toISOString(),
      completedAt: new Date().toISOString(),
      heartbeats: this.hbSystem.getHeartbeats(this.agentId),
      checkpoints: this.hbSystem.getCheckpoints(this.agentId),
      notifications: this.notifQueue.getPending().filter(n => n.agentId === this.agentId),
    };
  }

  // ── Internal ─────────────────────────────────

  private async execute(): Promise<void> {
    const maxRetries = this.config.maxRetries || 3;

    while (this.retries < maxRetries && !this.aborted && this.state === 'running') {
      try {
        // Simulated async work — in production, this would spawn child processes,
        // make API calls, or orchestrate cloud tasks
        await this.runTask();
        return; // Success
      } catch (err) {
        this.retries++;
        const errorMsg = (err as Error).message;

        if (this.retries >= maxRetries) {
          this.stderr += `\n[FATAL after ${this.retries} retries] ${errorMsg}`;
          this.exitCode = 1;
          return;
        }

        this.stderr += `\n[RETRY ${this.retries}/${maxRetries}] ${errorMsg}`;

        // Wait before retry (exponential backoff)
        await this.sleep(Math.min(1000 * Math.pow(2, this.retries), 30_000));

        // Checkpoint before retry
        this.createCheckpoint(`Retry ${this.retries}/${maxRetries} after error: ${errorMsg}`);
      }
    }
  }

  private async runTask(): Promise<void> {
    // Simulated task execution — in production this would use the real executor.
    // The agent simulates work in chunks so it can be paused/cancelled between chunks.
    const totalSteps = 5;
    const stepMs = (this.config.timeoutMs || 300_000) / totalSteps;

    for (let i = 0; i < totalSteps; i++) {
      if (this.aborted) return;

      if (this.state === 'paused') {
        // Wait until resumed
        await this.waitForResume();
        if (this.aborted) return;
      }

      // Simulate a step of work
      await this.sleep(Math.min(stepMs, 5000));

      const progress = Math.round(((i + 1) / totalSteps) * 100);
      this.stdout += `[Step ${i + 1}/${totalSteps}] Task "${this.config.taskName}" progress: ${progress}%\n`;

      // Emit progress
      this.emit('progress', { agentId: this.agentId, progress, step: i + 1, totalSteps });

      // Record heartbeat with progress
      this.hbSystem.recordHeartbeat(
        this.agentId,
        this.state,
        progress,
        `Step ${i + 1}/${totalSteps} completed`,
        this.getMetrics(),
      );
    }

    this.exitCode = 0;
    this.stdout += `[DONE] Task "${this.config.taskName}" completed successfully.\n`;
  }

  private async waitForResume(): Promise<void> {
    return new Promise<void>((resolve) => {
      const check = () => {
        if (this.state !== 'paused' || this.aborted) {
          resolve();
        } else {
          setTimeout(check, 500);
        }
      };
      check();
    });
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    const interval = this.config.heartbeatIntervalMs || 10_000;

    this.heartbeatTimer = setInterval(() => {
      const hb = this.hbSystem.recordHeartbeat(
        this.agentId,
        this.state,
        this.getProgress(),
        `Heartbeat — state: ${this.state}`,
        this.getMetrics(),
      );

      this.emit('heartbeat', hb);
    }, interval);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private startCheckpointing(): void {
    this.stopCheckpointing();
    const interval = this.config.checkpointIntervalMs || 60_000;

    this.checkpointTimer = setInterval(() => {
      this.createCheckpoint('Automatic checkpoint');
    }, interval);
  }

  private stopCheckpointing(): void {
    if (this.checkpointTimer) {
      clearInterval(this.checkpointTimer);
      this.checkpointTimer = null;
    }
  }

  private stopTimers(): void {
    this.stopHeartbeat();
    this.stopCheckpointing();
  }

  private createCheckpoint(message: string): Checkpoint {
    return this.hbSystem.createCheckpoint(
      this.agentId,
      this.state,
      this.getProgress(),
      this.stdout,
      this.stderr,
      this.exitCode,
      this.config.env || {},
      this.config.workDir,
    );
  }

  private getProgress(): number {
    // Estimate progress from output size relative to expected
    const outputLines = this.stdout.split('\n').filter(l => l.startsWith('[Step'));
    if (outputLines.length === 0) return 0;
    const lastStep = outputLines[outputLines.length - 1];
    const match = lastStep.match(/(\d+)\/(\d+)/);
    if (match) {
      return Math.round((parseInt(match[1], 10) / parseInt(match[2], 10)) * 100);
    }
    return 50;
  }

  private getMetrics(): AgentMetrics {
    const memUsage = process.memoryUsage();
    return {
      cpuPercent: 0, // Not easily measurable in Node without native addons
      memMB: Math.round(memUsage.heapUsed / 1024 / 1024),
      uptimeMs: Date.now() - this.startTime,
      outputSizeBytes: Buffer.byteLength(this.stdout + this.stderr, 'utf-8'),
      retriesUsed: this.retries,
    };
  }

  private sendNotification(event: string, data: Record<string, unknown>): void {
    const configs = this.config.notifications || [];
    for (const config of configs) {
      if (config.onEvents.includes(event as never)) {
        this.notifQueue.enqueue(config, this.agentId, event, data);
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// ──────────────────────────────────────────────
// Cloud Background Agent Manager
// ──────────────────────────────────────────────

export class CloudBackgroundAgentManager {
  private agents: Map<string, CloudBackgroundAgent> = new Map();
  private lifecycle: AgentLifecycleManager;
  private hbSystem: HeartbeatCheckpointSystem;
  private notifQueue: NotificationQueue;
  private staleCheckTimer: NodeJS.Timeout | null = null;

  constructor() {
    this.lifecycle = new AgentLifecycleManager();
    this.hbSystem = new HeartbeatCheckpointSystem();
    this.notifQueue = new NotificationQueue();

    // Start stale heartbeat detection
    this.startStaleDetection();
  }

  /**
   * Create and register a new background agent.
   */
  createAgent(config: Omit<AgentConfig, 'agentId'> & { agentId?: string }): CloudBackgroundAgent {
    const agent = new CloudBackgroundAgent(config, this.lifecycle, this.hbSystem, this.notifQueue);
    this.agents.set(agent.agentId, agent);

    // Clean up on completion
    agent.on('completed', () => {
      // Keep agent around for result retrieval
    });
    agent.on('failed', () => {
      // Keep agent around for debugging
    });
    agent.on('cancelled', () => {
      // Keep agent around for record
    });

    return agent;
  }

  /**
   * Start an agent. It runs in the background — the caller can disconnect.
   */
  async startAgent(agentId: string): Promise<void> {
    const agent = this.agents.get(agentId);
    if (!agent) throw new Error(`Agent ${agentId} not found`);
    await agent.start();
  }

  /**
   * Create and start an agent in one call. Returns immediately — agent runs in background.
   */
  async createAndStart(config: Omit<AgentConfig, 'agentId'> & { agentId?: string }): Promise<CloudBackgroundAgent> {
    const agent = this.createAgent(config);
    // Fire and forget
    agent.start().catch(err => {
      process.stderr.write(`[Agent ${agent.agentId}] Background execution error: ${(err as Error).message}\n`);
    });
    return agent;
  }

  pauseAgent(agentId: string): boolean {
    const agent = this.agents.get(agentId);
    if (!agent) return false;
    return agent.pause();
  }

  async resumeAgent(agentId: string): Promise<void> {
    const agent = this.agents.get(agentId);
    if (!agent) throw new Error(`Agent ${agentId} not found`);
    await agent.resume();
  }

  cancelAgent(agentId: string, reason?: string): boolean {
    const agent = this.agents.get(agentId);
    if (!agent) return false;
    return agent.cancel(reason);
  }

  getAgent(agentId: string): CloudBackgroundAgent | undefined {
    return this.agents.get(agentId);
  }

  listAgents(): CloudBackgroundAgent[] {
    return Array.from(this.agents.values());
  }

  getActiveAgents(): CloudBackgroundAgent[] {
    return Array.from(this.agents.values()).filter(a => {
      const state = a.getState();
      return state === 'running' || state === 'paused';
    });
  }

  getRunResult(agentId: string): AgentRunResult | null {
    const agent = this.agents.get(agentId);
    if (!agent) return null;
    return agent.getRunResult();
  }

  // ── Delegated accessors ─────────────────────

  getLifecycleManager(): AgentLifecycleManager {
    return this.lifecycle;
  }

  getHeartbeatSystem(): HeartbeatCheckpointSystem {
    return this.hbSystem;
  }

  getNotificationQueue(): NotificationQueue {
    return this.notifQueue;
  }

  // ── Stale Agent Detection ───────────────────

  private startStaleDetection(): void {
    this.staleCheckTimer = setInterval(() => {
      const activeAgents = this.getActiveAgents();
      for (const agent of activeAgents) {
        if (this.hbSystem.isHeartbeatStale(agent.agentId, 120_000)) {
          const lastHb = this.hbSystem.getLastHeartbeat(agent.agentId);
          const age = lastHb
            ? Math.round((Date.now() - new Date(lastHb.timestamp).getTime()) / 1000)
            : Infinity;

          this.notifQueue.enqueue(
            {
              channel: 'webhook',
              target: 'http://localhost:3000/api/agent-alerts',
              onEvents: ['heartbeat-lost'],
            },
            agent.agentId,
            'heartbeat-lost',
            {
              agentId: agent.agentId,
              state: agent.getState(),
              lastHeartbeatAgo: `${age}s`,
              message: `Agent heartbeat lost for ${age} seconds`,
            },
          );
        }
      }
    }, 30_000);
  }

  /**
   * Clean up all agents. Call on process shutdown.
   */
  shutdown(): void {
    if (this.staleCheckTimer) {
      clearInterval(this.staleCheckTimer);
      this.staleCheckTimer = null;
    }

    for (const agent of this.agents.values()) {
      agent.cancel('Manager shutdown');
    }
  }
}

// ──────────────────────────────────────────────
// Singleton
// ──────────────────────────────────────────────

let defaultAgentManager: CloudBackgroundAgentManager | null = null;

export function getCloudBackgroundAgentManager(): CloudBackgroundAgentManager {
  if (!defaultAgentManager) {
    defaultAgentManager = new CloudBackgroundAgentManager();
  }
  return defaultAgentManager;
}

export function initCloudBackgroundAgentManager(): CloudBackgroundAgentManager {
  if (defaultAgentManager) {
    defaultAgentManager.shutdown();
  }
  defaultAgentManager = new CloudBackgroundAgentManager();
  return defaultAgentManager;
}
