import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { homedir } from 'node:os';

// ─── Types ─────────────────────────────────────────────────────────────────

export interface ContextPack {
  id: string;
  title: string;
  description: string;
  author: string;
  authorId: string;
  teamId: string;
  /** Bundle of relevant file contents (file path -> content snippet) */
  files: Array<{ path: string; content: string; chunk: 'full' | 'diff' | 'header'; }>;
  /** Freeform notes attached to the pack */
  notes: string;
  /** AI-generated insights about the context */
  insights: string[];
  /** Tags for categorization */
  tags: string[];
  /** When this pack was created */
  createdAt: number;
  /** When this pack was last modified */
  updatedAt: number;
  /** Version counter for merge resolution */
  version: number;
  /** Parent pack ID if this is an update */
  parentId?: string;
  /** If this pack supersedes another */
  supersedes?: string[];
}

export interface TeamMember {
  id: string;
  name: string;
  email: string;
  roles: TeamRole[];
  joinedAt: number;
  lastActiveAt: number;
}

export type TeamRole = 'admin' | 'editor' | 'viewer' | 'contributor';

export interface TeamWorkspace {
  id: string;
  name: string;
  ownerId: string;
  members: TeamMember[];
  createdAt: number;
  updatedAt: number;
  settings: TeamSettings;
}

export interface TeamSettings {
  allowPublicSharing: boolean;
  requireApproval: boolean;
  maxContextPackSize: number;       // max file count per pack
  autoMergeConflicts: boolean;
  retentionDays: number;
}

export interface Subscription {
  id: string;
  subscriberId: string;
  workspaceId: string;
  /** Filter criteria for context updates */
  filter: {
    tags?: string[];
    authors?: string[];
    filePatterns?: string[];
  };
  createdAt: number;
  lastNotifiedAt: number;
  active: boolean;
}

export interface ContextUpdate {
  type: 'created' | 'updated' | 'deleted' | 'merged';
  packId: string;
  pack?: ContextPack;
  authorId: string;
  workspaceId: string;
  timestamp: number;
  changes?: {
    filesAdded: string[];
    filesRemoved: string[];
    filesModified: string[];
    insightsAdded: string[];
  };
}

export interface MergeConflict {
  field: string;
  base: unknown;
  ours: unknown;
  theirs: unknown;
  resolution?: 'ours' | 'theirs' | 'manual';
  resolvedValue?: unknown;
}

export interface MergeResult {
  success: boolean;
  conflicts: MergeConflict[];
  mergedPack?: ContextPack;
  resolution: 'auto' | 'manual' | 'failed';
}

export interface TeamContextConfig {
  storageDir?: string;
  workspaceId?: string;
  userId?: string;
  userName?: string;
}

// ─── Defaults ──────────────────────────────────────────────────────────────

const DEFAULT_SETTINGS: TeamSettings = {
  allowPublicSharing: false,
  requireApproval: false,
  maxContextPackSize: 50,
  autoMergeConflicts: true,
  retentionDays: 30,
};

const DEFAULT_CONFIG: Required<TeamContextConfig> = {
  storageDir: join(homedir(), '.cobra-commander', 'team-context-sharing'),
  workspaceId: 'default',
  userId: 'anonymous',
  userName: 'Anonymous',
};

// ─── Helpers ───────────────────────────────────────────────────────────────

function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 16);
}

function threeWayMergeValue(
  field: string,
  base: unknown,
  ours: unknown,
  theirs: unknown,
): { resolved: unknown; conflict: boolean } {
  // If no change from base in either branch, no conflict
  if (JSON.stringify(ours) === JSON.stringify(theirs)) {
    return { resolved: ours, conflict: false };
  }
  if (JSON.stringify(ours) === JSON.stringify(base)) {
    return { resolved: theirs, conflict: false };
  }
  if (JSON.stringify(theirs) === JSON.stringify(base)) {
    return { resolved: ours, conflict: false };
  }
  // Conflict — prefer ours for simple values
  return { resolved: ours, conflict: true };
}

// ─── TeamContextSharing ────────────────────────────────────────────────────

