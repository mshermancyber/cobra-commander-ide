import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ScaffoldConfig {
  /** Project name */
  name: string;
  /** Framework (e.g., 'react', 'vue', 'express', 'fastify', 'next') */
  framework: string;
  /** Language */
  language: 'typescript' | 'javascript';
  /** Package manager */
  packageManager: 'npm' | 'yarn' | 'pnpm';
  /** Additional libraries */
  libraries: string[];
  /** Project description */
  description: string;
  /** Output directory */
  outputDir: string;
  /** Type of application */
  appType: 'web' | 'api' | 'cli' | 'library' | 'fullstack';
}

export interface FileSpec {
  path: string;
  content: string;
  type: 'source' | 'config' | 'test' | 'docs' | 'static';
}

export interface PreviewServerConfig {
  port: number;
  rootDir: string;
  framework: string;
  hmr: boolean;
  openBrowser: boolean;
}

export interface PreviewInfo {
  url: string;
  port: number;
  pid?: number;
  status: 'starting' | 'running' | 'stopped' | 'error';
  errors: string[];
  lastBuildMs?: number;
}

export interface IterationState {
  iteration: number;
  prompt: string;
  generatedFiles: FileSpec[];
  previewState: PreviewInfo;
  feedback: string;
  changes: FileSpec[];
}

// ---------------------------------------------------------------------------
// Project Scaffolder
// ---------------------------------------------------------------------------

export class ProjectScaffolder {
  /**
   * Scaffold a new project from a configuration.
   */
  static scaffold(config: ScaffoldConfig): FileSpec[] {
    const files: FileSpec[] = [];
    const outDir = config.outputDir;

    // Create directory structure
    if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
    mkdirSync(join(outDir, 'src'), { recursive: true });

    // Generate package.json
    files.push({
      path: join(outDir, 'package.json'),
      content: ProjectScaffolder.generatePackageJson(config),
      type: 'config',
    });

    // Generate tsconfig if TypeScript
    if (config.language === 'typescript') {
      files.push({
        path: join(outDir, 'tsconfig.json'),
        content: ProjectScaffolder.generateTsConfig(),
        type: 'config',
      });
    }

    // Generate framework-specific files
    const frameworkFiles = ProjectScaffolder.generateFrameworkFiles(config);
    files.push(...frameworkFiles);

    // Generate README
    files.push({
      path: join(outDir, 'README.md'),
      content: ProjectScaffolder.generateReadme(config),
      type: 'docs',
    });

    // Write all files to disk
    for (const file of files) {
      const dir = file.path.split('/').slice(0, -1).join('/');
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(file.path, file.content);
    }

    return files;
  }

  /**
   * Generate package.json content.
   */
  static generatePackageJson(config: ScaffoldConfig): string {
    const pkg: Record<string, unknown> = {
      name: config.name,
      version: '0.1.0',
      description: config.description,
      main: config.appType === 'api' ? 'dist/index.js' : 'src/index.' + (config.language === 'typescript' ? 'ts' : 'js'),
      scripts: {
        dev: config.framework === 'next' ? 'next dev' : 'tsx src/index.ts',
        build: 'tsc',
        start: 'node dist/index.js',
        test: 'vitest run',
      },
      dependencies: {},
      devDependencies: {
        typescript: '^5.8.0',
        vitest: '^4.0.0',
        tsx: '^4.19.0',
      },
    };

    // Framework-specific dependencies
    const frameworkDeps: Record<string, Record<string, string>> = {
      react: { react: '^19.0.0', 'react-dom': '^19.0.0' },
      vue: { vue: '^3.5.0' },
      express: { express: '^5.0.0' },
      fastify: { fastify: '^5.0.0' },
      next: { next: '^15.0.0', react: '^19.0.0', 'react-dom': '^19.0.0' },
    };
    const deps = frameworkDeps[config.framework] || {};
    (pkg.dependencies as Record<string, string>)['...'] = Object.keys(deps).join(', ') + ' etc.';

    return JSON.stringify(pkg, null, 2);
  }

