import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  setMemory,
  getAllMemory,
  clearMemory,
  TypedMemoryStore,
} from '../src/core/agent-memory.js';

describe('agent-memory', () => {
  // Reset in-memory store before each test
  beforeEach(() => {
    clearMemory();
  });

  describe('simple memory', () => {
    it('setMemory() / getAllMemory() should roundtrip', () => {
      setMemory('project-name', 'cobra-commander', 'user');
      const all = getAllMemory();
      expect(all).toHaveLength(1);
      expect(all[0].key).toBe('project-name');
      expect(all[0].value).toBe('cobra-commander');
      expect(all[0].author).toBe('user');
    });

    it('clearMemory() should empty the store', () => {
      setMemory('key1', 'val1');
      setMemory('key2', 'val2');
      expect(getAllMemory()).toHaveLength(2);
      clearMemory();
      expect(getAllMemory()).toHaveLength(0);
    });

    it('getAllMemory() should return entries sorted by timestamp descending', async () => {
      setMemory('first', 'old');
      // Wait a tiny bit to ensure different timestamps
      await new Promise(r => setTimeout(r, 5));
      setMemory('second', 'new');
      const all = getAllMemory();
      expect(all[0].key).toBe('second');
      expect(all[1].key).toBe('first');
    });
  });

  describe('TypedMemoryStore', () => {
    let storeDir: string;
    let store: TypedMemoryStore;

    beforeEach(() => {
      storeDir = mkdtempSync(join(tmpdir(), 'memory-store-'));
      store = new TypedMemoryStore(storeDir);
    });

    afterEach(() => {
      rmSync(storeDir, { recursive: true, force: true });
    });

    it('save() / load() should roundtrip with YAML frontmatter', () => {
      store.save({
        name: 'Test Entry',
        description: 'A test memory entry',
        type: 'reference',
        content: 'This is the content',
        links: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      const loaded = store.load('Test Entry');
      expect(loaded).not.toBeNull();
      expect(loaded!.name).toBe('test-entry');
      expect(loaded!.description).toBe('A test memory entry');
      expect(loaded!.content).toBe('This is the content');
      expect(loaded!.type).toBe('reference');
    });

    it('search() should find matching entries', () => {
      store.save({
        name: 'API Design',
        description: 'REST API design patterns',
        type: 'reference',
        content: 'Use RESTful endpoints',
        links: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      store.save({
        name: 'Database Schema',
        description: 'PostgreSQL schema design',
        type: 'project',
        content: 'Tables and relations',
        links: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      const results = store.search('REST');
      expect(results).toHaveLength(1);
      expect(results[0].name).toBe('api-design');
    });

    it('list() should filter by type', () => {
      store.save({
        name: 'User Feedback',
        description: 'User said X',
        type: 'feedback',
        content: 'Feedback content',
        links: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      store.save({
        name: 'Project Config',
        description: 'Config details',
        type: 'project',
        content: 'Config content',
        links: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      const feedbacks = store.list('feedback');
      expect(feedbacks).toHaveLength(1);
      expect(feedbacks[0].type).toBe('feedback');

      const projects = store.list('project');
      expect(projects).toHaveLength(1);
      expect(projects[0].type).toBe('project');
    });

    it('save() should create a file with YAML frontmatter', () => {
      store.save({
        name: 'My Memory',
        description: 'Desc',
        type: 'user',
        content: 'Hello world',
        links: [],
        createdAt: 1000,
        updatedAt: 2000,
      });

      const filePath = join(storeDir, 'my-memory.md');
      expect(existsSync(filePath)).toBe(true);
      const content = readFileSync(filePath, 'utf-8');
      expect(content).toContain('name: my-memory');
      expect(content).toContain('type: user');
      expect(content).toContain('Hello world');
    });

    it('load() should return null for non-existent entry', () => {
      const result = store.load('nonexistent');
      expect(result).toBeNull();
    });
  });
});
