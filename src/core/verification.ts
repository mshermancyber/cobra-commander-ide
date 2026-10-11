import { execSync } from 'node:child_process';

export interface VerificationError {
  file: string;
  line: number;
  column?: number;
  message: string;
  code?: string;
  source: 'typescript' | 'eslint' | 'test' | 'runtime';
}

export interface VerificationResult {
  passed: boolean;
  errors: VerificationError[];
  summary: string;
  fixInstructions?: string;
}

/**
 * Parse TypeScript compiler output.
 * Format: file.ts(line,col): error TSxxxx: message
 */
function parseTypeScriptErrors(output: string): VerificationError[] {
  const errors: VerificationError[] = [];
  // Standard TS error format: file.ts(line,col): error TS2345: message
  const tsErrorRegex = /([\w./\\-]+\.(?:ts|tsx|js|jsx|mjs))\((\d+),(\d+)\):\s*(error)\s+(TS\d+)\s*:\s*(.+)/g;
  let match: RegExpExecArray | null;
  while ((match = tsErrorRegex.exec(output)) !== null) {
    errors.push({
      file: match[1],
      line: parseInt(match[2], 10),
      column: parseInt(match[3], 10),
      message: match[6].trim(),
      code: match[5],
      source: 'typescript',
    });
  }

  // Also match simpler format: file.ts:line:col - error TSxxxx
  const tsErrorRegex2 = /([\w./\\-]+\.(?:ts|tsx|js|jsx|mjs)):(\d+):(\d+)\s*-\s*(error)\s+(TS\d+)\s*:\s*(.+)/g;
  while ((match = tsErrorRegex2.exec(output)) !== null) {
    const m = match;
    const dup = errors.some(e => e.file === m[1] && e.line === parseInt(m[2], 10) && e.code === m[5]);
    if (!dup) {
      errors.push({
        file: m[1],
        line: parseInt(m[2], 10),
        column: parseInt(m[3], 10),
        message: m[6].trim(),
        code: m[5],
        source: 'typescript',
      });
    }
  }

  return errors;
}

/**
 * Parse ESLint output.
 * Format: file.ts:line:col: error/warning message (rule)
 */
function parseEslintErrors(output: string): VerificationError[] {
  const errors: VerificationError[] = [];
  // ESLint format: file.ts:line:col: error/warning message [rule]
  const eslintRegex = /([\w./\\-]+\.(?:ts|tsx|js|jsx|mjs|vue|svelte)):(\d+):(\d+):\s*(error|warning)\s+(.+?)(?:\s+\(([^)]+)\))?\s*$/gm;
  let match: RegExpExecArray | null;
  while ((match = eslintRegex.exec(output)) !== null) {
    errors.push({
      file: match[1],
      line: parseInt(match[2], 10),
      column: parseInt(match[3], 10),
      message: match[5].trim(),
      code: match[6] || undefined,
      source: 'eslint',
    });
  }
  return errors;
}

/**
 * Parse test runner output (Jest, Vitest, etc.).
 */
function parseTestErrors(output: string): VerificationError[] {
  const errors: VerificationError[] = [];

  // Match FAIL file.test.ts
  const failRegex = /FAIL\s+([\w./\\-]+\.(?:test|spec)\.(?:ts|tsx|js|jsx))/g;
  let match: RegExpExecArray | null;
  while ((match = failRegex.exec(output)) !== null) {
    errors.push({
      file: match[1],
      line: 0,
      message: `Test file failed: ${match[1]}`,
      source: 'test',
    });
  }

  // Match test failure details: ● test name
  const testNameRegex = /●\s+(.+)/g;
  while ((match = testNameRegex.exec(output)) !== null) {
    errors.push({
      file: '',
      line: 0,
      message: `Test failure: ${match[1].trim()}`,
      source: 'test',
    });
  }

  // Match "Expected X received Y" patterns
  const expectedReceivedRegex = /Expected:\s*(.+?)\n\s*Received:\s*(.+?)(?:\n|$)/gs;
  while ((match = expectedReceivedRegex.exec(output)) !== null) {
    errors.push({
      file: '',
      line: 0,
      message: `Expected ${match[1].trim()}, received ${match[2].trim()}`,
      source: 'test',
    });
  }

  // Match ✕ test name
  const failSymbolRegex = /✕\s+(.+)/g;
  while ((match = failSymbolRegex.exec(output)) !== null) {
    errors.push({
      file: '',
      line: 0,
      message: `Test failed: ${match[1].trim()}`,
      source: 'test',
    });
  }

  return errors;
}

