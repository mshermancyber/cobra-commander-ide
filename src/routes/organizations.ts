import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendJson, sendError } from '../api-server/middleware/error-handler.js';
import {
  listOrganizations,
  getOrganization,
  createOrganization,
  deleteOrganization,
  listOrgFindings,
  getFinding,
  countFindingsByStatus,
  type OrgFindingsFilter,
  type FindingSeverity,
} from '../models/org-finding.js';
import { getScanSchedulerStatus } from '../core/scan-scheduler.js';

// ─── Helpers ───────────────────────────────────────────────────────────────

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

function getQueryParams(req: IncomingMessage): URLSearchParams {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  return url.searchParams;
}

// ─── Route factory ─────────────────────────────────────────────────────────

export function createOrganizationRoutes() {

  // ── Organizations ────────────────────────────────────────────────────

  async function listOrgs(_req: IncomingMessage, res: ServerResponse): Promise<void> {
    const orgs = listOrganizations();
    sendJson(res, 200, orgs);
  }

  async function getOrg(_req: IncomingMessage, res: ServerResponse, params: Record<string, string>): Promise<void> {
    const org = getOrganization(params.id);
    if (!org) {
      sendError(res, 404, 'Organization not found');
      return;
    }
    sendJson(res, 200, org);
  }

  async function createOrg(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await parseBody(req);
    const name = body.name as string;
    const domain = body.domain as string;

    if (!name || typeof name !== 'string') {
      sendError(res, 400, 'Missing "name" field');
      return;
    }
    if (!domain || typeof domain !== 'string') {
      sendError(res, 400, 'Missing "domain" field');
      return;
    }

    // Basic domain validation
    if (!domain.includes('.') || domain.includes(' ')) {
      sendError(res, 400, 'Invalid domain format');
      return;
    }

    const org = createOrganization({ name, domain });
    sendJson(res, 201, org);
  }

  async function deleteOrg(_req: IncomingMessage, res: ServerResponse, params: Record<string, string>): Promise<void> {
    const deleted = deleteOrganization(params.id);
    if (!deleted) {
      sendError(res, 404, 'Organization not found');
      return;
    }
    sendJson(res, 200, { deleted: true });
  }

  // ── Findings ─────────────────────────────────────────────────────────

  async function listFindings(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const q = getQueryParams(req);

    const filter: OrgFindingsFilter = {};

    const orgId = q.get('orgId');
    if (orgId) filter.orgId = orgId;

    const severity = q.get('severity') as FindingSeverity | null;
    if (severity) filter.severity = severity;

    const since = q.get('since');
    if (since) filter.since = parseInt(since, 10);

    const limit = q.get('limit');
    if (limit) filter.limit = parseInt(limit, 10);

    // Note: triageStatus query param is NOT passed through by default.
    // The triage gate in listOrgFindings() already hides pending/NULL.
    // If the caller explicitly requests a specific triage status, we allow it.
    const triageStatus = q.get('triageStatus');
    if (triageStatus) {
      filter.triageStatus = triageStatus as OrgFindingsFilter['triageStatus'];
    }

    const findings = listOrgFindings(filter);
    sendJson(res, 200, findings);
  }

  async function getFindingHandler(_req: IncomingMessage, res: ServerResponse, params: Record<string, string>): Promise<void> {
    const finding = getFinding(params.id);
    if (!finding) {
      sendError(res, 404, 'Finding not found');
      return;
    }
    // Triage gate: hide pending/NULL findings from direct access too
    if (finding.triageStatus === null || finding.triageStatus === 'pending') {
      sendError(res, 404, 'Finding not found');
      return;
    }
    sendJson(res, 200, finding);
  }

  async function getFindingsStats(_req: IncomingMessage, res: ServerResponse): Promise<void> {
    const counts = countFindingsByStatus();
    const orgs = listOrganizations();
    const schedulerStatus = getScanSchedulerStatus();

    sendJson(res, 200, {
      findingsByStatus: counts,
      totalOrgs: orgs.length,
      orgsWithScans: orgs.filter(o => o.lastScannedAt !== null).length,
      scheduler: schedulerStatus,
    });
  }

  // ── Scheduler ────────────────────────────────────────────────────────

  async function getSchedulerStatus(_req: IncomingMessage, res: ServerResponse): Promise<void> {
    const status = getScanSchedulerStatus();
    sendJson(res, 200, status);
  }

  return {
    listOrgs,
    getOrg,
    createOrg,
    deleteOrg,
    listFindings,
    getFinding: getFindingHandler,
    getFindingsStats,
    getSchedulerStatus,
  };
}
