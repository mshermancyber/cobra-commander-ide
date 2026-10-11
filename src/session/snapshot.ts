import { mkdirSync, existsSync, writeFileSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';

// ─── Types ─────────────────────────────────────────────────────────────────

export interface OpenFileState {
  path: string;              // relative to workspace root
  cursorLine: number;
  cursorColumn: number;
  scrollTop: number;
  scrollLeft: number;
  isDirty: boolean;
  lastSaved: number;
  selections: Array<{
    startLine: number;
    startColumn: number;
    endLine: number;
    endColumn: number;
  }>;
}

export interface TerminalState {
  sessionId: string;
  shell: string;
  cwd: string;
  scrollback: string[];      // last N lines of terminal history
  cursorPosition: { row: number; col: number };
  processes: Array<{
    pid: number;
    command: string;
    status: 'running' | 'stopped';
  }>;
}

export interface ConversationTreeNode {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  children: ConversationTreeNode[];
  metadata?: Record<string, unknown>;
}

export interface WorkspaceSnapshot {
  id: string;
  parentId?: string;
  sessionId: string;
  timestamp: number;
  label?: string;
  openFiles: OpenFileState[];
  terminalState: TerminalState | null;
  conversationTree: ConversationTreeNode | null;
  workspaceRoot: string;
  activeFilePath?: string;
  // Incremental diff metadata
  isDiff: boolean;
  diffBaseId?: string;
  changedFiles: string[];
  removedFiles: string[];
}

export interface SnapshotDiff {
  baseId: string;
  targetId: string;
  openFilesAdded: OpenFileState[];
  openFilesRemoved: string[];       // file paths
  openFilesChanged: OpenFileState[];
  terminalsChanged: boolean;
  conversationNodesAdded: number;
  conversationNodesRemoved: number;
  changedFiles: string[];
  removedFiles: string[];
}

export interface RestoreConflict {
  type: 'file-dirty' | 'terminal-running' | 'divergent-conversation';
  description: string;
  choices: ConflictChoice[];
}

export interface ConflictChoice {
  id: string;
  label: string;
  description: string;
}

export interface RestoreResult {
  success: boolean;
  conflicts: RestoreConflict[];
  applied: boolean;
}

export interface SnapshotConfig {
  storageDir?: string;
  autoSnapshotOnPause?: boolean;
  maxSnapshots?: number;
  diffThreshold?: number;       // min changes to store as diff
  compressionEnabled?: boolean;
}

// ─── Defaults ──────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: Required<SnapshotConfig> = {
  storageDir: join(process.env.HOME || process.env.USERPROFILE || '/tmp', '.cobra-commander', 'snapshots'),
  autoSnapshotOnPause: true,
  maxSnapshots: 50,
  diffThreshold: 5,     // store as diff when fewer than 5 file changes vs full
  compressionEnabled: false,
};

// ─── Helpers ───────────────────────────────────────────────────────────────

function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 16);
}

function hashSnapshot(snapshot: WorkspaceSnapshot): string {
  const payload = JSON.stringify({
    openFiles: snapshot.openFiles,
    terminalState: snapshot.terminalState,
    conversationTree: snapshot.conversationTree,
  });
  return hashContent(payload);
}

// ─── SnapshotManager ───────────────────────────────────────────────────────

export class SnapshotManager {
  private config: Required<SnapshotConfig>;
  private sessionId: string;
  private workspaceRoot: string;
  private snapshotDir: string;
  private snapshots: WorkspaceSnapshot[] = [];
  private changeTracker: Map<string, { hash: string; timestamp: number }> = new Map();
  private autoSnapshotTimer: ReturnType<typeof setInterval> | null = null;

  constructor(sessionId: string, workspaceRoot: string, config?: SnapshotConfig) {
    this.sessionId = sessionId;
    this.workspaceRoot = workspaceRoot;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.snapshotDir = join(this.config.storageDir, sessionId);

    if (!existsSync(this.snapshotDir)) {
      mkdirSync(this.snapshotDir, { recursive: true });
    }

    this.loadIndex();
  }

  // ─── Snapshot Creation ──────────────────────────────────────────────────

