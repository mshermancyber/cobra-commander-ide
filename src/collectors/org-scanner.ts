import { execFileSync } from 'node:child_process';
import { createOrgFinding, type Organization, type OrgFinding } from '../models/org-finding.js';

// ─── Types ─────────────────────────────────────────────────────────────────

export interface ScanResult {
  orgId: string;
  orgName: string;
  findings: OrgFinding[];
  durationMs: number;
  errors: string[];
}

/** A named collector function that scans a single org for a specific signal type. */
export interface CollectorDef {
  name: string;
  label: string;
  description: string;
  fn: (org: Organization) => Promise<OrgFinding[]>;
}

// ─── OSINT Queries ─────────────────────────────────────────────────────────

interface OsintQuery {
  label: string;
  query: string;
  severity: OrgFinding['severity'];
}

function buildQueries(org: Organization): OsintQuery[] {
  const name = org.name;
  const domain = org.domain;
  return [
    {
      label: 'data-breach',
      query: `"${name}" data breach OR leak OR exposed`,
      severity: 'critical',
    },
    {
      label: 'security-incident',
      query: `"${name}" security incident OR vulnerability OR hacked`,
      severity: 'high',
    },
    {
      label: 'github-leaks',
      query: `site:github.com "${domain}" password OR secret OR key OR token`,
      severity: 'critical',
    },
    {
      label: 'pastebin',
      query: `site:pastebin.com "${domain}" OR "${name}"`,
      severity: 'high',
    },
    {
      label: 'subdomain',
      query: `site:*.${domain}`,
      severity: 'low',
    },
    {
      label: 'social-media',
      query: `"${name}" social media OR linkedin OR twitter`,
      severity: 'info',
    },
  ];
}

// ─── Collector factory ─────────────────────────────────────────────────────

/**
 * Build a collector function from a static query template.
 * The query template uses `{name}` and `{domain}` placeholders.
 */
function makeQueryCollector(
  name: string,
  label: string,
  description: string,
  template: string,
  severity: OrgFinding['severity'],
): CollectorDef {
  return {
    name,
    label,
    description,
    fn: async (org: Organization): Promise<OrgFinding[]> => {
      const query = template
        .replace(/\{name\}/g, org.name)
        .replace(/\{domain\}/g, org.domain);
      const results = webSearch(query, 3);
      return generateFindings(org, { label, query, severity }, results);
    },
  };
}

// ─── ALL_COLLECTORS ────────────────────────────────────────────────────────

/**
 * Every collector that runs once per hourly cycle.
 * Each collector is called once per org — the scheduler iterates
 * orgs inside each collector so we get per-org-per-collector coverage.
 */
export const ALL_COLLECTORS: CollectorDef[] = [
  makeQueryCollector(
    'data-breach',
    'data-breach',
    'Search for data breach mentions involving the org',
    '"{name}" data breach OR leak OR exposed',
    'critical',
  ),
  makeQueryCollector(
    'security-incident',
    'security-incident',
    'Search for security incidents or vulnerabilities',
    '"{name}" security incident OR vulnerability OR hacked',
    'high',
  ),
  makeQueryCollector(
    'github-leaks',
    'github-leaks',
    'Search GitHub for leaked credentials tied to the org domain',
    'site:github.com "{domain}" password OR secret OR key OR token',
    'critical',
  ),
  makeQueryCollector(
    'pastebin',
    'pastebin',
    'Search Pastebin for org domain or name mentions',
    'site:pastebin.com "{domain}" OR "{name}"',
    'high',
  ),
  makeQueryCollector(
    'subdomain',
    'subdomain',
    'Discover subdomains of the org domain',
    'site:*.{domain}',
    'low',
  ),
  makeQueryCollector(
    'social-media',
    'social-media',
    'Search for org social media presence',
    '"{name}" social media OR linkedin OR twitter',
    'info',
  ),
];

// ─── Web Search via SearXNG ────────────────────────────────────────────────

function getSearxngUrl(): string | null {
  return process.env.SEARXNG_URL || null;
}

function webSearch(query: string, maxResults: number = 3): Array<{ title: string; url: string; snippet: string }> {
  const searxngUrl = getSearxngUrl();
  if (!searxngUrl) return [];

  const searchUrl = `${searxngUrl}/search?q=${encodeURIComponent(query)}&format=json&categories=general`;

  try {
    const raw = execFileSync('curl', [
      '-sL',
      '--max-time', '10',
      '-H', 'Accept: application/json',
      searchUrl,
    ], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 15000,
    });

    const data = JSON.parse(raw);
    const results = (data.results || []).slice(0, maxResults);
    return results.map((r: any) => ({
      title: r.title || '(no title)',
      url: r.url || '',
      snippet: (r.content || '').slice(0, 300),
    }));
  } catch {
    return [];
  }
}

// ─── Finding Generation ────────────────────────────────────────────────────

function generateFindings(
  org: Organization,
  query: OsintQuery,
  results: Array<{ title: string; url: string; snippet: string }>,
): OrgFinding[] {
  const findings: OrgFinding[] = [];

  for (const result of results) {
    const finding = createOrgFinding({
      orgId: org.id,
      orgName: org.name,
      title: `[${query.label}] ${result.title.slice(0, 120)}`,
      description: result.snippet || `Search result for ${query.label} on ${org.name}`,
      severity: query.severity,
      source: query.label,
      url: result.url || undefined,
    });
    findings.push(finding);
  }

  return findings;
}

// ─── Main Scan Function ────────────────────────────────────────────────────

/**
 * Scan a single organization for OSINT findings.
 *
 * Runs a set of pre-defined search queries against SearXNG and creates
 * OrgFinding records for each result. Findings are created with triageStatus
 * = null so they remain invisible until triaged.
 *
 * Returns a ScanResult summarising what was found.
 */
export async function scanOrganization(org: Organization): Promise<ScanResult> {
  const startedAt = Date.now();
  const errors: string[] = [];
  const allFindings: OrgFinding[] = [];

  const queries = buildQueries(org);

  for (const q of queries) {
    try {
      const results = webSearch(q.query, 3);
      if (results.length > 0) {
        const findings = generateFindings(org, q, results);
        allFindings.push(...findings);
      }
      // Small delay between queries to be polite to the search engine
      await new Promise(r => setTimeout(r, 500));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`[${q.label}] ${msg}`);
    }
  }

  const durationMs = Date.now() - startedAt;

  return {
    orgId: org.id,
    orgName: org.name,
    findings: allFindings,
    durationMs,
    errors,
  };
}
