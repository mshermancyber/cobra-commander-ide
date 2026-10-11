import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendJson, sendError } from '../middleware/error-handler.js';
import { NotepadManager, NotepadSearch, type Notepad } from '../../core/notepads.js';

// Singleton manager for the API server lifetime
const notepadManager = new NotepadManager();
const notepadSearch = new NotepadSearch(notepadManager);

export function getNotepadManager(): NotepadManager {
  return notepadManager;
}

async function parseBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString()));
      } catch {
        resolve({});
      }
    });
    req.on('error', reject);
  });
}

export function createNotepadRoutes() {
  // GET /api/v1/notepads — list/search notepads
  async function listNotepads(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url || '/', 'http://localhost');
    const query = url.searchParams.get('q');
    const project = url.searchParams.get('project') || undefined;
    const tag = url.searchParams.get('tag');
    const pinned = url.searchParams.get('pinned');
    const global = url.searchParams.get('global');

    let notepads: Notepad[];

    if (query) {
      const results = notepadSearch.search(query, { project });
      notepads = results.map(r => r.notepad);
    } else {
      notepads = notepadManager.list({
        project,
        tags: tag ? [tag] : undefined,
        pinned: pinned === 'true' ? true : pinned === 'false' ? false : undefined,
        global: global === 'true' ? true : global === 'false' ? false : undefined,
      });
    }

    sendJson(res, 200, {
      count: notepads.length,
      notepads: notepads.map(n => ({
        id: n.id,
        title: n.title,
        content: n.content,
        tags: n.tags,
        project: n.project,
        pinned: n.pinned,
        global: n.global,
        createdAt: n.createdAt,
        updatedAt: n.updatedAt,
        author: n.author,
      })),
    });
  }

  // POST /api/v1/notepads — create notepad
  async function createNotepad(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await parseBody(req);
    if (!body.title || typeof body.title !== 'string' || !body.title.trim()) {
      sendError(res, 400, 'Missing or invalid "title" field');
      return;
    }

    const notepad = notepadManager.create({
      title: body.title as string,
      content: (body.content as string) || '',
      tags: Array.isArray(body.tags) ? body.tags as string[] : undefined,
      project: (body.project as string) || undefined,
      pinned: body.pinned === true || body.pinned === 'true',
      global: body.global === true || body.global === 'true',
      author: (body.author as string) || 'api',
    });

    sendJson(res, 201, notepad);
  }

  // GET /api/v1/notepads/:id — get notepad by ID
  async function getNotepad(_req: IncomingMessage, res: ServerResponse, params: Record<string, string>): Promise<void> {
    const notepad = notepadManager.get(params.id);
    if (!notepad) {
      sendError(res, 404, 'Notepad not found');
      return;
    }
    sendJson(res, 200, notepad);
  }

  // PUT /api/v1/notepads/:id — update notepad
  async function updateNotepad(req: IncomingMessage, res: ServerResponse, params: Record<string, string>): Promise<void> {
    const body = await parseBody(req);

    const updates: Partial<Pick<Notepad, 'title' | 'content' | 'tags' | 'pinned' | 'global' | 'project'>> = {};
    if (body.title !== undefined) updates.title = body.title as string;
    if (body.content !== undefined) updates.content = body.content as string;
    if (body.tags !== undefined) updates.tags = body.tags as string[];
    if (body.pinned !== undefined) updates.pinned = body.pinned === true || body.pinned === 'true';
    if (body.global !== undefined) updates.global = body.global === true || body.global === 'true';
    if (body.project !== undefined) updates.project = body.project as string;

    const updated = notepadManager.update(params.id, updates);
    if (!updated) {
      sendError(res, 404, 'Notepad not found');
      return;
    }

    sendJson(res, 200, updated);
  }

  // DELETE /api/v1/notepads/:id — delete notepad
  async function deleteNotepad(_req: IncomingMessage, res: ServerResponse, params: Record<string, string>): Promise<void> {
    const deleted = notepadManager.delete(params.id);
    if (!deleted) {
      sendError(res, 404, 'Notepad not found');
      return;
    }
    sendJson(res, 200, { deleted: true, id: params.id });
  }

  // POST /api/v1/notepads/:id/pin — toggle pin
  async function toggleNotepadPin(_req: IncomingMessage, res: ServerResponse, params: Record<string, string>): Promise<void> {
    const updated = notepadManager.togglePin(params.id);
    if (!updated) {
      sendError(res, 404, 'Notepad not found');
      return;
    }
    sendJson(res, 200, { id: updated.id, pinned: updated.pinned });
  }

  // POST /api/v1/notepads/search — advanced search with snippets
  async function searchNotepads(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await parseBody(req);
    if (!body.query || typeof body.query !== 'string' || !body.query.trim()) {
      sendError(res, 400, 'Missing or invalid "query" field');
      return;
    }

    const results = notepadSearch.searchWithSnippets(
      body.query as string,
      (body.snippetLength as number) || 120,
    );

    sendJson(res, 200, {
      query: body.query,
      count: results.length,
      results,
    });
  }

  // POST /api/v1/notepads/export — export all notepads
  async function exportNotepads(_req: IncomingMessage, res: ServerResponse): Promise<void> {
    const data = notepadManager.exportAll();
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', 'attachment; filename="notepads-export.json"');
    res.writeHead(200);
    res.end(data);
  }

  // POST /api/v1/notepads/import — import notepads
  async function importNotepads(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await parseBody(req);
    if (!body.data) {
      sendError(res, 400, 'Missing "data" field with JSON export');
      return;
    }

    const count = notepadManager.importAll(
      typeof body.data === 'string' ? body.data as string : JSON.stringify(body.data),
    );

    sendJson(res, 200, { imported: count });
  }

  return {
    listNotepads,
    createNotepad,
    getNotepad,
    updateNotepad,
    deleteNotepad,
    toggleNotepadPin,
    searchNotepads,
    exportNotepads,
    importNotepads,
  };
}
