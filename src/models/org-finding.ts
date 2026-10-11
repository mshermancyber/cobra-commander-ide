import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { monotonicId } from '../core/monotonic-id.js';
import { installRoot } from '../core/env-file.js';

// ─── Types ─────────────────────────────────────────────────────────────────

export type FindingSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';

export type TriageStatus = 'pending' | 'confirmed' | 'noise' | 'false_positive' | 'duplicate' | 'stale';

export interface OrgFinding {
  id: string;
  orgId: string;
  orgName: string;
  title: string;
  description: string;
  severity: FindingSeverity;
  source: string;
  url?: string;
  discoveredAt: number;
  triageStatus: TriageStatus | null;
  triageNotes?: string;
  triagedAt?: number;
}

export interface Organization {
  id: string;
  name: string;
  domain: string;
  lastScannedAt: number | null;
  createdAt: number;
}

export interface OrgFindingsFilter {
  orgId?: string;
  severity?: FindingSeverity;
  triageStatus?: TriageStatus | 'pending_or_null';
  since?: number;
  limit?: number;
}

// ─── Storage ───────────────────────────────────────────────────────────────

const CC_HOME = installRoot();
const DATA_DIR = join(CC_HOME, '.cobra-commander', 'osint');

function ensureDataDir(): void {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
}

function findingsPath(): string {
  return join(DATA_DIR, 'findings.jsonl');
}

function orgsPath(): string {
  return join(DATA_DIR, 'organizations.json');
}

// ─── Findings CRUD ─────────────────────────────────────────────────────────

/** Read all findings from the JSONL store. */
function readAllFindings(): OrgFinding[] {
  ensureDataDir();
  const fp = findingsPath();
  if (!existsSync(fp)) return [];
  try {
    return readFileSync(fp, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line) as OrgFinding);
  } catch {
    return [];
  }
}

/** Append a single finding to the JSONL file. */
function appendFinding(finding: OrgFinding): void {
  ensureDataDir();
  const fp = findingsPath();
  writeFileSync(fp, JSON.stringify(finding) + '\n', { flag: 'a' });
}

/** Overwrite the entire findings file (used after triage updates). */
function writeAllFindings(findings: OrgFinding[]): void {
  ensureDataDir();
  const fp = findingsPath();
  writeFileSync(fp, findings.map(f => JSON.stringify(f)).join('\n') + '\n');
}

/**
 * Create a new org finding. The finding is initially created with
 * triageStatus=null so it remains invisible in API queries until triaged.
 */
export function createOrgFinding(params: {
  orgId: string;
  orgName: string;
  title: string;
  description: string;
  severity: FindingSeverity;
  source: string;
  url?: string;
}): OrgFinding {
  const finding: OrgFinding = {
    id: `of-${monotonicId()}`,
    orgId: params.orgId,
    orgName: params.orgName,
    title: params.title,
    description: params.description,
    severity: params.severity,
    source: params.source,
    url: params.url,
    discoveredAt: Date.now(),
    triageStatus: null,
  };

  appendFinding(finding);
  return finding;
}

/**
 * List org findings.
 *
 * **Triage gate**: Findings with triageStatus IS NULL or triageStatus = 'pending'
 * are excluded from API responses. Only triaged findings (confirmed, noise,
 * false_positive, duplicate, stale) are returned.
 */
export function listOrgFindings(filter: OrgFindingsFilter = {}): OrgFinding[] {
  let findings = readAllFindings();

  // ── Triage gate: hide pending / untriaged findings ──
  findings = findings.filter(
    f => f.triageStatus !== null && f.triageStatus !== 'pending',
  );

  // Apply additional filters
  if (filter.orgId) {
    findings = findings.filter(f => f.orgId === filter.orgId);
  }
  if (filter.severity) {
    findings = findings.filter(f => f.severity === filter.severity);
  }
  if (filter.triageStatus) {
    findings = findings.filter(f => f.triageStatus === filter.triageStatus);
  }
  const since = filter.since;
  if (since !== undefined) {
    findings = findings.filter(f => f.discoveredAt >= since);
  }

  // Sort newest first
  findings.sort((a, b) => b.discoveredAt - a.discoveredAt);

  if (filter.limit && filter.limit > 0) {
    findings = findings.slice(0, filter.limit);
  }

  return findings;
}

/**
 * List findings that are pending triage (triageStatus IS NULL or = 'pending').
 * Used internally by the triage system — these are NOT visible via the public API.
 */
export function listPendingFindings(orgId?: string): OrgFinding[] {
  let findings = readAllFindings();
  findings = findings.filter(
    f => f.triageStatus === null || f.triageStatus === 'pending',
  );
  if (orgId) {
    findings = findings.filter(f => f.orgId === orgId);
  }
  findings.sort((a, b) => a.discoveredAt - b.discoveredAt);
  return findings;
}

/**
 * Update the triage status of a finding.
 */
export function updateFindingTriage(
  findingId: string,
  status: TriageStatus,
  notes?: string,
): OrgFinding | null {
  const all = readAllFindings();
  const idx = all.findIndex(f => f.id === findingId);
  if (idx === -1) return null;

  all[idx].triageStatus = status;
  all[idx].triageNotes = notes;
  all[idx].triagedAt = Date.now();

  writeAllFindings(all);
  return all[idx];
}

/** Get a single finding by ID. */
export function getFinding(id: string): OrgFinding | undefined {
  return readAllFindings().find(f => f.id === id);
}

/** Count findings grouped by triage status. */
export function countFindingsByStatus(): Record<string, number> {
  const all = readAllFindings();
  const counts: Record<string, number> = {};
  for (const f of all) {
    const key = f.triageStatus ?? 'null';
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

// ─── Organizations CRUD ────────────────────────────────────────────────────

function readAllOrgs(): Organization[] {
  ensureDataDir();
  const fp = orgsPath();
  if (!existsSync(fp)) return [];
  try {
    return JSON.parse(readFileSync(fp, 'utf-8'));
  } catch {
    return [];
  }
}

function writeAllOrgs(orgs: Organization[]): void {
  ensureDataDir();
  writeFileSync(orgsPath(), JSON.stringify(orgs, null, 2));
}

/** List all registered organizations. */
export function listOrganizations(): Organization[] {
  return readAllOrgs().sort((a, b) => a.name.localeCompare(b.name));
}

/** Get a single organization by ID. */
export function getOrganization(id: string): Organization | undefined {
  return readAllOrgs().find(o => o.id === id);
}

/** Create a new organization to monitor. */
export function createOrganization(params: {
  name: string;
  domain: string;
}): Organization {
  const org: Organization = {
    id: `org-${monotonicId()}`,
    name: params.name,
    domain: params.domain,
    lastScannedAt: null,
    createdAt: Date.now(),
  };

  const orgs = readAllOrgs();
  orgs.push(org);
  writeAllOrgs(orgs);
  return org;
}

/** Update an organization's lastScannedAt timestamp. */
export function touchOrganization(id: string): Organization | null {
  const orgs = readAllOrgs();
  const idx = orgs.findIndex(o => o.id === id);
  if (idx === -1) return null;
  orgs[idx].lastScannedAt = Date.now();
  writeAllOrgs(orgs);
  return orgs[idx];
}

/** Delete an organization and all its findings. */
export function deleteOrganization(id: string): boolean {
  const orgs = readAllOrgs();
  const filtered = orgs.filter(o => o.id !== id);
  if (filtered.length === orgs.length) return false;
  writeAllOrgs(filtered);

  // Also remove findings for this org
  const findings = readAllFindings().filter(f => f.orgId !== id);
  writeAllFindings(findings);
  return true;
}