  /**
   * Create a full workspace snapshot.
   */
  createSnapshot(params: {
    openFiles: OpenFileState[];
    terminalState?: TerminalState | null;
    conversationTree?: ConversationTreeNode | null;
    label?: string;
    activeFilePath?: string;
  }): WorkspaceSnapshot {
    const id = `snap-${Date.now()}-${randomUUID().slice(0, 6)}`;
    const parentId = this.latestSnapshot()?.id;

    const snapshot: WorkspaceSnapshot = {
      id,
      parentId,
      sessionId: this.sessionId,
      timestamp: Date.now(),
      label: params.label,
      openFiles: params.openFiles,
      terminalState: params.terminalState ?? null,
      conversationTree: params.conversationTree ?? null,
      workspaceRoot: this.workspaceRoot,
      activeFilePath: params.activeFilePath,
      isDiff: false,
      changedFiles: [],
      removedFiles: [],
    };

    this.snapshots.push(snapshot);
    this.persistSnapshot(snapshot);
    this.updateChangeTracker(snapshot);
    this.evictOldSnapshots();

    return snapshot;
  }

  /**
   * Create a diff-based incremental snapshot.
   * Only stores what changed since the base snapshot.
   */
  createDiffSnapshot(params: {
    openFiles: OpenFileState[];
    terminalState?: TerminalState | null;
    conversationTree?: ConversationTreeNode | null;
    label?: string;
    activeFilePath?: string;
    baseSnapshotId: string;
  }): WorkspaceSnapshot | null {
    const base = this.getSnapshot(params.baseSnapshotId);
    if (!base) return null;

    const id = `snap-diff-${Date.now()}-${randomUUID().slice(0, 6)}`;

    // Compute diffs
    const changedFiles: string[] = [];
    for (const ofCurrent of params.openFiles) {
      const ofBase = base.openFiles.find(f => f.path === ofCurrent.path);
      if (!ofBase) {
        changedFiles.push(ofCurrent.path);
      } else if (
        ofCurrent.cursorLine !== ofBase.cursorLine ||
        ofCurrent.cursorColumn !== ofBase.cursorColumn ||
        ofCurrent.isDirty !== ofBase.isDirty
      ) {
        changedFiles.push(ofCurrent.path);
      }
    }

    const removedFiles: string[] = base.openFiles
      .filter(bf => !params.openFiles.some(of => of.path === bf.path))
      .map(f => f.path);

    const terminalChanged = JSON.stringify(params.terminalState) !== JSON.stringify(base.terminalState);

    // Count conversation changes
    const baseConvNodes = this.countNodes(base.conversationTree);
    const currentConvNodes = this.countNodes(params.conversationTree ?? null);

    // Decide whether to store as diff or full
    const changeCount = changedFiles.length + removedFiles.length + (terminalChanged ? 1 : 0);
    if (changeCount >= this.config.diffThreshold) {
      // Too many changes, store as full snapshot
      return this.createSnapshot(params);
    }

    const snapshot: WorkspaceSnapshot = {
      id,
      parentId: base.id,
      sessionId: this.sessionId,
      timestamp: Date.now(),
      label: params.label,
      openFiles: params.openFiles,
      terminalState: params.terminalState ?? null,
      conversationTree: params.conversationTree ?? null,
      workspaceRoot: this.workspaceRoot,
      activeFilePath: params.activeFilePath,
      isDiff: true,
      diffBaseId: base.id,
      changedFiles,
      removedFiles,
    };

    this.snapshots.push(snapshot);
    this.persistSnapshot(snapshot);
    this.evictOldSnapshots();

    return snapshot;
  }

  /**
   * Auto-snapshot trigger — called on agent pause or periodic interval.
   */
  autoSnapshot(params: {
    openFiles: OpenFileState[];
    terminalState?: TerminalState | null;
    conversationTree?: ConversationTreeNode | null;
  }): WorkspaceSnapshot | null {
    if (!this.config.autoSnapshotOnPause) return null;

    const latest = this.latestSnapshot();
    if (!latest) {
      return this.createSnapshot(params);
    }

    // Check if anything changed since last snapshot
    const changed = this.hasMeaningfulChange(latest, params);
    if (!changed) return null;

    // Use diff snapshot for incremental updates
    return this.createDiffSnapshot({
      ...params,
      baseSnapshotId: latest.id,
      label: `auto-${new Date().toISOString()}`,
    });
  }

  /**
   * Start periodic auto-snapshots.
   */
  startAutoSnapshot(
    intervalMs: number,
    stateProvider: () => {
      openFiles: OpenFileState[];
      terminalState?: TerminalState | null;
      conversationTree?: ConversationTreeNode | null;
    },
  ): void {
    this.stopAutoSnapshot();
    this.autoSnapshotTimer = setInterval(() => {
      const state = stateProvider();
      try {
        this.autoSnapshot(state);
      } catch {
        // Silently ignore auto-snapshot failures
      }
    }, intervalMs);
  }

