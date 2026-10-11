// Destro agent — re-drive-the-failing-flow verification (§16.5).
// Created 2026-07-04.
//
// Used by the self-correct loop: after Destro makes a fix, run verify;
// if worse → auto-revert → re-diagnose.

import { executeDestroShell } from './destro-shell.js';

// ──────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────

/** Specification for an HTTP request to replay. */
export interface HttpRequestSpec {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
  timeout?: number;
}

/** A single metric data point captured at a point in time. */
export interface Baseline {
  metric: string;
  value: number | string;
  timestamp: number;
}

/** The outcome of a verification step. */
export interface VerifyResult {
  /** The fix improved the situation. */
  better: boolean;
  /** The fix made things worse. */
  worse: boolean;
  /** No meaningful change detected. */
  same: boolean;
  /** The captured baseline (before fix). */
  baseline: Baseline;
  /** The captured current state (after fix). */
  current: Baseline;
  /** Human-readable summary of the comparison. */
  summary: string;
}

// ──────────────────────────────────────────────
// Capture
// ──────────────────────────────────────────────

/**
 * Capture a baseline from a raw result object.
 *
 * Automatically extracts the most informative metric:
 * - For HTTP results: uses status code as the metric value
 * - For shell results: uses exit code as the metric value (0 = success)
 */
export function captureBaseline(result: {
  exitCode?: number;
  status?: number;
  stdout?: string;
  error?: string;
}): Baseline {
  const timestamp = Date.now();

  if (result.status !== undefined) {
    return {
      metric: 'http-status',
      value: result.status,
      timestamp,
    };
  }

  if (result.exitCode !== undefined) {
    return {
      metric: 'exit-code',
      value: result.exitCode,
      timestamp,
    };
  }

  // Fallback: use error presence
  if (result.error) {
    return {
      metric: 'error',
      value: result.error.slice(0, 200),
      timestamp,
    };
  }

  return {
    metric: 'unknown',
    value: 'no-metric',
    timestamp,
  };
}

// ──────────────────────────────────────────────
// Comparison
// ──────────────────────────────────────────────

/**
 * Compare a baseline with a current measurement and determine whether
 * things got better, worse, or stayed the same.
 *
 * Comparison logic:
 * - **HTTP status codes**: 2xx is "good", non-2xx is "bad". A move from
 *   non-2xx → 2xx is better; 2xx → non-2xx is worse.
 * - **Exit codes**: 0 is "good", non-zero is "bad". A move from non-zero → 0
 *   is better; 0 → non-zero is worse.
 * - **Other metrics**: simple string comparison. Different = indeterminate
 *   (treated as "same" with a note).
 */
export function compareResults(
  baseline: Baseline,
  current: Baseline,
): 'better' | 'worse' | 'same' {
  // Both are HTTP status codes
  if (baseline.metric === 'http-status' && current.metric === 'http-status') {
    const baseCode = typeof baseline.value === 'string'
      ? parseInt(baseline.value, 10)
      : baseline.value;
    const currCode = typeof current.value === 'string'
      ? parseInt(current.value, 10)
      : current.value;

    if (typeof baseCode !== 'number' || typeof currCode !== 'number') {
      return 'same';
    }

    const baseGood = baseCode >= 200 && baseCode < 300;
    const currGood = currCode >= 200 && currCode < 300;

    if (!baseGood && currGood) return 'better';
    if (baseGood && !currGood) return 'worse';
    return 'same';
  }

  // Both are exit codes
  if (baseline.metric === 'exit-code' && current.metric === 'exit-code') {
    const baseExit = typeof baseline.value === 'string'
      ? parseInt(baseline.value, 10)
      : baseline.value;
    const currExit = typeof current.value === 'string'
      ? parseInt(current.value, 10)
      : current.value;

    if (typeof baseExit !== 'number' || typeof currExit !== 'number') {
      return 'same';
    }

    const baseGood = baseExit === 0;
    const currGood = currExit === 0;

    if (!baseGood && currGood) return 'better';
    if (baseGood && !currGood) return 'worse';
    return 'same';
  }

  // Different metric types — can't meaningfully compare
  if (baseline.metric !== current.metric) {
    return 'same';
  }

  // Same metric type, compare values directly
  if (baseline.value === current.value) return 'same';

  // For numeric values on the same metric, lower is typically better for error counts
  const baseNum = typeof baseline.value === 'string'
    ? parseFloat(baseline.value)
    : baseline.value;
  const currNum = typeof current.value === 'string'
    ? parseFloat(current.value)
    : current.value;

  if (typeof baseNum === 'number' && typeof currNum === 'number' && !isNaN(baseNum) && !isNaN(currNum)) {
    // For error-type metrics, lower is better
    if (baseline.metric === 'error' || baseline.metric.startsWith('error')) {
      if (currNum < baseNum) return 'better';
      if (currNum > baseNum) return 'worse';
      return 'same';
    }
    // Default: lower is better
    if (currNum < baseNum) return 'better';
    if (currNum > baseNum) return 'worse';
  }

  return 'same';
}

