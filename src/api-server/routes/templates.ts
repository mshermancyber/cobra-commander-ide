import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendJson, sendError } from '../middleware/error-handler.js';
import {
  TaskTemplateEngine,
  TaskTemplate,
  TemplateRegistry,
  TemplateValidator,
  TemplateRenderer,
  TemplateContext,
  type ValidationResult,
} from '../../core/task-templates.js';

// ---------------------------------------------------------------------------
// Singleton registry
// ---------------------------------------------------------------------------

const registry = new TemplateRegistry();
const engine = new TaskTemplateEngine();

export function getTemplateRegistry(): TemplateRegistry {
  return registry;
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

export function createTemplateRoutes(workDir: string) {
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

  // GET /api/templates — list all templates, optionally filter by category
  async function listTemplates(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url || '/', 'http://localhost');
    const category = url.searchParams.get('category');
    const tag = url.searchParams.get('tag');

    let templates = registry.list();

    if (category) {
      const tplCat = category as 'crud' | 'api' | 'refactor' | 'testing' | 'devops' | 'documentation' | 'configuration' | 'debugging' | 'migration' | 'performance' | 'security';
      templates = registry.listByCategory(tplCat);
    }

    if (tag) {
      templates = templates.filter(t => t.tags.includes(tag));
    }

    sendJson(res, 200, {
      count: templates.length,
      templates: templates.map(t => ({
        id: t.id,
        name: t.name,
        description: t.description,
        category: t.category,
        tags: t.tags,
        variableCount: t.variables.length,
        requiredVariables: t.variables.filter(v => v.required).map(v => v.name),
      })),
    });
  }

  // GET /api/templates/:name — get a specific template
  async function getTemplate(_req: IncomingMessage, res: ServerResponse, params: Record<string, string>): Promise<void> {
    const name = params.name;
    const template = registry.get(name);

    if (!template) {
      sendError(res, 404, `Template "${name}" not found`);
      return;
    }

    sendJson(res, 200, {
      id: template.id,
      name: template.name,
      description: template.description,
      category: template.category,
      template: template.template,
      variables: template.variables.map(v => ({
        name: v.name,
        description: v.description,
        type: v.type,
        required: v.required,
        defaultValue: v.defaultValue,
        options: v.options,
      })),
      tags: template.tags,
      example: template.example,
    });
  }

  // POST /api/templates/validate — validate a template definition
  async function validateTemplate(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await parseBody(req);

    // Can validate an existing template by ID or a new template definition
    if (body.templateId) {
      const template = registry.get(body.templateId as string);
      if (!template) {
        sendError(res, 404, `Template "${body.templateId}" not found`);
        return;
      }

      // Validate context if provided
      if (body.variables) {
        const result = TemplateValidator.validateContext(template, {
          variables: body.variables as Record<string, string>,
          workDir: body.workDir as string || workDir,
        });
        sendJson(res, 200, result);
        return;
      }

      const result = TemplateValidator.validate(template);
      sendJson(res, 200, result);
      return;
    }

    // Validate a new template definition
    if (body.template) {
      const templateDef = body as unknown as TaskTemplate;
      const result = TemplateValidator.validate(templateDef);
      sendJson(res, 200, result);
      return;
    }

    sendError(res, 400, 'Provide either "templateId" or a full "template" definition');
  }

  // POST /api/templates/render — render a template with variables
  async function renderTemplate(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await parseBody(req);

    if (!body.templateId) {
      sendError(res, 400, 'Missing "templateId" field');
      return;
    }

    const templateId = body.templateId as string;
    const template = registry.get(templateId);

    if (!template) {
      sendError(res, 404, `Template "${templateId}" not found`);
      return;
    }

    const variables = (body.variables as Record<string, string>) || {};
    const context: TemplateContext = {
      variables,
      workDir: (body.workDir as string) || workDir,
      extra: body.extra as Record<string, unknown> | undefined,
    };

    // Validate context
    const validation = TemplateValidator.validateContext(template, context);
    if (!validation.valid) {
      sendError(res, 400, JSON.stringify(validation));
      return;
    }

    // Render
    const rendered = TemplateRenderer.render(template, context);
    if (!rendered) {
      sendError(res, 400, 'Failed to render template');
      return;
    }

    sendJson(res, 200, {
      templateId: rendered.id,
      name: rendered.name,
      category: rendered.category,
      content: rendered.content,
      summary: rendered.summary,
      expectedFiles: rendered.expectedFiles,
      effort: rendered.effort,
      warnings: validation.warnings,
    });
  }

  // GET /api/templates/categories — list template categories
  async function listCategories(_req: IncomingMessage, res: ServerResponse, _params: Record<string, string>): Promise<void> {
    const templates = registry.list();
    const categories = new Map<string, number>();
    for (const tpl of templates) {
      categories.set(tpl.category, (categories.get(tpl.category) || 0) + 1);
    }

    sendJson(res, 200, {
      categories: [...categories.entries()].map(([name, count]) => ({ name, count })),
    });
  }

  return { listTemplates, getTemplate, validateTemplate, renderTemplate, listCategories };
}
