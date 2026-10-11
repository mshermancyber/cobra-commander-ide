import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single text operation in the CRDT */
export interface TextOp {
  /** Unique operation ID (lamport timestamp + client ID) */
  id: OpId;
  /** Type of operation */
  type: 'insert' | 'delete';
  /** Character position in the document */
  position: number;
  /** Content (for insert) or length (for delete) */
  content?: string;
  length?: number;
  /** Operation origin (client ID) */
  origin: string;
  /** Lamport clock value */
  clock: number;
}

export interface OpId {
  client: string;
  clock: number;
}

/** A cursor position from a remote user */
export interface CursorPresence {
  userId: string;
  displayName: string;
  color: string;
  /** Position in the document */
  position: number;
  /** Selection range */
  selection?: {
    anchor: number;
    head: number;
  };
  /** Last activity timestamp */
  lastActive: number;
  /** Which file they're viewing */
  filePath: string;
}

/** A peer in the WebRTC mesh */
export interface Peer {
  id: string;
  displayName: string;
  color: string;
  /** Whether they're connected */
  connected: boolean;
  /** Data channel state */
  channelState: 'connecting' | 'open' | 'closing' | 'closed';
  /** ICE connection state */
  iceState: 'new' | 'checking' | 'connected' | 'completed' | 'failed' | 'disconnected' | 'closed';
  /** Join timestamp */
  joinedAt: number;
  /** Last message received timestamp */
  lastMessageAt: number;
}

/** A signaling message */
export interface SignalMessage {
  type: 'offer' | 'answer' | 'ice-candidate' | 'join' | 'leave' | 'cursor' | 'op' | 'sync-request' | 'sync-response' | 'file-open';
  from: string;
  to?: string | '*';
  payload: unknown;
  timestamp: number;
  roomId: string;
}

/** The document state managed by CRDT */
export interface CollaborativeDocument {
  filePath: string;
  content: string;
  /** Lamport clock */
  clock: number;
  /** Operation history (for OT transforms) */
  history: TextOp[];
  /** Version vector for each peer */
  versionVector: Map<string, number>;
  /** Cursors on this document */
  cursors: Map<string, CursorPresence>;
}

/** A collaboration session */
export interface CollaborationSession {
  id: string;
  roomId: string;
  participants: Map<string, Peer>;
  documents: Map<string, CollaborativeDocument>;
  /** Signaling server URL */
  signalingUrl: string;
  /** Whether the signaling connection is established */
  connected: boolean;
  /** Created timestamp */
  createdAt: number;
}

// ---------------------------------------------------------------------------
// Operational Transform Engine
// ---------------------------------------------------------------------------

export class OperationalTransform {
  /**
   * Transform two concurrent insert operations.
   * If op1 is before op2, shift op2's position right by length of op1's content.
   */
  static transformInserts(op1: TextOp, op2: TextOp): TextOp {
    if (op1.position < op2.position) {
      return {
        ...op2,
        position: op2.position + (op1.content?.length || 0),
      };
    }
    if (op1.position === op2.position && op1.origin < op2.origin) {
      // Tie-break by client ID: op1 wins, shift op2
      return {
        ...op2,
        position: op2.position + (op1.content?.length || 0),
      };
    }
    return op2;
  }

  /**
   * Transform an insert against a delete.
   */
  static transformInsertAgainstDelete(insert: TextOp, del: TextOp): TextOp {
    const delEnd = del.position + (del.length || 0);

    if (insert.position <= del.position) {
      // Insert before delete: no change
      return insert;
    }
    if (insert.position >= delEnd) {
      // Insert after delete: shift left by deleted length
      return {
        ...insert,
        position: insert.position - (del.length || 0),
      };
    }
    // Insert inside deleted range: move to start of deletion
    return {
      ...insert,
      position: del.position,
    };
  }