// ──────────────────────────────────────────────
// HTTP Replay
// ──────────────────────────────────────────────

/**
 * Replay an HTTP request and capture the result for comparison.
 *
 * @param requestSpec - The HTTP request to replay
 * @returns VerifyResult with better/worse/same determination
 */
export async function replayHttp(
  requestSpec: HttpRequestSpec,
): Promise<VerifyResult> {
  const startTime = Date.now();
  const timeoutMs = requestSpec.timeout || 10_000;

  const baseline: Baseline = {
    metric: 'http-status',
    value: 0,
    timestamp: startTime,
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let status = 0;
  let bodyPreview = '';
  let errorMessage: string | undefined;
  let timing = 0;

  try {
    const resp = await fetch(requestSpec.url, {
      method: requestSpec.method,
      headers: requestSpec.headers,
      body: requestSpec.body || undefined,
      signal: controller.signal,
    });

    clearTimeout(timer);
    status = resp.status;
    timing = Date.now() - startTime;

    try {
      const text = await resp.text();
      bodyPreview = text.slice(0, 500);
    } catch {
      bodyPreview = '(body unreadable)';
    }
  } catch (err: unknown) {
    clearTimeout(timer);
    const isTimeout = (err as Error).name === 'AbortError';
    errorMessage = isTimeout
      ? `Request timed out after ${timeoutMs}ms`
      : (err as Error).message;
    timing = Date.now() - startTime;
    status = 0;
  }

  const current: Baseline = {
    metric: 'http-status',
    value: status,
    timestamp: Date.now(),
  };

  const comparison = compareResults(baseline, current);

  const summaryParts: string[] = [];
  summaryParts.push(`HTTP ${requestSpec.method} ${requestSpec.url}`);
  if (errorMessage) {
    summaryParts.push(`Error: ${errorMessage}`);
  } else {
    summaryParts.push(`Status: ${status}, Time: ${timing}ms`);
    if (bodyPreview) {
      summaryParts.push(`Body preview: ${bodyPreview.slice(0, 200)}`);
    }
  }
  summaryParts.push(`Result: ${comparison}`);

  return {
    better: comparison === 'better',
    worse: comparison === 'worse',
    same: comparison === 'same',
    baseline,
    current,
    summary: summaryParts.join(' | '),
  };
}

// ──────────────────────────────────────────────
// Shell Command Check
// ──────────────────────────────────────────────

/**
 * Run a shell command as a verification check.
 *
 * Uses `executeDestroShell` from destro-shell.js for safety enforcement
 * (blocked patterns, permission checks, path bounds).
 *
 * @param command - Shell command to execute
 * @param cwd     - Working directory for the command
 * @returns VerifyResult with better/worse/same determination
 */
export async function runCheck(
  command: string,
  cwd: string,
): Promise<VerifyResult> {
  const startTime = Date.now();

  const baseline: Baseline = {
    metric: 'exit-code',
    value: 1, // Assume failure before check
    timestamp: startTime,
  };

  let exitCode = 1;
  let stdout = '';
  let stderr = '';

  try {
    const { result, is_error } = await executeDestroShell(
      { command },
      cwd,
    );

    stdout = result;
    exitCode = is_error ? 1 : 0;

    // Try to extract actual exit code from the result string
    const exitMatch = result.match(/^Exit code (\d+)/m);
    if (exitMatch) {
      exitCode = parseInt(exitMatch[1], 10);
    }
    if (result.startsWith('Error:')) {
      stderr = result;
      exitCode = exitCode === 0 ? 1 : exitCode;
    }
  } catch (err: unknown) {
    stderr = (err as Error).message || 'unknown error';
    exitCode = 1;
  }

  const current: Baseline = {
    metric: 'exit-code',
    value: exitCode,
    timestamp: Date.now(),
  };

  const comparison = compareResults(baseline, current);

  const summaryParts: string[] = [];
  summaryParts.push(`Command: ${command.slice(0, 120)}`);
  summaryParts.push(`Exit code: ${exitCode}`);
  if (stdout && stdout.length > 0) {
    summaryParts.push(`Stdout: ${stdout.slice(0, 200)}`);
  }
  if (stderr && stderr.length > 0) {
    summaryParts.push(`Stderr: ${stderr.slice(0, 200)}`);
  }
  summaryParts.push(`Result: ${comparison}`);

  return {
    better: comparison === 'better',
    worse: comparison === 'worse',
    same: comparison === 'same',
    baseline,
    current,
    summary: summaryParts.join(' | '),
  };
}
