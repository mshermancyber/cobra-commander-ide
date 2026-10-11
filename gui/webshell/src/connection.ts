// ---------------------------------------------------------------------------
// WebSocket connection manager with auto-reconnect
// ---------------------------------------------------------------------------

type EventHandler = (...args: any[]) => void;

interface QueuedMessage {
  data: string;
  timestamp: number;
}

export class WSConnection {
  private ws: WebSocket | null = null;
  private url: string;
  private handlers = new Map<string, Set<EventHandler>>();
  private queue: QueuedMessage[] = [];
  private reconnectDelay = 1000;
  private maxReconnectDelay = 30_000;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private shouldReconnect = true;
  private connected = false;
  private intentionalClose = false;

  constructor(url: string) {
    this.url = url;
  }

  connect(): void {
    if (this.ws?.readyState === WebSocket.OPEN || this.ws?.readyState === WebSocket.CONNECTING) {
      return;
    }

    this.intentionalClose = false;
    this.ws = new WebSocket(this.url);

    this.ws.onopen = () => {
      this.connected = true;
      this.reconnectDelay = 1000;
      this.emit('connected');

      // Flush queued messages
      while (this.queue.length > 0) {
        const msg = this.queue.shift()!;
        this.ws?.send(msg.data);
      }
    };

    this.ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data as string);
        this.emit('message', data);
      } catch {
        this.emit('raw', event.data);
      }
    };

    this.ws.onclose = () => {
      this.connected = false;
      this.emit('disconnected');

      if (!this.intentionalClose && this.shouldReconnect) {
        this.scheduleReconnect();
      }
    };

    this.ws.onerror = () => {
      // onclose will fire after this
    };
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
      this.connect();
    }, this.reconnectDelay);
  }

  disconnect(): void {
    this.intentionalClose = true;
    this.shouldReconnect = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  send(data: Record<string, unknown>): void {
    const payload = JSON.stringify(data);
    if (this.connected && this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(payload);
    } else {
      this.queue.push({ data: payload, timestamp: Date.now() });
      // Limit queue size
      if (this.queue.length > 100) {
        this.queue = this.queue.slice(-50);
      }
    }
  }

  on(event: string, handler: EventHandler): void {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, new Set());
    }
    this.handlers.get(event)!.add(handler);
  }

  off(event: string, handler: EventHandler): void {
    this.handlers.get(event)?.delete(handler);
  }

  private emit(event: string, ...args: any[]): void {
    this.handlers.get(event)?.forEach((h) => h(...args));
  }

  get isConnected(): boolean {
    return this.connected;
  }
}
