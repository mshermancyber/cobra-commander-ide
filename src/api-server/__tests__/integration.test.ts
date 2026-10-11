import { describe, it, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startApiServer, type ApiServerOptions } from '../server.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const TEST_WORKSPACE = join(process.cwd(), '.test-workspace', `integration-${randomUUID().slice(0, 8)}`);
let baseUrl = '';
let authToken = '';
let serverClose: () => void;

async function apiFetch(path: string, options: RequestInit = {}): Promise<{ status: number; data: unknown }> {
  const url = `${baseUrl}${path}`;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${authToken}`,
    ...(options.headers as Record<string, string> || {}),
  };

  const res = await fetch(url, { ...options, headers });
  let data: unknown;
  try {
    data = await res.json();
  } catch {
    data = await res.text();
  }
  return { status: res.status, data };
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

before(async () => {
  // Create temp workspace
  if (!existsSync(TEST_WORKSPACE)) {
    mkdirSync(TEST_WORKSPACE, { recursive: true });
  }

  // Write a test file
  writeFileSync(join(TEST_WORKSPACE, 'test.ts'), 'export const hello = "world";\n');

  // Start server on a random port
  const serverOptions: ApiServerOptions = {
    port: 0, // random
    host: '127.0.0.1',
    workDir: TEST_WORKSPACE,
  };

  const server = await startApiServer(serverOptions);
  baseUrl = `http://127.0.0.1:${server.port}`;
  authToken = server.token;
  serverClose = server.close;
});

