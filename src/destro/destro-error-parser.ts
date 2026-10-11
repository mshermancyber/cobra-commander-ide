// forked from core/error-parser.ts @ 2026-07-04 — DOWNSTREAM fork, do not backport to core

export interface ParsedError {
  file: string;
  line: number;
  column?: number;
  code?: string;
  message: string;
  severity: 'error' | 'warning';
}

// Parse TypeScript compiler errors: "src/foo.ts(12,5): error TS2345: ..."
export function parseDestroTscErrors(output: string): ParsedError[] {
  const errors: ParsedError[] = [];
  const pattern = /^(.+?)\((\d+),(\d+)\):\s*(error|warning)\s+(TS\d+):\s*(.+)$/gm;
  let match;
  while ((match = pattern.exec(output)) !== null) {
    errors.push({
      file: match[1],
      line: parseInt(match[2]),
      column: parseInt(match[3]),
      code: match[5],
      message: match[6],
      severity: match[4] as 'error' | 'warning',
    });
  }
  return errors;
}

// Parse ESLint errors: "/path/file.ts:12:5: error message (rule-name)"
export function parseDestroEslintErrors(output: string): ParsedError[] {
  const errors: ParsedError[] = [];
  const pattern = /^\s*(\d+):(\d+)\s+(error|warning)\s+(.+?)\s+(\S+)$/gm;
  let match;
  while ((match = pattern.exec(output)) !== null) {
    errors.push({
      file: '',
      line: parseInt(match[1]),
      column: parseInt(match[2]),
      code: match[5],
      message: match[4],
      severity: match[3] as 'error' | 'warning',
    });
  }
  return errors;
}

// Parse Jest/Vitest/Node test runner errors
export function parseDestroTestErrors(output: string): ParsedError[] {
  const errors: ParsedError[] = [];
  // "at Object.<anonymous> (src/foo.ts:12:5)"
  const pattern = /at\s+\S+\s+\((.+?):(\d+):(\d+)\)/g;
  let match;
  while ((match = pattern.exec(output)) !== null) {
    errors.push({
      file: match[1],
      line: parseInt(match[2]),
      column: parseInt(match[3]),
      message: 'Test failure at this location',
      severity: 'error',
    });
  }
  return errors;
}

// Parse container-specific errors from docker/journalctl output
export function parseContainerErrors(output: string): ParsedError[] {
  const errors: ParsedError[] = [];

  const patterns: Array<{ pattern: RegExp; message: string }> = [
    { pattern: /ImagePullBackOff/i, message: 'Container image pull backoff — registry unreachable or image missing' },
    { pattern: /ErrImagePull/i, message: 'Container image pull error — check image name and registry auth' },
    { pattern: /CrashLoopBackOff/i, message: 'Container crash loop backoff — process exits immediately after start' },
    { pattern: /OOMKilled/i, message: 'Container killed — out of memory (OOM)' },
    { pattern: /exit code 137/i, message: 'Container exited with code 137 — likely OOM killed by kernel' },
    { pattern: /port already (allocated|in use)/i, message: 'Port conflict — bind address already in use' },
    { pattern: /bind.*address.*(already )?in use/i, message: 'Bind address conflict — port occupied by another process' },
    { pattern: /health check failed/i, message: 'Container health check failed — service not responding' },
  ];

  const lines = output.split('\n');
  for (let i = 0; i < lines.length; i++) {
    for (const { pattern, message } of patterns) {
      if (pattern.test(lines[i])) {
        errors.push({
          file: '',
          line: i + 1,
          message,
          severity: 'error',
        });
      }
    }
  }

  return errors;
}

// Parse generic "file:line: message" patterns
export function parseDestroGenericErrors(output: string): ParsedError[] {
  const errors: ParsedError[] = [];
  const pattern = /^(.+?\.\w+):(\d+)(?::(\d+))?:\s*(.+)$/gm;
  let match;
  while ((match = pattern.exec(output)) !== null) {
    errors.push({
      file: match[1],
      line: parseInt(match[2]),
      column: match[3] ? parseInt(match[3]) : undefined,
      message: match[4],
      severity: 'error',
    });
  }
  return errors;
}

// Auto-detect error format and parse (includes container errors)
export function parseDestroErrors(output: string): ParsedError[] {
  let errors = parseDestroTscErrors(output);
  if (errors.length > 0) return errors;
  errors = parseDestroEslintErrors(output);
  if (errors.length > 0) return errors;
  errors = parseDestroTestErrors(output);
  if (errors.length > 0) return errors;
  errors = parseContainerErrors(output);
  if (errors.length > 0) return errors;
  return parseDestroGenericErrors(output);
}

// Build a targeted fix prompt from parsed errors
export function buildDestroFixPrompt(errors: ParsedError[], originalTask: string): string {
  if (errors.length === 0) return originalTask;

  const errorSummary = errors.slice(0, 10).map(e => {
    const loc = e.column ? `${e.file}:${e.line}:${e.column}` : `${e.file}:${e.line}`;
    return `- ${loc}: ${e.code ? `[${e.code}] ` : ''}${e.message}`;
  }).join('\n');

  const filesAffected = [...new Set(errors.map(e => e.file).filter(Boolean))];

  return `The previous attempt failed with ${errors.length} error(s). Fix these specific errors:\n\n${errorSummary}\n\nFiles to fix: ${filesAffected.join(', ')}\n\nOriginal task: ${originalTask}\n\nFocus ONLY on fixing these errors. Do not refactor or change unrelated code.`;
}