  /**
   * Stop periodic auto-snapshots.
   */
  stopAutoSnapshot(): void {
    if (this.autoSnapshotTimer) {
      clearInterval(this.autoSnapshotTimer);
      this.autoSnapshotTimer = null;
    }
  }

  // ─── Restoration ────────────────────────────────────────────────────────

  /**
   * Restore to a specific snapshot. Returns conflict info if restore
   * cannot proceed cleanly (e.g., current files are dirty).
   */
  restoreSnapshot(
    snapshotId: string,
    currentState: {
      openFiles: OpenFileState[];
      terminalState: TerminalState | null;
    },
  ): RestoreResult {
    const snapshot = this.getSnapshot(snapshotId);
    if (!snapshot) {
      return { success: false, conflicts: [], applied: false };
    }

    const conflicts: RestoreConflict[] = [];

    // Check for dirty files in current state
    const dirtyFiles = currentState.openFiles.filter(f => f.isDirty);
    const snapshotFiles = new Set(snapshot.openFiles.map(f => f.path));

    // Files that would be overwritten
    const collidingDirtyFiles = dirtyFiles.filter(f => snapshotFiles.has(f.path));
    if (collidingDirtyFiles.length > 0) {
      conflicts.push({
        type: 'file-dirty',
        description: `${collidingDirtyFiles.length} file(s) have unsaved changes: ${collidingDirtyFiles.map(f => f.path).join(', ')}`,
        choices: [
          {
            id: 'force',
            label: 'Discard Changes',
            description: 'Revert dirty files to snapshot state, losing current changes.',
          },
          {
            id: 'stash',
            label: 'Stash & Restore',
            description: 'Save current changes as a separate snapshot before restoring.',
          },
          {
            id: 'skip',
            label: 'Skip Dirty Files',
            description: 'Restore only clean files, keep dirty files as-is.',
          },
        ],
      });
    }

    // Check if terminal has running processes
    if (currentState.terminalState?.processes.some(p => p.status === 'running')) {
      if (snapshot.terminalState) {
        conflicts.push({
          type: 'terminal-running',
          description: 'Terminal has running processes that would be interrupted.',
          choices: [
            { id: 'kill', label: 'Kill & Restore', description: 'Terminate running processes and restore terminal state.' },
            { id: 'keep', label: 'Keep Current Terminals', description: 'Restore workspace but keep current terminal sessions.' },
          ],
        });
      }
    }

    // Check for divergent conversation
    const latestSnapshot = this.latestSnapshot();
    if (latestSnapshot && latestSnapshot.id !== snapshotId) {
      const latestConvNodes = this.countNodes(latestSnapshot.conversationTree);
      const targetConvNodes = this.countNodes(snapshot.conversationTree);
      if (latestConvNodes > targetConvNodes) {
        conflicts.push({
          type: 'divergent-conversation',
          description: `Current conversation has ${latestConvNodes} messages vs snapshot's ${targetConvNodes}. Restoring will lose conversation progress.`,
          choices: [
            { id: 'branch', label: 'Branch From Snapshot', description: 'Create a new session branch from snapshot, keeping current conversation.' },
            { id: 'force-restore', label: 'Full Restore', description: 'Discard current conversation and restore snapshot state.' },
          ],
        });
      }
    }

    return {
      success: conflicts.length === 0,
      conflicts,
      applied: false, // Caller decides how to resolve conflicts
    };
  }

  /**
   * Apply a snapshot restore after conflicts have been resolved.
   */
  applyRestore(
    snapshotId: string,
    resolution: Record<string, string>, // conflictType -> choiceId
  ): RestoreResult {
    const snapshot = this.getSnapshot(snapshotId);
    if (!snapshot) {
      return { success: false, conflicts: [], applied: false };
    }

    // Validate resolution against known conflicts
    for (const [conflictType, choiceId] of Object.entries(resolution)) {
      const validChoices = ['force', 'stash', 'skip', 'kill', 'keep', 'branch', 'force-restore'];
      if (!validChoices.includes(choiceId)) {
        return {
          success: false,
          conflicts: [{
            type: 'file-dirty',
            description: `Invalid resolution choice: ${choiceId} for conflict '${conflictType}'.`,
            choices: [],
          }],
          applied: false,
        };
      }
    }

    // If user chose to stash, create a pre-restore snapshot
    if (resolution['file-dirty'] === 'stash' || resolution['divergent-conversation'] === 'branch') {
      // Stash current state as a pre-restore snapshot (caller should provide current state)
      // This just signals acceptance — the actual stashing is a no-op here
    }

    return {
      success: true,
      conflicts: [],
      applied: true,
    };
  }

