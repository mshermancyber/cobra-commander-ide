import { writeFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve, extname } from 'node:path';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface TaskTemplate {
  /** Template ID */
  id: string;
  /** Display name */
  name: string;
  /** Description */
  description: string;
  /** Category for grouping */
  category: TemplateCategory;
  /** The template content with variables */
  template: string;
  /** Variables that need to be filled */
  variables: TemplateVariable[];
  /** Tags for filtering */
  tags: string[];
  /** Example filled template */
  example?: string;
}

export interface TemplateVariable {
  name: string;
  description: string;
  defaultValue?: string;
  required: boolean;
  type: 'string' | 'number' | 'boolean' | 'select' | 'path' | 'multi-line';
  options?: string[]; // For select type
  validation?: RegExp;
}

export type TemplateCategory =
  | 'crud'
  | 'api'
  | 'refactor'
  | 'testing'
  | 'devops'
  | 'documentation'
  | 'configuration'
  | 'debugging'
  | 'migration'
  | 'performance'
  | 'security';

export interface TemplateContext {
  /** Variables filled by the user */
  variables: Record<string, string>;
  /** Working directory */
  workDir: string;
  /** Optional additional context */
  extra?: Record<string, unknown>;
}

export interface RenderedTemplate {
  id: string;
  name: string;
  category: string;
  /** The rendered task content */
  content: string;
  /** Description of what this task will do */
  summary: string;
  /** Files likely to be created/modified */
  expectedFiles: string[];
  /** Estimated effort */
  effort: 'small' | 'medium' | 'large';
}

// ─── Prebuilt Templates ──────────────────────────────────────────────────────

