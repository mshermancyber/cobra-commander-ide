import { execSync, execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ToolDefinition } from '../core/types.js';

interface QueryResult {
  rows: Record<string, unknown>[];
  rowCount: number;
  columns: string[];
}

interface DbConfig {
  engine: 'postgres' | 'sqlite' | 'mysql';
  connectionString: string;
}

interface ApiConfig {
  name: string;
  baseUrl: string;
  headers?: Record<string, string>;
}

// Blocked SQL operations — only allow read-only queries
const ALLOWED_SQL_PATTERNS = [
  /^\s*SELECT\b/i,
  /^\s*DESCRIBE\b/i,
  /^\s*SHOW\b/i,
  /^\s*EXPLAIN\b/i,
  /^\s*WITH\b/i,
];

const BLOCKED_SQL_PATTERNS = [
  /\bINSERT\b/i,
  /\bUPDATE\b/i,
  /\bDELETE\b/i,
  /\bDROP\b/i,
  /\bALTER\b/i,
  /\bTRUNCATE\b/i,
  /\bCREATE\s+(TABLE|DATABASE|INDEX|VIEW|PROCEDURE|FUNCTION|TRIGGER)\b/i,
  /\bGRANT\b/i,
  /\bREVOKE\b/i,
  /\bEXEC\b/i,
  /\bEXECUTE\b/i,
];

// Blocked IP ranges for SSRF prevention
const PRIVATE_IP_PATTERNS = [
  /^https?:\/\/127\./,
  /^https?:\/\/10\./,
  /^https?:\/\/172\.(1[6-9]|2\d|3[01])\./,
  /^https?:\/\/192\.168\./,
  /^https?:\/\/0\./,
  /^https?:\/\/169\.254\./,
  /^https?:\/\/\[::1\]/,
  /^https?:\/\/\[fd/i,
  /^https?:\/\/localhost/i,
];

function loadDbConfig(workDir: string): DbConfig | null {
  const configPath = join(workDir, '.cobra-commander', 'db.json');
  if (!existsSync(configPath)) return null;
  try {
    return JSON.parse(readFileSync(configPath, 'utf-8'));
  } catch {
    return null;
  }
}

function loadApiConfigs(workDir: string): ApiConfig[] {
  const configPath = join(workDir, '.cobra-commander', 'apis.json');
  if (!existsSync(configPath)) return [];
  try {
    const raw = JSON.parse(readFileSync(configPath, 'utf-8'));
    return raw.apis || [];
  } catch {
    return [];
  }
}

function isQueryAllowed(sql: string): boolean {
  const trimmed = sql.trim();

  // Check blocked patterns first
  for (const pattern of BLOCKED_SQL_PATTERNS) {
    if (pattern.test(trimmed)) {
      return false;
    }
  }

  // Check allowed patterns
  for (const pattern of ALLOWED_SQL_PATTERNS) {
    if (pattern.test(trimmed)) {
      return true;
    }
  }

  return false;
}

function executePostgresQuery(connectionString: string, query: string): QueryResult {
  const output = execFileSync('psql', [
    connectionString,
    '-c', query,
    '--csv',
  ], {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 30000,
    maxBuffer: 10 * 1024 * 1024,
  }).trim();

  return parseCsvOutput(output);
}

function executeSqliteQuery(dbPath: string, query: string): QueryResult {
  const output = execFileSync('sqlite3', [
    '-header', '-csv',
    dbPath,
    query,
  ], {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 30000,
    maxBuffer: 10 * 1024 * 1024,
  }).trim();

  return parseCsvOutput(output);
}

function executeMysqlQuery(connectionString: string, query: string): QueryResult {
  // connectionString format: user:password@host:port/db
  const output = execFileSync('mysql', [
    '-u', connectionString,
    '-e', query,
    '--batch',
  ], {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 30000,
    maxBuffer: 10 * 1024 * 1024,
  }).trim();

  return parseTabOutput(output);
}

function parseCsvOutput(output: string): QueryResult {
  const lines = output.split('\n').filter(l => l.trim());
  if (lines.length === 0) {
    return { rows: [], rowCount: 0, columns: [] };
  }

  const columns = lines[0].split(',').map(c => c.trim());
  const rows: Record<string, unknown>[] = [];

  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split(',').map(v => v.trim());
    const row: Record<string, unknown> = {};
    columns.forEach((col, idx) => {
      row[col] = values[idx] || null;
    });
    rows.push(row);
  }

  return { rows, rowCount: rows.length, columns };
}

