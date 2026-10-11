import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { detectFormatter } from './formatter-detect.js';

/**
 * Parsed hunk from a unified diff.
 */
interface UnifiedHunk {
  /** Line number in the original file (from @@ header) */
  oldStart: number;
  /** Number of lines in the original file section */
  oldCount: number;
  /** Line number in the new file (from @@ header) */
  newStart: number;
  /** Number of lines in the new file section */
  newCount: number;
  /** Context header line text */
  context: string;
  /** Individual lines from the hunk (with leading ' ', '-', '+') */
  lines: string[];
}

/**
 * Result of applying a unified diff patch.
 */
export interface ApplyUnifiedDiffResult {
  success: boolean;
  error?: string;
  newContent?: string;
}

/**
 * Parse a unified diff text and extract hunks targeted at a specific file path.
 * Handles the standard @@ -line,count +line,count @@ format.
 */
function parseHunks(diffText: string, targetPath: string): UnifiedHunk[] {
  const hunks: UnifiedHunk[] = [];
  const lines = diffText.split('\n');
  let currentHunk: UnifiedHunk | null = null;
  let inTargetFile = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Detect file header lines: --- a/path and +++ b/path
    if (line.startsWith('--- ') || line.startsWith('+++ ')) {
      const filePath = line.slice(4).trim();
      // Strip leading a/ or b/ prefix
      const cleanPath = filePath.replace(/^[ab]\//, '');
      if (cleanPath.startsWith(targetPath) || targetPath.endsWith(cleanPath)) {
        inTargetFile = true;
      }
      continue;
    }

    // A header line for a different file resets the tracking
    if (line.startsWith('diff --git ') || line.startsWith('Index: ')) {
      inTargetFile = false;
      currentHunk = null;
      continue;
    }

    // Parse hunk header: @@ -oldStart,oldCount +newStart,newCount @@ context
    const hunkMatch = line.match(
      /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@(.*)/,
    );
    if (hunkMatch) {
      if (inTargetFile) {
        currentHunk = {
          oldStart: parseInt(hunkMatch[1], 10),
          oldCount: hunkMatch[2] !== undefined ? parseInt(hunkMatch[2], 10) : 1,
          newStart: parseInt(hunkMatch[3], 10),
          newCount: hunkMatch[4] !== undefined ? parseInt(hunkMatch[4], 10) : 1,
          context: hunkMatch[5].trim(),
          lines: [],
        };
        hunks.push(currentHunk);
      } else {
        currentHunk = null;
      }
      continue;
    }

    // Collect hunk lines if we're inside a hunk
    if (currentHunk && inTargetFile) {
      if (
        line.startsWith(' ') ||
        line.startsWith('-') ||
        line.startsWith('+') ||
        (currentHunk.lines.length > 0 && line.startsWith('\\')) || // \ No newline
        line === ''
      ) {
        currentHunk.lines.push(line);
      } else if (line.startsWith('diff ') || line.startsWith('@@')) {
        // Next hunk or diff, stop current
        currentHunk = null;
      }
    }
  }

  return hunks;
}

/**
 * Apply a single hunk to an array of file lines.
 * Returns the new lines array and the new offset, or throws on failure.
 */
function applyHunk(
  originalLines: string[],
  hunk: UnifiedHunk,
  currentOffset: number,
): { lines: string[]; newOffset: number } {
  // Find the matching location in the original file
  const hunkLines = hunk.lines;
  const contextLines: string[] = [];
  const deletionLines: string[] = [];
  const additionLines: string[] = [];

  for (const hl of hunkLines) {
    if (hl.startsWith(' ')) {
      contextLines.push(hl.slice(1));
    } else if (hl.startsWith('-')) {
      deletionLines.push(hl.slice(1));
    } else if (hl.startsWith('+')) {
      additionLines.push(hl.slice(1));
    }
    // Skip empty lines and \ No newline markers
  }

  // Build the search pattern: context lines interspersed with deletion lines
  const searchPattern: string[] = [];
  for (const hl of hunkLines) {
    if (hl.startsWith(' ') || hl.startsWith('-')) {
      searchPattern.push(hl.slice(1));
    }
  }

  // Build the replacement lines: context lines interspersed with addition lines
  const replacement: string[] = [];
  for (const hl of hunkLines) {
    if (hl.startsWith(' ') || hl.startsWith('+')) {
      replacement.push(hl.slice(1));
    }
  }

  // Search for the pattern starting from offset
  const targetLine = hunk.oldStart - 1 + currentOffset; // 0-based
  const matchStart = findMatch(originalLines, searchPattern, targetLine);

  if (matchStart === -1) {
    throw new Error(
      `Hunk failed to apply at line ${hunk.oldStart}: context mismatch`,
    );
  }

  // Apply the replacement
  const result = [...originalLines];
  const deleteLen = searchPattern.length;
  result.splice(matchStart, deleteLen, ...replacement);

  const newOffset =
    currentOffset + (replacement.length - searchPattern.length);

  return { lines: result, newOffset };
}

