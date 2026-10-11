import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

// ──────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────

export interface AiAction {
  /** Unique action ID */
  id: string;
  /** The file this action modified */
  file: string;
  /** Human-readable description of what the AI did */
  description: string;
  /** The inverse patch that reverses this action */
  inversePatch: string;
  /** The forward patch (the original AI edit) */
  forwardPatch: string;
  /** Content of the file *before* the action */
  beforeContent: string;
  /** Content of the file *after* the action */
  afterContent: string;
  /** Timestamp of when the action occurred */
  timestamp: number;
  /** The session or task ID that triggered this action */
  sessionId?: string;
  /** Whether this action has been undone */
  undone: boolean;
  /** Whether this action has been redone after undo */
  redone: boolean;
}

export interface UndoEntry {
  actionId: string;
  file: string;
  undoneAt: number;
}

export interface RedoEntry {
  actionId: string;
  file: string;
  redoneAt: number;
}

export interface UndoJournal {
  /** Schema version for forward compatibility */
  version: 1;
  /** All recorded actions indexed by file */
  actions: AiAction[];
  /** Stack of undo entries (most recent last) */
  undoStack: UndoEntry[];
  /** Stack of redo entries (most recent last) */
  redoStack: RedoEntry[];
  /** When the journal was last written */
  lastPersisted: number;
}

export interface UndoResult {
  success: boolean;
  undoneActionId?: string;
  file?: string;
  error?: string;
}

export interface RedoResult {
  success: boolean;
  redoneActionId?: string;
  file?: string;
  error?: string;
}

// ──────────────────────────────────────────────
// Undo Stack Manager
// ──────────────────────────────────────────────

const JOURNAL_DIRNAME = '.cobra-commander/history';
const JOURNAL_FILENAME = 'undo-journal.json';
const JOURNAL_VERSION = 1;

export class UndoStackManager {
  private projectRoot: string;
  private journalDir: string;
  private journalPath: string;
  private journal: UndoJournal;

  constructor(projectRoot: string) {
    this.projectRoot = projectRoot;
    this.journalDir = join(projectRoot, JOURNAL_DIRNAME);
    this.journalPath = join(this.journalDir, JOURNAL_FILENAME);
    this.journal = this.loadJournal();
  }

  // ── persistence ──

  private ensureDir(): void {
    if (!existsSync(this.journalDir)) {
      mkdirSync(this.journalDir, { recursive: true });
    }
  }

  private loadJournal(): UndoJournal {
    this.ensureDir();
    try {
      if (existsSync(this.journalPath)) {
        const raw = readFileSync(this.journalPath, 'utf-8');
        const parsed = JSON.parse(raw) as UndoJournal;
        if (parsed.version === JOURNAL_VERSION) {
          return parsed;
        }
      }
    } catch {
      // corrupted journal — start fresh
    }
    return {
      version: JOURNAL_VERSION,
      actions: [],
      undoStack: [],
      redoStack: [],
      lastPersisted: Date.now(),
    };
  }

  /**
   * Persist the journal to disk for crash recovery.
   */
  persist(): void {
    this.ensureDir();
    this.journal.lastPersisted = Date.now();
    const tmpPath = this.journalPath + '.tmp';
    writeFileSync(tmpPath, JSON.stringify(this.journal, null, 2), 'utf-8');
    writeFileSync(this.journalPath, JSON.stringify(this.journal, null, 2), 'utf-8');
    try { unlinkSync(tmpPath); } catch { /* ok */ }
  }

  // ── action recording ──

  /**
   * Record an AI edit action, storing before/after content and generating
   * the inverse patch automatically.
   */
  recordAction(
    file: string,
    description: string,
    beforeContent: string,
    afterContent: string,
    sessionId?: string,
  ): AiAction {
    const forwardPatch = generateUnifiedPatch(file, beforeContent, afterContent);
    const inversePatch = generateUnifiedPatch(file, afterContent, beforeContent);

    const action: AiAction = {
      id: randomUUID(),
      file,
      description,
      inversePatch,
      forwardPatch,
      beforeContent,
      afterContent,
      timestamp: Date.now(),
      sessionId,
      undone: false,
      redone: false,
    };

    this.journal.actions.push(action);
    this.persist();
    return action;
  }

