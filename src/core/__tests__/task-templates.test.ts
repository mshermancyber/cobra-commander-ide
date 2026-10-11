import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  TaskTemplateEngine,
  TemplateRegistry,
  TemplateValidator,
  TemplateRenderer,
  getBuiltinTemplates,
  quickRenderTemplate,
  type TaskTemplate,
  type TemplateContext,
} from '../task-templates.js';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Helper to create a test template
function makeTestTemplate(overrides?: Partial<TaskTemplate>): TaskTemplate {
  return {
    id: 'test-template',
    name: 'Test Template',
    description: 'A template for testing',
    category: 'configuration',
    template: 'Hello {{name}}, your role is {{role}}.',
    variables: [
      { name: 'name', description: 'User name', defaultValue: 'World', required: true, type: 'string' },
      { name: 'role', description: 'User role', defaultValue: 'Developer', required: false, type: 'select', options: ['Developer', 'Designer', 'Manager'] },
    ],
    tags: ['test'],
    ...overrides,
  };
}

describe('TaskTemplateEngine', () => {
  it('loads built-in templates on construction', () => {
    const engine = new TaskTemplateEngine();
    const templates = engine.listTemplates();
    assert.ok(templates.length >= 4, 'Should have at least 4 built-in templates');
  });

  it('lists templates by category', () => {
    const engine = new TaskTemplateEngine();
    const crud = engine.listByCategory('crud');
    assert.ok(crud.length > 0, 'Should have CRUD templates');
    assert.ok(crud.every(t => t.category === 'crud'));
  });

  it('returns undefined for non-existent template', () => {
    const engine = new TaskTemplateEngine();
    assert.equal(engine.getTemplate('non-existent'), undefined);
  });

  it('renders a built-in template with variable substitution', () => {
    const engine = new TaskTemplateEngine();
    const result = engine.render('add-crud', {
      variables: { entityName: 'Product', entityFields: 'name:string', routePrefix: '/products' },
      workDir: '/tmp',
    });
    assert.ok(result, 'Should render successfully');
    assert.ok(result!.content.includes('Product'), 'Should substitute entityName');
    assert.ok(result!.content.includes('/products'), 'Should substitute routePrefix');
    assert.equal(result!.effort, 'large', 'CRUD template should be large effort');
  });

  it('returns null for missing required variables', () => {
    const engine = new TaskTemplateEngine();
    const result = engine.render('add-crud', {
      variables: {},  // Missing all required vars
      workDir: '/tmp',
    });
    assert.equal(result, null, 'Should return null when required vars are missing');
  });

  it('uses default values when variables not provided', () => {
    const engine = new TaskTemplateEngine();
    // add-crud has entityName default 'Item'
    const result = engine.render('add-crud', {
      variables: { entityFields: 'name:string', routePrefix: '/items' },
      workDir: '/tmp',
    });
    assert.ok(result, 'Should render with defaults');
    assert.ok(result!.content.includes('Item'), 'Should use default entityName "Item"');
  });
});

describe('Template Validator', () => {
  it('validates a correct template', () => {
    const template = makeTestTemplate();
    const result = TemplateValidator.validate(template);
    assert.equal(result.valid, true);
    assert.equal(result.errors.length, 0);
  });

  it('rejects template with empty ID', () => {
    const template = makeTestTemplate({ id: '' });
    const result = TemplateValidator.validate(template);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.field === 'id'));
  });

  it('rejects template with empty name', () => {
    const template = makeTestTemplate({ name: '' });
    const result = TemplateValidator.validate(template);
    assert.equal(result.valid, false);
  });

  it('rejects template with empty content', () => {
    const template = makeTestTemplate({ template: '' });
    const result = TemplateValidator.validate(template);
    assert.equal(result.valid, false);
  });

  it('warns about undefined variables in template', () => {
    const template = makeTestTemplate({
      template: 'Hello {{name}}, your status is {{status}}.',
      variables: [{ name: 'name', description: 'Name', required: true, type: 'string' }],
    });
    const result = TemplateValidator.validate(template);
    assert.ok(result.warnings.length > 0, 'Should warn about undefined variable "status"');
  });

  it('warns about duplicate variable names', () => {
    const template = makeTestTemplate({
      variables: [
        { name: 'name', description: 'Name', required: true, type: 'string' },
        { name: 'name', description: 'Name again', required: false, type: 'string' },
      ],
    });
    const result = TemplateValidator.validate(template);
    assert.ok(result.errors.some(e => e.field.includes('name') && e.message.includes('Duplicate')));
  });

  it('validates context against template requirements', () => {
    const template = makeTestTemplate();
    const result = TemplateValidator.validateContext(template, {
      variables: { name: 'Alice' },
      workDir: '/tmp',
    });
    assert.equal(result.valid, true);
  });

  it('rejects context missing required variables without defaults', () => {
    const template = makeTestTemplate({
      variables: [
        { name: 'name', description: 'Name', required: true, type: 'string' },
      ],
    });
    // name has no default and isn't provided
    const result = TemplateValidator.validateContext(template, {
      variables: {},
      workDir: '/tmp',
    });
    assert.equal(result.valid, false);
  });
});

