// Destro agent — ops tools. Created 2026-07-04.

import type { ToolDefinition } from '../core/types.js';
import { executeDestroShell } from './destro-shell.js';
import { truncateDestroShellOutput } from './destro-tool-output.js';

// ──────────────────────────────────────────────
// Tool Definitions
// ──────────────────────────────────────────────

export const dockerPsTool: ToolDefinition = {
  name: 'docker_ps',
  description: 'List all Docker containers with ID, name, status, and image.',
  input_schema: {
    type: 'object',
    properties: {},
    required: [],
  },
};

export const dockerInspectTool: ToolDefinition = {
  name: 'docker_inspect',
  description: 'Inspect a Docker container and return its full configuration as JSON.',
  input_schema: {
    type: 'object',
    properties: {
      container: {
        type: 'string',
        description: 'Container name or ID to inspect',
      },
    },
    required: ['container'],
  },
};

export const dockerLogsTool: ToolDefinition = {
  name: 'docker_logs',
  description: 'Fetch the last N lines of logs from a Docker container.',
  input_schema: {
    type: 'object',
    properties: {
      container: {
        type: 'string',
        description: 'Container name or ID',
      },
      tail: {
        type: 'number',
        description: 'Number of lines to fetch (default: 100)',
      },
    },
    required: ['container'],
  },
};

export const journalctlTailTool: ToolDefinition = {
  name: 'journalctl_tail',
  description: 'Fetch the last N lines of journald logs for a systemd unit.',
  input_schema: {
    type: 'object',
    properties: {
      unit: {
        type: 'string',
        description: 'systemd unit name (e.g., nginx.service)',
      },
      lines: {
        type: 'number',
        description: 'Number of lines to fetch (default: 100)',
      },
    },
    required: ['unit'],
  },
};

export const dockerRestartTool: ToolDefinition = {
  name: 'docker_restart',
  description: 'Restart a Docker container.',
  input_schema: {
    type: 'object',
    properties: {
      container: {
        type: 'string',
        description: 'Container name or ID to restart',
      },
    },
    required: ['container'],
  },
};

export const dockerComposeUpTool: ToolDefinition = {
  name: 'docker_compose_up',
  description: 'Run docker compose up -d in the given working directory.',
  input_schema: {
    type: 'object',
    properties: {
      workDir: {
        type: 'string',
        description: 'Working directory containing docker-compose.yml (default: current)',
      },
    },
    required: [],
  },
};

export const systemctlStatusTool: ToolDefinition = {
  name: 'systemctl_status',
  description: 'Check the status of a systemd service.',
  input_schema: {
    type: 'object',
    properties: {
      service: {
        type: 'string',
        description: 'systemd service name (e.g., nginx.service)',
      },
    },
    required: ['service'],
  },
};

export const systemctlRestartTool: ToolDefinition = {
  name: 'systemctl_restart',
  description: 'Restart a systemd service.',
  input_schema: {
    type: 'object',
    properties: {
      service: {
        type: 'string',
        description: 'systemd service name to restart',
      },
    },
    required: ['service'],
  },
};

export const httpHealthProbeTool: ToolDefinition = {
  name: 'http_health_probe',
  description: 'Perform an HTTP GET health check against a URL. Returns status and body preview.',
  input_schema: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'Full URL to probe (e.g., http://localhost:3000/health)',
      },
      timeout: {
        type: 'number',
        description: 'Request timeout in milliseconds (default: 10000)',
      },
      expectedStatus: {
        type: 'number',
        description: 'Expected HTTP status code (default: 200)',
      },
    },
    required: ['url'],
  },
};

export const portCheckTool: ToolDefinition = {
  name: 'port_check',
  description: 'Check whether a given TCP port is listening and which process owns it.',
  input_schema: {
    type: 'object',
    properties: {
      port: {
        type: 'number',
        description: 'TCP port number to check',
      },
    },
    required: ['port'],
  },
};

// ──────────────────────────────────────────────
// All Tools Registry
// ──────────────────────────────────────────────

const ALL_OPS_TOOLS: ToolDefinition[] = [
  dockerPsTool,
  dockerInspectTool,
  dockerLogsTool,
  journalctlTailTool,
  dockerRestartTool,
  dockerComposeUpTool,
  systemctlStatusTool,
  systemctlRestartTool,
  httpHealthProbeTool,
  portCheckTool,
];

export function getAllOpsTools(): ToolDefinition[] {
  return ALL_OPS_TOOLS;
}

// ──────────────────────────────────────────────
// Tool Results
// ──────────────────────────────────────────────

interface DockerContainer {
  id: string;
  name: string;
  status: string;
  image: string;
}

interface OpsResult {
  ok: boolean;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  containers?: DockerContainer[];
  parsed?: unknown;
  status?: number;
  bodyPreview?: string;
  timedOut?: boolean;
  error?: string;
  listening?: boolean;
  process?: string;
}

function parseDockerPs(stdout: string): DockerContainer[] {
  const containers: DockerContainer[] = [];
  const lines = stdout.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Format: "ID Names Status Image" — space-separated, first 3 fields are ID/Names/Status
    const parts = trimmed.split(/\s+/);
    if (parts.length < 4) continue;
    const id = parts[0];
    const name = parts[1];
    const status = parts[2];
    const image = parts.slice(3).join(' ');
    containers.push({ id, name, status, image });
  }
  return containers;
}

// ──────────────────────────────────────────────
// Executor
// ──────────────────────────────────────────────

