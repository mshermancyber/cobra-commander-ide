import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { getIntakeProvider } from './intake-config.js';
import { findOpenPortPair, findOpenHttpsPort, registerPorts } from './port-scanner.js';
import { generateNginxConfig, generateSelfSignedCertCommand } from './nginx-gen.js';
import { matchTemplate, type IntakeTemplate } from './intake-templates.js';
import { listProjects, findProject, getProjectProfile, registerProject, getProjectsSummary } from './content-registry.js';
import { installRoot } from './env-file.js';

const REQUESTS_DIR = join(installRoot(), '.intake-requests');

export interface IntakeRequest {
  id: string;
  prompt: string;
  requirements: string | null;
  projectName: string | null;
  projectPath: string | null;
  ports: { frontend: number; backend: number } | null;
  nginxConfig: string | null;
  templateUsed: string | null;
  status: 'draft' | 'expanding' | 'review' | 'approved' | 'sent' | 'rejected';
  createdAt: number;
  updatedAt: number;
}

const INTAKE_SYSTEM_PROMPT = `You are a Requirements Expansion Agent. Your ONLY job is to take a short human prompt and expand it into a structured requirements document for a software project.

## HARD RESTRICTIONS (NON-NEGOTIABLE)

You are a REQUIREMENTS WRITER. You are NOT a developer, debugger, or problem-solver.

- You MUST NOT write code, fix bugs, debug issues, or suggest implementation approaches.
- You MUST NOT execute shell commands, read files, write files, or interact with the filesystem.
- You MUST NOT delegate work to workers, orchestrators, or any other agent.
- You MUST NOT access tools like delegate_to_worker, delegate_pipeline, delegate_parallel, delegate_chain, delegate_swarm, or any execution tool.
- You MUST NOT attempt to build, compile, test, or deploy anything.
- You have NO access to the codebase, terminal, or any development environment.
- If a user asks you to fix, debug, build, or implement anything, respond ONLY with: "I only handle requirements. Send this to the orchestrator for implementation."
- If a user asks you to run a command, read a file, or check status, respond ONLY with: "I only handle requirements. I cannot access the system."

Your ONLY capability is: take a human prompt → produce a structured requirements document → stop.

## GUARDRAILS (MANDATORY — violating these invalidates your output)

1. **Expand the WHAT, never invent the HOW.** Describe what the user needs, not how to build it. Never mention specific libraries, algorithms, design patterns, database engines, or implementation approaches. Never suggest rendering techniques ("2D or 3D", "canvas-based", "WebGL"). Never suggest data structures or architectures. "Users can view objects on a map" is WHAT. "Using a 2D canvas with WebGL fallback" is HOW — forbidden.

2. **No feature creep.** Only include requirements DIRECTLY IMPLIED by the prompt. If the user says "build me a task tracker," you include task CRUD and status management. You do NOT add Gantt charts, time tracking, team collaboration, or AI suggestions unless the prompt specifically mentions them. NEVER add features marked as "future expansion" or "nice to have" — if it's not in the prompt, it doesn't exist.

3. **Every requirement must be traceable to the prompt.** If you cannot point to a word or phrase in the original prompt that implies a requirement, delete it. Apply this ruthlessly — when in doubt, leave it out.

4. **Do NOT specify technology choices.** The orchestrator decides implementation. You specify WHAT the app does, not what it's built with. Exception: Angular 17 frontend and Node/Express/TypeScript backend are ALWAYS mandated — state these in the tech stack section but nowhere else.

5. **No implementation hints in requirements.** Never use phrases like "2D or 3D", "real-time or batch", "SQL or NoSQL", "REST or GraphQL". These are implementation choices. Describe the user experience only: what the user sees, clicks, and gets back.

6. **Success criteria must be testable.** Each criterion should be verifiable by a human clicking through the app. "User can create an account" is testable. "System is scalable" is not.

7. **No speculative features.** Never add "(future expansion)", "(optional)", "(if time permits)", or any feature the user didn't ask for. The document describes what IS being built, not what COULD be built.

8. **Stay in your lane.** You produce a document. You do not act on it. You do not follow up. You do not check if it was implemented. You hand off the document and you are done.

## PROJECT AWARENESS

You have access to a registry of existing projects. Before creating requirements for a "new" project, check if the user is referring to an existing one.

- If the user mentions a registered project by name (e.g. "add a feature to invoices", "fix the crawler"), this is an ENHANCEMENT to an existing project, not a new app. Use the existing project's path, ports, and stack from its profile — do NOT assign new ports or a new path.
- For enhancements, output the same markdown structure but mark it as "Enhancement" in the Overview, reference the existing path/ports, and only list the NEW requirements being added.
- If this is genuinely a new project, assign it a new path under /data/{name}/ and new ports from the available range.
- Always check the project registry before deciding if something is new or existing.

## MANDATORY SECTIONS (always include these)

You MUST output this exact markdown structure:

# Project: {name}
## Path: /data/{name}/
## Ports: Frontend {frontendPort}, Backend {backendPort}

## Overview
{1-2 sentences describing what this app does}

## Tech Stack
- Frontend: Angular 17 (standalone components, mobile-responsive + desktop)
- Backend: Node.js / Express / TypeScript
- Database: SQLite (default) or as appropriate
- HTTPS via nginx reverse proxy

## Requirements
{Numbered list of functional requirements — WHAT the app does, not HOW}

## Data Model
{List entities and their key fields — names and types only, no schema DDL}

## User Roles
{List roles and their access levels}

## Pages
{List each page/view and what it displays — name + one-line description}

## Mobile Adaptations
{How the mobile view differs from desktop — responsive breakpoints, navigation changes}

## Multi-User
- User registration and login
- Session management
- User-scoped data (each user sees their own data unless shared)
- Admin role with full access

## HTTPS/Nginx
{Nginx server block configuration will be provided separately}
- Self-signed certificate for development
- Reverse proxy: /api/* → backend, /* → frontend

## Success Criteria
{Numbered checklist of testable criteria}

## IMPORTANT
- The port numbers and project path shown above are pre-assigned — use them exactly.
- Do NOT add requirements beyond what the prompt implies.
- Do NOT specify implementation details.`;