const PREDEFINED_TEMPLATES: TaskTemplate[] = [
  {
    id: 'add-crud',
    name: 'Add CRUD Module',
    description: 'Create a complete CRUD module with routes, service, and data access layer',
    category: 'crud',
    template: `Create a CRUD module for {{entityName}}.

## Requirements
- Entity name: {{entityName}}
- Fields: {{entityFields}}
- Database: {{database}}
- Framework: {{framework}}

## Tasks
1. Create the data model/entity for {{entityName}}
2. Create the repository/data access layer ({{entityName}}Repository)
3. Create the service/business logic layer ({{entityName}}Service)
4. Create the controller/route handler ({{entityName}}Controller)
5. Add REST API routes:
   - POST /{{routePrefix}} - Create {{entityName}}
   - GET /{{routePrefix}} - List all {{entityName}}s
   - GET /{{routePrefix}}/:id - Get {{entityName}} by ID
   - PUT /{{routePrefix}}/:id - Update {{entityName}}
   - DELETE /{{routePrefix}}/:id - Delete {{entityName}}
6. Add input validation for all endpoints
7. Add error handling for all endpoints
8. Write unit tests for the service layer
9. Write integration tests for the API routes
10. Update API documentation

## Acceptance Criteria
- All CRUD operations work correctly
- Input validation returns proper 400 errors
- Not found returns 404
- Tests pass with >80% coverage
- API docs updated`,
    variables: [
      { name: 'entityName', description: 'Entity name (e.g., User, Product, Order)', defaultValue: 'Item', required: true, type: 'string' },
      { name: 'entityFields', description: 'Fields as "name:type, name:type" (e.g., "name:string, email:string, age:number")', defaultValue: 'id:string, name:string', required: true, type: 'multi-line' },
      { name: 'routePrefix', description: 'URL route prefix (e.g., /users, /products)', defaultValue: '/items', required: true, type: 'string' },
      { name: 'database', description: 'Database type', defaultValue: 'postgres', required: false, type: 'select', options: ['postgres', 'mysql', 'mongodb', 'sqlite', 'in-memory'] },
      { name: 'framework', description: 'Web framework', defaultValue: 'express', required: false, type: 'select', options: ['express', 'fastify', 'koa', 'hono'] },
    ],
    tags: ['crud', 'api', 'backend', 'rest'],
    example: `### Example
\`\`\`
/template add-crud --entityName=Product --entityFields="name:string, price:number, description:string" --routePrefix=/products --database=postgres
\`\`\``,
  },

  {
    id: 'add-api-endpoint',
    name: 'Add API Endpoint',
    description: 'Create a new API endpoint with routing, validation, and tests',
    category: 'api',
    template: `Add a new {{method}} {{path}} API endpoint.

## Requirements
- Method: {{method}}
- Path: {{path}}
- Purpose: {{purpose}}
- Authentication: {{authentication}}
- Framework: {{framework}}

## Tasks
1. Define the route in the {{routeFile}} route file
2. Create/update the controller handler function
3. Add request validation schema
4. Define response types/schema
5. Add error handling for:
   - Invalid input (400)
   - Not found (404)
   - Unauthorized (401)
   - Server error (500)
6. Write unit tests for the handler
7. Write integration tests for the endpoint
8. Update API documentation (OpenAPI spec)

## Acceptance Criteria
- Endpoint responds with correct status codes
- Input validation works
- Authentication/authorization enforced
- Tests pass
- API docs updated`,
    variables: [
      { name: 'method', description: 'HTTP method', defaultValue: 'GET', required: true, type: 'select', options: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'] },
      { name: 'path', description: 'API path (e.g., /users/:id/profile)', defaultValue: '/api/resource', required: true, type: 'string' },
      { name: 'purpose', description: 'What the endpoint does', defaultValue: 'Retrieve resource data', required: true, type: 'string' },
      { name: 'routeFile', description: 'Route file path', defaultValue: 'src/routes/api.ts', required: true, type: 'path' },
      { name: 'authentication', description: 'Auth type', defaultValue: 'Bearer JWT', required: false, type: 'select', options: ['None', 'Bearer JWT', 'API Key', 'OAuth 2.0', 'Session Cookie'] },
      { name: 'framework', description: 'Web framework', defaultValue: 'express', required: false, type: 'select', options: ['express', 'fastify', 'koa', 'hono'] },
    ],
    tags: ['api', 'endpoint', 'rest', 'backend'],
  },

  {
    id: 'refactor-module',
    name: 'Refactor Module',
    description: 'Refactor an existing module for better structure, performance, or readability',
    category: 'refactor',
    template: `Refactor the {{moduleName}} module.

## Context
- Module: {{moduleName}}
- Current issues: {{currentIssues}}
- Target improvement: {{targetImprovement}}

## Analysis Tasks
1. Review the current code structure of {{moduleName}}
2. Identify code smells and anti-patterns
3. Document the current architecture and dependencies
4. Propose a refactoring plan

## Implementation Tasks
1. Extract shared utilities and constants
2. Break down large functions (<50 lines per function)
3. Apply the Single Responsibility Principle
4. Improve naming consistency
5. Remove dead code and unused imports
6. Add proper TypeScript types (no 'any')
7. Simplify complex conditional logic
8. Optimize performance bottlenecks
9. Update tests to match new structure
10. Ensure backward compatibility or document breaking changes

## Acceptance Criteria
- All existing tests pass
- Code coverage maintained or improved
- No new linting errors
- Module is more maintainable and readable
- Breaking changes documented`,
    variables: [
      { name: 'moduleName', description: 'Module name/path', defaultValue: 'src/services/user-service.ts', required: true, type: 'path' },
      { name: 'currentIssues', description: 'What problems exist', defaultValue: 'Too many responsibilities, hard to test, tight coupling', required: true, type: 'multi-line' },
      { name: 'targetImprovement', description: 'What the refactor should achieve', defaultValue: 'Better separation of concerns, improved testability', required: true, type: 'string' },
    ],
    tags: ['refactor', 'code-quality', 'maintenance'],
  },

  {
    id: 'add-tests',
    name: 'Add Test Coverage',
    description: 'Add comprehensive test coverage for a module or file',
    category: 'testing',
    template: `Add tests for {{targetFile}}.

## Requirements
- Target: {{targetFile}}
- Framework: {{testFramework}}
- Target coverage: {{targetCoverage}}%

## Tasks
1. Analyze the source code to understand functionality
2. Identify edge cases and error conditions
3. Test organization:
   - Unit tests for pure functions
   - Integration tests for modules with dependencies
   - Mock external dependencies appropriately
4. Test categories to cover:
   a. Happy path (expected inputs)
   b. Edge cases (null, undefined, empty, boundary values)
   c. Error handling (exceptions, invalid inputs)
   d. Async operations (if applicable)
   e. State transitions (if applicable)
5. Write test file(s) in the appropriate location
6. Run tests and verify they pass
7. Check coverage meets {{targetCoverage}}% threshold
8. Add any missing test cases

## Acceptance Criteria
- Tests pass consistently
- Coverage >= {{targetCoverage}}%
- Edge cases and error paths covered
- Tests are readable and maintainable`,
    variables: [
      { name: 'targetFile', description: 'File to test', defaultValue: 'src/services/example.ts', required: true, type: 'path' },
      { name: 'testFramework', description: 'Test framework', defaultValue: 'vitest', required: false, type: 'select', options: ['vitest', 'jest', 'node-test', 'mocha'] },
      { name: 'targetCoverage', description: 'Target coverage percentage', defaultValue: '80', required: false, type: 'number' },
    ],
    tags: ['testing', 'coverage', 'quality'],
  },

  {
    id: 'add-error-handling',
    name: 'Add Error Handling',
    description: 'Add comprehensive error handling to a module',
    category: 'debugging',
    template: `Add error handling to {{targetModule}}.

## Requirements
- Module: {{targetModule}}
- Error strategy: {{errorStrategy}}

## Tasks
1. Audit current error handling in {{targetModule}}
2. Define custom error classes (if needed)
3. Add try-catch blocks around:
   - External API calls
   - File system operations
   - Database queries
   - User input processing
4. Add input validation with clear error messages
5. Add error logging with appropriate context
6. Add graceful degradation for non-critical errors
7. Ensure errors are properly propagated to callers
8. Add error recovery/retry logic where appropriate
9. Write tests for error scenarios
10. Document error types and handling patterns

## Acceptance Criteria
- All error paths are handled
- Errors contain useful context messages
- No unhandled promise rejections
- Error scenarios are tested
- Logging captures relevant error details`,
    variables: [
      { name: 'targetModule', description: 'Module to add error handling to', defaultValue: 'src/services/api-client.ts', required: true, type: 'path' },
      { name: 'errorStrategy', description: 'Error handling approach', defaultValue: 'Custom error classes + centralized handler', required: false, type: 'select', options: ['Custom error classes + centralized handler', 'Simple try-catch with logging', 'Result monad pattern', 'Retry with circuit breaker'] },
    ],
    tags: ['error-handling', 'robustness', 'debugging'],
  },

  {
    id: 'migrate-version',
    name: 'Migrate Library/Framework Version',
    description: 'Migrate to a new major version of a library or framework',
    category: 'migration',
    template: `Migrate {{library}} from {{fromVersion}} to {{toVersion}}.

## Requirements
- Library: {{library}}
- From: {{fromVersion}}
- To: {{toVersion}}
- Migration guide: {{migrationGuide}}

## Tasks
1. Review the official migration guide and changelog
2. Identify breaking changes affecting the codebase
3. Find all usages of {{library}} in the project
4. Update package.json version
5. Update imports and API calls as needed
6. Address breaking changes:
   a. Changed function signatures
   b. Removed/deprecated APIs
   c. Changed behavior or defaults
   d. Type changes
7. Update TypeScript types
8. Run tests and fix failures
9. Update documentation
10. Manual testing of affected features

## Acceptance Criteria
- All tests pass
- No deprecation warnings
- Build succeeds
- Features work as expected
- Migration notes documented`,
    variables: [
      { name: 'library', description: 'Library name', defaultValue: 'express', required: true, type: 'string' },
      { name: 'fromVersion', description: 'Current version', defaultValue: '4.x', required: true, type: 'string' },
      { name: 'toVersion', description: 'Target version', defaultValue: '5.x', required: true, type: 'string' },
      { name: 'migrationGuide', description: 'URL to migration guide', defaultValue: 'https://example.com/migration-guide', required: false, type: 'string' },
    ],
    tags: ['migration', 'upgrade', 'dependencies'],
  },

  {
    id: 'performance-audit',
    name: 'Performance Audit & Optimization',
    description: 'Audit and optimize the performance of a module or endpoint',
    category: 'performance',
    template: `Perform a performance audit on {{target}}.

## Requirements
- Target: {{target}}
- Performance goal: {{performanceGoal}}

## Tasks
1. Establish baseline performance metrics
2. Profile the code to find bottlenecks:
   - CPU hotspots
   - Memory usage
   - I/O operations
   - Network calls
3. Optimization opportunities to evaluate:
   a. Caching (in-memory, Redis, CDN)
   b. Database query optimization (indexes, N+1 queries)
   c. Batching of operations
   d. Parallel execution of independent operations
   e. Lazy loading / code splitting
   f. Connection pooling
   g. Data structure optimization
4. Implement optimizations
5. Re-measure performance
6. Add performance tests
7. Document trade-offs

## Acceptance Criteria
- Performance improved by at least {{performanceGoal}}
- No regression in functionality
- Performance tests added
- Trade-offs documented`,
    variables: [
      { name: 'target', description: 'Target to optimize', defaultValue: 'GET /api/products endpoint', required: true, type: 'string' },
      { name: 'performanceGoal', description: 'Performance improvement goal', defaultValue: '50% faster response time', required: false, type: 'string' },
    ],
    tags: ['performance', 'optimization', 'profiling'],
  },

  {
    id: 'security-review',
    name: 'Security Review',
    description: 'Perform a security review of a module or API',
    category: 'security',
    template: `Perform a security review of {{target}}.

## Requirements
- Target: {{target}}
- Security level: {{securityLevel}}

## Tasks
1. Review for OWASP Top 10 vulnerabilities:
   a. Broken Access Control
   b. Cryptographic Failures
   c. Injection (SQL, NoSQL, Command, XSS)
   d. Insecure Design
   e. Security Misconfiguration
   f. Vulnerable Components
   g. Authentication Failures
   h. Software/Data Integrity Failures
   i. Logging & Monitoring Failures
   j. SSRF
2. Check for:
   - Input validation
   - Output encoding
   - Authentication & session management
   - Authorization checks
   - Sensitive data exposure
   - CORS configuration
   - Rate limiting
   - Dependency vulnerabilities
3. Write security test cases
4. Document findings
5. Implement fixes for critical/high issues

## Acceptance Criteria
- All critical vulnerabilities addressed
- Security tests added
- Findings documented
- Dependency scan passes`,
    variables: [
      { name: 'target', description: 'Module or API to review', defaultValue: 'src/routes/api.ts', required: true, type: 'path' },
      { name: 'securityLevel', description: 'Security review depth', defaultValue: 'standard', required: false, type: 'select', options: ['basic', 'standard', 'comprehensive'] },
    ],
    tags: ['security', 'audit', 'vulnerability'],
  },
];

// ─── Template Engine ─────────────────────────────────────────────────────────

export class TaskTemplateEngine {
  private templates: Map<string, TaskTemplate> = new Map();

  constructor() {
    this.loadBuiltinTemplates();
  }

  /**
   * Get all available templates.
   */
  listTemplates(): TaskTemplate[] {
    return [...this.templates.values()];
  }

  /**
   * Get templates by category.
   */
  listByCategory(category: TemplateCategory): TaskTemplate[] {
    return [...this.templates.values()].filter(t => t.category === category);
  }

  /**
   * Get a specific template.
   */
  getTemplate(id: string): TaskTemplate | undefined {
    return this.templates.get(id);
  }

  /**
   * Register a custom template.
   */
  registerTemplate(template: TaskTemplate): void {
    this.templates.set(template.id, template);
  }

  /**
   * Render a template with variable substitution.
   */
  render(id: string, context: TemplateContext): RenderedTemplate | null {
    const template = this.templates.get(id);
    if (!template) return null;

    // Validate required variables
    for (const variable of template.variables) {
      if (variable.required && !context.variables[variable.name] && !variable.defaultValue) {
        return null; // Missing required variable
      }
    }

    // Substitute variables
    let content = template.template;
    for (const variable of template.variables) {
      const value = context.variables[variable.name] || variable.defaultValue || '';
      content = content.replace(new RegExp(`\\{\\{${variable.name}\\}\\}`, 'g'), value);
    }

    // Guess expected files
    const expectedFiles = this.guessExpectedFiles(template, context);

    // Estimate effort
    const effort = this.estimateEffort(template);

    return {
      id: template.id,
      name: template.name,
      category: template.category,
      content,
      summary: template.description,
      expectedFiles,
      effort,
    };
  }

  /**
   * Handle the /template command.
   */
  handleTemplateCommand(args: string[], workDir: string): string {
    if (args.length === 0 || args[0] === 'list') {
      return this.formatTemplateList();
    }

    const templateId = args[0];

    if (args[0] === 'categories') {
      return this.formatCategories();
    }

    if (args[0] === 'show' && args[1]) {
      const tpl = this.templates.get(args[1]);
      if (!tpl) return `Template "${args[1]}" not found.`;
      return this.formatTemplateDetail(tpl);
    }

    const template = this.templates.get(templateId);
    if (!template) {
      return `Template "${templateId}" not found. Use /template list to see available templates.`;
    }

    // Parse variable arguments: --key=value or -k value
    const variables: Record<string, string> = {};
    const remainingArgs = args.slice(1);

    for (let i = 0; i < remainingArgs.length; i++) {
      const arg = remainingArgs[i];
      const eqMatch = arg.match(/^--([^=]+)=(.+)$/);
      if (eqMatch) {
        variables[eqMatch[1]] = eqMatch[2];
      } else if (arg.startsWith('--')) {
        const key = arg.slice(2);
        const nextVal = remainingArgs[i + 1];
        if (nextVal && !nextVal.startsWith('--')) {
          variables[key] = nextVal;
          i++;
        } else {
          variables[key] = 'true';
        }
      }
    }

    const rendered = this.render(templateId, { variables, workDir });

    if (!rendered) {
      const missing = template.variables
        .filter(v => v.required && !variables[v.name] && !v.defaultValue)
        .map(v => v.name);

      let msg = `Cannot render template "${templateId}". Missing required variables: ${missing.join(', ')}\n`;
      msg += this.formatTemplateDetail(template);
      return msg;
    }

    return rendered.content;
  }

  /**
   * Save a rendered template to a file.
   */
  saveToFile(id: string, context: TemplateContext, outputPath?: string): string | null {
    const rendered = this.render(id, context);
    if (!rendered) return null;

    const outPath = outputPath || join(
      context.workDir,
      '.tasks',
      `${rendered.id}-${Date.now()}.md`,
    );

    const dir = outPath.split('/').slice(0, -1).join('/') || '.';
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    writeFileSync(outPath, rendered.content, 'utf-8');
    return outPath;
  }

  // ── Private Methods ────────────────────────────────────────────────────

  private loadBuiltinTemplates(): void {
    for (const template of PREDEFINED_TEMPLATES) {
      this.templates.set(template.id, template);
    }
  }

  private formatTemplateList(): string {
    const lines = ['Available Task Templates:', ''];

    const categories = new Map<TemplateCategory, TaskTemplate[]>();
    for (const template of this.templates.values()) {
      if (!categories.has(template.category)) categories.set(template.category, []);
      categories.get(template.category)!.push(template);
    }

    for (const [category, templates] of categories) {
      lines.push(`## ${category.toUpperCase()}`);
      for (const tpl of templates) {
        lines.push(`  /template ${tpl.id} — ${tpl.description}`);
      }
      lines.push('');
    }

    lines.push('Usage: /template <template-id> --var1=value1 --var2=value2');
    lines.push('Show details: /template show <template-id>');
    return lines.join('\n');
  }

  private formatCategories(): string {
    const categories = new Set<TemplateCategory>();
    for (const tpl of this.templates.values()) {
      categories.add(tpl.category);
    }
    return `Template categories: ${[...categories].join(', ')}`;
  }

  private formatTemplateDetail(template: TaskTemplate): string {
    const lines: string[] = [
      `Template: ${template.name} (${template.id})`,
      `Category: ${template.category}`,
      `Description: ${template.description}`,
      `Tags: ${template.tags.join(', ')}`,
      ``,
      `Variables:`,
    ];

    for (const v of template.variables) {
      const req = v.required ? ' (required)' : ' (optional)';
      const def = v.defaultValue ? ` [default: ${v.defaultValue}]` : '';
      const opts = v.options ? ` [options: ${v.options.join(', ')}]` : '';
      lines.push(`  --${v.name}: ${v.type}${req}${def}${opts}`);
      lines.push(`    ${v.description}`);
    }

    if (template.example) {
      lines.push('');
      lines.push(template.example);
    }

    return lines.join('\n');
  }

  private guessExpectedFiles(template: TaskTemplate, context: TemplateContext): string[] {
    const vars = context.variables;
    const files: string[] = [];

    switch (template.id) {
      case 'add-crud': {
        const name = (vars.entityName || 'item').toLowerCase();
        files.push(
          `src/models/${name}.ts`,
          `src/repositories/${name}-repository.ts`,
          `src/services/${name}-service.ts`,
          `src/controllers/${name}-controller.ts`,
          `src/routes/${name}s.ts`,
          `src/__tests__/${name}.test.ts`,
        );
        break;
      }
      case 'add-api-endpoint':
        files.push(vars.routeFile || 'src/routes/api.ts');
        files.push('src/__tests__/api.test.ts');
        break;
      case 'refactor-module':
        files.push(vars.moduleName || 'src/module.ts');
        break;
      case 'add-tests':
        files.push(
          vars.targetFile?.replace('.ts', '.test.ts') || 'src/__tests__/test.ts',
        );
        break;
      default:
        break;
    }

    return files;
  }

  private estimateEffort(template: TaskTemplate): 'small' | 'medium' | 'large' {
    const taskCount = template.template.split('\n').filter(l => /^\d+\./.test(l.trim())).length;

    if (taskCount <= 4) return 'small';
    if (taskCount <= 8) return 'medium';
    return 'large';
  }
}

// ─── Convenience functions ───────────────────────────────────────────────────

export function createTaskTemplateEngine(): TaskTemplateEngine {
  return new TaskTemplateEngine();
}

/**
 * Get all built-in template definitions.
 */
export function getBuiltinTemplates(): TaskTemplate[] {
  return PREDEFINED_TEMPLATES;
}

/**
 * Quick render without needing the engine.
 */
export function quickRenderTemplate(
  templateId: string,
  variables: Record<string, string>,
  workDir?: string,
): RenderedTemplate | null {
  const engine = new TaskTemplateEngine();
  return engine.render(templateId, {
    variables,
    workDir: workDir || process.cwd(),
  });
}

// ─── Template Validator ────────────────────────────────────────────────────────

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
  warnings: string[];
}

