import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { createServer } from 'node:net';
import { installRoot } from './env-file.js';

const REGISTRY_PATH = join(installRoot(), 'ports.json');
const PORT_RANGE_START = 4500;
const PORT_RANGE_END = 4600;
const DATA_DIR = '/data';

export interface PortEntry {
  port: number;
  project: string;
  service: 'frontend' | 'backend' | 'other';
  assignedAt: number;
}

export interface PortRegistry {
  entries: PortEntry[];
  lastScanned?: number;
}

export function loadPortRegistry(): PortRegistry {
  if (existsSync(REGISTRY_PATH)) {
    try {
      return JSON.parse(readFileSync(REGISTRY_PATH, 'utf-8'));
    } catch { /* ignore */ }
  }
  return { entries: [] };
}

function savePortRegistry(registry: PortRegistry): void {
  writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2), 'utf-8');
}

function isPortInUse(port: number): boolean {
  try {
    const result = execSync(`fuser ${port}/tcp 2>/dev/null`, { encoding: 'utf-8', timeout: 3000 });
    return result.trim().length > 0;
  } catch {
    return false;
  }
}

export function scanActivePorts(): PortEntry[] {
  const active: PortEntry[] = [];
  const registry = loadPortRegistry();

  for (let port = PORT_RANGE_START; port <= PORT_RANGE_END; port++) {
    if (isPortInUse(port)) {
      const existing = registry.entries.find(e => e.port === port);
      active.push(existing || {
        port,
        project: 'unknown',
        service: 'other',
        assignedAt: Date.now(),
      });
    }
  }

  return active;
}

export function scanProjects(): Array<{ name: string; path: string }> {
  const projects: Array<{ name: string; path: string }> = [];
  if (!existsSync(DATA_DIR)) return projects;

  try {
    const entries = readdirSync(DATA_DIR);
    for (const entry of entries) {
      const fullPath = join(DATA_DIR, entry);
      try {
        if (statSync(fullPath).isDirectory()) {
          const hasPkg = existsSync(join(fullPath, 'package.json'));
          const hasSrc = existsSync(join(fullPath, 'src'));
          if (hasPkg || hasSrc) {
            projects.push({ name: entry, path: fullPath });
          }
        }
      } catch { /* skip inaccessible */ }
    }
  } catch { /* ignore */ }

  return projects;
}

export function findOpenPortPair(): { frontend: number; backend: number } | null {
  const usedPorts = new Set<number>();

  for (let port = PORT_RANGE_START; port <= PORT_RANGE_END; port++) {
    if (isPortInUse(port)) usedPorts.add(port);
  }

  const registry = loadPortRegistry();
  for (const entry of registry.entries) {
    usedPorts.add(entry.port);
  }

  for (let port = PORT_RANGE_START; port <= PORT_RANGE_END - 1; port += 2) {
    if (!usedPorts.has(port) && !usedPorts.has(port + 1)) {
      return { frontend: port, backend: port + 1 };
    }
  }

  return null;
}

export function registerPorts(project: string, frontend: number, backend: number): void {
  const registry = loadPortRegistry();

  registry.entries = registry.entries.filter(
    e => e.project !== project && e.port !== frontend && e.port !== backend
  );

  registry.entries.push(
    { port: frontend, project, service: 'frontend', assignedAt: Date.now() },
    { port: backend, project, service: 'backend', assignedAt: Date.now() },
  );

  savePortRegistry(registry);
}

export function unregisterProject(project: string): void {
  const registry = loadPortRegistry();
  registry.entries = registry.entries.filter(e => e.project !== project);
  savePortRegistry(registry);
}

export function findOpenHttpsPort(): number | null {
  const usedPorts = new Set<number>();
  const registry = loadPortRegistry();
  for (const entry of registry.entries) {
    usedPorts.add(entry.port);
  }

  for (let port = 9440; port <= 9499; port++) {
    if (!usedPorts.has(port) && !isPortInUse(port)) {
      return port;
    }
  }
  return null;
}

export function getProjectPorts(project: string): PortEntry[] {
  const registry = loadPortRegistry();
  return registry.entries.filter(e => e.project === project);
}

export function fullScan(): PortRegistry {
  const active = scanActivePorts();
  const registry = loadPortRegistry();

  for (const entry of active) {
    if (!registry.entries.find(e => e.port === entry.port)) {
      registry.entries.push(entry);
    }
  }

  registry.entries = registry.entries.filter(e =>
    active.some(a => a.port === e.port) || !isPortInUse(e.port) === false
  );

  registry.lastScanned = Date.now();
  savePortRegistry(registry);
  return registry;
}