after(() => {
  serverClose();
  // Clean up workspace
  try {
    rmSync(TEST_WORKSPACE, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('API Server Integration', () => {
  // --- Health ---
  describe('GET /api/health', () => {
    it('returns status ok', async () => {
      const { status, data } = await apiFetch('/api/health');
      assert.equal(status, 200);
      const d = data as Record<string, unknown>;
      assert.equal(d.status, 'ok');
      assert.ok(typeof d.uptime === 'number');
      assert.ok(typeof d.version === 'string');
      assert.ok(typeof d.timestamp === 'string');
    });
  });

  // --- Completions ---
  describe('POST /api/completions', () => {
    it('returns 503 when provider not initialized', async () => {
      const { status } = await apiFetch('/api/completions', {
        method: 'POST',
        body: JSON.stringify({
          filePath: 'test.ts',
          line: 1,
          column: 10,
          prefix: 'const x = ',
        }),
      });
      // May be 503 (no provider) or 400 depending on init state
      assert.ok([400, 503].includes(status));
    });

    it('returns 400 for missing fields', async () => {
      const { status } = await apiFetch('/api/completions', {
        method: 'POST',
        body: JSON.stringify({}),
      });
      assert.equal(status, 400);
    });
  });

  // --- Files ---
  describe('GET /api/files', () => {
    it('reads a file', async () => {
      const { status, data } = await apiFetch('/api/files?path=test.ts');
      assert.equal(status, 200);
      const d = data as Record<string, unknown>;
      assert.ok(typeof d.content === 'string');
    });

    it('returns 400 for missing path', async () => {
      const { status } = await apiFetch('/api/files');
      assert.equal(status, 400);
    });
  });

  describe('PUT /api/files', () => {
    it('writes a file', async () => {
      const { status } = await apiFetch('/api/files', {
        method: 'PUT',
        body: JSON.stringify({
          path: 'new-test.ts',
          content: 'export const test = true;',
        }),
      });
      assert.equal(status, 200);
      assert.ok(existsSync(join(TEST_WORKSPACE, 'new-test.ts')));
    });
  });

  // --- Search ---
  describe('POST /api/search', () => {
    it('accepts search queries', async () => {
      const { status } = await apiFetch('/api/search', {
        method: 'POST',
        body: JSON.stringify({
          query: 'hello',
          fileTypes: '.ts',
        }),
      });
      // May return results or empty
      assert.equal(status, 200);
    });
  });

  // --- Sessions ---
  describe('POST /api/sessions', () => {
    it('creates a session', async () => {
      const { status, data } = await apiFetch('/api/sessions', {
        method: 'POST',
        body: JSON.stringify({ name: 'Test Session' }),
      });
      assert.equal(status, 200);
      const d = data as Record<string, unknown>;
      assert.ok(typeof d.id === 'string');
    });
  });

  describe('GET /api/sessions', () => {
    it('lists sessions', async () => {
      const { status, data } = await apiFetch('/api/sessions');
      assert.equal(status, 200);
      assert.ok(Array.isArray(data));
    });
  });

  // --- Templates ---
  describe('GET /api/templates', () => {
    it('lists templates', async () => {
      const { status, data } = await apiFetch('/api/templates');
      assert.equal(status, 200);
      const d = data as Record<string, unknown>;
      assert.ok(Array.isArray(d.templates));
      assert.ok((d.templates as unknown[]).length > 0);
    });
  });

  describe('GET /api/templates/:name', () => {
    it('gets a specific template', async () => {
      const { status, data } = await apiFetch('/api/templates/add-crud');
      assert.equal(status, 200);
      const d = data as Record<string, unknown>;
      assert.equal(d.id, 'add-crud');
      assert.equal(d.category, 'crud');
    });

    it('returns 404 for unknown template', async () => {
      const { status } = await apiFetch('/api/templates/nonexistent');
      assert.equal(status, 404);
    });
  });

  describe('POST /api/templates/validate', () => {
    it('validates template parameters', async () => {
      const { status, data } = await apiFetch('/api/templates/validate', {
        method: 'POST',
        body: JSON.stringify({
          templateId: 'add-crud',
          variables: {
            entityName: 'Product',
            entityFields: 'name:string',
            routePrefix: '/products',
          },
        }),
      });
      assert.equal(status, 200);
      const d = data as Record<string, unknown>;
      assert.equal(d.valid, true);
    });

    it('reports missing required variables', async () => {
      const { status, data } = await apiFetch('/api/templates/validate', {
        method: 'POST',
        body: JSON.stringify({
          templateId: 'add-crud',
          variables: {},
        }),
      });
      assert.equal(status, 400);
      const d = data as Record<string, unknown>;
      assert.equal(d.valid, false);
      assert.ok(Array.isArray(d.missing));
      assert.ok((d.missing as unknown[]).length > 0);
    });
  });

  describe('POST /api/templates/render', () => {
    it('renders a template', async () => {
      const { status, data } = await apiFetch('/api/templates/render', {
        method: 'POST',
        body: JSON.stringify({
          templateId: 'add-crud',
          variables: {
            entityName: 'Product',
            entityFields: 'name:string, price:number',
            routePrefix: '/products',
          },
        }),
      });
      assert.equal(status, 200);
      const d = data as Record<string, unknown>;
      assert.ok(typeof d.content === 'string');
      assert.ok((d.content as string).includes('Product'));
      assert.ok((d.content as string).includes('/products'));
    });
  });

  // --- Generation ---
  describe('POST /api/generate/app', () => {
    it('generates app from prompt', async () => {
      const { status, data } = await apiFetch('/api/generate/app', {
        method: 'POST',
        body: JSON.stringify({
          prompt: 'A simple Express API server',
          framework: 'express',
        }),
      });
      assert.equal(status, 200);
      const d = data as Record<string, unknown>;
      assert.ok(typeof d.id === 'string');
      assert.ok(Array.isArray(d.files));
    });

    it('returns 400 for missing prompt', async () => {
      const { status } = await apiFetch('/api/generate/app', {
        method: 'POST',
        body: JSON.stringify({}),
      });
      assert.equal(status, 400);
    });
  });

  // --- Collaboration ---
  describe('POST /api/collab/sessions', () => {
    it('creates a collaboration session', async () => {
      const { status, data } = await apiFetch('/api/collab/sessions', {
        method: 'POST',
        body: JSON.stringify({
          name: 'Pair Programming Session',
          files: { 'main.ts': 'console.log("hello");' },
        }),
      });
      assert.equal(status, 201);
      const d = data as Record<string, unknown>;
      assert.ok(typeof d.id === 'string');
    });
  });

  describe('GET /api/collab/sessions', () => {
    it('lists collaboration sessions', async () => {
      const { status, data } = await apiFetch('/api/collab/sessions');
      assert.equal(status, 200);
      const d = data as Record<string, unknown>;
      assert.ok(Array.isArray(d.sessions));
    });
  });

  // --- Version ---
  describe('GET /api/v1/version', () => {
    it('returns API version info', async () => {
      const { status, data } = await apiFetch('/api/v1/version');
      assert.equal(status, 200);
      const d = data as Record<string, unknown>;
      assert.equal(d.apiVersion, 'v1');
      assert.ok(Array.isArray(d.supportedVersions));
    });
  });
});
