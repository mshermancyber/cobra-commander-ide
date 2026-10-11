import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendJson, sendError } from '../middleware/error-handler.js';
import {
  expandPrompt,
  listRequests,
  loadRequest,
  approveRequest,
  updateRequirements,
  markSent,
  rejectRequest,
} from '../../core/intake-agent.js';
import * as store from '../../core/task-store.js';
import {
  getIntakeConfig,
  updateIntakeConfig,
  reloadIntakeConfig,
} from '../../core/intake-config.js';
import {
  loadPortRegistry,
  scanActivePorts,
  findOpenPortPair,
  scanProjects,
} from '../../core/port-scanner.js';
import {
  listIntakeTemplates,
  getIntakeTemplate,
  addIntakeTemplate,
} from '../../core/intake-templates.js';
import {
  listProjects as listContentProjects,
  getProjectProfile,
  findProject,
  registerProject,
  updateProjectProfile,
} from '../../core/content-registry.js';

function parseBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString()));
      } catch {
        resolve({});
      }
    });
    req.on('error', reject);
  });
}

export function createIntakeRoutes() {
  async function expand(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await parseBody(req);
    const prompt = body.prompt as string;
    if (!prompt || typeof prompt !== 'string') {
      sendError(res, 400, 'Missing "prompt" field');
      return;
    }

    const request = await expandPrompt(prompt);
    sendJson(res, 200, request);
  }

  async function list(_req: IncomingMessage, res: ServerResponse): Promise<void> {
    const requests = listRequests();
    sendJson(res, 200, { count: requests.length, requests });
  }

  async function get(_req: IncomingMessage, res: ServerResponse, params: Record<string, string>): Promise<void> {
    const request = loadRequest(params.id);
    if (!request) {
      sendError(res, 404, 'Request not found');
      return;
    }
    sendJson(res, 200, request);
  }

  async function update(req: IncomingMessage, res: ServerResponse, params: Record<string, string>): Promise<void> {
    const body = await parseBody(req);
    const requirements = body.requirements as string;
    if (!requirements) {
      sendError(res, 400, 'Missing "requirements" field');
      return;
    }

    const request = updateRequirements(params.id, requirements);
    if (!request) {
      sendError(res, 404, 'Request not found');
      return;
    }
    sendJson(res, 200, request);
  }

  async function approve(_req: IncomingMessage, res: ServerResponse, params: Record<string, string>): Promise<void> {
    const request = approveRequest(params.id);
    if (!request) {
      sendError(res, 404, 'Request not found or not in reviewable state');
      return;
    }
    sendJson(res, 200, request);
  }

  async function reject(_req: IncomingMessage, res: ServerResponse, params: Record<string, string>): Promise<void> {
    const request = rejectRequest(params.id);
    if (!request) {
      sendError(res, 404, 'Request not found');
      return;
    }
    sendJson(res, 200, request);
  }

  async function send(_req: IncomingMessage, res: ServerResponse, params: Record<string, string>): Promise<void> {
    const request = markSent(params.id);
    if (!request) {
      sendError(res, 404, 'Request not found or not approved');
      return;
    }

    // Never default to '/data' (root) — that lets workers write anywhere.
    // Fall back to a dedicated workspace when no project path was assigned.
    const projectPath = request.projectPath || '/data/_workspace';
    const requirements = `${request.requirements}\n\nProject: ${request.projectName}\nPath: ${projectPath}${request.ports ? `\nPorts: Frontend ${request.ports.frontend}, Backend ${request.ports.backend}` : ''}${request.nginxConfig ? `\n\nNginx config:\n${request.nginxConfig}` : ''}\n\nDo NOT run security scans. Read existing code first. Run npx tsc --noEmit when done.`;
    const context = `Intake request ${request.id}. Working directory: ${projectPath}.`;
    // Drop a pending task; the daemon's task-runner claims and executes it
    // durably (survives process death, heartbeats, resumes on crash). No inline
    // fire — one execution path keeps concurrency limits + resume uniform.
    const taskRecord = store.createTask(requirements, context, projectPath);

    sendJson(res, 200, { ...request, taskId: taskRecord.id, dispatched: true });
  }

  async function getPorts(_req: IncomingMessage, res: ServerResponse): Promise<void> {
    const registry = loadPortRegistry();
    const projects = scanProjects();
    sendJson(res, 200, { registry, projects });
  }

  async function scanPorts(_req: IncomingMessage, res: ServerResponse): Promise<void> {
    const active = scanActivePorts();
    const nextPair = findOpenPortPair();
    sendJson(res, 200, { activePorts: active, nextAvailable: nextPair });
  }

  async function getConfig(_req: IncomingMessage, res: ServerResponse): Promise<void> {
    const config = getIntakeConfig();
    sendJson(res, 200, {
      providerUrl: config.baseUrl,
      model: config.model,
      hasApiKey: !!config.apiKey,
    });
  }

  async function setConfig(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await parseBody(req);
    const updated = updateIntakeConfig({
      baseUrl: body.providerUrl as string | undefined,
      model: body.model as string | undefined,
      apiKey: body.apiKey as string | undefined,
    });
    sendJson(res, 200, {
      providerUrl: updated.baseUrl,
      model: updated.model,
      hasApiKey: !!updated.apiKey,
    });
  }

  async function reloadConfig(_req: IncomingMessage, res: ServerResponse): Promise<void> {
    const config = reloadIntakeConfig();
    sendJson(res, 200, {
      providerUrl: config.baseUrl,
      model: config.model,
      hasApiKey: !!config.apiKey,
      message: 'Configuration reloaded from environment',
    });
  }

  async function getTemplates(_req: IncomingMessage, res: ServerResponse): Promise<void> {
    const templates = listIntakeTemplates();
    sendJson(res, 200, { count: templates.length, templates });
  }

  async function createTemplate(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await parseBody(req);
    if (!body.id || !body.name || !body.description || !body.category || !body.skeleton) {
      sendError(res, 400, 'Missing required fields: id, name, description, category, skeleton');
      return;
    }

    addIntakeTemplate({
      id: body.id as string,
      name: body.name as string,
      description: body.description as string,
      category: body.category as any,
      skeleton: body.skeleton as string,
      defaultPages: (body.defaultPages as string[]) || [],
      defaultDataModels: (body.defaultDataModels as string[]) || [],
    });

    sendJson(res, 201, { success: true });
  }

  async function listProjects(_req: IncomingMessage, res: ServerResponse): Promise<void> {
    const projects = listContentProjects();
    sendJson(res, 200, { count: projects.length, projects });
  }

  async function getProject(_req: IncomingMessage, res: ServerResponse, params: Record<string, string>): Promise<void> {
    const entry = findProject(params.name);
    if (!entry) {
      sendError(res, 404, 'Project not found');
      return;
    }
    const profile = getProjectProfile(entry.projectName);
    sendJson(res, 200, { ...entry, profile });
  }

  async function updateProject(req: IncomingMessage, res: ServerResponse, params: Record<string, string>): Promise<void> {
    const body = await parseBody(req);
    const profile = body.profile as string;
    if (!profile) {
      sendError(res, 400, 'Missing "profile" field');
      return;
    }
    const ok = updateProjectProfile(params.name, profile);
    if (!ok) {
      sendError(res, 404, 'Project not found');
      return;
    }
    sendJson(res, 200, { success: true });
  }

  async function createProject(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await parseBody(req);
    const projectName = body.projectName as string;
    const folderPath = body.folderPath as string;
    const profile = body.profile as string;
    if (!projectName || !folderPath || !profile) {
      sendError(res, 400, 'Missing required fields: projectName, folderPath, profile');
      return;
    }
    registerProject({ projectName, folderPath, profile });
    sendJson(res, 201, { success: true });
  }

  return {
    expand,
    list,
    get,
    update,
    approve,
    reject,
    send,
    getPorts,
    scanPorts,
    getConfig,
    setConfig,
    reloadConfig,
    getTemplates,
    createTemplate,
    listProjects,
    getProject,
    updateProject,
    createProject,
  };
}
