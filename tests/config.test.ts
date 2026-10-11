import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig } from '../src/core/config.js';

describe('loadConfig', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    // Point config resolution at a path that does not exist, so these assertions
    // test the built-in defaults rather than whatever the host has configured.
    process.env.CC_CONFIG_FILE = join(tmpdir(), 'cobra-commander-test-absent.json');
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_BASE_URL;
    delete process.env.OPENAI_MODEL;
    delete process.env.WORKER_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.WORKER_MODEL;
    delete process.env.ORCHESTRATOR_MODEL;
    delete process.env.WORKER_BASE_URL;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('should populate default config values', () => {
    const config = loadConfig({ workDir: '/tmp/test' });
    expect(config).toBeDefined();
    expect(config.workDir).toBe('/tmp/test');
    expect(config.maxWorkerTurns).toBeGreaterThan(0);
    expect(config.maxOrchestratorTurns).toBeGreaterThan(0);
    expect(config.commandTimeout).toBeGreaterThan(0);
    expect(config.verbose).toBe(false);
    expect(config.autoScan).toBe(false);
    expect(config.autoCommitEnabled).toBe(false);
  });

  it('should configure worker pool with default entry', () => {
    const config = loadConfig({ workDir: '/tmp/test' });
    expect(config.workerPool).toBeDefined();
    expect(Array.isArray(config.workerPool)).toBe(true);
    expect(config.workerPool.length).toBeGreaterThanOrEqual(1);
    const defaultWorker = config.workerPool[0];
    expect(defaultWorker.name).toBe('default');
    expect(defaultWorker.tier).toBe('standard');
    expect(defaultWorker.provider).toBeDefined();
    expect(defaultWorker.provider.model).toBe('gpt-5.1');
  });

  it('should resolve additional dirs to absolute paths', () => {
    const config = loadConfig({
      workDir: '/tmp/test',
      additionalDirs: ['/tmp/other', '/tmp/more'],
    });
    expect(config.additionalDirs).toEqual(['/tmp/other', '/tmp/more']);
  });

  it('should merge with env vars for API keys', () => {
    process.env.WORKER_API_KEY = 'wk-test-key';
    process.env.ORCHESTRATOR_API_KEY = 'or-test-key';
    const config = loadConfig({ workDir: '/tmp/test' });
    expect(config.worker.apiKey).toBe('wk-test-key');
    expect(config.orchestrator.apiKey).toBe('or-test-key');
  });

  it('should not crash when API keys are missing', () => {
    delete process.env.WORKER_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    expect(() => loadConfig({ workDir: '/tmp/test' })).not.toThrow();
    const config = loadConfig({ workDir: '/tmp/test' });
    expect(config.worker.apiKey).toBe('');
    expect(config.orchestrator.apiKey).toBe('');
  });

  it('should respect overrides for maxWorkerTurns and maxOrchestratorTurns', () => {
    const config = loadConfig({
      workDir: '/tmp/test',
      maxWorkerTurns: 50,
      maxOrchestratorTurns: 10,
    });
    expect(config.maxWorkerTurns).toBe(50);
    expect(config.maxOrchestratorTurns).toBe(10);
  });

  it('should set default verification config', () => {
    const config = loadConfig({ workDir: '/tmp/test' });
    expect(config.verification).toBeDefined();
    expect(config.verification!.commands).toContain('npx tsc --noEmit');
    expect(config.verification!.timeout).toBe(60);
    expect(config.verification!.failOnWarnings).toBe(false);
  });
});
