// Destro agent — tool call schema validation. Created 2026-07-04.
// Validates LLM tool calls against per-tool JSON schemas with bounded retries.

import type { ToolDefinition } from '../core/types.js';

// ──────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────

/** Result of validating a tool call against its schema. */
export interface ToolValidationResult {
  valid: boolean;
  errors: string[];
  correctivePrompt?: string;
}

/** Per-tool-call retry tracker. Keyed by tool call id. */
const retryCounts = new Map<string, number>();

/** Maximum retry attempts per tool call before hard-failing. */
const MAX_RETRIES = 3;

// ──────────────────────────────────────────────
// JSON Schema Type Helpers
// ──────────────────────────────────────────────

type JsonSchemaType = 'string' | 'number' | 'boolean' | 'object' | 'array' | 'null';

interface JsonSchemaProperty {
  type?: JsonSchemaType;
  description?: string;
  // Recursive nesting for objects/arrays is ignored beyond type check
}

interface JsonSchema {
  type?: JsonSchemaType;
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
}

/**
 * Walk the ToolDefinition.input_schema and extract the top-level JSON Schema shape.
 * Treats input_schema as a simple object with optional `type`, `properties`, and `required`.
 */
function extractSchema(def: ToolDefinition): JsonSchema {
  const s = def.input_schema as Record<string, unknown>;
  return {
    type: (s.type as JsonSchemaType) || undefined,
    properties: (s.properties as Record<string, JsonSchemaProperty>) || undefined,
    required: Array.isArray(s.required)
      ? (s.required as string[])
      : undefined,
  };
}

// ──────────────────────────────────────────────
// Validation
// ──────────────────────────────────────────────

/**
 * Check that a value matches the expected JSON Schema type.
 */
function checkType(value: unknown, expected: JsonSchemaType): boolean {
  switch (expected) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number';
    case 'boolean':
      return typeof value === 'boolean';
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value);
    case 'array':
      return Array.isArray(value);
    case 'null':
      return value === null;
    default:
      return true; // Unknown types pass (future-proof)
  }
}

/**
 * Human-readable label for a JSON Schema type.
 */
function typeLabel(t: JsonSchemaType): string {
  switch (t) {
    case 'string':
      return 'a string';
    case 'number':
      return 'a number';
    case 'boolean':
      return 'a boolean (true/false)';
    case 'object':
      return 'an object';
    case 'array':
      return 'an array';
    case 'null':
      return 'null';
    default:
      return t;
  }
}

/**
 * Validate tool call arguments against the tool's input_schema.
 *
 * Checks:
 * - Top-level type is 'object'
 * - Required fields are present
 * - Field types match the schema (string/number/boolean/object/array)
 *
 * Tracks retries per tool call id. On malformed input, builds a corrective
 * reprompt message that can be fed back to the LLM.
 *
 * @param name   - Tool name being called
 * @param args   - Arguments passed to the tool (parsed JSON)
 * @param schemas - Map of tool name → ToolDefinition
 * @param callId - Optional call id for retry tracking
 */
export function validateToolCall(
  name: string,
  args: unknown,
  schemas: Record<string, ToolDefinition>,
  callId?: string,
): ToolValidationResult {
  const errors: string[] = [];

  // Check tool exists in schema map
  const def = schemas[name];
  if (!def) {
    return {
      valid: false,
      errors: [`Unknown tool: "${name}". Available tools: ${Object.keys(schemas).join(', ')}`],
      correctivePrompt: `Tool "${name}" is not available. Please use one of: ${Object.keys(schemas).join(', ')}.`,
    };
  }

  const schema = extractSchema(def);

  // args must be an object (JSON Schema type 'object' for tool input)
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    errors.push(
      `Tool "${name}" expects an object with properties, but received ${args === null ? 'null' : typeof args}.`,
    );

    // Check retries
    if (callId) {
      const current = (retryCounts.get(callId) || 0) + 1;
      retryCounts.set(callId, current);
      if (current >= MAX_RETRIES) {
        return {
          valid: false,
          errors: [
            ...errors,
            `Retry limit (${MAX_RETRIES}) exceeded for tool call "${name}". Aborting.`,
          ],
          correctivePrompt: buildCorrectivePrompt(name, args, errors.join('; ')),
        };
      }
    }

    return {
      valid: false,
      errors,
      correctivePrompt: buildCorrectivePrompt(name, args, errors.join('; ')),
    };
  }

  const input = args as Record<string, unknown>;

  // Check required fields
  if (schema.required) {
    for (const req of schema.required) {
      if (!(req in input) || input[req] === undefined) {
        errors.push(`Missing required field "${req}" for tool "${name}".`);
      }
    }
  }

  // Check property types
  if (schema.properties) {
    for (const [propName, propSchema] of Object.entries(schema.properties)) {
      const value = input[propName];

      // Skip if value is undefined (already caught by required check or optional)
      if (value === undefined) continue;

      if (propSchema.type) {
        if (!checkType(value, propSchema.type)) {
          const actualType = Array.isArray(value)
            ? 'array'
            : typeof value;
          errors.push(
            `Field "${propName}" for tool "${name}" should be ${typeLabel(propSchema.type)}, but got ${typeLabel(actualType as JsonSchemaType)} (value: ${JSON.stringify(value)}).`,
          );
        }
      }
    }
  }

  // Track retries
  if (callId) {
    if (errors.length > 0) {
      const current = (retryCounts.get(callId) || 0) + 1;
      retryCounts.set(callId, current);
      if (current >= MAX_RETRIES) {
        errors.push(`Retry limit (${MAX_RETRIES}) exceeded for tool call "${name}". Aborting.`);
      }
    } else {
      // Successful call — reset retry count
      retryCounts.delete(callId);
    }
  }

  const valid = errors.length === 0;
  const correctivePrompt = valid
    ? undefined
    : buildCorrectivePrompt(name, args, errors.join('; '));

  return { valid, errors, correctivePrompt };
}

// ──────────────────────────────────────────────
// Corrective Prompt Builder
// ──────────────────────────────────────────────

/**
 * Build a corrective reprompt message telling the LLM what was wrong and
 * what the correct schema looks like.
 *
 * This message is designed to be appended to the conversation so the LLM
 * can self-correct its tool call on the next turn.
 */
export function buildCorrectivePrompt(
  name: string,
  args: unknown,
  error: string,
): string {
  const lines: string[] = [
    `Your tool call to "${name}" was invalid.`,
    '',
    `**Error**: ${error}`,
    '',
    '**What you passed**:',
    '```json',
    JSON.stringify(args, null, 2),
    '```',
    '',
    'Please correct the arguments and retry. Make sure:',
    '- All required fields are present',
    '- Each field has the correct type (string, number, boolean, object, or array)',
    '- No extra or misspelled fields',
  ];

  return lines.join('\n');
}

// ──────────────────────────────────────────────
// Retry Management
// ──────────────────────────────────────────────

/**
 * Reset retry count for a given tool call id.
 */
export function resetRetryCount(callId: string): void {
  retryCounts.delete(callId);
}

/**
 * Get the current retry count for a tool call id.
 */
export function getRetryCount(callId: string): number {
  return retryCounts.get(callId) || 0;
}

/**
 * Clear all retry state. Useful between sessions.
 */
export function clearAllRetries(): void {
  retryCounts.clear();
}