export interface ValidationError {
  field: string;
  message: string;
  severity: 'error' | 'warning';
}

export class TemplateValidator {
  /**
   * Validate a template definition.
   */
  static validate(template: TaskTemplate): ValidationResult {
    const errors: ValidationError[] = [];
    const warnings: string[] = [];

    // Check required fields
    if (!template.id || template.id.trim().length === 0) {
      errors.push({ field: 'id', message: 'Template ID is required', severity: 'error' });
    }
    if (!template.name || template.name.trim().length === 0) {
      errors.push({ field: 'name', message: 'Template name is required', severity: 'error' });
    }
    if (!template.template || template.template.trim().length === 0) {
      errors.push({ field: 'template', message: 'Template content is required', severity: 'error' });
    }
    if (!template.category) {
      errors.push({ field: 'category', message: 'Template category is required', severity: 'error' });
    }

    // Validate variables referenced in template exist
    const varRefs = template.template.match(/\{\{(\w+)\}\}/g) || [];
    const varNames = new Set(varRefs.map(v => v.slice(2, -2)));
    const definedVars = new Set(template.variables.map(v => v.name));

    for (const ref of varNames) {
      if (!definedVars.has(ref)) {
        warnings.push(`Variable "{{${ref}}}" used in template but not defined in variables list`);
      }
    }

    // Validate variable definitions
    for (const v of template.variables) {
      if (!v.name || v.name.trim().length === 0) {
        errors.push({ field: `variables[${v.name}]`, message: 'Variable name is required', severity: 'error' });
      }
      if (v.type === 'select' && (!v.options || v.options.length === 0)) {
        warnings.push(`Variable "${v.name}" is type 'select' but has no options defined`);
      }
      if (v.required && !v.defaultValue) {
        warnings.push(`Required variable "${v.name}" has no default value — user must provide it`);
      }
    }

    // Validate variable names are unique
    const seenVars = new Set<string>();
    for (const v of template.variables) {
      if (seenVars.has(v.name)) {
        errors.push({
          field: `variables[${v.name}]`,
          message: `Duplicate variable name: "${v.name}"`,
          severity: 'error',
        });
      }
      seenVars.add(v.name);
    }

    // Validate ID uniqueness (only check within provided context)
    if (template.id.includes('/') || template.id.includes('\\')) {
      warnings.push(`Template ID "${template.id}" contains path separators — may cause issues`);
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }

  /**
   * Validate a rendered context against a template's variable requirements.
   */
  static validateContext(template: TaskTemplate, context: TemplateContext): ValidationResult {
    const errors: ValidationError[] = [];
    const warnings: string[] = [];

    for (const variable of template.variables) {
      const value = context.variables[variable.name];
      const hasValue = value !== undefined && value !== null && value !== '';
      const hasDefault = variable.defaultValue !== undefined && variable.defaultValue !== null;

      if (variable.required && !hasValue && !hasDefault) {
        errors.push({
          field: variable.name,
          message: `Required variable "${variable.name}" is missing and has no default`,
          severity: 'error',
        });
      }

      if (hasValue && variable.validation) {
        if (!variable.validation.test(value)) {
          errors.push({
            field: variable.name,
            message: `Variable "${variable.name}" value "${value}" fails validation pattern`,
            severity: 'error',
          });
        }
      }

      if (hasValue && variable.type === 'select' && variable.options) {
        if (!variable.options.includes(value)) {
          warnings.push(
            `Variable "${variable.name}" value "${value}" is not one of the suggested options: ${variable.options.join(', ')}`,
          );
        }
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }
}

// ─── Template Renderer ─────────────────────────────────────────────────────────

export class TemplateRenderer {
  /**
   * Render a template with variable substitution.
   */
  static render(template: TaskTemplate, context: TemplateContext): RenderedTemplate | null {
    // Validate required variables
    const validation = TemplateValidator.validateContext(template, context);
    if (!validation.valid) return null;

    // Substitute variables
    let content = template.template;
    for (const variable of template.variables) {
      const value = context.variables[variable.name] || variable.defaultValue || '';
      content = content.replace(
        new RegExp(`\\{\\{${variable.name}\\}\\}`, 'g'),
        value,
      );
    }

    // Estimate expected files
    const expectedFiles = TemplateRenderer.guessExpectedFiles(template, context);
    const effort = TemplateRenderer.estimateEffort(template);

    return {
      id: template.id,
      name: template.name,
      category: template.category,
      content,
      summary: template.description,
      expectedFiles,
      effort,
    };
  }

  /**
   * Guess expected files from template and context.
   */
  private static guessExpectedFiles(template: TaskTemplate, context: TemplateContext): string[] {
    const vars = context.variables;
    const files: string[] = [];

    switch (template.id) {
      case 'add-crud': {
        const name = (vars.entityName || 'item').toLowerCase();
        files.push(
          `src/models/${name}.ts`,
          `src/repositories/${name}-repository.ts`,
          `src/services/${name}-service.ts`,
          `src/controllers/${name}-controller.ts`,
          `src/routes/${name}s.ts`,
          `src/__tests__/${name}.test.ts`,
        );
        break;
      }
      case 'add-api-endpoint':
        files.push(vars.routeFile || 'src/routes/api.ts');
        files.push('src/__tests__/api.test.ts');
        break;
      case 'refactor-module':
        files.push(vars.moduleName || 'src/module.ts');
        break;
      case 'add-tests':
        files.push(vars.targetFile?.replace('.ts', '.test.ts') || 'src/__tests__/test.ts');
        break;
      case 'add-error-handling':
        files.push(vars.targetModule || 'src/module.ts');
        break;
      case 'migrate-version':
        files.push('package.json');
        break;
      default:
        break;
    }

    return files;
  }

  /**
   * Estimate effort based on template complexity.
   */
  private static estimateEffort(template: TaskTemplate): 'small' | 'medium' | 'large' {
    const taskCount = template.template.split('\n').filter(l => /^\d+\./.test(l.trim())).length;
    if (taskCount <= 4) return 'small';
    if (taskCount <= 8) return 'medium';
    return 'large';
  }
}

// ─── Template Registry (with directory scanning) ───────────────────────────────

export interface TemplateFileFormat {
  name: string;
  description?: string;
  category?: string;
  template: string;
  variables?: Array<{
    name: string;
    description?: string;
    defaultValue?: string;
    required?: boolean;
    type?: string;
    options?: string[];
  }>;
  tags?: string[];
  example?: string;
}

export class TemplateRegistry {
  private templates: Map<string, TaskTemplate> = new Map();
  private searchDirs: string[] = [];

  constructor() {
    // Preload built-in templates
    for (const tpl of PREDEFINED_TEMPLATES) {
      this.templates.set(tpl.id, tpl);
    }
  }

  /**
   * Register a template.
   */
  register(template: TaskTemplate): void {
    this.templates.set(template.id, template);
  }

  /**
   * Get a template by ID.
   */
  get(id: string): TaskTemplate | undefined {
    return this.templates.get(id);
  }

  /**
   * List all registered templates.
   */
  list(): TaskTemplate[] {
    return [...this.templates.values()];
  }

  /**
   * List templates by category.
   */
  listByCategory(category: TemplateCategory): TaskTemplate[] {
    return this.list().filter(t => t.category === category);
  }

  /**
   * Discover templates from a directory.
   * Scans for YAML/JSON template definition files.
   */
  discover(directory: string): TaskTemplate[] {
    this.searchDirs.push(directory);
    const discovered: TaskTemplate[] = [];

    if (!existsSync(directory)) return discovered;

    try {
      const entries = readdirSync(directory, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile()) continue;

        const filePath = join(directory, entry.name);
        const ext = extname(entry.name).toLowerCase();

        if (ext === '.json' || ext === '.yaml' || ext === '.yml') {
          try {
            const content = readFileSync(filePath, 'utf-8');
            const parsed = TemplateRegistry.parseTemplateFile(content, ext);
            if (parsed) {
              const template = TemplateRegistry.convertToTemplate(parsed, entry.name.replace(ext, ''));
              const validation = TemplateValidator.validate(template);
              if (validation.valid) {
                this.register(template);
                discovered.push(template);
              }
            }
          } catch {
            // skip malformed files
          }
        }
      }
    } catch {
      // skip inaccessible directories
    }

    return discovered;
  }

  /**
   * Parse a template definition file (JSON or simple YAML).
   */
  static parseTemplateFile(content: string, ext: string): TemplateFileFormat | null {
    try {
      if (ext === '.json') {
        return JSON.parse(content) as TemplateFileFormat;
      }

      if (ext === '.yaml' || ext === '.yml') {
        return TemplateRegistry.parseSimpleYaml(content);
      }

      return null;
    } catch {
      return null;
    }
  }

  /**
   * Simple YAML parser for template definition files.
   * Handles the subset of YAML needed for template definitions.
   */
  private static parseSimpleYaml(content: string): TemplateFileFormat | null {
    const lines = content.split('\n');
    const result: Record<string, unknown> = {};
    const currentList: { parent: string; items: Record<string, unknown>[] }[] = [];
    let currentKey = '';
    let isMultiline = false;
    let multilineBuffer: string[] = [];

    for (const rawLine of lines) {
      // Skip comments
      if (rawLine.trim().startsWith('#')) continue;
      if (rawLine.trim().length === 0) {
        if (isMultiline) multilineBuffer.push('');
        continue;
      }

      if (isMultiline) {
        // Check if multiline ends (unindented line or new key)
        const indented = rawLine.startsWith('  ') || rawLine.startsWith('\t');
        if (!indented && !rawLine.match(/^\s+-/)) {
          result[currentKey] = multilineBuffer.join('\n').trim();
          isMultiline = false;
          multilineBuffer = [];
        } else {
          multilineBuffer.push(rawLine.replace(/^\s+/, ''));
          continue;
        }
      }

      // List item
      const listMatch = rawLine.match(/^\s+-\s+(.+)$/);
      if (listMatch && currentList.length > 0) {
        const list = currentList[currentList.length - 1];
        const itemValue = listMatch[1].trim();

        // Check if it's a key:value pair
        const kvMatch = itemValue.match(/^(\w+):\s*(.+)$/);
        if (kvMatch) {
          if (list.items.length > 0 && Object.keys(list.items[list.items.length - 1]).length < 3) {
            list.items[list.items.length - 1][kvMatch[1]] = kvMatch[2];
          } else {
            list.items.push({ [kvMatch[1]]: kvMatch[2] });
          }
        } else {
          list.items.push({ name: itemValue } as unknown as Record<string, unknown>);
        }
        continue;
      }

      // Key: Value
      const match = rawLine.match(/^(\w[\w\s]*):\s*(.*)$/);
      if (match) {
        currentKey = match[1].trim();
        const value = match[2].trim();

        if (value === '|' || value === '>') {
          isMultiline = true;
          multilineBuffer = [];
        } else if (value === '') {
          // Could be start of a list
          currentList.push({ parent: currentKey, items: [] });
        } else {
          result[currentKey] = value;
        }
      }
    }

    // Flush multiline buffer
    if (isMultiline && currentKey) {
      result[currentKey] = multilineBuffer.join('\n').trim();
    }

    // Convert lists
    for (const list of currentList) {
      result[list.parent] = list.items;
    }

    return result as unknown as TemplateFileFormat;
  }

  /**
   * Convert a parsed template file format to the internal TaskTemplate type.
   */
  static convertToTemplate(parsed: TemplateFileFormat, defaultId: string): TaskTemplate {
    const variables: TemplateVariable[] = (parsed.variables || []).map(v => ({
      name: v.name,
      description: v.description || '',
      defaultValue: v.defaultValue,
      required: v.required !== false,
      type: (v.type as TemplateVariable['type']) || 'string',
      options: v.options,
    }));

    return {
      id: defaultId,
      name: parsed.name,
      description: parsed.description || '',
      category: (parsed.category as TemplateCategory) || 'configuration',
      template: parsed.template,
      variables,
      tags: parsed.tags || [],
      example: parsed.example,
    };
  }

  /**
   * Render a template with context.
   */
  render(id: string, context: TemplateContext): RenderedTemplate | null {
    const template = this.templates.get(id);
    if (!template) return null;
    return TemplateRenderer.render(template, context);
  }

  /**
   * Validate a template definition.
   */
  validate(template: TaskTemplate): ValidationResult {
    return TemplateValidator.validate(template);
  }

  /**
   * Remove a template from the registry.
   */
  unregister(id: string): boolean {
    return this.templates.delete(id);
  }

  /**
   * Count registered templates.
   */
  get count(): number {
    return this.templates.size;
  }

  /**
   * Get the search directories used for discovery.
   */
  getSearchDirs(): string[] {
    return [...this.searchDirs];
  }
}