describe('Template Renderer', () => {
  it('renders a template with variable substitution', () => {
    const template = makeTestTemplate();
    const result = TemplateRenderer.render(template, {
      variables: { name: 'Alice', role: 'Developer' },
      workDir: '/tmp',
    });
    assert.ok(result);
    assert.equal(result!.content, 'Hello Alice, your role is Developer.');
  });

  it('uses defaults when variables not provided', () => {
    const template = makeTestTemplate();
    const result = TemplateRenderer.render(template, {
      variables: { name: 'Bob' },
      workDir: '/tmp',
    });
    assert.ok(result);
    assert.equal(result!.content, 'Hello Bob, your role is Developer.');
  });

  it('returns null for invalid context', () => {
    const template = makeTestTemplate({
      variables: [
        { name: 'name', description: 'Name', required: true, type: 'string' },
      ],
    });
    const result = TemplateRenderer.render(template, {
      variables: {},  // missing required name
      workDir: '/tmp',
    });
    assert.equal(result, null);
  });
});

describe('Template Registry with directory discovery', () => {
  it('preloads built-in templates', () => {
    const registry = new TemplateRegistry();
    assert.ok(registry.count >= 4);
  });

  it('registers and retrieves templates', () => {
    const registry = new TemplateRegistry();
    const template = makeTestTemplate({ id: 'custom-test' });
    registry.register(template);
    assert.equal(registry.get('custom-test')?.name, 'Test Template');
  });

  it('lists templates by category', () => {
    const registry = new TemplateRegistry();
    const crud = registry.listByCategory('crud');
    assert.ok(crud.length > 0);
    assert.ok(crud.every(t => t.category === 'crud'));
  });

  it('discovers templates from a directory', () => {
    const tmpDir = join(tmpdir(), `cobra-test-templates-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });

    const jsonTemplate = {
      name: 'Discovered Template',
      description: 'Found via discovery',
      category: 'testing',
      template: 'Test {{var1}} with {{var2}}',
      variables: [
        { name: 'var1', description: 'First var', required: true },
        { name: 'var2', description: 'Second var', defaultValue: 'default' },
      ],
      tags: ['discovered'],
    };

    writeFileSync(join(tmpDir, 'discovered.json'), JSON.stringify(jsonTemplate));

    try {
      const registry = new TemplateRegistry();
      const discovered = registry.discover(tmpDir);
      assert.ok(discovered.length > 0, 'Should discover at least one template');
      assert.equal(discovered[0].name, 'Discovered Template');
    } finally {
      try { rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
    }
  });

  it('unregisters templates', () => {
    const registry = new TemplateRegistry();
    const template = makeTestTemplate({ id: 'to-remove' });
    registry.register(template);
    assert.ok(registry.get('to-remove'));
    registry.unregister('to-remove');
    assert.equal(registry.get('to-remove'), undefined);
  });
});

describe('Quick render convenience', () => {
  it('renders without needing the engine', () => {
    const result = quickRenderTemplate('add-crud', {
      entityName: 'Widget',
      entityFields: 'title:string',
      routePrefix: '/widgets',
    });
    assert.ok(result);
    assert.ok(result!.content.includes('Widget'));
  });

  it('returns null for unknown template', () => {
    const result = quickRenderTemplate('no-such-template', {});
    assert.equal(result, null);
  });
});

describe('Built-in templates', () => {
  it('returns all built-in templates', () => {
    const templates = getBuiltinTemplates();
    assert.ok(templates.length >= 4);
    const ids = templates.map(t => t.id);
    assert.ok(ids.includes('add-crud'));
    assert.ok(ids.includes('add-api-endpoint'));
    assert.ok(ids.includes('refactor-module'));
    assert.ok(ids.includes('add-tests'));
  });

  it('each built-in has required fields', () => {
    for (const tpl of getBuiltinTemplates()) {
      assert.ok(tpl.id, `Template should have id`);
      assert.ok(tpl.name, `Template ${tpl.id} should have name`);
      assert.ok(tpl.template, `Template ${tpl.id} should have template content`);
      assert.ok(tpl.category, `Template ${tpl.id} should have category`);
    }
  });
});