  // ── undo ──

  /**
   * Undo the most recent AI action for a specific file, or the most
   * recent action overall if no file is specified.
   */
  undo(file?: string): UndoResult {
    const candidates = this.journal.actions
      .filter((a) => !a.undone)
      .filter((a) => (file ? a.file === file : true));

    if (candidates.length === 0) {
      return { success: false, error: 'Nothing to undo' };
    }

    const action = candidates[candidates.length - 1];

    try {
      const filePath = join(this.projectRoot, action.file);
      let currentContent: string;
      if (existsSync(filePath)) {
        currentContent = readFileSync(filePath, 'utf-8');
      } else {
        currentContent = '';
      }

      const restored = applyPatch(currentContent, action.inversePatch);
      writeFileSync(filePath, restored, 'utf-8');

      action.undone = true;

      const undoEntry: UndoEntry = {
        actionId: action.id,
        file: action.file,
        undoneAt: Date.now(),
      };
      this.journal.undoStack.push(undoEntry);
      this.journal.redoStack = [];

      this.persist();

      return {
        success: true,
        undoneActionId: action.id,
        file: action.file,
      };
    } catch (err) {
      return {
        success: false,
        error: `Failed to apply inverse patch: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /**
   * Undo the last N AI actions in reverse chronological order.
   */
  undoMultiple(n: number, file?: string): UndoResult[] {
    const results: UndoResult[] = [];
    for (let i = 0; i < n; i++) {
      const result = this.undo(file);
      results.push(result);
      if (!result.success) break;
    }
    return results;
  }

  // ── redo ──

  /**
   * Redo the most recently undone action.
   */
  redo(file?: string): RedoResult {
    const candidates = this.journal.actions
      .filter((a) => a.undone && !a.redone)
      .filter((a) => (file ? a.file === file : true));

    if (candidates.length === 0) {
      return { success: false, error: 'Nothing to redo' };
    }

    const action = candidates[candidates.length - 1];

    try {
      const filePath = join(this.projectRoot, action.file);
      let currentContent: string;
      if (existsSync(filePath)) {
        currentContent = readFileSync(filePath, 'utf-8');
      } else {
        currentContent = '';
      }

      const restored = applyPatch(currentContent, action.forwardPatch);
      writeFileSync(filePath, restored, 'utf-8');

      action.undone = false;
      action.redone = true;

      const redoEntry: RedoEntry = {
        actionId: action.id,
        file: action.file,
        redoneAt: Date.now(),
      };
      this.journal.redoStack.push(redoEntry);

      this.persist();

      return {
        success: true,
        redoneActionId: action.id,
        file: action.file,
      };
    } catch (err) {
      return {
        success: false,
        error: `Failed to apply forward patch: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /**
   * Redo the last N undone actions.
   */
  redoMultiple(n: number, file?: string): RedoResult[] {
    const results: RedoResult[] = [];
    for (let i = 0; i < n; i++) {
      const result = this.redo(file);
      results.push(result);
      if (!result.success) break;
    }
    return results;
  }

  // ── query ──

  /**
   * Get all actions for a specific file.
   */
  getActionsForFile(file: string): AiAction[] {
    return this.journal.actions.filter((a) => a.file === file);
  }

  /**
   * Get the most recent N actions.
   */
  getRecentActions(n: number = 20): AiAction[] {
    return this.journal.actions.slice(-n).reverse();
  }

  /**
   * Get count of undoable actions.
   */
  undoableCount(file?: string): number {
    return this.journal.actions.filter((a) => !a.undone)
      .filter((a) => (file ? a.file === file : true)).length;
  }

  /**
   * Get count of redoable actions.
   */
  redoableCount(file?: string): number {
    return this.journal.actions.filter((a) => a.undone && !a.redone)
      .filter((a) => (file ? a.file === file : true)).length;
  }

  /**
   * Clear all history for a file (or everything).
   */
  clearHistory(file?: string): number {
    const before = this.journal.actions.length;
    if (file) {
      this.journal.actions = this.journal.actions.filter((a) => a.file !== file);
    } else {
      this.journal.actions = [];
    }
    this.journal.undoStack = [];
    this.journal.redoStack = [];
    this.persist();
    return before - this.journal.actions.length;
  }

  /**
   * Get the full undo/redo status summary.
   */
  getStatus(): { totalActions: number; undoableCount: number; redoableCount: number; files: string[] } {
    const files = Array.from(new Set(this.journal.actions.map((a) => a.file))).sort();
    return {
      totalActions: this.journal.actions.length,
      undoableCount: this.undoableCount(),
      redoableCount: this.redoableCount(),
      files,
    };
  }
}

// ──────────────────────────────────────────────
// Simple unified patch generation (line-based)
// ──────────────────────────────────────────────

/**
 * Generate a simple unified diff patch from before → after content.
 * Uses a line-difference algorithm suitable for undo/redo operations.
 */
function generateUnifiedPatch(
  filePath: string,
  before: string,
  after: string,
): string {
  const beforeLines = before.split('\n');
  const afterLines = after.split('\n');
  const hunks = computeHunks(beforeLines, afterLines);

  if (hunks.length === 0) return '';

  const parts: string[] = [
    `--- a/${filePath}`,
    `+++ b/${filePath}`,
  ];

  for (const hunk of hunks) {
    parts.push(
      `@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@`,
    );
    for (const line of hunk.lines) {
      parts.push(line);
    }
  }

  return parts.join('\n');
}

interface HunkData {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: string[];
}

function computeHunks(beforeLines: string[], afterLines: string[]): HunkData[] {
  const lcs = computeLCS(beforeLines, afterLines);
  const hunks: HunkData[] = [];

  let bi = 0; // before index
  let ai = 0; // after index
  let li = 0; // LCS index
  const contextLines = 3;

  while (bi < beforeLines.length || ai < afterLines.length) {
    // Skip matching lines at the start
    while (li < lcs.length && bi < beforeLines.length && ai < afterLines.length) {
      const matchBeforeIdx = lcs[li][0];
      const matchAfterIdx = lcs[li][1];
      if (bi === matchBeforeIdx && ai === matchAfterIdx) {
        bi++;
        ai++;
        li++;
      } else {
        break;
      }
    }

    if (bi >= beforeLines.length && ai >= afterLines.length) break;

    // Found a change — collect the hunk
    const hunkOldStart = Math.max(0, bi);
    const hunkNewStart = Math.max(0, ai);
    const hunkLines: string[] = [];
    let oldCount = 0;
    let newCount = 0;

    // Find end of this change (next matching point in LCS)
    const nextMatch = li < lcs.length ? lcs[li] : null;
    const endOld = nextMatch ? nextMatch[0] : beforeLines.length;
    const endNew = nextMatch ? nextMatch[1] : afterLines.length;

    // Include context before
    for (let c = Math.max(0, hunkOldStart - contextLines); c < hunkOldStart; c++) {
      hunkLines.push(` ${beforeLines[c]}`);
      oldCount++;
      newCount++;
    }

    // Deleted/changed lines
    for (let i = hunkOldStart; i < endOld; i++) {
      hunkLines.push(`-${beforeLines[i]}`);
      oldCount++;
    }

    // Added lines
    for (let i = hunkNewStart; i < endNew; i++) {
      hunkLines.push(`+${afterLines[i]}`);
      newCount++;
    }

    // Include context after
    for (let c = endOld; c < Math.min(beforeLines.length, endOld + contextLines); c++) {
      hunkLines.push(` ${beforeLines[c]}`);
      oldCount++;
      newCount++;
    }

    hunks.push({
      oldStart: hunkOldStart + 1, // 1-based
      oldCount,
      newStart: hunkNewStart + 1, // 1-based
      newCount,
      lines: hunkLines,
    });

    bi = endOld;
    ai = endNew;
    // li stays on nextMatch for next iteration
  }

  return hunks;
}

/**
 * Compute the Longest Common Subsequence of two string arrays.
 * Returns pairs of [beforeIndex, afterIndex].
 */
function computeLCS(a: string[], b: string[]): Array<[number, number]> {
  const m = a.length;
  const n = b.length;

  // DP table
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Backtrack to find the LCS pairs
  const pairs: Array<[number, number]> = [];
  let i = m;
  let j = n;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      pairs.unshift([i - 1, j - 1]);
      i--;
      j--;
    } else if (dp[i - 1][j] > dp[i][j - 1]) {
      i--;
    } else {
      j--;
    }
  }

  return pairs;
}

// ──────────────────────────────────────────────
// Patch application
// ──────────────────────────────────────────────

/**
 * Apply a simple unified patch to content, returning the patched result.
 * This is a simplified implementation intended for undo/redo operations
 * where the patch was generated from known before/after content.
 */
function applyPatch(content: string, patch: string): string {
  if (!patch) return content;

  const contentLines = content.split('\n');
  const patchLines = patch.split('\n');

  // If the file doesn't exist and the patch creates it
  if (contentLines.length === 1 && contentLines[0] === '' && patch.includes('@@')) {
    const result: string[] = [];
    for (const line of patchLines) {
      if (line.startsWith('+')) result.push(line.substring(1));
      else if (line.startsWith(' ')) result.push(line.substring(1));
      // Skip metadata lines
    }
    return result.join('\n');
  }

  // Parse hunks and apply
  let result = [...contentLines];
  let hunkIndex = 0;
  let offset = 0; // track insert/delete offset

  while (hunkIndex < patchLines.length) {
    const line = patchLines[hunkIndex];
    const hunkMatch = line.match(/^@@ -(\d+),(\d+) \+(\d+),(\d+) @@/);
    if (hunkMatch) {
      const oldStart = parseInt(hunkMatch[1], 10) - 1; // 0-based
      const oldCount = parseInt(hunkMatch[2], 10);
      const newStart = parseInt(hunkMatch[3], 10) - 1;
      const newCount = parseInt(hunkMatch[4], 10);

      hunkIndex++;
      const hunkLines: string[] = [];
      let addedCount = 0;
      let removedCount = 0;

      while (
        hunkIndex < patchLines.length &&
        !patchLines[hunkIndex].startsWith('@@') &&
        !patchLines[hunkIndex].startsWith('---') &&
        !patchLines[hunkIndex].startsWith('+++')
      ) {
        const hl = patchLines[hunkIndex];
        if (hl.startsWith('-')) {
          removedCount++;
        } else if (hl.startsWith('+')) {
          addedCount++;
          hunkLines.push(hl.substring(1));
        } else if (hl.startsWith(' ')) {
          hunkLines.push(hl.substring(1));
          removedCount++;
          addedCount++;
        }
        hunkIndex++;
      }

      // Apply: remove oldCount lines at oldStart, insert hunkLines
      const adjustedStart = oldStart + offset;
      result.splice(adjustedStart, oldCount - (hunkLines.length - addedCount), ...hunkLines);
      offset += hunkLines.length - oldCount;
    } else {
      hunkIndex++;
    }
  }

  return result.join('\n');
}

// ──────────────────────────────────────────────
// Singleton factory
// ──────────────────────────────────────────────

const instances = new Map<string, UndoStackManager>();

/**
 * Get or create an UndoStackManager for the given project root.
 */
export function getUndoStackManager(projectRoot: string): UndoStackManager {
  let mgr = instances.get(projectRoot);
  if (!mgr) {
    mgr = new UndoStackManager(projectRoot);
    instances.set(projectRoot, mgr);
  }
  return mgr;
}