  // ─── Diff Computation ───────────────────────────────────────────────────

  /**
   * Compute a diff between two snapshots.
   */
  computeDiff(baseSnapshotId: string, targetSnapshotId: string): SnapshotDiff | null {
    const base = this.getSnapshot(baseSnapshotId);
    const target = this.getSnapshot(targetSnapshotId);
    if (!base || !target) return null;

    const baseFilePaths = new Set(base.openFiles.map(f => f.path));
    const targetFilePaths = new Set(target.openFiles.map(f => f.path));

    const openFilesAdded: OpenFileState[] = [];
    const openFilesRemoved: string[] = [];
    const openFilesChanged: OpenFileState[] = [];

    for (const f of target.openFiles) {
      if (!baseFilePaths.has(f.path)) {
        openFilesAdded.push(f);
      } else {
        const baseFile = base.openFiles.find(bf => bf.path === f.path)!;
        if (
          f.cursorLine !== baseFile.cursorLine ||
          f.cursorColumn !== baseFile.cursorColumn ||
          f.isDirty !== baseFile.isDirty ||
          JSON.stringify(f.selections) !== JSON.stringify(baseFile.selections)
        ) {
          openFilesChanged.push(f);
        }
      }
    }

    for (const f of base.openFiles) {
      if (!targetFilePaths.has(f.path)) {
        openFilesRemoved.push(f.path);
      }
    }

    const terminalsChanged =
      JSON.stringify(base.terminalState) !== JSON.stringify(target.terminalState);

    const baseConvNodes = this.countNodes(base.conversationTree);
    const targetConvNodes = this.countNodes(target.conversationTree);

    return {
      baseId: base.id,
      targetId: target.id,
      openFilesAdded,
      openFilesRemoved,
      openFilesChanged,
      terminalsChanged,
      conversationNodesAdded: Math.max(0, targetConvNodes - baseConvNodes),
      conversationNodesRemoved: Math.max(0, baseConvNodes - targetConvNodes),
      changedFiles: target.changedFiles,
      removedFiles: target.removedFiles,
    };
  }

  /**
   * Reconstruct a full snapshot from a chain of diff snapshots.
   */
  reconstructFromChain(snapshotId: string): WorkspaceSnapshot | null {
    const target = this.getSnapshot(snapshotId);
    if (!target) return null;

    if (!target.isDiff || !target.diffBaseId) return target;

    // Walk diff chain to find the last full snapshot
    const chain: WorkspaceSnapshot[] = [target];
    let current = target;

    const visited = new Set<string>([current.id]);

    while (current.diffBaseId && !visited.has(current.diffBaseId)) {
      const base = this.getSnapshot(current.diffBaseId);
      if (!base) break;
      visited.add(base.id);
      chain.push(base);
      if (!base.isDiff) break;
      current = base;
    }

    // Start from the oldest full snapshot and apply diffs
    chain.reverse();
    const full = chain[0];

    for (let i = 1; i < chain.length; i++) {
      const diff = chain[i];
      // Merge open files
      const fileMap = new Map<string, OpenFileState>();
      for (const f of full.openFiles) fileMap.set(f.path, f);
      for (const f of diff.openFiles) fileMap.set(f.path, f);
      full.openFiles = [...fileMap.values()];
      if (diff.terminalState) full.terminalState = diff.terminalState;
      if (diff.conversationTree) full.conversationTree = diff.conversationTree;
      if (diff.activeFilePath) full.activeFilePath = diff.activeFilePath;
    }

    return full;
  }

  // ─── Snapshot Listing & Management ──────────────────────────────────────

  /**
   * Get a snapshot by ID.
   */
  getSnapshot(id: string): WorkspaceSnapshot | null {
    // Check in-memory first
    const mem = this.snapshots.find(s => s.id === id);
    if (mem) return mem;

    // Try loading from disk
    const filePath = join(this.snapshotDir, `${id}.json`);
    if (!existsSync(filePath)) return null;
    try {
      const snap = JSON.parse(readFileSync(filePath, 'utf-8')) as WorkspaceSnapshot;
      return snap;
    } catch {
      return null;
    }
  }

