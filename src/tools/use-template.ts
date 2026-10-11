import type { ToolDefinition, ToolCall } from '../core/types.js';
import { installRoot } from '../core/env-file.js';
import {
  TemplateRegistry,
  TemplateRenderer,
  TemplateValidator,
  type TaskTemplate,
} from '../core/task-templates.js';

// Singleton registry shared with API routes
const registry = new TemplateRegistry();

export function getTemplateRegistry(): TemplateRegistry {
  return registry;
}

// ─── Tool definition ────────────────────────────────────────────────────────

export const useTemplateTool: ToolDefinition = {
  name: 'use_template',
  description: `Render a task template to generate a well-structured task prompt. Use this when delegating work to create consistent, detailed task descriptions. You can list available templates, get details about a specific template, or render a template with variables filled in.`,
  input_schema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['list', 'describe', 'render'],
        description: 'What to do: "list" all available templates, "describe" a specific template, or "render" a template with variables',
      },
      templateId: {
        type: 'string',
        description: 'Template ID (required for "describe" and "render" actions). Use ids from the list action.',
      },
      variables: {
        type: 'object',
        description: 'Variable values for rendering (required for "render" action). Map of variable name → value.',
      },
    },
    required: ['action'],
  },
};

// ─── Execute ────────────────────────────────────────────────────────────────

export function executeUseTemplate(input: Record<string, unknown>): { result: string; is_error: boolean } {
  const action = input.action as string;

  switch (action) {
    case 'list': {
      const templates = registry.list();
      if (templates.length === 0) {
        return { result: 'No templates available.', is_error: false };
      }

      const byCategory = new Map<string, TaskTemplate[]>();
      for (const tpl of templates) {
        if (!byCategory.has(tpl.category)) byCategory.set(tpl.category, []);
        byCategory.get(tpl.category)!.push(tpl);
      }

      let output = `Available templates (${templates.length}):\n\n`;
      for (const [category, tpls] of [...byCategory.entries()].sort()) {
        output += `## ${category}\n`;
        for (const tpl of tpls) {
          output += `- **${tpl.id}**: ${tpl.name} — ${tpl.description}\n`;
          const required = tpl.variables.filter(v => v.required).map(v => v.name);
          if (required.length > 0) {
            output += `  Required vars: ${required.join(', ')}\n`;
          }
        }
        output += '\n';
      }
      return { result: output, is_error: false };
    }

    case 'describe': {
      const templateId = input.templateId as string;
      if (!templateId) {
        return { result: 'Error: "templateId" is required for describe action', is_error: true };
      }

      const template = registry.get(templateId);
      if (!template) {
        return {
          result: `Error: Template "${templateId}" not found. Use action=list to see available templates.`,
          is_error: true,
        };
      }

      let output = `## ${template.id}: ${template.name}\n`;
      output += `**Category:** ${template.category}\n`;
      output += `**Description:** ${template.description}\n`;
      output += `**Tags:** ${template.tags.join(', ')}\n\n`;

      output += `### Template\n\`\`\`\n${template.template}\n\`\`\`\n\n`;

      output += `### Variables\n`;
      for (const v of template.variables) {
        const req = v.required ? ' (required)' : ' (optional)';
        const def = v.defaultValue ? ` [default: ${v.defaultValue}]` : '';
        const opts = v.options ? ` options: [${v.options.join(', ')}]` : '';
        output += `- **${v.name}** (${v.type})${req}${def}${opts}: ${v.description}\n`;
      }

      if (template.example) {
        output += `\n### Example\n${template.example}\n`;
      }

      return { result: output, is_error: false };
    }

    case 'render': {
      const templateId = input.templateId as string;
      if (!templateId) {
        return { result: 'Error: "templateId" is required for render action', is_error: true };
      }

      const variables = (input.variables as Record<string, string>) || {};
      const template = registry.get(templateId);
      if (!template) {
        return {
          result: `Error: Template "${templateId}" not found. Use action=list to see available templates.`,
          is_error: true,
        };
      }

      // Validate required variables
      const ctx = { variables, workDir: installRoot() };
      const validation = TemplateValidator.validateContext(template, ctx);
      if (!validation.valid) {
        return {
          result: `Error: Missing or invalid variables:\n${validation.errors?.join('\n') || 'Unknown validation error'}`,
          is_error: true,
        };
      }

      // Render
      const rendered = TemplateRenderer.render(template, ctx);
      if (!rendered) {
        return { result: 'Error: Failed to render template', is_error: true };
      }

      let output = `## Rendered Template: ${rendered.name}\n`;
      output += `**Category:** ${rendered.category}\n`;
      output += `**Effort:** ${rendered.effort}\n`;
      if (rendered.expectedFiles.length > 0) {
        output += `**Expected files:** ${rendered.expectedFiles.join(', ')}\n`;
      }
      output += `\n### Task\n\`\`\`\n${rendered.content}\n\`\`\`\n`;

      if (validation.warnings && validation.warnings.length > 0) {
        output += `\n### Warnings\n`;
        for (const w of validation.warnings) {
          output += `- ${w}\n`;
        }
      }

      return { result: output, is_error: false };
    }

    default:
      return {
        result: `Error: Unknown action "${action}". Use "list", "describe", or "render".`,
        is_error: true,
      };
  }
}
