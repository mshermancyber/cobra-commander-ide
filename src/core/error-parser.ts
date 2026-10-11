export interface ParsedError {
  file: string;
  line: number;
  column?: number;
  code?: string;
  message: string;
  severity: 'error' | 'warning';
}

// Parse TypeScript compiler errors: "src/foo.ts(12,5): error TS2345: ..."
export function parseTscErrors(output: string): ParsedError[] {
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
export function parseEslintErrors(output: string): ParsedError[] {
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
export function parseTestErrors(output: string): ParsedError[] {
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

// Parse generic "file:line: message" patterns
export function parseGenericErrors(output: string): ParsedError[] {
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

// Auto-detect error format and parse
export function parseErrors(output: string): ParsedError[] {
  let errors = parseTscErrors(output);
  if (errors.length > 0) return errors;
  errors = parseEslintErrors(output);
  if (errors.length > 0) return errors;
  errors = parseTestErrors(output);
  if (errors.length > 0) return errors;
  return parseGenericErrors(output);
}

// Build a targeted fix prompt from parsed errors
export function buildFixPrompt(errors: ParsedError[], originalTask: string): string {
  if (errors.length === 0) return originalTask;

  const errorSummary = errors.slice(0, 10).map(e => {
    const loc = e.column ? `${e.file}:${e.line}:${e.column}` : `${e.file}:${e.line}`;
    return `- ${loc}: ${e.code ? `[${e.code}] ` : ''}${e.message}`;
  }).join('\n');

  const filesAffected = [...new Set(errors.map(e => e.file).filter(Boolean))];

  return `The previous attempt failed with ${errors.length} error(s). Fix these specific errors:

${errorSummary}

Files to fix: ${filesAffected.join(', ')}

Original task: ${originalTask}

Focus ONLY on fixing these errors. Do not refactor or change unrelated code.`;
}