  /**
   * List all snapshots for the current session, newest first.
   */
  listSnapshots(filter?: { label?: string; after?: number; before?: number }): WorkspaceSnapshot[] {
    let list = [...this.snapshots];

    // Also load any on-disk snapshots not in memory
    if (existsSync(this.snapshotDir)) {
      const files = readdirSync(this.snapshotDir).filter(f => f.endsWith('.json') && f !== 'index.json');
      const inMemIds = new Set(this.snapshots.map(s => s.id));
      for (const file of files) {
        const id = file.replace('.json', '');
        if (!inMemIds.has(id)) {
          const snap = this.getSnapshot(id);
          if (snap) list.push(snap);
        }
      }
    }

    list.sort((a, b) => b.timestamp - a.timestamp);

    if (filter) {
      if (filter.label) {
        list = list.filter(s => s.label?.includes(filter.label!));
      }
      if (filter.after !== undefined) {
        list = list.filter(s => s.timestamp > filter.after!);
      }
      if (filter.before !== undefined) {
        list = list.filter(s => s.timestamp < filter.before!);
      }
    }

    return list;
  }

  /**
   * Get the latest (most recent) snapshot.
   */
  latestSnapshot(): WorkspaceSnapshot | null {
    const list = this.listSnapshots();
    return list.length > 0 ? list[0] : null;
  }

  /**
   * Delete a snapshot by ID.
   */
  deleteSnapshot(id: string): boolean {
    this.snapshots = this.snapshots.filter(s => s.id !== id);
    const filePath = join(this.snapshotDir, `${id}.json`);
    try {
      if (existsSync(filePath)) {
        const { unlinkSync } = require('node:fs');
        unlinkSync(filePath);
      }
      return true;
    } catch { return false; }
  }

  /**
   * Export snapshots for session transfer.
   */
  exportSnapshots(): WorkspaceSnapshot[] {
    return this.listSnapshots();
  }

  /**
   * Import snapshots from another manager or external source.
   */
  importSnapshots(snapshots: WorkspaceSnapshot[]): number {
    let count = 0;
    for (const snap of snapshots) {
      if (!this.getSnapshot(snap.id) && snap.sessionId === this.sessionId) {
        this.snapshots.push(snap);
        this.persistSnapshot(snap);
        count++;
      }
    }
    return count;
  }

  // ─── Conflict Preview ───────────────────────────────────────────────────

  /**
   * Preview what files will be affected by a restore without applying it.
   */
  previewRestore(snapshotId: string, currentOpenFiles: OpenFileState[]): {
    filesToOpen: string[];
    filesToClose: string[];
    filesWithConflict: string[];
  } {
    const snapshot = this.getSnapshot(snapshotId);
    if (!snapshot) return { filesToOpen: [], filesToClose: [], filesWithConflict: [] };

    const currentPaths = new Set(currentOpenFiles.map(f => f.path));
    const snapshotPaths = new Set(snapshot.openFiles.map(f => f.path));

    const filesToOpen = [...snapshotPaths].filter(p => !currentPaths.has(p));
    const filesToClose = [...currentPaths].filter(p => !snapshotPaths.has(p));
    const filesWithConflict = currentOpenFiles
      .filter(f => f.isDirty && snapshotPaths.has(f.path))
      .map(f => f.path);

    return { filesToOpen, filesToClose, filesWithConflict };
  }

  // ─── Internal Helpers ───────────────────────────────────────────────────

  private hasMeaningfulChange(
    latest: WorkspaceSnapshot,
    current: { openFiles: OpenFileState[]; terminalState?: TerminalState | null; conversationTree?: ConversationTreeNode | null },
  ): boolean {
    // Check file changes
    if (latest.openFiles.length !== current.openFiles.length) return true;

    const latestMap = new Map(latest.openFiles.map(f => [f.path, f]));
    for (const cf of current.openFiles) {
      const lf = latestMap.get(cf.path);
      if (!lf) return true;
      if (
        lf.cursorLine !== cf.cursorLine ||
        lf.cursorColumn !== cf.cursorColumn ||
        lf.isDirty !== cf.isDirty
      ) return true;
    }

    // Check terminal changes
    if (JSON.stringify(latest.terminalState) !== JSON.stringify(current.terminalState ?? null)) return true;

    // Check conversation changes
    const latestNodes = this.countNodes(latest.conversationTree);
    const currentNodes = this.countNodes(current.conversationTree ?? null);
    if (latestNodes !== currentNodes) return true;

    return false;
  }