  /**
   * Transform a delete against an insert.
   */
  static transformDeleteAgainstInsert(del: TextOp, insert: TextOp): TextOp {
    const insertLen = insert.content?.length || 0;
    const delEnd = del.position + (del.length || 0);

    if (insert.position >= delEnd) {
      // Insert is after delete: no change
      return del;
    }
    if (insert.position <= del.position) {
      // Insert is before delete: shift right
      return {
        ...del,
        position: del.position + insertLen,
      };
    }
    // Insert is inside deleted range: extend delete
    return {
      ...del,
      length: (del.length || 0) + insertLen,
    };
  }

  /**
   * Transform two concurrent deletes.
   */
  static transformDeletes(del1: TextOp, del2: TextOp): TextOp {
    const end1 = del1.position + (del1.length || 0);
    const end2 = del2.position + (del2.length || 0);

    if (del1.position < del2.position) {
      if (end1 <= del2.position) {
        // del1 entirely before del2: shift del2 left
        return {
          ...del2,
          position: del2.position - (del1.length || 0),
        };
      }
      // Overlapping: adjust
      return {
        ...del2,
        position: del1.position,
        length: Math.max(0, end2 - end1),
      };
    }
    // del1.position >= del2.position: no change to del2 (it's before del1)
    return del2;
  }

  /**
   * Apply two concurrent operations to get the transformed remote operation.
   */
  static transform(op: TextOp, concurrentOp: TextOp): TextOp {
    if (op.type === 'insert' && concurrentOp.type === 'insert') {
      return OperationalTransform.transformInserts(concurrentOp, op);
    }
    if (op.type === 'insert' && concurrentOp.type === 'delete') {
      return OperationalTransform.transformInsertAgainstDelete(op, concurrentOp);
    }
    if (op.type === 'delete' && concurrentOp.type === 'insert') {
      return OperationalTransform.transformDeleteAgainstInsert(op, concurrentOp);
    }
    if (op.type === 'delete' && concurrentOp.type === 'delete') {
      return OperationalTransform.transformDeletes(concurrentOp, op);
    }
    return op;
  }

  /**
   * Apply a text operation to a document string.
   */
  static apply(content: string, op: TextOp): string {
    if (op.type === 'insert') {
      return content.slice(0, op.position) + (op.content || '') + content.slice(op.position);
    }
    if (op.type === 'delete') {
      return content.slice(0, op.position) + content.slice(op.position + (op.length || 0));
    }
    return content;
  }

  /**
   * Compute the inverse of an operation (for undo).
   */
  static invert(content: string, op: TextOp): TextOp {
    if (op.type === 'insert') {
      return {
        id: { client: op.origin, clock: op.clock + 1 },
        type: 'delete',
        position: op.position,
        length: op.content?.length || 0,
        origin: op.origin,
        clock: op.clock + 1,
      };
    }
    if (op.type === 'delete') {
      const deleted = content.slice(op.position, op.position + (op.length || 0));
      return {
        id: { client: op.origin, clock: op.clock + 1 },
        type: 'insert',
        position: op.position,
        content: deleted,
        origin: op.origin,
        clock: op.clock + 1,
      };
    }
    return op;
  }
}

// ---------------------------------------------------------------------------
// CRDT Document
// ---------------------------------------------------------------------------

export class CrdtDocument {
  private doc: CollaborativeDocument;
  private emitter: EventEmitter;

  constructor(filePath: string, initialContent: string = '') {
    this.doc = {
      filePath,
      content: initialContent,
      clock: 0,
      history: [],
      versionVector: new Map(),
      cursors: new Map(),
    };
    this.emitter = new EventEmitter();
  }

  /**
   * Apply a local operation. Returns the transformed operation
   * that should be broadcast to peers.
   */
  applyLocal(op: TextOp): TextOp {
    // Apply operation locally
    this.doc.content = OperationalTransform.apply(this.doc.content, op);
    this.doc.history.push(op);
    this.doc.clock = Math.max(this.doc.clock, op.clock) + 1;

    // Update version vector
    this.doc.versionVector.set(op.origin, op.clock);

    // Emit change event
    this.emitter.emit('change', op, this.doc.content);

    return op;
  }

