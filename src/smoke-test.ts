#!/usr/bin/env tsx
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { apiBaseUrl } from './core/net-defaults.js';
import { homedir } from 'node:os';

const G = '\x1b[32m';
const R = '\x1b[31m';
const D = '\x1b[2m';
const B = '\x1b[1m';
const X = '\x1b[0m';

const API_BASE = process.env.SMOKE_TEST_URL || apiBaseUrl();

function loadToken(): string {
  if (process.env.API_TOKEN) return process.env.API_TOKEN;
  try {
    const envContent = readFileSync(join(process.cwd(), '.env'), 'utf-8');
    const match = envContent.match(/^API_TOKEN=(.+)$/m);
    if (match) return match[1].trim();
  } catch { /* ignore */ }
  try {
    const home = homedir();
    return readFileSync(join(home, '.cobra-commander', 'api-token'), 'utf-8').trim();
  } catch { /* ignore */ }
  return '';
}

const TOKEN = loadToken();

interface TestResult {
  name: string;
  pass: boolean;
  detail: string;
}

async function test(name: string, fn: () => Promise<string>): Promise<TestResult> {
  try {
    const detail = await fn();
    return { name, pass: true, detail };
  } catch (e: any) {
    return { name, pass: false, detail: e.message };
  }
}

function authHeaders(): Record<string, string> {
  if (!TOKEN) return {};
  return { 'Authorization': `Bearer ${TOKEN}` };
}

async function main(): Promise<void> {
  console.log(`\n${B}Cobra Commander — Smoke Test${X}`);
  console.log(`${D}Target: ${API_BASE}${X}`);
  console.log(`${D}Token: ${TOKEN ? TOKEN.slice(0, 8) + '...' : 'none'}${X}\n`);

  const results: TestResult[] = [];

  // Test 1: Health endpoint (with auth)
  results.push(await test('GET /api/health', async () => {
    const resp = await fetch(`${API_BASE}/api/health`, { headers: authHeaders() });
    if (resp.status !== 200) throw new Error(`status ${resp.status}`);
    const body = await resp.json() as { status: string; version: string; uptime: number };
    if (body.status !== 'ok') throw new Error(`status field: ${body.status}`);
    return `status=ok, version=${body.version}, uptime=${body.uptime}s`;
  }));

  // Test 2: API v1 health
  results.push(await test('GET /api/v1/health', async () => {
    const resp = await fetch(`${API_BASE}/api/v1/health`, { headers: authHeaders() });
    if (resp.status !== 200) throw new Error(`status ${resp.status}`);
    const body = await resp.json() as { status: string };
    return `status=${body.status}`;
  }));

  // Test 3: Auth required (no token → 401)
  results.push(await test('Auth gate (no token → 401)', async () => {
    const resp = await fetch(`${API_BASE}/api/v1/health`);
    if (TOKEN && resp.status !== 401) throw new Error(`expected 401, got ${resp.status}`);
    if (!TOKEN && resp.status !== 200) throw new Error(`no token configured but got ${resp.status}`);
    return TOKEN ? 'correctly rejected' : 'no token configured (open)';
  }));

  // Test 4: CORS headers present
  results.push(await test('CORS headers', async () => {
    const resp = await fetch(`${API_BASE}/api/health`, {
      headers: { ...authHeaders(), 'Origin': 'http://localhost:3000' },
    });
    const acao = resp.headers.get('access-control-allow-origin');
    if (!acao) throw new Error('no access-control-allow-origin header');
    return `allow-origin: ${acao}`;
  }));

  // Test 5: Server responds fast
  results.push(await test('Latency < 200ms', async () => {
    const start = performance.now();
    await fetch(`${API_BASE}/api/health`, { headers: authHeaders() });
    const ms = Math.round(performance.now() - start);
    if (ms > 200) throw new Error(`${ms}ms`);
    return `${ms}ms`;
  }));

  // Print results
  console.log(`${D}─────────────────────────────────────────${X}`);
  let passed = 0;
  for (const r of results) {
    const icon = r.pass ? `${G}✓${X}` : `${R}✗${X}`;
    const detail = r.pass ? `${D}${r.detail}${X}` : `${R}${r.detail}${X}`;
    console.log(`  ${icon} ${r.name} — ${detail}`);
    if (r.pass) passed++;
  }

  console.log(`${D}─────────────────────────────────────────${X}`);
  const total = results.length;
  if (passed === total) {
    console.log(`\n  ${G}${B}All ${total} tests passed.${X}\n`);
    process.exit(0);
  } else {
    console.log(`\n  ${R}${B}${total - passed}/${total} tests failed.${X}\n`);
    process.exit(1);
  }
}

main();