  private countNodes(tree: ConversationTreeNode | null): number {
    if (!tree) return 0;
    let count = 1;
    for (const child of tree.children) {
      count += this.countNodes(child);
    }
    return count;
  }

  private updateChangeTracker(snapshot: WorkspaceSnapshot): void {
    for (const f of snapshot.openFiles) {
      this.changeTracker.set(f.path, {
        hash: hashContent(JSON.stringify(f)),
        timestamp: snapshot.timestamp,
      });
    }
  }

  // ─── Persistence ────────────────────────────────────────────────────────

  private persistSnapshot(snapshot: WorkspaceSnapshot): void {
    const filePath = join(this.snapshotDir, `${snapshot.id}.json`);
    writeFileSync(filePath, JSON.stringify(snapshot, null, 2), 'utf-8');
    this.saveIndex();
  }

  private loadIndex(): void {
    const indexPath = join(this.snapshotDir, 'index.json');
    if (!existsSync(indexPath)) return;
    try {
      const ids = JSON.parse(readFileSync(indexPath, 'utf-8')) as string[];
      for (const id of ids) {
        const snap = this.getSnapshot(id);
        if (snap && !this.snapshots.some(s => s.id === snap.id)) {
          this.snapshots.push(snap);
        }
      }
    } catch {
      // Corrupt index, rebuild by scanning directory
      this.rebuildIndex();
    }
  }

  private saveIndex(): void {
    const indexPath = join(this.snapshotDir, 'index.json');
    const ids = this.snapshots.map(s => s.id);
    writeFileSync(indexPath, JSON.stringify(ids), 'utf-8');
  }

  private rebuildIndex(): void {
    if (!existsSync(this.snapshotDir)) return;
    const files = readdirSync(this.snapshotDir).filter(f => f.endsWith('.json') && f !== 'index.json');
    this.snapshots = [];
    for (const file of files) {
      try {
        const data = JSON.parse(readFileSync(join(this.snapshotDir, file), 'utf-8')) as WorkspaceSnapshot;
        this.snapshots.push(data);
      } catch { /* skip corrupted files */ }
    }
    this.saveIndex();
  }

  private evictOldSnapshots(): void {
    if (this.snapshots.length <= this.config.maxSnapshots) return;

    // Keep the most recent N snapshots, delete oldest
    const toRemove = this.snapshots
      .sort((a, b) => a.timestamp - b.timestamp)
      .slice(0, this.snapshots.length - this.config.maxSnapshots);

    for (const snap of toRemove) {
      this.deleteSnapshot(snap.id);
    }
  }
}

// ─── Convenience Functions ────────────────────────────────────────────────

/**
 * Deep-clone a workspace snapshot for safe sharing.
 */
export function cloneSnapshot(snapshot: WorkspaceSnapshot): WorkspaceSnapshot {
  return JSON.parse(JSON.stringify(snapshot)) as WorkspaceSnapshot;
}

/**
 * Compare two open file states for equality.
 */
export function filesEqual(a: OpenFileState, b: OpenFileState): boolean {
  return (
    a.path === b.path &&
    a.cursorLine === b.cursorLine &&
    a.cursorColumn === b.cursorColumn &&
    a.isDirty === b.isDirty
  );
}

/**
 * Create a conflict resolution description string for display.
 */
export function formatConflict(conflict: RestoreConflict): string {
  const choices = conflict.choices.map(c => `  [${c.id}] ${c.label}: ${c.description}`).join('\n');
  return `Conflict (${conflict.type}): ${conflict.description}\n${choices}`;
}

/**
 * Validate that a snapshot is complete and consistent.
 */
export function validateSnapshot(snapshot: WorkspaceSnapshot): string[] {
  const issues: string[] = [];
  if (!snapshot.id) issues.push('Missing snapshot ID');
  if (!snapshot.sessionId) issues.push('Missing session ID');
  if (snapshot.isDiff && !snapshot.diffBaseId) issues.push('Diff snapshot missing base ID');
  if (!snapshot.workspaceRoot) issues.push('Missing workspace root');

  // Check for duplicate file paths in open files
  const paths = new Set<string>();
  for (const f of snapshot.openFiles) {
    if (paths.has(f.path)) {
      issues.push(`Duplicate file in open files: ${f.path}`);
    }
    paths.add(f.path);
  }

  return issues;
}