  /**
   * Apply a remote operation. Transforms against concurrent local ops
   * that haven't been acknowledged yet.
   */
  applyRemote(op: TextOp): TextOp | null {
    const localVersion = this.doc.versionVector.get(op.origin) || 0;

    // If we've already seen this op, ignore it
    if (op.clock <= localVersion) return null;

    // Find concurrent operations (those we applied after the remote peer's last known state)
    const concurrentOps = this.doc.history.filter(
      h => h.clock > localVersion && h.origin !== op.origin,
    );

    // Transform the remote operation against concurrent local operations
    let transformedOp = op;
    for (const concurrent of concurrentOps) {
      transformedOp = OperationalTransform.transform(transformedOp, concurrent);
    }

    // Apply the transformed operation
    this.doc.content = OperationalTransform.apply(this.doc.content, transformedOp);
    this.doc.history.push(transformedOp);
    this.doc.versionVector.set(op.origin, op.clock);
    this.doc.clock = Math.max(this.doc.clock, op.clock) + 1;

    this.emitter.emit('remote-change', transformedOp, this.doc.content);

    return transformedOp;
  }

  /**
   * Create an insert operation at the given position.
   */
  createInsert(position: number, content: string, clientId: string): TextOp {
    this.doc.clock++;
    return {
      id: { client: clientId, clock: this.doc.clock },
      type: 'insert',
      position,
      content,
      origin: clientId,
      clock: this.doc.clock,
    };
  }

  /**
   * Create a delete operation.
   */
  createDelete(position: number, length: number, clientId: string): TextOp {
    this.doc.clock++;
    return {
      id: { client: clientId, clock: this.doc.clock },
      type: 'delete',
      position,
      length,
      origin: clientId,
      clock: this.doc.clock,
    };
  }

  /**
   * Update a peer's cursor presence on this document.
   */
  updateCursor(
    userId: string,
    position: number,
    selection?: { anchor: number; head: number },
  ): void {
    const existing = this.doc.cursors.get(userId);
    if (existing) {
      existing.position = position;
      existing.lastActive = Date.now();
      if (selection) existing.selection = selection;
    }
    this.emitter.emit('cursor-move', userId, position, selection);
  }

  /**
   * Add a cursor for a peer.
   */
  addCursor(cursor: CursorPresence): void {
    this.doc.cursors.set(cursor.userId, cursor);
    this.emitter.emit('cursor-join', cursor);
  }

  /**
   * Remove a cursor for a peer.
   */
  removeCursor(userId: string): void {
    this.doc.cursors.delete(userId);
    this.emitter.emit('cursor-leave', userId);
  }

  /**
   * Get all cursors on this document.
   */
  getCursors(): CursorPresence[] {
    return [...this.doc.cursors.values()];
  }

  /**
   * Get the complete document snapshot for syncing a new peer.
   */
  getSnapshot(): { content: string; clock: number; versionVector: Record<string, number> } {
    const vv: Record<string, number> = {};
    for (const [client, clock] of this.doc.versionVector) {
      vv[client] = clock;
    }
    return {
      content: this.doc.content,
      clock: this.doc.clock,
      versionVector: vv,
    };
  }

  /**
   * Get the current content.
   */
  getContent(): string {
    return this.doc.content;
  }

  /**
   * Get the file path.
   */
  getFilePath(): string {
    return this.doc.filePath;
  }

  /**
   * Register event listeners.
   */
  on(event: 'change', fn: (op: TextOp, content: string) => void): void;
  on(event: 'remote-change', fn: (op: TextOp, content: string) => void): void;
  on(event: 'cursor-move', fn: (userId: string, position: number, selection?: { anchor: number; head: number }) => void): void;
  on(event: 'cursor-join', fn: (cursor: CursorPresence) => void): void;
  on(event: 'cursor-leave', fn: (userId: string) => void): void;
  on(event: string, fn: (...args: any[]) => void): void {
    this.emitter.on(event, fn);
  }

  /**
   * Remove event listeners.
   */
  off(event: string, fn: (...args: any[]) => void): void {
    this.emitter.off(event, fn);
  }
}

