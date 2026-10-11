import { WebSocketServer, WebSocket } from 'ws';
import type { Server as HttpServer } from 'node:http';
import { serverEvents } from './events.js';
import { loadToken } from '../middleware/auth.js';

interface WsClient {
  ws: WebSocket;
  channels: Set<string>;
}

const clients = new Set<WsClient>();

export function setupWebSocket(server: HttpServer): WebSocketServer {
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const token = url.searchParams.get('token');
    const expected = loadToken();

    if (expected && token !== expected) {
      ws.close(4001, 'Unauthorized');
      return;
    }

    const client: WsClient = { ws, channels: new Set(['*']) };
    clients.add(client);

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'subscribe' && msg.channel) {
          client.channels.add(msg.channel);
        } else if (msg.type === 'unsubscribe' && msg.channel) {
          client.channels.delete(msg.channel);
        }
      } catch { /* ignore invalid messages */ }
    });

    ws.on('close', () => { clients.delete(client); });
    ws.on('error', () => { clients.delete(client); });

    ws.send(JSON.stringify({ type: 'connected', timestamp: Date.now() }));
  });

  serverEvents.on('broadcast', (eventStr: string) => {
    for (const client of clients) {
      if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(eventStr);
      }
    }
  });

  return wss;
}