function parseTabOutput(output: string): QueryResult {
  const lines = output.split('\n').filter(l => l.trim());
  if (lines.length === 0) {
    return { rows: [], rowCount: 0, columns: [] };
  }

  const columns = lines[0].split('\t').map(c => c.trim());
  const rows: Record<string, unknown>[] = [];

  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split('\t').map(v => v.trim());
    const row: Record<string, unknown> = {};
    columns.forEach((col, idx) => {
      row[col] = values[idx] || null;
    });
    rows.push(row);
  }

  return { rows, rowCount: rows.length, columns };
}

function formatQueryResult(result: QueryResult): string {
  if (result.rowCount === 0) {
    return '(no rows returned)';
  }

  const header = result.columns.join(' | ');
  const separator = result.columns.map(() => '---').join(' | ');
  const rows = result.rows.map(row =>
    result.columns.map(col => String(row[col] ?? 'NULL')).join(' | ')
  );

  return `${result.rowCount} row(s) returned\n\n${header}\n${separator}\n${rows.join('\n')}`;
}

export function createDbTools(workDir: string): ToolDefinition[] {
  const tools: ToolDefinition[] = [];

  // query_database tool
  tools.push({
    name: 'query_database',
    description: 'Run a read-only SQL query against a database. Supports postgres, sqlite, and mysql. Only SELECT, DESCRIBE, SHOW, EXPLAIN, and WITH queries are allowed. Connection config can be read from .cobra-commander/db.json or provided inline.',
    input_schema: {
      type: 'object',
      properties: {
        engine: {
          type: 'string',
          enum: ['postgres', 'sqlite', 'mysql'],
          description: 'Database engine',
        },
        connectionString: {
          type: 'string',
          description: 'Connection string (e.g., postgresql://user:pass@host/db, or path to sqlite file)',
        },
        query: {
          type: 'string',
          description: 'SQL query to execute (SELECT, DESCRIBE, SHOW, EXPLAIN, WITH only)',
        },
      },
      required: ['engine', 'query'],
    },
  });

  // http_request tool
  tools.push({
    name: 'http_request',
    description: 'Make an HTTP request to an external API. Supports GET, POST, PUT, DELETE methods. Blocks requests to internal/metadata endpoints. API configs can be read from .cobra-commander/apis.json.',
    input_schema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'The full URL to request',
        },
        method: {
          type: 'string',
          enum: ['GET', 'POST', 'PUT', 'DELETE'],
          description: 'HTTP method',
        },
        headers: {
          type: 'object',
          description: 'Optional HTTP headers as key-value pairs',
          additionalProperties: { type: 'string' },
        },
        body: {
          type: 'string',
          description: 'Request body (for POST/PUT)',
        },
      },
      required: ['url', 'method'],
    },
  });

  return tools;
}

export function executeDbTool(
  name: string,
  input: Record<string, unknown>,
  workDir: string,
): { result: string; is_error: boolean } {
  if (name === 'query_database') {
    return executeQuery(input, workDir);
  }
  if (name === 'http_request') {
    return executeHttpRequest(input, workDir);
  }
  return { result: `Unknown tool: ${name}`, is_error: true };
}