/**
 * Find the search pattern in the original lines starting from a target index.
 * Returns the line index of the match, or -1 if not found.
 */
function findMatch(
  originalLines: string[],
  pattern: string[],
  startIndex: number,
): number {
  if (pattern.length === 0) return startIndex;

  // Try exact match first, with some fuzziness around start position
  const searchRadius = 20;
  const minSearch = Math.max(0, startIndex - searchRadius);
  const maxSearch = Math.min(originalLines.length - pattern.length, startIndex + searchRadius);

  for (let i = minSearch; i <= maxSearch; i++) {
    let matches = true;
    for (let j = 0; j < pattern.length; j++) {
      const orig = (originalLines[i + j] ?? '').trimEnd();
      const pat = (pattern[j] ?? '').trimEnd();
      if (orig !== pat) {
        matches = false;
        break;
      }
    }
    if (matches) return i;
  }

  // Try broader search
  for (let i = 0; i <= originalLines.length - pattern.length; i++) {
    let matches = true;
    for (let j = 0; j < pattern.length; j++) {
      if ((originalLines[i + j] ?? '').trimEnd() !== (pattern[j] ?? '').trimEnd()) {
        matches = false;
        break;
      }
    }
    if (matches) return i;
  }

  return -1;
}

/**
 * Apply a unified diff to a file.
 *
 * Parses the diff text for hunks targeting the specified file, applies them
 * sequentially with line offset tracking, and writes the result atomically.
 * If any hunk fails to apply, the file is not modified.
 *
 * @param filePath - Path to the file to patch
 * @param diffText - Unified diff text
 * @param workDir - Working directory (for auto-format after apply)
 * @returns Result indicating success or failure
 */
export function applyUnifiedDiff(
  filePath: string,
  diffText: string,
  workDir?: string,
): ApplyUnifiedDiffResult {
  if (!existsSync(filePath)) {
    return { success: false, error: `File not found: ${filePath}` };
  }

  const originalContent = readFileSync(filePath, 'utf-8');
  const hunks = parseHunks(diffText, filePath);

  if (hunks.length === 0) {
    return {
      success: false,
      error: 'No applicable hunks found in the diff for this file',
    };
  }

  // Try to apply all hunks to a copy of the content
  let lines = originalContent.split('\n');
  let totalOffset = 0;

  try {
    for (const hunk of hunks) {
      const result = applyHunk(lines, hunk, totalOffset);
      lines = result.lines;
      totalOffset = result.newOffset;
    }
  } catch (err) {
    return {
      success: false,
      error: (err as Error).message,
    };
  }

  const newContent = lines.join('\n');

  // Write the modified file
  try {
    writeFileSync(filePath, newContent, 'utf-8');
  } catch (err) {
    return {
      success: false,
      error: `Failed to write file: ${(err as Error).message}`,
    };
  }

  // Auto-format if workDir is provided
  if (workDir) {
    try {
      const formatter = detectFormatter(workDir);
      if (formatter) {
        execSync(`${formatter.command} ${formatter.args.join(' ')} "${filePath}"`, {
          cwd: workDir,
          stdio: 'pipe',
          timeout: 10000,
        });
      }
    } catch {
      // Formatting failure is non-fatal
    }
  }

  return { success: true, newContent };
}
