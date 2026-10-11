import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { loadConfig, hydrateWorkerKey } from '../core/config.js';
import { authMiddleware, setToken } from './middleware/auth.js';
import { corsMiddleware } from './middleware/cors.js';
import { sendJson, sendError, wrapHandler } from './middleware/error-handler.js';
import { setupWebSocket } from './websocket/handlers.js';
import { handleHealth, setHealthWorkDir } from './routes/health.js';
import { DEFAULT_API_PORT, DEFAULT_BIND_HOST } from '../core/net-defaults.js';
import { handleMonitoring } from './routes/monitoring.js';
import { circuitBreaker } from '../core/circuit-breaker.js';
// sessions route archived
import { createTaskRoutes } from './routes/tasks.js';
import { createFileRoutes } from './routes/files.js';
import { createSecurityRoutes } from './routes/security.js';
import { createConfigRoutes } from './routes/config.js';
import { createModelRoutes } from './routes/models.js';
import { createGitRoutes } from './routes/git.js';
// analytics route archived
import { createSearchRoutes } from './routes/search.js';
import { createTerminalRoutes } from './routes/terminal.js';
import { createWorkspaceRoutes } from './routes/workspace.js';
import { createCompletionRoutes, initCompletionProvider } from './routes/completions.js';
// knowledge + generation routes archived
import { createTemplateRoutes } from './routes/templates.js';
import { createDocumentRoutes } from './routes/documents.js';
import { createNotepadRoutes } from './routes/notepads.js';
import { createUploadRoutes } from './routes/upload.js';
import { createWorkerRoutes } from './routes/workers.js';
import { createIntakeRoutes } from './routes/intake.js';
import { createOrganizationRoutes } from '../routes/organizations.js';
import { createDestroRoutes } from './routes/destro.js';

export interface ApiServerOptions {
  port: number;
  host: string;
  workDir: string;
  authToken?: string;
}

// ---------------------------------------------------------------------------
// API Versioning
// ---------------------------------------------------------------------------

const CURRENT_API_VERSION = 'v1';
const SUPPORTED_VERSIONS = ['v1'];
const DEPRECATED_VERSIONS: string[] = [];

interface VersionInfo {
  version: string;
  deprecated: boolean;
  sunsetDate?: string;
  message?: string;
}