  /**
   * Generate tsconfig.json.
   */
  static generateTsConfig(): string {
    return JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        strict: true,
        esModuleInterop: true,
        outDir: 'dist',
        rootDir: 'src',
        skipLibCheck: true,
      },
      include: ['src'],
    }, null, 2);
  }

  /**
   * Generate framework-specific scaffold files.
   */
  static generateFrameworkFiles(config: ScaffoldConfig): FileSpec[] {
    const files: FileSpec[] = [];
    const srcDir = join(config.outputDir, 'src');

    switch (config.framework) {
      case 'express': {
        files.push({
          path: join(srcDir, 'index.ts'),
          content: [
            `import express from 'express';`,
            ``,
            `const app = express();`,
            `const port = process.env.PORT || 3000;`,
            ``,
            `app.use(express.json());`,
            ``,
            `app.get('/api/health', (_req, res) => {`,
            `  res.json({ status: 'ok' });`,
            `});`,
            ``,
            `app.listen(port, () => {`,
            `  console.log(\`Server running at http://localhost:\${port}\`);`,
            `});`,
            ``,
            `export default app;`,
          ].join('\n'),
          type: 'source',
        });
        break;
      }
      case 'react': {
        files.push({
          path: join(srcDir, 'App.tsx'),
          content: [
            `import React from 'react';`,
            ``,
            `export function App(): React.ReactElement {`,
            `  return (`,
            `    <div className="app">`,
            `      <h1>${config.name}</h1>`,
            `      <p>${config.description}</p>`,
            `    </div>`,
            `  );`,
            `}`,
          ].join('\n'),
          type: 'source',
        });
        files.push({
          path: join(srcDir, 'main.tsx'),
          content: [
            `import React from 'react';`,
            `import { createRoot } from 'react-dom/client';`,
            `import { App } from './App.js';`,
            ``,
            `const root = createRoot(document.getElementById('root')!);`,
            `root.render(<React.StrictMode><App /></React.StrictMode>);`,
          ].join('\n'),
          type: 'source',
        });
        break;
      }
      case 'vue': {
        files.push({
          path: join(srcDir, 'App.vue'),
          content: [
            `<template>`,
            `  <div class="app">`,
            `    <h1>${config.name}</h1>`,
            `    <p>${config.description}</p>`,
            `  </div>`,
            `</template>`,
            ``,
            `<script setup lang="ts">`,
            `// ${config.name} main component`,
            `</script>`,
          ].join('\n'),
          type: 'source',
        });
        break;
      }
      case 'next': {
        files.push({
          path: join(config.outputDir, 'pages', 'index.tsx'),
          content: [
            `import type { NextPage } from 'next';`,
            ``,
            `const Home: NextPage = () => {`,
            `  return (`,
            `    <main>`,
            `      <h1>${config.name}</h1>`,
            `      <p>${config.description}</p>`,
            `    </main>`,
            `  );`,
            `};`,
            ``,
            `export default Home;`,
          ].join('\n'),
          type: 'source',
        });
        break;
      }
      default: {
        files.push({
          path: join(srcDir, 'index.ts'),
          content: [
            `// ${config.name}`,
            `// ${config.description}`,
            ``,
            `console.log('Hello from ${config.name}!');`,
          ].join('\n'),
          type: 'source',
        });
      }
    }

    return files;
  }

  /**
   * Generate README content.
   */
  static generateReadme(config: ScaffoldConfig): string {
    return [
      `# ${config.name}`,
      ``,
      `${config.description}`,
      ``,
      `## Tech Stack`,
      `- Framework: ${config.framework}`,
      `- Language: ${config.language}`,
      `- Package Manager: ${config.packageManager}`,
      ``,
      `## Getting Started`,
      ``,
      `\`\`\`bash`,
      `${config.packageManager} install`,
      `${config.packageManager} run dev`,
      `\`\`\``,
      ``,
      `## Project Structure`,
      `\`\`\``,
      `src/        - Source code`,
      `  index.${config.language === 'typescript' ? 'ts' : 'js'}`,
      `\`\`\``,
    ].join('\n');
  }
}

