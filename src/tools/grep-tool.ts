import { execFileSync } from 'node:child_process';
import type { ToolDefinition } from '../core/types.js';
import { truncateToolOutput } from '../core/tool-output-truncation.js';
import { shouldIgnore } from '../core/ignore-patterns.js';

export const grepTool: ToolDefinition = {
  name: 'grep_files',
  description: 'Search files by regex pattern. Returns filepath:line_number:matching_line.',
  input_schema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Regex pattern to search for' },
      path: { type: 'string', description: 'Directory or file to search within, relative to project root. Default "."' },
      include: { type: 'string', description: 'Glob for file extensions to include, e.g. "*.ts"' },
      max_results: { type: 'number', description: 'Max matches to return, default 50' },
    },
    required: ['pattern'],
  },
};

const EXCLUDE_DIRS = ['node_modules', '.git', 'dist', 'build'];

export function executeGrepTool(
  input: Record<string, unknown>, workDir: string,
): { result: string; is_error: boolean } {
  const pattern = input.pattern as string;
  const searchPath = (input.path as string) || '.';
  const include = input.include as string | undefined;
  const maxResults = (input.max_results as number) || 50;

  // Build the grep arguments array (no shell interpretation)
  const args: string[] = ['-rn'];

  // Add include filter if provided
  if (include) {
    args.push(`--include=${include}`);
  }

  // Exclude common directories
  for (const dir of EXCLUDE_DIRS) {
    args.push(`--exclude-dir=${dir}`);
  }

  args.push('--');
  args.push(pattern);
  args.push(searchPath);

  try {
    const output = execFileSync('grep', args, {
      cwd: workDir,
      timeout: 30_000,
      maxBuffer: 10 * 1024 * 1024,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const lines = output.trim().split('\n').filter(Boolean);
    const filtered = lines.filter(line => {
      const filePath = line.split(':')[0];
      return !shouldIgnore(filePath);
    });

    if (filtered.length === 0) {
      return { result: 'No matches found', is_error: false };
    }

    const limited = filtered.slice(0, maxResults);
    let result = limited.join('\n');

    if (filtered.length > maxResults) {
      result += `\n... (${filtered.length - maxResults} more matches not shown)`;
    }

    const truncated = truncateToolOutput(result);
    return { result: truncated.text, is_error: false };
  } catch (err: unknown) {
    const e = err as { stderr?: string; stdout?: string; message?: string; status?: number };

    // grep returns exit code 1 when no matches found
    if (e.status === 1) {
      return { result: 'No matches found', is_error: false };
    }

    const output = [e.stdout, e.stderr, e.message].filter(Boolean).join('\n');
    const truncated = truncateToolOutput(output, 2000, 20000);
    return { result: `Error: ${truncated.text || 'grep failed'}`, is_error: true };
  }
}