export async function executeOpsTool(
  toolName: string,
  input: Record<string, unknown>,
  workDir: string,
): Promise<OpsResult> {
  switch (toolName) {
    // ── docker_ps ────────────────────────────
    case 'docker_ps': {
      const { result, is_error } = await executeDestroShell(
        { command: 'docker ps -a --format "{{.ID}} {{.Names}} {{.Status}} {{.Image}}"' },
        workDir,
      );
      const containers = is_error ? [] : parseDockerPs(result);
      return { ok: !is_error, stdout: result, stderr: '', exitCode: is_error ? 1 : 0, containers };
    }

    // ── docker_inspect ───────────────────────
    case 'docker_inspect': {
      const container = input.container as string;
      const { result, is_error } = await executeDestroShell(
        { command: `docker inspect ${container}` },
        workDir,
      );
      let parsed: unknown;
      try {
        parsed = JSON.parse(result);
      } catch {
        parsed = undefined;
      }
      return { ok: !is_error, stdout: result, stderr: '', exitCode: is_error ? 1 : 0, parsed };
    }

    // ── docker_logs ──────────────────────────
    case 'docker_logs': {
      const container = input.container as string;
      const tail = (input.tail as number) || 100;
      const { result, is_error } = await executeDestroShell(
        { command: `docker logs --tail ${tail} ${container}` },
        workDir,
      );
      const clamped = truncateDestroShellOutput(result);
      return { ok: !is_error, stdout: clamped.text, stderr: '', exitCode: is_error ? 1 : 0 };
    }

    // ── journalctl_tail ──────────────────────
    case 'journalctl_tail': {
      const unit = input.unit as string;
      const lines = (input.lines as number) || 100;
      const { result, is_error } = await executeDestroShell(
        { command: `journalctl -u ${unit} --no-pager -n ${lines}` },
        workDir,
      );
      const clamped = truncateDestroShellOutput(result);
      return { ok: !is_error, stdout: clamped.text, stderr: '', exitCode: is_error ? 1 : 0 };
    }

    // ── docker_restart ───────────────────────
    case 'docker_restart': {
      const container = input.container as string;
      const { result, is_error } = await executeDestroShell(
        { command: `docker restart ${container}` },
        workDir,
      );
      return { ok: !is_error, stdout: result, stderr: '', exitCode: is_error ? 1 : 0 };
    }

    // ── docker_compose_up ────────────────────
    case 'docker_compose_up': {
      const composeWorkDir = (input.workDir as string) || workDir;
      const { result, is_error } = await executeDestroShell(
        { command: 'docker compose up -d' },
        composeWorkDir,
      );
      return { ok: !is_error, stdout: result, stderr: '', exitCode: is_error ? 1 : 0 };
    }

    // ── systemctl_status ─────────────────────
    case 'systemctl_status': {
      const service = input.service as string;
      const { result, is_error } = await executeDestroShell(
        { command: `systemctl status ${service}` },
        workDir,
      );
      return { ok: !is_error, stdout: result, stderr: '', exitCode: is_error ? 1 : 0 };
    }

    // ── systemctl_restart ────────────────────
    case 'systemctl_restart': {
      const service = input.service as string;
      const { result, is_error } = await executeDestroShell(
        { command: `systemctl restart ${service}` },
        workDir,
      );
      return { ok: !is_error, stdout: result, stderr: '', exitCode: is_error ? 1 : 0 };
    }

    // ── http_health_probe ────────────────────
    case 'http_health_probe': {
      const url = input.url as string;
      const timeoutMs = (input.timeout as number) || 10_000;
      const expectedStatus = (input.expectedStatus as number) || 200;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const resp = await fetch(url, { signal: controller.signal });
        clearTimeout(timer);
        const bodyText = await resp.text();
        const bodyPreview = bodyText.slice(0, 500);
        return {
          ok: resp.status === expectedStatus,
          status: resp.status,
          bodyPreview,
          timedOut: false,
        };
      } catch (err: unknown) {
        clearTimeout(timer);
        const isTimeout = (err as Error).name === 'AbortError';
        return {
          ok: false,
          timedOut: isTimeout,
          error: isTimeout ? `Request timed out after ${timeoutMs}ms` : (err as Error).message,
        };
      }
    }

    // ── port_check ───────────────────────────
    case 'port_check': {
      const port = input.port as number;

      // Try ss first, fall back to netstat
      let { result, is_error } = await executeDestroShell(
        { command: `ss -tlnp 2>/dev/null | grep ':${port}\\b' || netstat -tlnp 2>/dev/null | grep ':${port}\\b'` },
        workDir,
      );

      const listening = !is_error && result.trim().length > 0;
      let processName: string | undefined;

      if (listening) {
        // Extract process name from ss/netstat output
        // Typical ss line: LISTEN 0 128 0.0.0.0:4100 0.0.0.0:* users:(("node",pid=1234,fd=18))
        const procMatch = result.match(/users:\(\(["']?(\w+)/);
        if (procMatch) {
          processName = procMatch[1];
        } else {
          // netstat fallback: tcp 0 0 0.0.0.0:4100 0.0.0.0:* LISTEN 1234/node
          const netstatMatch = result.match(/\d+\/(\w+)/);
          if (netstatMatch) {
            processName = netstatMatch[1];
          }
        }
      }

      return { ok: true, listening, process: processName };
    }

    default:
      return { ok: false, error: `Unknown ops tool: ${toolName}` };
  }
}