// ---------------------------------------------------------------------------
// WebRTC Signaling Client
// ---------------------------------------------------------------------------

export interface SignalingConfig {
  /** Signaling server WebSocket URL */
  url: string;
  /** Room ID */
  roomId: string;
  /** Local peer information */
  peer: {
    id: string;
    displayName: string;
    color: string;
  };
  /** Reconnect interval (ms) */
  reconnectMs?: number;
}

export class SignalingClient {
  private config: SignalingConfig;
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private emitter: EventEmitter;
  private connected: boolean = false;
  private messageQueue: SignalMessage[] = [];

  constructor(config: SignalingConfig) {
    this.config = config;
    this.emitter = new EventEmitter();
  }

  /**
   * Connect to the signaling server.
   */
  connect(): void {
    try {
      this.ws = new WebSocket(this.config.url);

      this.ws.onopen = () => {
        this.connected = true;
        // Send join message
        this.send({
          type: 'join',
          from: this.config.peer.id,
          to: '*',
          payload: {
            displayName: this.config.peer.displayName,
            color: this.config.peer.color,
          },
          timestamp: Date.now(),
          roomId: this.config.roomId,
        });

        // Flush queued messages
        for (const msg of this.messageQueue) {
          this.send(msg);
        }
        this.messageQueue = [];

        this.emitter.emit('connected');
      };

      this.ws.onmessage = (event: MessageEvent) => {
        try {
          const message: SignalMessage = JSON.parse(event.data as string);
          if (message.roomId !== this.config.roomId) return;
          this.emitter.emit('message', message);
        } catch {
          // ignore malformed messages
        }
      };

      this.ws.onclose = () => {
        this.connected = false;
        this.emitter.emit('disconnected');
        this.scheduleReconnect();
      };

      this.ws.onerror = (err: Event) => {
        this.emitter.emit('error', err);
      };
    } catch (err) {
      this.emitter.emit('error', err);
      this.scheduleReconnect();
    }
  }

  /**
   * Send a signaling message via the WebSocket.
   */
  send(message: SignalMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    } else {
      this.messageQueue.push(message);
    }
  }

  /**
   * Disconnect from the signaling server.
   */
  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.ws) {
      // Send leave message
      try {
        this.send({
          type: 'leave',
          from: this.config.peer.id,
          to: '*',
          payload: {},
          timestamp: Date.now(),
          roomId: this.config.roomId,
        });
      } catch {
        // ignore
      }
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
  }

  /**
   * Whether the signaling connection is active.
   */
  isConnected(): boolean {
    return this.connected;
  }

  /**
   * Register event handlers.
   */
  on(event: 'connected', fn: () => void): void;
  on(event: 'disconnected', fn: () => void): void;
  on(event: 'message', fn: (message: SignalMessage) => void): void;
  on(event: 'error', fn: (error: Event | Error) => void): void;
  on(event: string, fn: (...args: any[]) => void): void {
    this.emitter.on(event, fn);
  }

  off(event: string, fn: (...args: any[]) => void): void {
    this.emitter.off(event, fn);
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    const delay = this.config.reconnectMs || 5000;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }
}

// ---------------------------------------------------------------------------
// Cursor Presence / Awareness
// ---------------------------------------------------------------------------

const PRESENCE_COLORS = [
  '#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', '#FFEAA7',
  '#DDA0DD', '#98D8C8', '#F7DC6F', '#BB8FCE', '#85C1E9',
  '#F8C471', '#82E0AA', '#F1948A', '#85C1E9', '#BB8FCE',
];

export class PresenceManager {
  private cursors: Map<string, CursorPresence> = new Map();
  private usedColors: Set<string> = new Set();
  private emitter: EventEmitter;

  constructor() {
    this.emitter = new EventEmitter();
  }

