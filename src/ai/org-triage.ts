import type { OrgFinding, TriageStatus } from '../models/org-finding.js';
import {
  listPendingFindings,
  updateFindingTriage,
} from '../models/org-finding.js';

// ─── Types ─────────────────────────────────────────────────────────────────

export interface TriageResult {
  findingId: string;
  status: TriageStatus;
  notes: string;
}

export interface BatchTriageResult {
  orgId?: string;
  totalTriaged: number;
  results: TriageResult[];
  errors: string[];
}

// ─── Keyword-based Classification ──────────────────────────────────────────

const NOISE_PATTERNS = [
  /sponsored/i,
  /advertisement/i,
  /click here/i,
  /buy now/i,
  /sign up/i,
  /newsletter/i,
  /subscribe/i,
  /job posting/i,
  /careers/i,
  /hiring/i,
  /press release/i,
  /stock (price|quote|ticker)/i,
];

const FALSE_POSITIVE_PATTERNS = [
  /unrelated company/i,
  /different organization/i,
  /similarly named/i,
  /not affiliated/i,
  /trademark dispute/i,
];

const CONFIRMED_PATTERNS = [
  /data breach/i,
  /vulnerability/i,
  /CVE-\d{4}-\d{4,}/i,
  /exploit/i,
  /exposed (database|api|credentials|keys?|tokens?|secrets?)/i,
  /ransomware/i,
  /hacked/i,
  /incident response/i,
  /security advisory/i,
  /leaked (credentials?|data|database|password)/i,
  /github.*(?:password|secret|key|token|credential)/i,
  /pastebin.*(?:password|email|leak)/i,
];

/**
 * Classify a single finding based on keyword analysis of title + description.
 */
function classifyFinding(finding: OrgFinding): { status: TriageStatus; notes: string } {
  const text = `${finding.title} ${finding.description}`;

  // Check confirmed patterns first
  for (const pattern of CONFIRMED_PATTERNS) {
    if (pattern.test(text)) {
      return {
        status: 'confirmed',
        notes: `Auto-classified as confirmed: matched pattern "${pattern.source}"`,
      };
    }
  }

  // Check false positive patterns
  for (const pattern of FALSE_POSITIVE_PATTERNS) {
    if (pattern.test(text)) {
      return {
        status: 'false_positive',
        notes: `Auto-classified as false positive: matched pattern "${pattern.source}"`,
      };
    }
  }

  // Check noise patterns
  for (const pattern of NOISE_PATTERNS) {
    if (pattern.test(text)) {
      return {
        status: 'noise',
        notes: `Auto-classified as noise: matched pattern "${pattern.source}"`,
      };
    }
  }

  // Check for duplicate-like content
  if (finding.source === 'social-media' && finding.severity === 'info') {
    return {
      status: 'stale',
      notes: 'Low-value social media result auto-marked as stale',
    };
  }

  // Default: confirm generic findings with low confidence
  return {
    status: 'confirmed',
    notes: 'Auto-classified as confirmed: no exclusion patterns matched',
  };
}

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Triage a single org finding.
 *
 * Analyses the finding's title and description, classifies it using keyword
 * heuristics, and updates the triage status in the store.
 */
export function triageOrgFinding(finding: OrgFinding): TriageResult {
  const { status, notes } = classifyFinding(finding);
  updateFindingTriage(finding.id, status, notes);
  return { findingId: finding.id, status, notes };
}

/**
 * Batch-triage all untriaged findings, optionally filtered by org.
 *
 * Scans the findings store for any records where triageStatus IS NULL or
 * triageStatus = 'pending', classifies each one, and persists the results.
 *
 * This is called automatically after each org scan completes so that
 * findings never appear in API responses before they have been triaged.
 */
export function batchTriageUntriaged(orgId?: string): BatchTriageResult {
  const pending = listPendingFindings(orgId);
  const results: TriageResult[] = [];
  const errors: string[] = [];

  for (const finding of pending) {
    try {
      const result = triageOrgFinding(finding);
      results.push(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`Failed to triage finding ${finding.id}: ${msg}`);
    }
  }

  return {
    orgId,
    totalTriaged: results.length,
    results,
    errors,
  };
}