// ---------------------------------------------------------------------------
// Preview Server
// ---------------------------------------------------------------------------

export class PreviewServer {
  private config: PreviewServerConfig;
  private server: ReturnType<typeof createServer> | null = null;
  private state: PreviewInfo;

  constructor(config: PreviewServerConfig) {
    this.config = config;
    this.state = {
      url: `http://localhost:${config.port}`,
      port: config.port,
      status: 'stopped',
      errors: [],
    };
  }

  /**
   * Start the preview server.
   */
  async start(): Promise<PreviewInfo> {
    this.state.status = 'starting';

    return new Promise((resolve) => {
      this.server = createServer((_req: IncomingMessage, res: ServerResponse) => {
        const url = _req.url || '/';
        const filePath = join(this.config.rootDir, url === '/' ? 'index.html' : url);

        // Inject HMR script if enabled
        const isHtml = url === '/' || url.endsWith('.html');
        let content: string;
        try {
          content = readFileSync(filePath, 'utf-8');
          if (isHtml && this.config.hmr) {
            content = PreviewServer.injectHmr(content, this.config.port);
          }
          res.writeHead(200, { 'Content-Type': isHtml ? 'text/html' : 'text/plain' });
          res.end(content);
        } catch {
          res.writeHead(404);
          res.end('Not found');
        }
      });

      this.server.listen(this.config.port, () => {
        this.state.status = 'running';
        this.state.lastBuildMs = 0;
        resolve(this.state);
      });

      this.server.on('error', (err: Error) => {
        this.state.status = 'error';
        this.state.errors.push(err.message);
        resolve(this.state);
      });
    });
  }

  /**
   * Stop the preview server.
   */
  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          this.state.status = 'stopped';
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  /**
   * Get current server state.
   */
  getState(): PreviewInfo {
    return { ...this.state };
  }

  /**
   * Notify HMR of file changes.
   */
  notifyChange(filePath: string): void {
    // In production, this would send a WebSocket message to the client
    this.state.lastBuildMs = Date.now();
  }

  /**
   * Inject HMR client script into HTML.
   */
  private static injectHmr(html: string, port: number): string {
    const hmrScript = [
      `<script>`,
      `  const ws = new WebSocket('ws://localhost:${port}/__hmr');`,
      `  ws.onmessage = (e) => {`,
      `    if (e.data === 'reload') location.reload();`,
      `  };`,
      `</script>`,
    ].join('\n');
    return html.replace('</body>', `${hmrScript}\n</body>`);
  }
}

// ---------------------------------------------------------------------------
// Iteration Loop
// ---------------------------------------------------------------------------

export class IterationLoop {
  private history: IterationState[] = [];
  private maxIterations: number;

  constructor(maxIterations = 10) {
    this.maxIterations = maxIterations;
  }

  /**
   * Add an iteration to the history.
   */
  record(state: IterationState): void {
    this.history.push(state);
  }

  /**
   * Get iteration history.
   */
  getHistory(): IterationState[] {
    return [...this.history];
  }

  /**
   * Get the current iteration count.
   */
  get currentIteration(): number {
    return this.history.length;
  }

  /**
   * Check if maximum iterations have been reached.
   */
  get isDone(): boolean {
    return this.history.length >= this.maxIterations;
  }

  /**
   * Get the latest state.
   */
  get latest(): IterationState | null {
    return this.history[this.history.length - 1] || null;
  }