  /**
   * Register a new peer's presence.
   */
  register(userId: string, displayName: string): CursorPresence {
    const color = this.assignColor();
    const presence: CursorPresence = {
      userId,
      displayName,
      color,
      position: 0,
      lastActive: Date.now(),
      filePath: '',
    };
    this.cursors.set(userId, presence);
    this.emitter.emit('joined', presence);
    return presence;
  }

  /**
   * Update a peer's cursor position.
   */
  updateCursor(
    userId: string,
    position: number,
    filePath?: string,
    selection?: { anchor: number; head: number },
  ): void {
    const presence = this.cursors.get(userId);
    if (!presence) return;

    presence.position = position;
    presence.lastActive = Date.now();
    if (filePath) presence.filePath = filePath;
    if (selection) presence.selection = selection;

    this.emitter.emit('moved', presence);
  }

  /**
   * Remove a peer's presence.
   */
  remove(userId: string): void {
    const presence = this.cursors.get(userId);
    if (presence) {
      this.usedColors.delete(presence.color);
    }
    this.cursors.delete(userId);
    this.emitter.emit('left', userId);
  }

  /**
   * Get all active presences.
   */
  getAll(): CursorPresence[] {
    return [...this.cursors.values()].filter(
      p => Date.now() - p.lastActive < 300_000, // 5 minutes timeout
    );
  }

  /**
   * Get a specific peer's presence.
   */
  get(userId: string): CursorPresence | undefined {
    return this.cursors.get(userId);
  }

  /**
   * Register event handlers.
   */
  on(event: 'joined', fn: (presence: CursorPresence) => void): void;
  on(event: 'moved', fn: (presence: CursorPresence) => void): void;
  on(event: 'left', fn: (userId: string) => void): void;
  on(event: string, fn: (...args: any[]) => void): void {
    this.emitter.on(event, fn);
  }

  off(event: string, fn: (...args: any[]) => void): void {
    this.emitter.off(event, fn);
  }

  private assignColor(): string {
    for (const color of PRESENCE_COLORS) {
      if (!this.usedColors.has(color)) {
        this.usedColors.add(color);
        return color;
      }
    }
    // All colors used, generate a random one
    const hue = Math.floor(Math.random() * 360);
    return `hsl(${hue}, 70%, 60%)`;
  }
}

// ---------------------------------------------------------------------------
// Multiplayer Session — main entry point
// ---------------------------------------------------------------------------

export interface MultiplayerConfig {
  /** Signaling server URL */
  signalingUrl: string;
  /** Unique peer ID */
  peerId?: string;
  /** Display name */
  displayName?: string;
  /** Room ID for the session */
  roomId?: string;
  /** Reconnect interval in ms */
  reconnectMs?: number;
}

export class MultiplayerSession {
  private config: MultiplayerConfig;
  private session: CollaborationSession;
  private signaling: SignalingClient;
  private presence: PresenceManager;
  private docs: Map<string, CrdtDocument> = new Map();

  constructor(config: MultiplayerConfig) {
    const peerId = config.peerId || `peer-${randomUUID().slice(0, 8)}`;
    const roomId = config.roomId || randomUUID();

    this.config = config;

    this.session = {
      id: randomUUID(),
      roomId,
      participants: new Map(),
      documents: new Map(),
      signalingUrl: config.signalingUrl,
      connected: false,
      createdAt: Date.now(),
    };

    const color = PRESENCE_COLORS[Math.floor(Math.random() * PRESENCE_COLORS.length)];

    this.signaling = new SignalingClient({
      url: config.signalingUrl,
      roomId,
      peer: {
        id: peerId,
        displayName: config.displayName || 'Anonymous',
        color,
      },
      reconnectMs: config.reconnectMs,
    });

    this.presence = new PresenceManager();
    this.setupSignalingHandlers();
  }

  /**
   * Start the multiplayer session.
   */
  start(): void {
    this.signaling.connect();
  }

  /**
   * Stop the session.
   */
  stop(): void {
    this.signaling.disconnect();
    this.session.connected = false;
  }