export class TeamContextSharing {
  private config: Required<TeamContextConfig>;
  private workspace: TeamWorkspace;
  private packs: Map<string, ContextPack> = new Map();
  private subscriptions: Map<string, Subscription[]> = new Map(); // subscriberId -> subs
  private eventLog: ContextUpdate[] = [];
  private storageDir: string;

  constructor(config?: TeamContextConfig) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.storageDir = this.config.storageDir;
    this.ensureDirectories();

    this.workspace = this.loadWorkspace() || this.createDefaultWorkspace();
    this.loadPacks();
    this.loadSubscriptions();
  }

  // ─── Workspace Management ───────────────────────────────────────────────

  getWorkspace(): TeamWorkspace {
    return { ...this.workspace };
  }

  updateWorkspaceSettings(updates: Partial<TeamSettings>): TeamWorkspace {
    this.workspace.settings = { ...this.workspace.settings, ...updates };
    this.workspace.updatedAt = Date.now();
    this.persistWorkspace();
    return this.getWorkspace();
  }

  // ─── Member Management (ACL) ────────────────────────────────────────────

  addMember(name: string, email: string, roles: TeamRole[] = ['viewer']): TeamMember {
    const member: TeamMember = {
      id: `member-${randomUUID().slice(0, 8)}`,
      name,
      email,
      roles,
      joinedAt: Date.now(),
      lastActiveAt: Date.now(),
    };

    this.workspace.members.push(member);
    this.workspace.updatedAt = Date.now();
    this.persistWorkspace();
    return member;
  }

  removeMember(memberId: string): boolean {
    const idx = this.workspace.members.findIndex(m => m.id === memberId);
    if (idx < 0) return false;

    // Cannot remove workspace owner
    if (this.workspace.members[idx].id === this.workspace.ownerId) return false;

    this.workspace.members.splice(idx, 1);
    this.workspace.updatedAt = Date.now();
    this.persistWorkspace();
    return true;
  }

  updateMemberRoles(memberId: string, roles: TeamRole[]): TeamMember | null {
    const member = this.workspace.members.find(m => m.id === memberId);
    if (!member) return null;

    member.roles = roles;
    member.lastActiveAt = Date.now();
    this.workspace.updatedAt = Date.now();
    this.persistWorkspace();
    return { ...member };
  }

  getMembers(): TeamMember[] {
    return [...this.workspace.members];
  }

  /**
   * Check if a member has the required permissions for an action.
   */
  checkAccess(memberId: string, requiredRole: TeamRole): boolean {
    const member = this.workspace.members.find(m => m.id === memberId);
    if (!member) {
      // Owner always has access
      if (memberId === this.workspace.ownerId) return true;
      return false;
    }

    const roleHierarchy: TeamRole[] = ['viewer', 'contributor', 'editor', 'admin'];
    const memberMaxRole = Math.max(...member.roles.map(r => roleHierarchy.indexOf(r)));
    const requiredRoleIndex = roleHierarchy.indexOf(requiredRole);

    return memberMaxRole >= requiredRoleIndex;
  }

  // ─── Context Pack CRUD ──────────────────────────────────────────────────

  /**
   * Create a new context pack with bundled files, notes, and insights.
   */
  createPack(params: {
    title: string;
    description: string;
    files: Array<{ path: string; content: string; chunk?: 'full' | 'diff' | 'header' }>;
    notes: string;
    insights?: string[];
    tags?: string[];
    authorId?: string;
    authorName?: string;
  }): ContextPack {
    const authorId = params.authorId || this.config.userId;
    const authorName = params.authorName || this.config.userName;

    if (!this.checkAccess(authorId, 'contributor')) {
      throw new Error(`Member ${authorId} does not have contributor access`);
    }

    const pack: ContextPack = {
      id: `pack-${Date.now()}-${randomUUID().slice(0, 6)}`,
      title: params.title,
      description: params.description,
      author: authorName,
      authorId,
      teamId: this.workspace.id,
      files: params.files.map(f => ({ ...f, chunk: f.chunk || 'full' })),
      notes: params.notes,
      insights: params.insights || [],
      tags: params.tags || [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      version: 1,
    };

    this.packs.set(pack.id, pack);
    this.persistPack(pack);

    this.logEvent({
      type: 'created',
      packId: pack.id,
      pack,
      authorId,
      workspaceId: this.workspace.id,
      timestamp: Date.now(),
    });

    this.notifySubscribers(pack.id, 'created');
    return pack;
  }

  /**
   * Update an existing context pack.
   */
  updatePack(
    packId: string,
    updates: Partial<Pick<ContextPack, 'title' | 'description' | 'files' | 'notes' | 'insights' | 'tags'>>,
    authorId?: string,
  ): ContextPack | null {
    const pack = this.packs.get(packId);
    if (!pack) return null;

    const userId = authorId || this.config.userId;
    if (!this.checkAccess(userId, 'editor') && pack.authorId !== userId) {
      throw new Error(`Member ${userId} does not have editor access`);
    }

    const changes = {
      filesAdded: [] as string[],
      filesRemoved: [] as string[],
      filesModified: [] as string[],
      insightsAdded: [] as string[],
    };

    if (updates.title) pack.title = updates.title;
    if (updates.description) pack.description = updates.description;
    if (updates.notes) pack.notes = updates.notes;
    if (updates.tags) pack.tags = updates.tags;

    if (updates.files) {
      const oldPaths = new Set(pack.files.map(f => f.path));
      const newPaths = new Set(updates.files.map(f => f.path));

      for (const f of updates.files) {
        if (!oldPaths.has(f.path)) changes.filesAdded.push(f.path);
        else changes.filesModified.push(f.path);
      }
      for (const p of oldPaths) {
        if (!newPaths.has(p)) changes.filesRemoved.push(p);
      }

      pack.files = updates.files.map(f => ({ ...f, chunk: f.chunk || 'full' }));
    }

    if (updates.insights) {
      const oldInsights = new Set(pack.insights);
      for (const ins of updates.insights) {
        if (!oldInsights.has(ins)) changes.insightsAdded.push(ins);
      }
      pack.insights = updates.insights;
    }

    pack.updatedAt = Date.now();
    pack.version++;

    this.persistPack(pack);

    this.logEvent({
      type: 'updated',
      packId: pack.id,
      pack,
      authorId: userId,
      workspaceId: this.workspace.id,
      timestamp: Date.now(),
      changes,
    });

    this.notifySubscribers(pack.id, 'updated');
    return pack;
  }

  /**
   * Get a context pack by ID.
   */
  getPack(packId: string): ContextPack | null {
    return this.packs.get(packId) || null;
  }

  /**
   * List all context packs, optionally filtered.
   */
  listPacks(filter?: {
    authorId?: string;
    tags?: string[];
    since?: number;
    search?: string;
  }): ContextPack[] {
    let packs = [...this.packs.values()];

    if (filter) {
      if (filter.authorId) {
        packs = packs.filter(p => p.authorId === filter.authorId);
      }
      if (filter.tags && filter.tags.length > 0) {
        packs = packs.filter(p => filter.tags!.some(t => p.tags.includes(t)));
      }
      if (filter.since) {
        packs = packs.filter(p => p.updatedAt >= filter.since!);
      }
      if (filter.search) {
        const lower = filter.search.toLowerCase();
        packs = packs.filter(p =>
          p.title.toLowerCase().includes(lower) ||
          p.description.toLowerCase().includes(lower) ||
          p.notes.toLowerCase().includes(lower)
        );
      }
    }

    return packs.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /**
   * Delete a context pack.
   */
  deletePack(packId: string, authorId?: string): boolean {
    const pack = this.packs.get(packId);
    if (!pack) return false;

    const userId = authorId || this.config.userId;
    if (!this.checkAccess(userId, 'admin') && pack.authorId !== userId) {
      throw new Error(`Member ${userId} does not have permission to delete this pack`);
    }

    this.packs.delete(packId);
    this.removePackFromDisk(packId);

    this.logEvent({
      type: 'deleted',
      packId,
      authorId: userId,
      workspaceId: this.workspace.id,
      timestamp: Date.now(),
    });

    this.notifySubscribers(packId, 'deleted');
    return true;
  }

  // ─── Publish/Subscribe Model ────────────────────────────────────────────

  /**
   * Subscribe to context updates matching filter criteria.
   */
  subscribe(
    subscriberId: string,
    filter?: Subscription['filter'],
  ): Subscription {
    const sub: Subscription = {
      id: `sub-${subscriberId}-${Date.now()}`,
      subscriberId,
      workspaceId: this.workspace.id,
      filter: filter || {},
      createdAt: Date.now(),
      lastNotifiedAt: Date.now(),
      active: true,
    };

    const existing = this.subscriptions.get(subscriberId) || [];
    existing.push(sub);
    this.subscriptions.set(subscriberId, existing);
    this.persistSubscriptions();

    return sub;
  }

  /**
   * Unsubscribe from context updates.
   */
  unsubscribe(subscriptionId: string): boolean {
    for (const [subscriberId, subs] of this.subscriptions) {
      const idx = subs.findIndex(s => s.id === subscriptionId);
      if (idx >= 0) {
        subs.splice(idx, 1);
        if (subs.length === 0) {
          this.subscriptions.delete(subscriberId);
        }
        this.persistSubscriptions();
        return true;
      }
    }
    return false;
  }

  /**
   * Get pending updates for a subscriber since their last notification.
   */
  getPendingUpdates(subscriberId: string): ContextUpdate[] {
    const subs = this.subscriptions.get(subscriberId) || [];
    if (subs.length === 0) return [];

    let lastNotified = 0;
    for (const sub of subs) {
      if (sub.lastNotifiedAt > lastNotified) {
        lastNotified = sub.lastNotifiedAt;
      }
    }

    return this.eventLog.filter(
      event => event.timestamp > lastNotified && this.matchesFilter(event, subs)
    );
  }

  /**
   * Mark all pending updates as notified for a subscriber.
   */
  markNotified(subscriberId: string): void {
    const subs = this.subscriptions.get(subscriberId) || [];
    const now = Date.now();
    for (const sub of subs) {
      sub.lastNotifiedAt = now;
    }
    this.persistSubscriptions();
  }

  // ─── Merge Resolution ───────────────────────────────────────────────────

  /**
   * Three-way merge of two context packs with a common ancestor.
   */
  mergePacks(
    oursId: string,
    theirsId: string,
    baseId?: string,
  ): MergeResult {
    const oursPack = this.packs.get(oursId);
    const theirsPack = this.packs.get(theirsId);

    if (!oursPack || !theirsPack) {
      return { success: false, conflicts: [], resolution: 'failed' };
    }

    const basePack = baseId ? this.packs.get(baseId) : null;
    const conflicts: MergeConflict[] = [];

    // If no base, use two-way merge (ours preference)
    if (!basePack) {
      const autoResolved = this.twoWayMerge(oursPack, theirsPack, conflicts);
      return {
        success: conflicts.length === 0,
        conflicts,
        mergedPack: autoResolved,
        resolution: conflicts.length === 0 ? 'auto' : 'manual',
      };
    }

    // Three-way merge by field
    const merged: ContextPack = {
      id: `pack-merged-${Date.now()}-${randomUUID().slice(0, 6)}`,
      title: oursPack.title,
      description: oursPack.description,
      author: `${oursPack.author} + ${theirsPack.author}`,
      authorId: oursPack.authorId,
      teamId: this.workspace.id,
      files: [],
      notes: '',
      insights: [],
      tags: [],
      createdAt: Math.min(oursPack.createdAt, theirsPack.createdAt),
      updatedAt: Date.now(),
      version: Math.max(oursPack.version, theirsPack.version) + 1,
      parentId: oursPack.id,
      supersedes: [theirsPack.id],
    };

    // Merge title
    const titleMerge = threeWayMergeValue('title', basePack.title, oursPack.title, theirsPack.title);
    merged.title = titleMerge.resolved as string;
    if (titleMerge.conflict) {
      conflicts.push({ field: 'title', base: basePack.title, ours: oursPack.title, theirs: theirsPack.title });
    }

    // Merge description
    const descMerge = threeWayMergeValue('description', basePack.description, oursPack.description, theirsPack.description);
    merged.description = descMerge.resolved as string;
    if (descMerge.conflict) {
      conflicts.push({ field: 'description', base: basePack.description, ours: oursPack.description, theirs: theirsPack.description });
    }

    // Merge notes (concatenate if both changed)
    if (oursPack.notes !== basePack.notes && theirsPack.notes !== basePack.notes) {
      merged.notes = `${oursPack.notes}\n\n--- Merged from ${theirsPack.author} ---\n${theirsPack.notes}`;
    } else if (oursPack.notes !== basePack.notes) {
      merged.notes = oursPack.notes;
    } else {
      merged.notes = theirsPack.notes;
    }

    // Merge files (union with conflict detection)
    const baseFileMap = new Map(basePack.files.map(f => [f.path, f]));
    const oursFileMap = new Map(oursPack.files.map(f => [f.path, f]));
    const theirsFileMap = new Map(theirsPack.files.map(f => [f.path, f]));

    const allPaths = new Set([
      ...baseFileMap.keys(),
      ...oursFileMap.keys(),
      ...theirsFileMap.keys(),
    ]);

    for (const path of allPaths) {
      const baseFile = baseFileMap.get(path);
      const oursFile = oursFileMap.get(path);
      const theirsFile = theirsFileMap.get(path);

      if (oursFile && theirsFile) {
        if (JSON.stringify(oursFile) === JSON.stringify(theirsFile)) {
          merged.files.push(oursFile);
        } else if (JSON.stringify(oursFile) === JSON.stringify(baseFile)) {
          merged.files.push(theirsFile);
        } else if (JSON.stringify(theirsFile) === JSON.stringify(baseFile)) {
          merged.files.push(oursFile);
        } else {
          // Both changed — use ours by default, flag conflict
          merged.files.push(oursFile);
          conflicts.push({
            field: `file:${path}`,
            base: baseFile?.content?.slice(0, 100),
            ours: oursFile.content?.slice(0, 100),
            theirs: theirsFile.content?.slice(0, 100),
            resolution: this.workspace.settings.autoMergeConflicts ? 'ours' : undefined,
          });
        }
      } else if (oursFile) {
        merged.files.push(oursFile);
      } else if (theirsFile) {
        merged.files.push(theirsFile);
      }
    }

    // Merge insights (union)
    const insightSet = new Set([...basePack.insights, ...oursPack.insights, ...theirsPack.insights]);
    merged.insights = [...insightSet];

    // Merge tags (union)
    const tagSet = new Set([...basePack.tags, ...oursPack.tags, ...theirsPack.tags]);
    merged.tags = [...tagSet];

    // If auto-merge is enabled and conflicts are resolvable
    if (this.workspace.settings.autoMergeConflicts) {
      for (const conflict of conflicts) {
        if (!conflict.resolution) {
          conflict.resolution = 'ours';
        }
      }
    }

    const autoResolved = conflicts.every(c => c.resolution);

    if (autoResolved) {
      this.packs.set(merged.id, merged);
      this.persistPack(merged);
      this.logEvent({
        type: 'merged',
        packId: merged.id,
        pack: merged,
        authorId: this.config.userId,
        workspaceId: this.workspace.id,
        timestamp: Date.now(),
      });
    }

    return {
      success: autoResolved,
      conflicts,
      mergedPack: autoResolved ? merged : undefined,
      resolution: autoResolved ? 'auto' : 'manual',
    };
  }

  /**
   * Resolve a merge conflict manually.
   */
  resolveConflict(
    conflict: MergeConflict,
    resolution: 'ours' | 'theirs' | 'manual',
    resolvedValue?: unknown,
  ): MergeConflict {
    conflict.resolution = resolution;
    if (resolution === 'manual' && resolvedValue !== undefined) {
      conflict.resolvedValue = resolvedValue;
    } else if (resolution === 'ours') {
      conflict.resolvedValue = conflict.ours;
    } else if (resolution === 'theirs') {
      conflict.resolvedValue = conflict.theirs;
    }
    return conflict;
  }

  // ─── Event Log ──────────────────────────────────────────────────────────

  /**
   * Get the event log, optionally filtered.
   */
  getEventLog(filter?: {
    authorId?: string;
    type?: ContextUpdate['type'];
    since?: number;
    limit?: number;
  }): ContextUpdate[] {
    let log = [...this.eventLog];

    if (filter) {
      if (filter.authorId) log = log.filter(e => e.authorId === filter.authorId);
      if (filter.type) log = log.filter(e => e.type === filter.type);
      const sinceVal = filter.since;
      if (sinceVal !== undefined) log = log.filter(e => e.timestamp > sinceVal);
    }

    log.sort((a, b) => b.timestamp - a.timestamp);

    if (filter?.limit) {
      log = log.slice(0, filter.limit);
    }

    return log;
  }

  // ─── Cleanup ────────────────────────────────────────────────────────────

  /**
   * Evict expired context packs based on retention settings.
   */
  evictExpired(): number {
    const cutoff = Date.now() - this.workspace.settings.retentionDays * 86_400_000;
    let removed = 0;

    for (const [id, pack] of this.packs) {
      if (pack.updatedAt < cutoff) {
        this.packs.delete(id);
        this.removePackFromDisk(id);
        removed++;
      }
    }

    return removed;
  }

  // ─── Statistics ─────────────────────────────────────────────────────────

  getStats(): {
    totalPacks: number;
    totalMembers: number;
    totalSubscriptions: number;
    totalEvents: number;
    storageSizeBytes: number;
  } {
    let subCount = 0;
    for (const subs of this.subscriptions.values()) {
      subCount += subs.length;
    }

    return {
      totalPacks: this.packs.size,
      totalMembers: this.workspace.members.length,
      totalSubscriptions: subCount,
      totalEvents: this.eventLog.length,
      storageSizeBytes: 0, // approximate — not computed here
    };
  }

  // ─── Internal ───────────────────────────────────────────────────────────

  private twoWayMerge(
    ours: ContextPack,
    theirs: ContextPack,
    conflicts: MergeConflict[],
  ): ContextPack {
    const merged: ContextPack = {
      ...ours,
      id: `pack-merged-${Date.now()}-${randomUUID().slice(0, 6)}`,
      author: `${ours.author} + ${theirs.author}`,
      createdAt: Math.min(ours.createdAt, theirs.createdAt),
      updatedAt: Date.now(),
      version: Math.max(ours.version, theirs.version) + 1,
      parentId: ours.id,
      supersedes: [theirs.id],
      // Union files, preferring ours on path conflict
      files: [...ours.files],
      insights: [...new Set([...ours.insights, ...theirs.insights])],
      tags: [...new Set([...ours.tags, ...theirs.tags])],
    };

    // Add theirs files not in ours
    const oursPaths = new Set(ours.files.map(f => f.path));
    for (const f of theirs.files) {
      if (!oursPaths.has(f.path)) {
        merged.files.push(f);
      } else {
        // Conflict — file exists in both
        conflicts.push({
          field: `file:${f.path}`,
          base: null,
          ours: ours.files.find(of => of.path === f.path)?.content?.slice(0, 100),
          theirs: f.content?.slice(0, 100),
        });
      }
    }

    // Merge notes
    if (ours.notes !== theirs.notes) {
      merged.notes = `${ours.notes}\n\n--- From ${theirs.author} ---\n${theirs.notes}`;
    }

    return merged;
  }

  private notifySubscribers(packId: string, eventType: ContextUpdate['type']): void {
    for (const [subscriberId, subs] of this.subscriptions) {
      for (const sub of subs) {
        if (!sub.active) continue;
        // Check if this pack matches the subscriber's filter
        const pack = this.packs.get(packId);
        if (!pack) continue;

        let matches = true;
        if (sub.filter.tags && sub.filter.tags.length > 0) {
          matches = sub.filter.tags.some(t => pack.tags.includes(t));
        }
        if (sub.filter.authors && sub.filter.authors.length > 0) {
          matches = matches && sub.filter.authors.includes(pack.authorId);
        }
        // File pattern matching is deferred to the subscriber
        if (matches) break; // Don't need to check all subs — we just need one match
      }
    }
  }

  private matchesFilter(event: ContextUpdate, subs: Subscription[]): boolean {
    return subs.some(sub => {
      if (!sub.active) return false;
      if (!sub.filter.tags && !sub.filter.authors && !sub.filter.filePatterns) return true;
      // Simplified: if no filter constraints, match all
      return !sub.filter.tags?.length && !sub.filter.authors?.length && !sub.filter.filePatterns?.length;
    });
  }

  private logEvent(event: ContextUpdate): void {
    this.eventLog.push(event);
    // Keep event log bounded
    if (this.eventLog.length > 1000) {
      this.eventLog = this.eventLog.slice(-500);
    }
  }

  private createDefaultWorkspace(): TeamWorkspace {
    return {
      id: this.config.workspaceId,
      name: 'My Team Workspace',
      ownerId: this.config.userId,
      members: [{
        id: this.config.userId,
        name: this.config.userName,
        email: '',
        roles: ['admin'],
        joinedAt: Date.now(),
        lastActiveAt: Date.now(),
      }],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      settings: { ...DEFAULT_SETTINGS },
    };
  }

  // ─── Persistence ────────────────────────────────────────────────────────

  private ensureDirectories(): void {
    const dirs = [
      this.storageDir,
      join(this.storageDir, 'packs'),
    ];
    for (const dir of dirs) {
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
    }
  }

  private persistWorkspace(): void {
    const path = join(this.storageDir, 'workspace.json');
    writeFileSync(path, JSON.stringify(this.workspace, null, 2), 'utf-8');
  }

  private loadWorkspace(): TeamWorkspace | null {
    const path = join(this.storageDir, 'workspace.json');
    if (!existsSync(path)) return null;
    try {
      return JSON.parse(readFileSync(path, 'utf-8')) as TeamWorkspace;
    } catch {
      return null;
    }
  }

  private persistPack(pack: ContextPack): void {
    const path = join(this.storageDir, 'packs', `${pack.id}.json`);
    writeFileSync(path, JSON.stringify(pack, null, 2), 'utf-8');
  }

  private removePackFromDisk(packId: string): void {
    const path = join(this.storageDir, 'packs', `${packId}.json`);
    try {
      if (existsSync(path)) unlinkSync(path);
    } catch { /* ignore */ }
  }

  private loadPacks(): void {
    const packsDir = join(this.storageDir, 'packs');
    if (!existsSync(packsDir)) return;

    try {
      const files = readdirSync(packsDir).filter(f => f.endsWith('.json'));
      for (const file of files) {
        try {
          const pack = JSON.parse(readFileSync(join(packsDir, file), 'utf-8')) as ContextPack;
          this.packs.set(pack.id, pack);
        } catch { /* skip corrupted */ }
      }
    } catch { /* ignore */ }
  }

  private persistSubscriptions(): void {
    const path = join(this.storageDir, 'subscriptions.json');
    const data = [...this.subscriptions.entries()].map(([key, subs]) => ({ key, subs }));
    writeFileSync(path, JSON.stringify(data, null, 2), 'utf-8');
  }

  private loadSubscriptions(): void {
    const path = join(this.storageDir, 'subscriptions.json');
    if (!existsSync(path)) return;
    try {
      const data = JSON.parse(readFileSync(path, 'utf-8')) as Array<{ key: string; subs: Subscription[] }>;
      for (const entry of data) {
        this.subscriptions.set(entry.key, entry.subs);
      }
    } catch { /* ignore */ }
  }
}

// ─── Convenience Functions ─────────────────────────────────────────────────

/**
 * Create a context pack from the current workspace state (open files, notes, etc.).
 */
export function createContextPackFromWorkspace(params: {
  title: string;
  description: string;
  openFiles: Array<{ path: string; content: string }>;
  notes?: string;
  insights?: string[];
  tags?: string[];
  authorId?: string;
  authorName?: string;
}): ContextPack {
  const sharing = new TeamContextSharing();
  return sharing.createPack({
    ...params,
    files: params.openFiles,
    notes: params.notes || '',
  });
}

/**
 * Resolve all conflicts in a merge result with a default strategy.
 */
export function autoResolveConflicts(
  conflicts: MergeConflict[],
  strategy: 'ours' | 'theirs',
): MergeConflict[] {
  for (const conflict of conflicts) {
    conflict.resolution = strategy;
    conflict.resolvedValue = strategy === 'ours' ? conflict.ours : conflict.theirs;
  }
  return conflicts;
}