function extractApiVersion(req: IncomingMessage): VersionInfo {
  const url = req.url || '/';

  const pathMatch = url.match(/^\/api\/(v\d+)\//);
  if (pathMatch) {
    const version = pathMatch[1];
    if (DEPRECATED_VERSIONS.includes(version)) {
      return {
        version,
        deprecated: true,
        sunsetDate: '2026-01-01',
        message: 'API version ' + version + ' is deprecated and will be removed. Please migrate to ' + CURRENT_API_VERSION + '.',
      };
    }
    return { version, deprecated: false };
  }

  const headerVersion = req.headers['x-api-version'] as string | undefined;
  if (headerVersion && SUPPORTED_VERSIONS.includes(headerVersion)) {
    if (DEPRECATED_VERSIONS.includes(headerVersion)) {
      return {
        version: headerVersion,
        deprecated: true,
        sunsetDate: '2026-01-01',
        message: 'API version ' + headerVersion + ' is deprecated. Please migrate to ' + CURRENT_API_VERSION + '.',
      };
    }
    return { version: headerVersion, deprecated: false };
  }

  if (url.startsWith('/api/') && !url.startsWith('/api/v')) {
    return {
      version: CURRENT_API_VERSION,
      deprecated: true,
      message: 'Using unversioned API path. Please migrate to /api/v1/... paths. Set X-API-Version header to suppress this warning.',
    };
  }

  return { version: CURRENT_API_VERSION, deprecated: false };
}

function setDeprecationHeaders(res: ServerResponse, info: VersionInfo): void {
  if (info.deprecated) {
    res.setHeader('X-API-Deprecated', 'true');
    if (info.sunsetDate) {
      res.setHeader('X-API-Sunset', info.sunsetDate);
    }
    if (info.message) {
      res.setHeader('X-API-Deprecation-Message', info.message);
    }
  }
  res.setHeader('X-API-Version', info.version);
  res.setHeader('X-API-Current-Version', CURRENT_API_VERSION);
}

// ---------------------------------------------------------------------------
// Route types
// ---------------------------------------------------------------------------

type RouteHandler = (req: IncomingMessage, res: ServerResponse, params: Record<string, string>) => Promise<void>;

interface Route {
  method: string;
  pattern: RegExp;
  paramNames: string[];
  handler: RouteHandler;
  legacy?: boolean;
}

function route(method: string, path: string, handler: RouteHandler): Route {
  const paramNames: string[] = [];
  const patternStr = path.replace(/:(\w+)/g, (_m, name) => {
    paramNames.push(name);
    return '([^/]+)';
  });
  return { method, pattern: new RegExp('^' + patternStr + '$'), paramNames, handler };
}

function v1Route(method: string, path: string, handler: RouteHandler): Route[] {
  const versionedPath = '/api/v1' + path;
  const legacyPath = '/api' + path;
  return [
    { ...route(method, versionedPath, handler), legacy: false },
    { ...route(method, legacyPath, handler), legacy: true },
  ];
}

function v1OnlyRoute(method: string, path: string, handler: RouteHandler): Route {
  return { ...route(method, '/api/v1' + path, handler), legacy: false };
}

export async function startApiServer(options: ApiServerOptions): Promise<{ port: number; token: string; close: () => void }> {
  const {
    port = DEFAULT_API_PORT,
    host = DEFAULT_BIND_HOST,
    workDir,
  } = options;

  setHealthWorkDir(workDir);

  // Auth token
  const tokenDir = join(homedir(), '.cobra-commander');
  if (!existsSync(tokenDir)) mkdirSync(tokenDir, { recursive: true });
  const tokenPath = join(tokenDir, 'api-token');
  let token = options.authToken || '';
  if (!token) {
    if (existsSync(tokenPath)) {
      token = readFileSync(tokenPath, 'utf-8').trim();
    } else {
      token = randomUUID();
      writeFileSync(tokenPath, token);
    }
  }
  setToken(token);

  // Load config
  const config = loadConfig({ workDir });
  await hydrateWorkerKey(config);

  // Create route handlers
  const tasks = createTaskRoutes(config);
  const files = createFileRoutes(workDir);
  const security = createSecurityRoutes(workDir);
  const configRoutes = createConfigRoutes(workDir);
  const models = createModelRoutes(config, options.workDir);
  const git = createGitRoutes(workDir);
  const search = createSearchRoutes(workDir);
  const terminal = createTerminalRoutes(workDir);
  const workspace = createWorkspaceRoutes(workDir);
  const completions = createCompletionRoutes(workDir);

  // Code generation and template routes
  const templates = createTemplateRoutes(workDir);

  // Initialize inline completion provider if worker key is available
  const workerKey = config.worker.apiKey;
  if (workerKey) {
    initCompletionProvider(workerKey, config.worker.baseUrl);
  }

  // Document conversion routes
  const documents = createDocumentRoutes();

  // Notepad routes
  const notepads = createNotepadRoutes();

  // Upload routes
  const upload = createUploadRoutes(workDir);
  const workers = createWorkerRoutes();
  const intake = createIntakeRoutes();
  const orgs = createOrganizationRoutes();
  const destroRoutes = createDestroRoutes();

  // Register routes with versioned (/api/v1/...) and legacy (/api/...) paths
  const routes: Route[] = [
    // Health (always unversioned)
    route('GET', '/api/health', handleHealth),
    route('GET', '/api/v1/health', handleHealth),

    // Monitoring (always unversioned)
    route('GET', '/api/monitoring', handleMonitoring),
    route('GET', '/api/v1/monitoring', handleMonitoring),

    // Circuit breaker status
    ...v1Route('GET', '/circuit-breaker', async (_req, res) => {
      sendJson(res, 200, {
        state: circuitBreaker.currentState,
        failures: circuitBreaker.failures,
      });
    }),

    // Sessions (archived)

    // Tasks (read-only) + cancel
    ...v1Route('GET', '/tasks', tasks.listTasks),
    ...v1Route('GET', '/tasks/counts', tasks.taskCounts),
    ...v1Route('GET', '/tasks/:id', tasks.getTask),
    ...v1Route('POST', '/tasks/:id/cancel', tasks.cancelTask),

    // Workers
    ...v1Route('GET', '/workers', workers.listWorkers),

    // Files
    ...v1Route('GET', '/files/tree', files.getFileTree),
    ...v1Route('GET', '/files', files.readFile),
    ...v1Route('PUT', '/files', files.writeFile),

    // Security
    ...v1Route('POST', '/security/scan', security.launchScan),
    ...v1Route('GET', '/security/findings', security.getFindings),
    ...v1Route('GET', '/security/dashboard', security.getDashboard),
    ...v1Route('GET', '/security/reviews', security.getReviews),
    ...v1Route('GET', '/security/reviews/:id/findings', security.getReviewFindings),

    // Config
    ...v1Route('GET', '/config', configRoutes.getConfig),
    ...v1Route('PUT', '/config', configRoutes.updateConfig),
    ...v1Route('GET', '/config/profiles', configRoutes.listProfiles),

    // Models
    ...v1Route('GET', '/models', models.listModels),
    ...v1Route('PUT', '/models/active', models.setActiveModel),

    // Git
    ...v1Route('GET', '/git/status', git.getStatus),
    ...v1Route('GET', '/git/log', git.getLog),
    ...v1Route('GET', '/git/diff', git.getDiff),
    ...v1Route('GET', '/git/checkpoints', git.getCheckpoints),
    ...v1Route('POST', '/git/checkpoints', git.createCheckpoint),

    // Analytics
    // Analytics (archived)

    // Search
    ...v1Route('POST', '/search', search.search),

    // Terminal
    ...v1Route('POST', '/terminal/exec', terminal.exec),

    // Workspace
    ...v1Route('GET', '/workspace', workspace.listWorkspaces),
    ...v1Route('POST', '/workspace/start', workspace.startWorkspace),
    ...v1Route('GET', '/workspace/:id', workspace.getWorkspace),
    ...v1Route('POST', '/workspace/:id/approve', workspace.approveWorkspace),
    ...v1Route('POST', '/workspace/:id/reject/:fileIndex', workspace.rejectChange),
    ...v1Route('POST', '/workspace/:id/stop', workspace.stopWorkspace),
    ...v1Route('GET', '/workspace/:id/changes', workspace.getChanges),
    ...v1Route('POST', '/workspace/:id/edit', workspace.editFile),
    ...v1Route('POST', '/workspace/:id/plan', workspace.updatePlan),
    ...v1Route('POST', '/workspace/:id/execute', workspace.executePlan),

    // Completions
    ...v1Route('POST', '/completions', completions.getCompletions),

    // Templates
    ...v1Route('GET', '/templates', templates.listTemplates),
    ...v1Route('GET', '/templates/categories', templates.listCategories),
    ...v1Route('GET', '/templates/:name', templates.getTemplate),
    ...v1Route('POST', '/templates/validate', templates.validateTemplate),
    ...v1Route('POST', '/templates/render', templates.renderTemplate),

    // Version info endpoint
    v1OnlyRoute('GET', '/version', async (_req, res) => {
      sendJson(res, 200, {
        apiVersion: CURRENT_API_VERSION,
        supportedVersions: SUPPORTED_VERSIONS,
        deprecatedVersions: DEPRECATED_VERSIONS,
      });
    }),

    // ── Document Preview & Export ────────────
    ...v1Route('POST', '/documents/convert', documents.convertDocument),
    ...v1Route('POST', '/documents/export', documents.exportDocument),

    // ── File Upload ──────────────────────────
    ...v1Route('POST', '/files/upload', upload.uploadFile),

    // ── Notepads ────────────────────────────
    ...v1Route('GET', '/notepads', notepads.listNotepads),
    ...v1Route('POST', '/notepads', notepads.createNotepad),
    ...v1Route('POST', '/notepads/search', notepads.searchNotepads),
    ...v1Route('POST', '/notepads/export', notepads.exportNotepads),
    ...v1Route('POST', '/notepads/import', notepads.importNotepads),
    ...v1Route('GET', '/notepads/:id', notepads.getNotepad),
    ...v1Route('PUT', '/notepads/:id', notepads.updateNotepad),
    ...v1Route('DELETE', '/notepads/:id', notepads.deleteNotepad),
    ...v1Route('POST', '/notepads/:id/pin', notepads.toggleNotepadPin),

      // ── Intake Agent ────────────────────────
      ...v1Route('POST', '/intake/expand', intake.expand),
      ...v1Route('GET', '/intake/requests', intake.list),
      ...v1Route('GET', '/intake/requests/:id', intake.get),
      ...v1Route('PUT', '/intake/requests/:id', intake.update),
      ...v1Route('POST', '/intake/requests/:id/approve', intake.approve),
      ...v1Route('POST', '/intake/requests/:id/reject', intake.reject),
      ...v1Route('POST', '/intake/requests/:id/send', intake.send),
      ...v1Route('GET', '/intake/ports', intake.getPorts),
      ...v1Route('POST', '/intake/ports/scan', intake.scanPorts),
      ...v1Route('GET', '/intake/config', intake.getConfig),
      ...v1Route('PUT', '/intake/config', intake.setConfig),
      ...v1Route('POST', '/intake/config/reload', intake.reloadConfig),
      ...v1Route('GET', '/intake/templates', intake.getTemplates),
      ...v1Route('POST', '/intake/templates', intake.createTemplate),
      ...v1Route('GET', '/intake/projects', intake.listProjects),
      ...v1Route('GET', '/intake/projects/:name', intake.getProject),
      ...v1Route('PUT', '/intake/projects/:name', intake.updateProject),
      ...v1Route('POST', '/intake/projects', intake.createProject),

      // ── Organizations & OSINT ──────────────
      ...v1Route('GET', '/orgs', orgs.listOrgs),
      ...v1Route('GET', '/orgs/:id', orgs.getOrg),
      ...v1Route('POST', '/orgs', orgs.createOrg),
      ...v1Route('DELETE', '/orgs/:id', orgs.deleteOrg),
      ...v1Route('GET', '/orgs/:id/findings', orgs.listFindings),
      ...v1Route('GET', '/findings', orgs.listFindings),
      // NOTE: /findings/stats must precede /findings/:id to avoid :id capturing "stats"
      ...v1Route('GET', '/findings/stats', orgs.getFindingsStats),
      ...v1Route('GET', '/findings/:id', orgs.getFinding),
      ...v1Route('GET', '/scan-scheduler/status', orgs.getSchedulerStatus),

      // ── Destro Agent ────────────────────────
      ...v1Route('GET', '/destro/health', destroRoutes.health),
      ...v1Route('POST', '/destro/chat', destroRoutes.chat),
      ...v1Route('GET', '/destro/sessions', destroRoutes.listSessions),
      ...v1Route('GET', '/destro/sessions/:id', destroRoutes.getSession),
      ...v1Route('POST', '/destro/sessions/:id/steer', destroRoutes.steer),
      ...v1Route('POST', '/destro/sessions/:id/abort', destroRoutes.abort),
      ...v1Route('POST', '/destro/sessions/:id/approve', destroRoutes.approve),
    ];

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    // CORS
    corsMiddleware(req, res);
    if (req.method === 'OPTIONS') return;

    // Auth
    if (!authMiddleware(req, res)) return;

    // API Versioning
    const versionInfo = extractApiVersion(req);
    setDeprecationHeaders(res, versionInfo);

    // Route matching
    const url = new URL(req.url || '/', 'http://' + (req.headers.host || 'localhost'));
    const pathname = url.pathname;
    const method = req.method || 'GET';

    for (const r of routes) {
      if (r.method !== method) continue;
      const match = pathname.match(r.pattern);
      if (match) {
        const params: Record<string, string> = {};
        r.paramNames.forEach((name, i) => { params[name] = match[i + 1]; });

        // Extra deprecation for legacy routes
        if (r.legacy) {
          res.setHeader('X-API-Deprecated', 'true');
          res.setHeader('X-API-Sunset', '2026-07-01');
        }

        try {
          await r.handler(req, res, params);
        } catch (err) {
          console.error('[api] unhandled route error:', err instanceof Error ? err.stack || err.message : String(err));
          sendError(res, 500, 'Internal server error');
        }
        return;
      }
    }

    sendError(res, 404, 'Not found: ' + method + ' ' + pathname);
  });

  // WebSocket
  setupWebSocket(server);

  return new Promise((resolve) => {
    server.listen(port, host, () => {
      console.log('API server running at http://' + host + ':' + port);
      console.log('Auth token configured (set API_TOKEN env var to override)');
      resolve({
        port,
        token,
        close: () => { server.close(); },
      });
    });
  });
}