  /**
   * Open a file for collaborative editing.
   */
  openFile(filePath: string, content: string): CrdtDocument {
    const existing = this.docs.get(filePath);
    if (existing) return existing;

    const doc = new CrdtDocument(filePath, content);
    this.docs.set(filePath, doc);

    // Notify peers
    this.signaling.send({
      type: 'file-open',
      from: this.config.peerId || 'unknown',
      to: '*',
      payload: { filePath, content },
      timestamp: Date.now(),
      roomId: this.session.roomId,
    });

    // Update own presence
    this.presence.updateCursor(
      this.config.peerId || 'unknown',
      0,
      filePath,
    );

    return doc;
  }

  /**
   * Apply a local edit and broadcast it.
   */
  applyEdit(
    filePath: string,
    type: 'insert' | 'delete',
    position: number,
    contentOrLength: string | number,
  ): TextOp | null {
    const doc = this.docs.get(filePath);
    if (!doc) return null;

    const clientId = this.config.peerId || 'unknown';
    let op: TextOp;

    if (type === 'insert') {
      op = doc.createInsert(position, contentOrLength as string, clientId);
    } else {
      op = doc.createDelete(position, contentOrLength as number, clientId);
    }

    // Apply locally
    doc.applyLocal(op);

    // Broadcast to peers
    this.signaling.send({
      type: 'op',
      from: clientId,
      to: '*',
      payload: { filePath, op },
      timestamp: Date.now(),
      roomId: this.session.roomId,
    });

    return op;
  }

  /**
   * Move cursor and broadcast presence.
   */
  moveCursor(
    filePath: string,
    position: number,
    selection?: { anchor: number; head: number },
  ): void {
    this.presence.updateCursor(
      this.config.peerId || 'unknown',
      position,
      filePath,
      selection,
    );

    // Update the document's cursors
    const doc = this.docs.get(filePath);
    if (doc) {
      doc.updateCursor(this.config.peerId || 'unknown', position, selection);
    }

    // Broadcast cursor position
    this.signaling.send({
      type: 'cursor',
      from: this.config.peerId || 'unknown',
      to: '*',
      payload: { filePath, position, selection },
      timestamp: Date.now(),
      roomId: this.session.roomId,
    });
  }

  /**
   * Get the collaborative document for a file.
   */
  getDocument(filePath: string): CrdtDocument | undefined {
    return this.docs.get(filePath);
  }

  /**
   * Get all participants.
   */
  getParticipants(): Peer[] {
    return [...this.session.participants.values()];
  }

  /**
   * Get all cursor presences.
   */
  getPresences(): CursorPresence[] {
    return this.presence.getAll();
  }

  /**
   * Get the session info.
   */
  getSession(): CollaborationSession {
    return this.session;
  }

  /**
   * Whether the session is connected.
   */
  isConnected(): boolean {
    return this.session.connected;
  }

  /**
   * Register event handlers.
   */
  on(
    event: 'peer-joined' | 'peer-left',
    fn: (peer: Peer) => void,
  ): void;
  on(
    event: 'remote-edit',
    fn: (filePath: string, op: TextOp) => void,
  ): void;
  on(
    event: 'cursor-move',
    fn: (userId: string, filePath: string, position: number) => void,
  ): void;
  on(event: string, fn: (...args: any[]) => void): void {
    this.presence.on(event as any, fn as any);
  }

  // -----------------------------------------------------------------------
  // Signaling message handlers
  // -----------------------------------------------------------------------

  private setupSignalingHandlers(): void {
    this.signaling.on('connected', () => {
      this.session.connected = true;
    });

    this.signaling.on('disconnected', () => {
      this.session.connected = false;
    });

    this.signaling.on('message', (msg: SignalMessage) => {
      switch (msg.type) {
        case 'join':
          this.handlePeerJoin(msg);
          break;
        case 'leave':
          this.handlePeerLeave(msg);
          break;
        case 'op':
          this.handleRemoteOp(msg);
          break;
        case 'cursor':
          this.handleCursorMove(msg);
          break;
        case 'file-open':
          this.handleFileOpen(msg);
          break;
        case 'sync-request':
          this.handleSyncRequest(msg);
          break;
        case 'sync-response':
          this.handleSyncResponse(msg);
          break;
        default:
          // Offer/Answer/ICE are handled by WebRTC layer
          break;
      }
    });
  }

