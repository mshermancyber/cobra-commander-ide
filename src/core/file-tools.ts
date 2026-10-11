import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { stripBom, preserveBom } from './bom.js';
import { detectFormatter } from './formatter-detect.js';
import { execSync } from 'node:child_process';

/**
 * Write a file while preserving BOM if the file already had one.
 * If the file does not exist yet, no BOM is added.
 *
 * @param filePath - Absolute or relative path to the file
 * @param content - The new content to write
 */
export function writeBomAware(filePath: string, content: string): void {
  let existing = '';
  try {
    existing = readFileSync(filePath, 'utf-8');
  } catch {
    // File doesn't exist yet — write as-is
  }
  const final = existing ? preserveBom(existing, content) : stripBom(content);
  writeFileSync(filePath, final);
}

/**
 * Run the project's detected formatter on a given file.
 * Skips if no formatter is configured.
 *
 * @param filePath - Path to the file to format
 * @param workDir - Working directory used to detect the formatter
 */
export function autoFormat(filePath: string, workDir: string): void {
  const formatter = detectFormatter(workDir);
  if (!formatter) return;

  const absPath = resolve(workDir, filePath);
  try {
    execSync(
      [formatter.command, ...formatter.args, absPath].join(' '),
      { cwd: workDir, timeout: 15_000, stdio: 'pipe' },
    );
  } catch {
    // Formatting is best-effort — never fail the write because of it
  }
}