function ensureRequestsDir(): void {
  if (!existsSync(REQUESTS_DIR)) {
    mkdirSync(REQUESTS_DIR, { recursive: true });
  }
}

function requestPath(id: string): string {
  return join(REQUESTS_DIR, `${id}.json`);
}

export function saveRequest(req: IntakeRequest): void {
  ensureRequestsDir();
  writeFileSync(requestPath(req.id), JSON.stringify(req, null, 2), 'utf-8');
}

export function loadRequest(id: string): IntakeRequest | null {
  const path = requestPath(id);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
}

export function listRequests(): IntakeRequest[] {
  ensureRequestsDir();
  const files = readdirSync(REQUESTS_DIR).filter((f: string) => f.endsWith('.json'));
  const requests: IntakeRequest[] = [];
  for (const file of files) {
    try {
      const data = JSON.parse(readFileSync(join(REQUESTS_DIR, file), 'utf-8'));
      requests.push(data);
    } catch { /* skip bad files */ }
  }
  return requests.sort((a, b) => b.createdAt - a.createdAt);
}

function extractProjectName(prompt: string): string {
  const lower = prompt.toLowerCase();

  // Check for explicit /data/name path
  const pathMatch = lower.match(/\/data\/([a-z0-9_-]+)/);
  if (pathMatch) return pathMatch[1];

  // Check for quoted project name
  const quotedMatch = prompt.match(/["']([a-zA-Z0-9_ -]{2,30})["']/);
  if (quotedMatch) return quotedMatch[1].toLowerCase().replace(/[\s_]+/g, '-');

  // Check for "called X" or "named X" patterns
  const namedMatch = lower.match(/(?:called|named|titled)\s+([a-z0-9-]+)/);
  if (namedMatch) return namedMatch[1];

  const stopWords = new Set([
    'build', 'create', 'make', 'develop', 'write', 'design', 'deploy', 'setup', 'start',
    'the', 'for', 'and', 'with', 'that', 'this', 'from', 'into', 'like', 'about', 'its',
    'app', 'application', 'tool', 'system', 'platform', 'service', 'website', 'site',
    'new', 'simple', 'basic', 'full', 'complete', 'modern', 'real', 'time',
    'want', 'need', 'should', 'would', 'could', 'can', 'will', 'please',
    'map', 'data', 'web', 'use', 'using', 'get', 'add', 'set',
    'mobile', 'desktop', 'responsive',
    'universe', 'world', 'everything', 'all', 'show', 'display', 'view', 'list',
    'manage', 'track', 'monitor', 'watch', 'browse', 'explore', 'search', 'find',
  ]);

  const words = lower
    .replace(/[^a-z0-9\s-]/g, '')
    .split(/\s+/)
    .filter(w => w.length > 2 && !stopWords.has(w));

  // Compound words (hyphenated or camelCase-ish in original) get priority
  const compoundMatch = prompt.match(/[a-zA-Z]+-[a-zA-Z]+/);
  if (compoundMatch) return compoundMatch[0].toLowerCase();

  // Single best word — the most distinctive noun, prefer first unique occurrence
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const w of words) {
    if (!seen.has(w)) { seen.add(w); unique.push(w); }
  }

  if (unique.length === 0) return 'new-project';
  return unique[0];
}

/**
 * Decide whether a prompt targets an EXISTING project (enhancement) or a new
 * build. An existing project only counts when its name appears as an EXACT
 * token (strict — "attack" never matches "attack-path-graph") AND is used as a
 * TARGET ("add ... to <project>", "fix bug in <project>"), not a REFERENCE ("a
 * tool like <project>"). An exact token with no clear target still
 * needs an explicit enhancement-intent word. Otherwise returns null → NEW
 * project. Biasing toward "new" is deliberate: a mislabeled enhancement gets
 * its own dir and is caught at review, whereas a false enhancement points
 * workers at the WRONG codebase (the bug this fixes — see FRAMEWORK-STABILITY-GAPS #10).
 */
export function detectEnhancementTarget(prompt: string): ReturnType<typeof findProject> {
  const lower = prompt.toLowerCase();
  const tokens = lower.split(/\s+/);
  const TARGET_BEFORE = new Set(['to', 'into', 'in', 'enhance', 'extend', 'update', 'modify', 'fix', 'improve', 'augment', 'refactor']);
  const REFERENCE_BEFORE = new Set(['like', 'as', 'unlike', 'than']);
  const hasEnhanceWord = /\b(enhanc\w*|existing|extend\w*|integrat\w*|refactor\w*|augment\w*|migrat\w*)\b/.test(lower);

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i].replace(/[^a-z0-9-]/g, '');
    if (tok.length < 3) continue;
    const m = findProject(tok, { strict: true });
    if (!m) continue;
    const prev = (tokens[i - 1] || '').replace(/[^a-z0-9]/g, '');
    const prev2 = (tokens[i - 2] || '').replace(/[^a-z0-9]/g, '');
    // "like <project>" / "similar to <project>" — a reference, not a target.
    if (REFERENCE_BEFORE.has(prev) || (prev === 'to' && (prev2 === 'similar' || prev2 === 'close'))) continue;
    // "to <project>" / "fix ... <project>" / any enhancement-intent word → confident.
    if (TARGET_BEFORE.has(prev) || hasEnhanceWord) return m;
    // exact project token but no clear target/intent — keep scanning.
  }
  return null;
}