  private handlePeerJoin(msg: SignalMessage): void {
    const payload = msg.payload as { displayName: string; color: string };
    const peer: Peer = {
      id: msg.from,
      displayName: payload.displayName || 'Unknown',
      color: payload.color || '#999',
      connected: true,
      channelState: 'open',
      iceState: 'connected',
      joinedAt: Date.now(),
      lastMessageAt: Date.now(),
    };

    this.session.participants.set(msg.from, peer);
    this.presence.register(msg.from, peer.displayName);

    // Send our state to sync the new peer
    for (const [filePath, doc] of this.docs) {
      const snapshot = doc.getSnapshot();
      this.signaling.send({
        type: 'sync-response',
        from: this.config.peerId || 'unknown',
        to: msg.from,
        payload: { filePath, snapshot },
        timestamp: Date.now(),
        roomId: this.session.roomId,
      });
    }
  }

  private handlePeerLeave(msg: SignalMessage): void {
    this.session.participants.delete(msg.from);
    this.presence.remove(msg.from);

    // Remove their cursors from all documents
    for (const doc of this.docs.values()) {
      doc.removeCursor(msg.from);
    }
  }

  private handleRemoteOp(msg: SignalMessage): void {
    const payload = msg.payload as { filePath: string; op: TextOp };
    let doc = this.docs.get(payload.filePath);

    // If we don't have the document, request a sync
    if (!doc) {
      this.signaling.send({
        type: 'sync-request',
        from: this.config.peerId || 'unknown',
        to: msg.from,
        payload: { filePath: payload.filePath },
        timestamp: Date.now(),
        roomId: this.session.roomId,
      });
      return;
    }

    // Transform and apply the remote operation
    doc.applyRemote(payload.op);
  }

  private handleCursorMove(msg: SignalMessage): void {
    const payload = msg.payload as {
      filePath: string;
      position: number;
      selection?: { anchor: number; head: number };
    };

    this.presence.updateCursor(
      msg.from,
      payload.position,
      payload.filePath,
      payload.selection,
    );

    const doc = this.docs.get(payload.filePath);
    if (doc) {
      doc.updateCursor(msg.from, payload.position, payload.selection);
    }
  }

  private handleFileOpen(msg: SignalMessage): void {
    const payload = msg.payload as { filePath: string; content: string };
    let doc = this.docs.get(payload.filePath);

    if (!doc) {
      doc = new CrdtDocument(payload.filePath, payload.content);
      this.docs.set(payload.filePath, doc);
    }

    this.presence.updateCursor(msg.from, 0, payload.filePath);
  }

  private handleSyncRequest(msg: SignalMessage): void {
    const payload = msg.payload as { filePath: string };
    const doc = this.docs.get(payload.filePath);

    if (doc) {
      this.signaling.send({
        type: 'sync-response',
        from: this.config.peerId || 'unknown',
        to: msg.from,
        payload: {
          filePath: payload.filePath,
          snapshot: doc.getSnapshot(),
        },
        timestamp: Date.now(),
        roomId: this.session.roomId,
      });
    }
  }

  private handleSyncResponse(msg: SignalMessage): void {
    const payload = msg.payload as {
      filePath: string;
      snapshot: { content: string; clock: number; versionVector: Record<string, number> };
    };

    let doc = this.docs.get(payload.filePath);
    if (!doc) {
      doc = new CrdtDocument(payload.filePath, payload.snapshot.content);
      this.docs.set(payload.filePath, doc);
    }
  }
}

// ---------------------------------------------------------------------------
// Convenience factory
// ---------------------------------------------------------------------------

/**
 * Create and start a multiplayer collaboration session.
 */
export function createMultiplayerSession(config: MultiplayerConfig): MultiplayerSession {
  const session = new MultiplayerSession(config);
  session.start();
  return session;
}