  /**
   * Create a diff between two iterations.
   */
  diff(fromIteration: number, toIteration: number): FileSpec[] {
    const from = this.history[fromIteration];
    const to = this.history[toIteration];
    if (!from || !to) return [];

    const changes: FileSpec[] = [];
    const fromFiles = new Map(from.generatedFiles.map(f => [f.path, f.content]));
    const toFiles = new Map(to.generatedFiles.map(f => [f.path, f.content]));

    // Find new and modified files
    for (const [path, content] of toFiles) {
      const oldContent = fromFiles.get(path);
      if (!oldContent || oldContent !== content) {
        changes.push({ path, content, type: 'source' });
      }
    }

    return changes;
  }

  /**
   * Reset the iteration history.
   */
  reset(): void {
    this.history = [];
  }
}

// ---------------------------------------------------------------------------
// AppGenerator — main orchestrator
// ---------------------------------------------------------------------------

export interface GenerationPrompt {
  description: string;
  framework?: string;
  language?: 'typescript' | 'javascript';
  features?: string[];
  outputDir?: string;
}

export interface GenerationResult {
  id: string;
  config: ScaffoldConfig;
  files: FileSpec[];
  previewUrl: string;
  iterations: IterationState[];
  generatedAt: number;
}

export class AppGenerator {
  private outputBaseDir: string;

  constructor(outputBaseDir?: string) {
    this.outputBaseDir = outputBaseDir || join(process.cwd(), '.generated-apps');
  }

  /**
   * Generate a full application from a prompt.
   */
  async generate(prompt: GenerationPrompt): Promise<GenerationResult> {
    const id = `gen-${randomUUID().slice(0, 8)}`;
    const outputDir = join(this.outputBaseDir, id);

    // Detect framework from prompt
    const framework = prompt.framework || AppGenerator.detectFramework(prompt.description);
    const language = prompt.language || 'typescript';

    const config: ScaffoldConfig = {
      name: prompt.description.slice(0, 30).replace(/[^a-zA-Z0-9-]/g, '-').toLowerCase() || 'generated-app',
      framework,
      language,
      packageManager: 'npm',
      libraries: prompt.features || [],
      description: prompt.description,
      outputDir,
      appType: AppGenerator.detectAppType(framework),
    };

    // Scaffold the project
    const files = ProjectScaffolder.scaffold(config);

    return {
      id,
      config,
      files,
      previewUrl: `http://localhost:0`,  // will be set by preview server
      iterations: [],
      generatedAt: Date.now(),
    };
  }

  /**
   * Run the full generate → preview → iterate loop.
   */
  async generateWithPreview(
    prompt: GenerationPrompt,
    previewPort?: number,
  ): Promise<{ result: GenerationResult; preview: PreviewServer | null }> {
    const result = await this.generate(prompt);

    const port = previewPort || 3000;
    const preview = new PreviewServer({
      port,
      rootDir: result.config.outputDir,
      framework: result.config.framework,
      hmr: true,
      openBrowser: true,
    });

    const info = await preview.start();
    result.previewUrl = info.url;

    return { result, preview };
  }

  /**
   * Detect the appropriate framework from a text prompt.
   */
  static detectFramework(prompt: string): string {
    const lower = prompt.toLowerCase();
    if (lower.includes('react') || lower.includes('component') || lower.includes('jsx')) return 'react';
    if (lower.includes('vue')) return 'vue';
    if (lower.includes('next') || lower.includes('ssr')) return 'next';
    if (lower.includes('api') || lower.includes('rest') || lower.includes('server')) return 'express';
    if (lower.includes('cli') || lower.includes('command')) return 'cli';
    return 'express';
  }

  /**
   * Detect application type from framework.
   */
  static detectAppType(framework: string): ScaffoldConfig['appType'] {
    switch (framework) {
      case 'react':
      case 'vue':
        return 'web';
      case 'express':
      case 'fastify':
        return 'api';
      case 'next':
        return 'fullstack';
      case 'cli':
        return 'cli';
      default:
        return 'api';
    }
  }
}