/**
 * Parse generic runtime errors.
 */
function parseRuntimeErrors(output: string): VerificationError[] {
  const errors: VerificationError[] = [];

  // Match stack trace lines: at function (file.ts:line:col)
  const stackRegex = /at\s+(?:\w+\s+)?\(?([\w./\\-]+\.(?:ts|tsx|js|jsx|mjs)):(\d+):(\d+)\)?/g;
  let match: RegExpExecArray | null;
  while ((match = stackRegex.exec(output)) !== null) {
    errors.push({
      file: match[1],
      line: parseInt(match[2], 10),
      column: parseInt(match[3], 10),
      message: `Runtime error at ${match[1]}:${match[2]}`,
      source: 'runtime',
    });
  }

  // Match Error: message patterns
  const errorMsgRegex = /^(?:Uncaught\s+)?(?:Error|TypeError|ReferenceError|SyntaxError|RangeError):\s*(.+)$/gm;
  while ((match = errorMsgRegex.exec(output)) !== null) {
    errors.push({
      file: '',
      line: 0,
      message: match[1].trim(),
      source: 'runtime',
    });
  }

  return errors;
}

export function parseVerificationOutput(output: string, source: string): VerificationError[] {
  const errors: VerificationError[] = [];

  switch (source) {
    case 'typescript':
      errors.push(...parseTypeScriptErrors(output));
      break;
    case 'eslint':
      errors.push(...parseEslintErrors(output));
      break;
    case 'test':
      errors.push(...parseTestErrors(output));
      break;
    case 'runtime':
      errors.push(...parseRuntimeErrors(output));
      break;
    default:
      // Auto-detect: try all parsers
      errors.push(...parseTypeScriptErrors(output));
      errors.push(...parseEslintErrors(output));
      errors.push(...parseTestErrors(output));
      errors.push(...parseRuntimeErrors(output));
      break;
  }

  return errors;
}

export function formatFixInstructions(errors: VerificationError[]): string {
  if (errors.length === 0) return '';

  const lines: string[] = ['Fix these errors:'];

  for (let i = 0; i < errors.length; i++) {
    const e = errors[i];
    const location = e.file ? `${e.file}:${e.line}` : '';
    const codeStr = e.code ? ` ${e.code}` : '';
    const sourceStr = e.source ? ` [${e.source}]` : '';
    if (location) {
      lines.push(`${i + 1}. ${location} —${codeStr}${sourceStr} ${e.message}`);
    } else {
      lines.push(`${i + 1}.${codeStr}${sourceStr} ${e.message}`);
    }
  }

  lines.push('');
  lines.push('Read each file, understand the error, and fix it.');
  lines.push('After fixing, run the verification command again to confirm all errors are resolved.');

  return lines.join('\n');
}

export function runVerification(
  workDir: string,
  commands: string[],
  timeout: number,
): VerificationResult {
  const allErrors: VerificationError[] = [];
  const outputParts: string[] = [];

  for (const cmd of commands) {
    try {
      execSync(cmd, {
        cwd: workDir,
        timeout: timeout * 1000,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      // Command succeeded
      outputParts.push(`[OK] ${cmd}`);
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string };
      const output = [e.stdout, e.stderr].filter(Boolean).join('\n').trim();
      if (output) {
        outputParts.push(`[FAIL] ${cmd}\n${output.slice(0, 5000)}`);
        // Auto-detect source from command
        let source = 'runtime';
        if (cmd.includes('tsc')) source = 'typescript';
        else if (cmd.includes('eslint') || cmd.includes('lint')) source = 'eslint';
        else if (cmd.includes('test') || cmd.includes('jest') || cmd.includes('vitest')) source = 'test';
        allErrors.push(...parseVerificationOutput(output, source));
      }
    }
  }

  const summary = outputParts.join('\n\n');
  const passed = allErrors.length === 0;

  let fixInstructions: string | undefined;
  if (!passed) {
    fixInstructions = formatFixInstructions(allErrors);
  }

  return {
    passed,
    errors: allErrors,
    summary,
    fixInstructions,
  };
}