function executeQuery(
  input: Record<string, unknown>,
  workDir: string,
): { result: string; is_error: boolean } {
  let engine = input.engine as string;
  const query = input.query as string;
  let connectionString = input.connectionString as string | undefined;

  if (!query) {
    return { result: 'Missing required parameter: query', is_error: true };
  }

  // Check if query is allowed
  if (!isQueryAllowed(query)) {
    return {
      result: 'Blocked: Only read-only queries are allowed (SELECT, DESCRIBE, SHOW, EXPLAIN, WITH). INSERT, UPDATE, DELETE, DROP, ALTER, TRUNCATE, CREATE, GRANT, REVOKE, EXECUTE are blocked.',
      is_error: true,
    };
  }

  // Try to load default connection from config if not provided
  if (!connectionString) {
    const dbConfig = loadDbConfig(workDir);
    if (dbConfig) {
      engine ||= dbConfig.engine;
      connectionString = dbConfig.connectionString;
    }
  }

  if (!connectionString) {
    return {
      result: 'No connection string provided and no default database configured in .cobra-commander/db.json',
      is_error: true,
    };
  }

  try {
    let result: QueryResult;

    switch (engine) {
      case 'postgres':
        result = executePostgresQuery(connectionString, query);
        break;
      case 'sqlite':
        result = executeSqliteQuery(connectionString, query);
        break;
      case 'mysql':
        result = executeMysqlQuery(connectionString, query);
        break;
      default:
        return { result: `Unsupported engine: ${engine}. Supported: postgres, sqlite, mysql`, is_error: true };
    }

    return { result: formatQueryResult(result), is_error: false };
  } catch (err) {
    return { result: `Query failed: ${(err as Error).message.split('\n')[0]}`, is_error: true };
  }
}

function executeHttpRequest(
  input: Record<string, unknown>,
  workDir: string,
): { result: string; is_error: boolean } {
  const url = input.url as string;
  const method = (input.method as string) || 'GET';
  const headers = input.headers as Record<string, string> | undefined;
  const body = input.body as string | undefined;

  if (!url) {
    return { result: 'Missing required parameter: url', is_error: true };
  }

  // SSRF prevention: block private/internal IPs
  for (const pattern of PRIVATE_IP_PATTERNS) {
    if (pattern.test(url)) {
      return { result: 'Blocked: URL points to a private or internal network address', is_error: true };
    }
  }

  try {
    // Build curl args as array (shell-safe, no command injection)
    const curlArgs: string[] = [];

    // Add method
    if (method !== 'GET') {
      curlArgs.push('-X', method);
    }

    // Add headers
    if (headers) {
      for (const [key, value] of Object.entries(headers)) {
        // Sanitize header values: reject newlines to prevent header injection
        if (key.includes('\r') || key.includes('\n') || value.includes('\r') || value.includes('\n')) {
          return { result: 'Invalid header: contains newline characters', is_error: true };
        }
        curlArgs.push('-H', `${key}: ${value}`);
      }
    }

    // Add body
    if (body && (method === 'POST' || method === 'PUT')) {
      curlArgs.push('-d', body);
    }

    // Add URL last
    curlArgs.push(url);

    const output = execFileSync('curl', [
      '-sS', '-L',
      '--max-time', '30',
      ...curlArgs,
    ], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 35000,
      maxBuffer: 5 * 1024 * 1024,
    });

    // Get status code using execFileSync with separate args
    let statusCode = '200';
    try {
      statusCode = execFileSync('curl', [
        '-sS', '-o', '/dev/null',
        '-w', '%{http_code}',
        url,
      ], {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 10000,
      }).trim();
    } catch {
      // Ignore status code errors
    }

    const truncated = output.length > 50000
      ? output.slice(0, 25000) + '\n\n... [truncated] ...\n\n' + output.slice(-25000)
      : output;

    return {
      result: `HTTP ${statusCode}\n\n${truncated || '(empty response)'}`,
      is_error: false,
    };
  } catch (err) {
    return { result: `HTTP request failed: ${(err as Error).message.split('\n')[0]}`, is_error: true };
  }
}