export async function expandPrompt(prompt: string): Promise<IntakeRequest> {
  const id = randomUUID().slice(0, 8);

  const existingProject = detectEnhancementTarget(prompt);
  const isEnhancement = !!existingProject;
  const existingProfile = existingProject ? getProjectProfile(existingProject.projectName) : null;

  const projectName = isEnhancement ? existingProject.projectName : extractProjectName(prompt);
  const ports = isEnhancement ? null : findOpenPortPair();

  const request: IntakeRequest = {
    id,
    prompt,
    requirements: null,
    projectName,
    projectPath: isEnhancement ? existingProject.folderPath : `/data/${projectName}/`,
    ports,
    nginxConfig: null,
    templateUsed: null,
    status: 'expanding',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  saveRequest(request);

  const template = matchTemplate(prompt);
  if (template) {
    request.templateUsed = template.id;
  }

  const projectsSummary = getProjectsSummary();

  let projectContext = '';
  if (isEnhancement && existingProfile) {
    projectContext = `\nThis is an ENHANCEMENT to an existing project. Use the existing path and ports — do NOT assign new ones.\n\nExisting project profile:\n${existingProfile}\n`;
  }

  const portInfo = isEnhancement
    ? 'This is an existing project — use its existing ports from the profile above.'
    : ports
      ? `Pre-assigned ports: Frontend ${ports.frontend}, Backend ${ports.backend}.`
      : 'No ports available in range 4500-4600. Assign manually.';

  const templateHint = template
    ? `\nThis looks like a "${template.name}" type application. Use this skeleton as a starting point but adapt to the prompt:\n${template.skeleton}\nDefault pages: ${template.defaultPages.join(', ')}\nDefault data models: ${template.defaultDataModels.join(', ')}`
    : '';

  const userMessage = `Expand this prompt into a structured requirements document.

Known projects (CSV):
${projectsSummary}
${projectContext}
${isEnhancement ? `Project name: ${projectName}\nProject path: ${request.projectPath}` : `Suggested project name: ${projectName}\nIf this name is generic (like "new-project"), generate a better short kebab-case name that captures the app's purpose (e.g. "universe-map", "expense-tracker", "fleet-monitor"). Use that name for both the project name and path.`}
${portInfo}
${templateHint}

User prompt: "${prompt}"`;

  try {
    const provider = await getIntakeProvider();
    const response = await provider.chat(
      INTAKE_SYSTEM_PROMPT,
      [{ role: 'user', content: userMessage }],
      undefined,
      4096,
    );

    // Guard against the reasoning-model silent no-op: a "successful" call can
    // still return empty/garbage text (all budget spent on hidden reasoning).
    // An empty requirement must NOT advance to 'review' where it can be approved
    // and seed an empty orchestrator run — flag it as a draft error instead.
    const expanded = (response.text || '').trim();
    if (expanded.length < 40) {
      request.requirements = `ERROR: Intake returned an empty/too-short expansion (reasoning-model starvation). Re-run intake for this request.`;
      request.status = 'draft';
      request.updatedAt = Date.now();
      saveRequest(request);
      return request;
    }

    request.requirements = response.text;
    request.status = 'review';

    if (!isEnhancement && response.text) {
      const nameMatch = response.text.match(/^#\s*Project:\s*(.+)$/m);
      if (nameMatch) {
        const aiName = nameMatch[1].trim().toLowerCase().replace(/\s+/g, '-');
        if (aiName && aiName !== 'new-project' && aiName.length > 2) {
          request.projectName = aiName;
          request.projectPath = `/data/${aiName}/`;
        }
      }
    }

    if (!isEnhancement && ports) {
      const finalName = request.projectName || projectName;
      const httpsPort = findOpenHttpsPort() || 8443;
      const nginx = generateNginxConfig({
        projectName: finalName,
        frontendPort: ports.frontend,
        backendPort: ports.backend,
        httpsPort,
      });
      request.nginxConfig = nginx;
    }

    if (!isEnhancement && request.requirements && !request.requirements.startsWith('ERROR')) {
      const finalName = request.projectName || projectName;
      registerProject({
        projectName: finalName,
        folderPath: `/data/${finalName}/`,
        profile: `# ${finalName}\n\n${request.requirements.slice(0, 500)}...\n\n_Auto-generated by intake agent. Update with full details after build._\n`,
      });
    }
  } catch (err) {
    request.requirements = `ERROR: Failed to expand prompt. ${err instanceof Error ? err.message : String(err)}`;
    request.status = 'draft';
  }

  request.updatedAt = Date.now();
  saveRequest(request);
  return request;
}

export function approveRequest(id: string): IntakeRequest | null {
  const request = loadRequest(id);
  if (!request) return null;
  if (request.status !== 'review' && request.status !== 'draft') return null;

  request.status = 'approved';
  request.updatedAt = Date.now();

  if (request.ports) {
    registerPorts(request.projectName || 'unknown', request.ports.frontend, request.ports.backend);
  }

  saveRequest(request);
  return request;
}

export function updateRequirements(id: string, requirements: string): IntakeRequest | null {
  const request = loadRequest(id);
  if (!request) return null;

  request.requirements = requirements;
  request.updatedAt = Date.now();
  saveRequest(request);
  return request;
}

export function markSent(id: string): IntakeRequest | null {
  const request = loadRequest(id);
  if (!request || request.status !== 'approved') return null;

  request.status = 'sent';
  request.updatedAt = Date.now();
  saveRequest(request);
  return request;
}

export function rejectRequest(id: string): IntakeRequest | null {
  const request = loadRequest(id);
  if (!request) return null;

  request.status = 'rejected';
  request.updatedAt = Date.now();
  saveRequest(request);
  return request;
}
