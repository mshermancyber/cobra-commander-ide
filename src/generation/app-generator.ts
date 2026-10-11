import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  statSync,
  watch,
} from 'node:fs';
import { join, relative, extname, basename, dirname } from 'node:path';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createInterface } from 'node:readline';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StackRecommendation {
  framework: string;
  language: 'typescript' | 'javascript';
  styling: 'css' | 'tailwind' | 'styled-components' | 'css-modules';
  testing: 'vitest' | 'jest' | 'playwright';
  stateManagement?: 'redux' | 'zustand' | 'pinia' | 'context';
  routing?: 'react-router' | 'next-router' | 'vue-router';
  buildTool: 'vite' | 'webpack' | 'next' | 'nuxt';
  packageManager: 'npm' | 'yarn' | 'pnpm';
  confidence: number;
  reasoning: string;
}

export interface PromptAnalysis {
  rawPrompt: string;
  inferredProjectType: 'web' | 'api' | 'cli' | 'library' | 'fullstack' | 'mobile';
  inferredFeatures: string[];
  keywords: string[];
  stackRecommendation: StackRecommendation;
  ambiguityScore: number;
  clarificationQuestions: string[];
}

export interface FileTreeNode {
  name: string;
  type: 'directory' | 'file';
  children?: FileTreeNode[];
  fileType?: 'source' | 'config' | 'test' | 'style' | 'docs' | 'static';
  template?: string;
  testFile?: string;
}

export interface GeneratedFile {
  path: string;
  content: string;
  type: 'source' | 'config' | 'test' | 'style' | 'docs' | 'static';
  generatedBy: string;
}

export interface IterationRecord {
  iteration: number;
  timestamp: number;
  prompt: string;
  generatedFiles: GeneratedFile[];
  feedback?: string;
  changes: Array<{ file: string; action: 'added' | 'modified' | 'deleted' }>;
}

export interface PreviewServerConfig {
  port: number;
  rootDir: string;
  hmr: boolean;
  framework: string;
  openBrowser: boolean;
}

export interface PreviewState {
  url: string;
  port: number;
  status: 'starting' | 'running' | 'stopped' | 'error';
  startedAt?: number;
  errors: string[];
  watcherActive: boolean;
  clients: number;
}

export interface GenerationResult {
  id: string;
  prompt: PromptAnalysis;
  stack: StackRecommendation;
  files: GeneratedFile[];
  fileTree: FileTreeNode;
  iterations: IterationRecord[];
  previewUrl?: string;
  generatedAt: number;
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Prompt Analyzer — GAP-086: Infer project scaffold from natural language
// ---------------------------------------------------------------------------

export class PromptAnalyzer {
  private readonly FRAMEWORK_SIGNALS: Record<string, string[]> = {
    react: ['react', 'jsx', 'tsx', 'component', 'hook', 'redux', 'zustand', 'react-router'],
    vue: ['vue', 'vuex', 'pinia', 'composition', 'options api', 'vue-router', 'sfc'],
    svelte: ['svelte', 'sveltekit'],
    angular: ['angular', 'ngmodule', 'rxjs'],
    next: ['next.js', 'nextjs', 'ssr', 'server component', 'app router', 'pages router'],
    nuxt: ['nuxt', 'nuxt.js'],
    express: ['express', 'middleware', 'rest api', 'endpoint'],
    fastify: ['fastify', 'fast api'],
    nest: ['nestjs', 'nest', 'decorator', 'module'],
    astro: ['astro', 'static site'],
    remix: ['remix', 'loader', 'action'],
    solid: ['solidjs', 'solid-js'],
  };

  private readonly PROJECT_TYPE_SIGNALS: Record<string, string[]> = {
    web: ['website', 'spa', 'frontend', 'ui', 'page', 'browser', 'client-side', 'dashboard'],
    api: ['api', 'backend', 'server', 'rest', 'graphql', 'endpoint', 'microservice'],
    fullstack: ['fullstack', 'full-stack', 'both', 'frontend and backend', 'monolithic'],
    cli: ['cli', 'command line', 'terminal', 'tool', 'script'],
    library: ['library', 'package', 'npm', 'sdk', 'reusable'],
    mobile: ['mobile', 'react native', 'expo', 'flutter', 'ios', 'android'],
  };

  private readonly FEATURE_SIGNALS: Record<string, string[]> = {
    auth: ['auth', 'login', 'signup', 'authentication', 'oauth', 'jwt', 'session'],
    database: ['database', 'postgres', 'mysql', 'mongodb', 'sqlite', 'prisma', 'orm', 'drizzle'],
    stateManagement: ['state', 'store', 'redux', 'zustand', 'pinia', 'context'],
    routing: ['routing', 'router', 'navigation', 'pages'],
    testing: ['test', 'testing', 'unit', 'integration', 'e2e'],
    styling: ['css', 'tailwind', 'sass', 'styled', 'style', 'design'],
    i18n: ['i18n', 'internationalization', 'translate', 'locale', 'language'],
    realtime: ['realtime', 'websocket', 'socket', 'live', 'streaming'],
    fileUpload: ['upload', 'file', 's3', 'storage', 'image'],
    payment: ['payment', 'stripe', 'billing', 'checkout', 'subscription'],
    search: ['search', 'fulltext', 'elasticsearch', 'algolia'],
    notification: ['notification', 'email', 'push', 'alert', 'sms'],
    analytics: ['analytics', 'tracking', 'metrics', 'dashboard', 'report'],
    caching: ['cache', 'redis', 'caching', 'performance'],
    docker: ['docker', 'container', 'containerized'],
    ci: ['ci/cd', 'ci', 'pipeline', 'github actions', 'gitlab ci'],
  };

  /**
   * Analyze a natural language prompt and infer the tech stack and features.
   */
  analyze(prompt: string): PromptAnalysis {
    const lower = prompt.toLowerCase();
    const keywords = this.extractKeywords(lower);
    const projectType = this.inferProjectType(lower);
    const features = this.inferFeatures(lower);
    const stack = this.recommendStack(lower, projectType, features);
    const ambiguityScore = this.computeAmbiguityScore(lower, stack);
    const questions = ambiguityScore > 0.3 ? this.generateClarificationQuestions(lower, stack, features) : [];

    return {
      rawPrompt: prompt,
      inferredProjectType: projectType,
      inferredFeatures: features,
      keywords,
      stackRecommendation: stack,
      ambiguityScore,
      clarificationQuestions: questions,
    };
  }

  private extractKeywords(lower: string): string[] {
    const allKeywords = [
      ...Object.keys(this.FRAMEWORK_SIGNALS),
      ...Object.keys(this.PROJECT_TYPE_SIGNALS),
      ...Object.keys(this.FEATURE_SIGNALS),
    ];
    return allKeywords.filter(kw => lower.includes(kw));
  }

  private inferProjectType(lower: string): PromptAnalysis['inferredProjectType'] {
    let best: PromptAnalysis['inferredProjectType'] = 'web';
    let maxSignals = 0;
    for (const [type, signals] of Object.entries(this.PROJECT_TYPE_SIGNALS)) {
      const count = signals.filter(s => lower.includes(s)).length;
      if (count > maxSignals) {
        maxSignals = count;
        best = type as PromptAnalysis['inferredProjectType'];
      }
    }
    return best;
  }

  private inferFeatures(lower: string): string[] {
    const features: string[] = [];
    for (const [feature, signals] of Object.entries(this.FEATURE_SIGNALS)) {
      if (signals.some(s => lower.includes(s))) features.push(feature);
    }
    return features;
  }

  private recommendStack(
    lower: string,
    projectType: PromptAnalysis['inferredProjectType'],
    features: string[],
  ): StackRecommendation {
    // Determine framework
    let framework = 'react';
    let maxSignals = 0;
    for (const [fw, signals] of Object.entries(this.FRAMEWORK_SIGNALS)) {
      const count = signals.filter(s => lower.includes(s)).length;
      if (count > maxSignals) { maxSignals = count; framework = fw; }
    }

    // Default by project type if no strong signal
    if (maxSignals === 0) {
      if (projectType === 'api') framework = 'express';
      else if (projectType === 'cli') framework = 'cli';
      else if (projectType === 'library') framework = 'library';
      else framework = 'react';
    }

    // Determine styling
    let styling: StackRecommendation['styling'] = 'css';
    if (lower.includes('tailwind')) styling = 'tailwind';
    else if (lower.includes('styled-component')) styling = 'styled-components';
    else if (lower.includes('css-module')) styling = 'css-modules';

    // Determine testing
    let testing: StackRecommendation['testing'] = 'vitest';
    if (lower.includes('jest')) testing = 'jest';
    else if (lower.includes('playwright')) testing = 'playwright';

    // Determine state management
    let stateManagement: StackRecommendation['stateManagement'] | undefined;
    if (lower.includes('redux')) stateManagement = 'redux';
    else if (lower.includes('zustand')) stateManagement = 'zustand';
    else if (lower.includes('pinia')) stateManagement = 'pinia';
    else if (lower.includes('context')) stateManagement = 'context';

    // Determine routing
    let routing: StackRecommendation['routing'] | undefined;
    if (framework === 'next') routing = 'next-router';
    else if (framework === 'vue' || framework === 'nuxt') routing = 'vue-router';
    else if (framework === 'react') routing = 'react-router';

    // Determine build tool
    let buildTool: StackRecommendation['buildTool'] = 'vite';
    if (framework === 'next') buildTool = 'next';
    else if (framework === 'nuxt') buildTool = 'nuxt';
    else if (lower.includes('webpack')) buildTool = 'webpack';

    // Package manager
    let packageManager: StackRecommendation['packageManager'] = 'npm';
    if (lower.includes('yarn')) packageManager = 'yarn';
    else if (lower.includes('pnpm')) packageManager = 'pnpm';

    const confidence = maxSignals > 2 ? 0.9 : maxSignals > 0 ? 0.6 : 0.3;

    const reasoningParts = [`Detected framework "${framework}" based on ${maxSignals} keyword matches`];
    if (projectType !== 'web') reasoningParts.push(`inferred project type "${projectType}"`);
    if (features.length > 0) reasoningParts.push(`with features: ${features.join(', ')}`);

    return {
      framework,
      language: lower.includes('javascript') && !lower.includes('typescript') ? 'javascript' : 'typescript',
      styling,
      testing,
      stateManagement,
      routing,
      buildTool,
      packageManager,
      confidence,
      reasoning: reasoningParts.join(', ') + '.',
    };
  }

  private computeAmbiguityScore(lower: string, stack: StackRecommendation): number {
    let score = 0;
    // Check for competing frameworks
    const frameworkMatches = Object.entries(this.FRAMEWORK_SIGNALS)
      .filter(([, signals]) => signals.some(s => lower.includes(s)))
      .length;
    if (frameworkMatches > 2) score += 0.3;
    if (stack.confidence < 0.5) score += 0.4;
    if (!lower.includes('test') && !lower.includes('testing')) score += 0.1;
    return Math.min(score, 1.0);
  }

  private generateClarificationQuestions(
    _lower: string,
    stack: StackRecommendation,
    features: string[],
  ): string[] {
    const questions: string[] = [];
    if (stack.confidence < 0.5) {
      questions.push(`Framework choice uncertain — did you have a preference between React, Vue, or another?`);
    }
    if (!features.includes('auth') && !features.includes('database')) {
      questions.push('Will this app need authentication or a database?');
    }
    if (!features.includes('testing')) {
      questions.push('Should test scaffolding be included?');
    }
    return questions;
  }
}

// ---------------------------------------------------------------------------
// File Tree Generator — GAP-086: Plan routes, components, styles, tests
// ---------------------------------------------------------------------------

export interface TreeGeneratorOptions {
  includeTests: boolean;
  includeStyles: boolean;
  includeStorybook: boolean;
  includeE2E: boolean;
  routes?: string[];
  componentNames?: string[];
}

export class FileTreeGenerator {
  private readonly FRAMEWORK_TEMPLATES: Record<string, FileTreeNode> = {
    react: {
      name: 'src',
      type: 'directory',
      children: [
        { name: 'components', type: 'directory', children: [] },
        { name: 'pages', type: 'directory', children: [] },
        { name: 'hooks', type: 'directory', children: [] },
        { name: 'utils', type: 'directory', children: [] },
        { name: 'types', type: 'directory', children: [] },
        { name: 'styles', type: 'directory', children: [] },
        { name: 'main.tsx', type: 'file', fileType: 'source', template: 'react-entry' },
        { name: 'App.tsx', type: 'file', fileType: 'source', template: 'react-app' },
        { name: 'vite-env.d.ts', type: 'file', fileType: 'config' },
      ],
    },
    vue: {
      name: 'src',
      type: 'directory',
      children: [
        { name: 'components', type: 'directory', children: [] },
        { name: 'pages', type: 'directory', children: [] },
        { name: 'composables', type: 'directory', children: [] },
        { name: 'utils', type: 'directory', children: [] },
        { name: 'types', type: 'directory', children: [] },
        { name: 'styles', type: 'directory', children: [] },
        { name: 'main.ts', type: 'file', fileType: 'source', template: 'vue-entry' },
        { name: 'App.vue', type: 'file', fileType: 'source', template: 'vue-app' },
      ],
    },
    express: {
      name: 'src',
      type: 'directory',
      children: [
        { name: 'routes', type: 'directory', children: [] },
        { name: 'middleware', type: 'directory', children: [] },
        { name: 'controllers', type: 'directory', children: [] },
        { name: 'services', type: 'directory', children: [] },
        { name: 'models', type: 'directory', children: [] },
        { name: 'utils', type: 'directory', children: [] },
        { name: 'types', type: 'directory', children: [] },
        { name: 'index.ts', type: 'file', fileType: 'source', template: 'express-entry' },
      ],
    },
    fastify: {
      name: 'src',
      type: 'directory',
      children: [
        { name: 'routes', type: 'directory', children: [] },
        { name: 'plugins', type: 'directory', children: [] },
        { name: 'schemas', type: 'directory', children: [] },
        { name: 'services', type: 'directory', children: [] },
        { name: 'utils', type: 'directory', children: [] },
        { name: 'types', type: 'directory', children: [] },
        { name: 'index.ts', type: 'file', fileType: 'source', template: 'fastify-entry' },
      ],
    },
    next: {
      name: 'src',
      type: 'directory',
      children: [
        { name: 'app', type: 'directory', children: [
          { name: 'layout.tsx', type: 'file', fileType: 'source', template: 'next-layout' },
          { name: 'page.tsx', type: 'file', fileType: 'source', template: 'next-page' },
        ]},
        { name: 'components', type: 'directory', children: [] },
        { name: 'lib', type: 'directory', children: [] },
        { name: 'hooks', type: 'directory', children: [] },
        { name: 'types', type: 'directory', children: [] },
      ],
    },
  };

  private readonly ROOT_TEMPLATES: Record<string, FileTreeNode[]> = {
    react: [
      { name: 'vite.config.ts', type: 'file', fileType: 'config', template: 'vite-react' },
      { name: 'index.html', type: 'file', fileType: 'static', template: 'html' },
      { name: 'package.json', type: 'file', fileType: 'config', template: 'package' },
    ],
    vue: [
      { name: 'vite.config.ts', type: 'file', fileType: 'config', template: 'vite-vue' },
      { name: 'index.html', type: 'file', fileType: 'static', template: 'html' },
      { name: 'package.json', type: 'file', fileType: 'config', template: 'package' },
    ],
    express: [
      { name: 'package.json', type: 'file', fileType: 'config', template: 'package' },
      { name: 'tsconfig.json', type: 'file', fileType: 'config', template: 'tsconfig' },
    ],
    fastify: [
      { name: 'package.json', type: 'file', fileType: 'config', template: 'package' },
      { name: 'tsconfig.json', type: 'file', fileType: 'config', template: 'tsconfig' },
    ],
    next: [
      { name: 'next.config.ts', type: 'file', fileType: 'config', template: 'next-config' },
      { name: 'package.json', type: 'file', fileType: 'config', template: 'package' },
    ],
  };

  /**
   * Generate a full file tree from a stack recommendation and options.
   */
  generate(stack: StackRecommendation, options: TreeGeneratorOptions): FileTreeNode {
    const framework = stack.framework;
    const baseTemplate = this.FRAMEWORK_TEMPLATES[framework];

    // Clone the template
    const tree: FileTreeNode = baseTemplate
      ? JSON.parse(JSON.stringify(baseTemplate))
      : { name: 'src', type: 'directory', children: [] };

    const rootFiles: FileTreeNode[] = (this.ROOT_TEMPLATES[framework] || [])
      .map(f => JSON.parse(JSON.stringify(f)));

    // Add routes
    if (options.routes && options.routes.length > 0) {
      const pagesDir = this.findOrCreateDir(tree, framework === 'next' ? 'app' : 'pages');
      for (const route of options.routes) {
        const routeName = route.replace(/[^a-zA-Z0-9-]/g, '-').toLowerCase();
        const componentFileName = framework === 'vue'
          ? `${routeName}.vue`
          : `${routeName}.tsx`;
        (pagesDir.children ||= []).push({
          name: componentFileName,
          type: 'file',
          fileType: 'source',
          template: `${framework}-page`,
        });
        if (options.includeTests) {
          (pagesDir.children ||= []).push({
            name: `${routeName}.test.${stack.language === 'typescript' ? 'ts' : 'js'}${framework === 'vue' ? '' : 'x'}`,
            type: 'file',
            fileType: 'test',
          });
        }
      }
    }

    // Add components
    if (options.componentNames && options.componentNames.length > 0) {
      const componentsDir = this.findOrCreateDir(tree, 'components');
      for (const comp of options.componentNames) {
        const ext = framework === 'vue' ? '.vue' : '.tsx';
        (componentsDir.children ||= []).push({ name: `${comp}${ext}`, type: 'file', fileType: 'source' });
        if (options.includeStyles) {
          (componentsDir.children ||= []).push({
            name: `${comp}.${stack.styling === 'css-modules' ? 'module.' : ''}css`,
            type: 'file',
            fileType: 'style',
          });
        }
        if (options.includeTests) {
          (componentsDir.children ||= []).push({
            name: `${comp}.test.${stack.language === 'typescript' ? 'ts' : 'js'}${ext === '.vue' ? '' : 'x'}`,
            type: 'file',
            fileType: 'test',
          });
        }
      }
    }

    // Add test directory if enabled
    if (options.includeTests) {
      const testDir = (tree.children || []).find(c => c.type === 'directory' && c.name === '__tests__');
      if (!testDir) {
        (tree.children ||= []).push({ name: '__tests__', type: 'directory', children: [] });
      }
    }

    // Add storybook directory
    if (options.includeStorybook) {
      const storiesDir = this.findOrCreateDir(tree, 'components');
      (storiesDir.children ||= []).push({
        name: 'Component.stories.tsx',
        type: 'file',
        fileType: 'source',
        template: 'story',
      });
    }

    // Build wrapper node with root files
    const root: FileTreeNode = {
      name: '<project>',
      type: 'directory',
      children: [
        ...rootFiles,
        tree,
      ],
    };

    return root;
  }

  /**
   * Find or create a directory node by name.
   */
  private findOrCreateDir(tree: FileTreeNode, dirName: string): FileTreeNode {
    const existing = (tree.children || []).find(
      c => c.type === 'directory' && c.name === dirName,
    );
    if (existing) return existing;
    const dir: FileTreeNode = { name: dirName, type: 'directory', children: [] };
    (tree.children ||= []).push(dir);
    return dir;
  }

  /**
   * Convert the tree to a list of relative file paths.
   */
  static flattenTree(tree: FileTreeNode, prefix = ''): string[] {
    const paths: string[] = [];
    const currentPath = prefix ? `${prefix}/${tree.name}` : tree.name;
    if (tree.type === 'file') {
      paths.push(currentPath);
    } else if (tree.children) {
      for (const child of tree.children) {
        paths.push(...FileTreeGenerator.flattenTree(child, currentPath));
      }
    }
    return paths;
  }

  /**
   * Pretty-print a file tree.
   */
  static printTree(tree: FileTreeNode, indent = 0): string {
    const prefix = '  '.repeat(indent);
    const connector = indent === 0 ? '' : '├── ';
    const icon = tree.type === 'directory' ? '📁' : '📄';
    let result = `${prefix}${connector}${icon} ${tree.name}\n`;
    if (tree.type === 'directory' && tree.children) {
      for (const child of tree.children) {
        result += FileTreeGenerator.printTree(child, indent + 1);
      }
    }
    return result;
  }
}

// ---------------------------------------------------------------------------
// Code Generator — GAP-086: Generate actual file contents from templates
// ---------------------------------------------------------------------------

export class CodeGenerator {
  /**
   * Generate file content from a tree node's template hint.
   */
  generateFile(node: FileTreeNode, stack: StackRecommendation): string {
    const template = node.template || this.inferTemplate(node, stack);
    return this.resolveTemplate(template, node, stack);
  }

  /**
   * Infer template name from file path.
   */
  private inferTemplate(node: FileTreeNode, stack: StackRecommendation): string {
    const name = node.name.toLowerCase();
    if (name.endsWith('.test.ts') || name.endsWith('.test.tsx') || name.endsWith('.spec.ts')) return 'test';
    if (name.endsWith('.css') || name.endsWith('.scss')) return 'style';
    if (name === 'package.json') return 'package';
    if (name === 'tsconfig.json') return 'tsconfig';
    if (name.endsWith('.vue')) return 'vue-component';
    if (name.endsWith('.tsx')) return 'react-component';
    return `default-${stack.framework}`;
  }

  /**
   * Resolve a template name to actual file content.
   */
  private resolveTemplate(template: string, node: FileTreeNode, stack: StackRecommendation): string {
    const name = node.name.replace(/\.[^.]+$/, '');
    const isTs = stack.language === 'typescript';

    switch (template) {
      case 'react-entry':
        return [
          `import { StrictMode } from 'react';`,
          `import { createRoot } from 'react-dom/client';`,
          `import App from './App.js';`,
          `import './styles/index.css';`,
          ``,
          `const rootEl = document.getElementById('root');`,
          `if (!rootEl) throw new Error('Root element not found');`,
          ``,
          `createRoot(rootEl).render(`,
          `  <StrictMode>`,
          `    <App />`,
          `  </StrictMode>,`,
          `);`,
        ].join('\n');

      case 'react-app':
        return [
          `import { useState } from 'react';`,
          ``,
          `export default function App() {`,
          `  const [count, setCount] = useState(0);`,
          ``,
          `  return (`,
          `    <main className="app">`,
          `      <h1>Welcome</h1>`,
          `      <p>Edit src/App.tsx and save to reload.</p>`,
          `      <button onClick={() => setCount(c => c + 1)}>`,
          `        Count: {count}`,
          `      </button>`,
          `    </main>`,
          `  );`,
          `}`,
        ].join('\n');

      case 'react-page':
      case 'react-component':
        return [
          `import type { FC } from 'react';`,
          ``,
          `interface ${name}Props {`,
          `  className?: string;`,
          `}`,
          ``,
          `export const ${name}: FC<${name}Props> = ({ className }) => {`,
          `  return (`,
          `    <div className={className}>`,
          `      <h2>${name}</h2>`,
          `    </div>`,
          `  );`,
          `};`,
          ``,
          `export default ${name};`,
        ].join('\n');

      case 'vue-entry':
        return [
          `import { createApp } from 'vue';`,
          `import App from './App.vue';`,
          `import './styles/index.css';`,
          ``,
          `createApp(App).mount('#app');`,
        ].join('\n');

      case 'vue-app':
        return [
          `<template>`,
          `  <main class="app">`,
          `    <h1>Welcome</h1>`,
          `    <p>Edit src/App.vue and save to reload.</p>`,
          `  </main>`,
          `</template>`,
          ``,
          `<script setup lang="ts">`,
          `// App root component`,
          `</script>`,
          ``,
          `<style scoped>`,
          `.app {`,
          `  text-align: center;`,
          `  padding: 2rem;`,
          `}`,
          `</style>`,
        ].join('\n');

      case 'vue-component':
        return [
          `<template>`,
          `  <div class="${name.toLowerCase()}">`,
          `    <slot />`,
          `  </div>`,
          `</template>`,
          ``,
          `<script setup lang="ts">`,
          `interface Props {`,
          `  className?: string;`,
          `}`,
          ``,
          `const props = defineProps<Props>();`,
          `</script>`,
        ].join('\n');

      case 'express-entry':
        return [
          `import express from 'express';`,
          `import { healthRouter } from './routes/health.js';`,
          ``,
          `const app = express();`,
          `const port = process.env.PORT || 3000;`,
          ``,
          `app.use(express.json());`,
          `app.use('/health', healthRouter);`,
          ``,
          `app.listen(port, () => {`,
          `  console.log(\`Server running at http://localhost:\${port}\`);`,
          `});`,
          ``,
          `export default app;`,
        ].join('\n');

      case 'fastify-entry':
        return [
          `import Fastify from 'fastify';`,
          `import { healthRoutes } from './routes/health.js';`,
          ``,
          `const fastify = Fastify({ logger: true });`,
          ``,
          `await fastify.register(healthRoutes);`,
          ``,
          `try {`,
          `  await fastify.listen({ port: 3000 });`,
          `} catch (err) {`,
          `  fastify.log.error(err);`,
          `  process.exit(1);`,
          `}`,
        ].join('\n');

      case 'next-layout':
        return [
          `import type { Metadata } from 'next';`,
          `import './globals.css';`,
          ``,
          `export const metadata: Metadata = {`,
          `  title: 'Generated App',`,
          `  description: 'Built with Cobra Commander',`,
          `};`,
          ``,
          `export default function RootLayout({`,
          `  children,`,
          `}: {`,
          `  children: React.ReactNode;`,
          `}) {`,
          `  return (`,
          `    <html lang="en">`,
          `      <body>{children}</body>`,
          `    </html>`,
          `  );`,
          `}`,
        ].join('\n');

      case 'next-page':
        return [
          `export default function HomePage() {`,
          `  return (`,
          `    <main>`,
          `      <h1>Welcome</h1>`,
          `      <p>Built with Cobra Commander</p>`,
          `    </main>`,
          `  );`,
          `}`,
        ].join('\n');

      case 'next-config':
        return [
          `import type { NextConfig } from 'next';`,
          ``,
          `const nextConfig: NextConfig = {`,
          `  // configuration`,
          `};`,
          ``,
          `export default nextConfig;`,
        ].join('\n');

      case 'vite-react':
        return [
          `import { defineConfig } from 'vite';`,
          `import react from '@vitejs/plugin-react';`,
          ``,
          `export default defineConfig({`,
          `  plugins: [react()],`,
          `});`,
        ].join('\n');

      case 'vite-vue':
        return [
          `import { defineConfig } from 'vite';`,
          `import vue from '@vitejs/plugin-vue';`,
          ``,
          `export default defineConfig({`,
          `  plugins: [vue()],`,
          `});`,
        ].join('\n');

      case 'html':
        return [
          `<!DOCTYPE html>`,
          `<html lang="en">`,
          `<head>`,
          `  <meta charset="UTF-8" />`,
          `  <meta name="viewport" content="width=device-width, initial-scale=1.0" />`,
          `  <title>Generated App</title>`,
          `</head>`,
          `<body>`,
          `  <div id="root"></div>`,
          `  <script type="module" src="/src/main.tsx"></script>`,
          `</body>`,
          `</html>`,
        ].join('\n');

      case 'test':
        return [
          `import { describe, it, expect } from 'vitest';`,
          ``,
          `describe('${name}', () => {`,
          `  it('should work', () => {`,
          `    expect(true).toBe(true);`,
          `  });`,
          `});`,
        ].join('\n');

      case 'style':
        return [
          `.${name.toLowerCase()} {`,
          `  /* Add styles here */`,
          `}`,
        ].join('\n');

      case 'story':
        return [
          `import type { Meta, StoryObj } from '@storybook/react';`,
          `import { Button } from './Button.js';`,
          ``,
          `const meta: Meta<typeof Button> = {`,
          `  component: Button,`,
          `  title: 'Components/Button',`,
          `};`,
          ``,
          `export default meta;`,
          ``,
          `type Story = StoryObj<typeof Button>;`,
          ``,
          `export const Primary: Story = {`,
          `  args: { label: 'Click me' },`,
          `};`,
        ].join('\n');

      case 'package':
        return this.generatePackageJson(stack);

      case 'tsconfig':
        return JSON.stringify({
          compilerOptions: {
            target: 'ES2022',
            module: isTs ? 'NodeNext' : 'ESNext',
            moduleResolution: isTs ? 'NodeNext' : 'Bundler',
            strict: true,
            esModuleInterop: true,
            outDir: 'dist',
            rootDir: 'src',
            skipLibCheck: true,
            jsx: stack.framework === 'react' ? 'react-jsx' : undefined,
          },
          include: ['src'],
        }, null, 2);

      default:
        return `// Generated: ${node.name}\n// Template: ${template}\n`;
    }
  }

  private generatePackageJson(stack: StackRecommendation): string {
    const pkg: Record<string, unknown> = {
      name: 'generated-app',
      version: '0.1.0',
      private: true,
      type: 'module',
      scripts: {
        dev: this.devCommand(stack),
        build: this.buildCommand(stack),
        start: this.startCommand(stack),
      },
    };

    if (stack.testing === 'vitest') {
      (pkg.scripts as Record<string, string>).test = 'vitest run';
    } else if (stack.testing === 'jest') {
      (pkg.scripts as Record<string, string>).test = 'jest';
    }

    return JSON.stringify(pkg, null, 2);
  }

  private devCommand(stack: StackRecommendation): string {
    switch (stack.framework) {
      case 'next': return 'next dev';
      case 'nuxt': return 'nuxt dev';
      case 'vue': return 'vite';
      case 'react': return 'vite';
      case 'svelte': return 'vite dev';
      default: return 'tsx src/index.ts';
    }
  }

  private buildCommand(stack: StackRecommendation): string {
    switch (stack.framework) {
      case 'next': return 'next build';
      case 'nuxt': return 'nuxt build';
      case 'vue': return 'vue-tsc && vite build';
      case 'react': return 'tsc && vite build';
      default: return 'tsc';
    }
  }

  private startCommand(stack: StackRecommendation): string {
    switch (stack.framework) {
      case 'next': return 'next start';
      case 'express': return 'node dist/index.js';
      case 'fastify': return 'node dist/index.js';
      default: return 'vite preview';
    }
  }
}

// ---------------------------------------------------------------------------
// Live Preview Server with HMR — GAP-086
// ---------------------------------------------------------------------------

export class LivePreviewServer {
  private config: PreviewServerConfig;
  private server: ReturnType<typeof createServer> | null = null;
  private state: PreviewState;
  private watcher: ReturnType<typeof watch> | null = null;
  private clientCount = 0;
  private readonly MIME_TYPES: Record<string, string> = {
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'application/javascript',
    '.ts': 'application/typescript',
    '.tsx': 'text/typescript',
    '.jsx': 'text/javascript',
    '.json': 'application/json',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.woff2': 'font/woff2',
    '.vue': 'text/html',
  };

  constructor(config: PreviewServerConfig) {
    this.config = config;
    this.state = {
      url: `http://localhost:${config.port}`,
      port: config.port,
      status: 'stopped',
      errors: [],
      watcherActive: false,
      clients: 0,
    };
  }

  async start(): Promise<PreviewState> {
    this.state.status = 'starting';

    return new Promise((resolve) => {
      this.server = createServer((req: IncomingMessage, res: ServerResponse) => {
        this.handleRequest(req, res);
      });

      this.server.listen(this.config.port, () => {
        this.state.status = 'running';
        this.state.startedAt = Date.now();

        if (this.config.hmr) {
          this.startFileWatcher();
        }

        resolve({ ...this.state });
      });

      this.server.on('error', (err: Error) => {
        this.state.status = 'error';
        this.state.errors.push(err.message);
        resolve({ ...this.state });
      });
    });
  }

  async stop(): Promise<void> {
    if (this.watcher) {
      this.watcher.close();
      this.state.watcherActive = false;
    }
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

  getState(): PreviewState {
    return { ...this.state };
  }

  notifyReload(): void {
    // HMR clients would receive WebSocket events in a full implementation
    this.state.clients = this.clientCount;
  }

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    const url = req.url || '/';

    // HMR endpoint
    if (url === '/__hmr' && req.headers.upgrade === 'websocket') {
      this.clientCount++;
      res.writeHead(200);
      res.end();
      return;
    }

    // Try to serve from rootDir
    const filePath = url === '/' || url === '/index.html'
      ? join(this.config.rootDir, 'index.html')
      : join(this.config.rootDir, url);

    try {
      if (existsSync(filePath) && statSync(filePath).isFile()) {
        const content = readFileSync(filePath);
        const ext = extname(filePath).toLowerCase();
        const mime = this.MIME_TYPES[ext] || 'application/octet-stream';

        // Inject HMR script into HTML
        if ((ext === '.html' || ext === '') && this.config.hmr) {
          let html = content.toString('utf-8');
          html = this.injectHmrScript(html);
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(html);
        } else {
          res.writeHead(200, { 'Content-Type': mime });
          res.end(content);
        }
      } else {
        // SPA fallback: serve index.html
        const indexPath = join(this.config.rootDir, 'index.html');
        if (existsSync(indexPath)) {
          let html = readFileSync(indexPath, 'utf-8');
          if (this.config.hmr) html = this.injectHmrScript(html);
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(html);
        } else {
          res.writeHead(404);
          res.end('Not Found');
        }
      }
    } catch (err) {
      res.writeHead(500);
      res.end(`Server Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private injectHmrScript(html: string): string {
    const hmr = [
      `<script>`,
      `(function() {`,
      `  var ws = new WebSocket('ws://localhost:${this.config.port}/__hmr');`,
      `  ws.onmessage = function(e) {`,
      `    if (e.data === 'reload') location.reload();`,
      `    if (e.data === 'refresh-css') {`,
      `      var links = document.querySelectorAll('link[rel=stylesheet]');`,
      `      links.forEach(function(l) {`,
      `        l.href = l.href.replace(/\\?.*/, '') + '?v=' + Date.now();`,
      `      });`,
      `    }`,
      `  };`,
      `  ws.onclose = function() {`,
      `    setTimeout(function() { location.reload(); }, 2000);`,
      `  };`,
      `})();`,
      `</script>`,
    ].join('\n');
    return html.replace('</body>', `${hmr}\n</body>`);
  }

  private startFileWatcher(): void {
    try {
      this.watcher = watch(
        this.config.rootDir,
        { recursive: true },
        (_eventType, filename) => {
          if (filename && !filename.includes('node_modules') && !filename.includes('.git')) {
            this.notifyReload();
          }
        },
      );
      this.state.watcherActive = true;
    } catch {
      this.state.watcherActive = false;
    }
  }
}

// ---------------------------------------------------------------------------
// Iterative Refinement Loop — GAP-086
// ---------------------------------------------------------------------------

export interface RefinementOptions {
  maxIterations: number;
  autoAccept: boolean;
  previewPort: number;
}

export class IterativeRefinementLoop {
  private history: IterationRecord[] = [];
  private maxIterations: number;
  private codeGenerator: CodeGenerator;
  private previewServer: LivePreviewServer | null = null;

  constructor(options?: RefinementOptions) {
    this.maxIterations = options?.maxIterations ?? 10;
    this.codeGenerator = new CodeGenerator();
  }

  get iterationCount(): number {
    return this.history.length;
  }

  get isMaxedOut(): boolean {
    return this.history.length >= this.maxIterations;
  }

  get latest(): IterationRecord | null {
    return this.history[this.history.length - 1] ?? null;
  }

  /**
   * Execute one iteration: generate → write → preview → (await feedback) → refine.
   */
  async iterate(
    prompt: string,
    stack: StackRecommendation,
    fileTree: FileTreeNode,
    outputDir: string,
    previewPort: number,
  ): Promise<IterationRecord> {
    const iteration = this.history.length + 1;
    const genFiles = this.generateAllFiles(fileTree, stack, outputDir);

    // Write files to disk
    for (const file of genFiles) {
      const fullPath = join(outputDir, file.path);
      const dir = dirname(fullPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(fullPath, file.content);
    }

    // Start preview server if not running
    if (!this.previewServer) {
      this.previewServer = new LivePreviewServer({
        port: previewPort,
        rootDir: outputDir,
        hmr: true,
        framework: stack.framework,
        openBrowser: false,
      });
      await this.previewServer.start();
    }

    const record: IterationRecord = {
      iteration,
      timestamp: Date.now(),
      prompt,
      generatedFiles: genFiles,
      changes: genFiles.map(f => ({ file: f.path, action: 'added' })),
    };

    this.history.push(record);
    return record;
  }

  /**
   * Apply feedback to modify generated files.
   */
  applyFeedback(
    feedback: string,
    stack: StackRecommendation,
    fileTree: FileTreeNode,
    outputDir: string,
  ): IterationRecord {
    const lastRecord = this.latest;
    if (!lastRecord) throw new Error('No iteration to apply feedback to');

    const iteration = this.history.length + 1;
    const changes: IterationRecord['changes'] = [];

    // Parse feedback for specific file modification instructions
    const lower = feedback.toLowerCase();
    const currentFiles = new Map<string, string>();
    for (const f of lastRecord.generatedFiles) {
      currentFiles.set(f.path, f.content);
    }

    // Simple feedback-driven modifications
    const genFiles: GeneratedFile[] = [...lastRecord.generatedFiles];
    for (const file of genFiles) {
      const oldContent = currentFiles.get(file.path) || '';
      let newContent = oldContent;

      // If feedback mentions "change title", modify h1
      if (lower.includes('title') || lower.includes('heading')) {
        const titleMatch = feedback.match(/title[:\s]+(.+?)(?:\.|$)/i) ||
                          feedback.match(/heading[:\s]+(.+?)(?:\.|$)/i);
        if (titleMatch && titleMatch[1] && (file.path.endsWith('.tsx') || file.path.endsWith('.vue'))) {
          newContent = newContent.replace(/<h1>[^<]*<\/h1>/g, `<h1>${titleMatch[1].trim()}</h1>`);
        }
      }

      if (newContent !== oldContent) {
        file.content = newContent;
        const fullPath = join(outputDir, file.path);
        writeFileSync(fullPath, newContent);
        changes.push({ file: file.path, action: 'modified' });
      }
    }

    const record: IterationRecord = {
      iteration,
      timestamp: Date.now(),
      prompt: feedback,
      generatedFiles: genFiles,
      feedback,
      changes,
    };

    this.history.push(record);

    // Notify preview server
    this.previewServer?.notifyReload();

    return record;
  }

  /**
   * Stop the preview server.
   */
  async stopPreview(): Promise<void> {
    await this.previewServer?.stop();
    this.previewServer = null;
  }

  getHistory(): IterationRecord[] {
    return [...this.history];
  }

  reset(): void {
    this.history = [];
  }

  private generateAllFiles(
    tree: FileTreeNode,
    stack: StackRecommendation,
    _outputDir: string,
  ): GeneratedFile[] {
    const files: GeneratedFile[] = [];

    const walk = (node: FileTreeNode, currentPath: string) => {
      const nodePath = currentPath ? `${currentPath}/${node.name}` : node.name;
      if (node.type === 'directory' && node.children) {
        for (const child of node.children) {
          walk(child, nodePath);
        }
      } else {
        const isoExt = extname(node.name).toLowerCase();
        const type = isoExt.match(/\.(test|spec)\.(ts|js)x?$/)
          ? 'test'
          : node.fileType || 'source';
        files.push({
          path: nodePath,
          content: this.codeGenerator.generateFile(node, stack),
          type,
          generatedBy: 'code-generator',
        });
      }
    };

    walk(tree, '');
    return files;
  }
}

// ---------------------------------------------------------------------------
// AppGenerator — main orchestrator (GAP-086)
// ---------------------------------------------------------------------------

export interface GenerateOptions {
  prompt: string;
  outputDir?: string;
  previewPort?: number;
  maxIterations?: number;
  routes?: string[];
  components?: string[];
  includeTests?: boolean;
  includeStyles?: boolean;
  includeStorybook?: boolean;
  includeE2E?: boolean;
}

export class AppGenerator {
  private promptAnalyzer: PromptAnalyzer;
  private treeGenerator: FileTreeGenerator;
  private refinementLoop: IterativeRefinementLoop | null = null;

  constructor() {
    this.promptAnalyzer = new PromptAnalyzer();
    this.treeGenerator = new FileTreeGenerator();
  }

  /**
   * Generate a full application from a natural language prompt.
   */
  async generate(options: GenerateOptions): Promise<GenerationResult> {
    const startedAt = Date.now();
    const id = `gen-${randomUUID().slice(0, 8)}`;
    const outputDir = options.outputDir || join(process.cwd(), '.generated-apps', id);
    const previewPort = options.previewPort || 5173;

    // Phase 1: Analyze prompt
    const analysis = this.promptAnalyzer.analyze(options.prompt);

    // Phase 2: Plan file tree
    const fileTree = this.treeGenerator.generate(analysis.stackRecommendation, {
      includeTests: options.includeTests ?? true,
      includeStyles: options.includeStyles ?? true,
      includeStorybook: options.includeStorybook ?? false,
      includeE2E: options.includeE2E ?? false,
      routes: options.routes || ['home'],
      componentNames: options.components || [],
    });

    // Phase 3: Generate files via iterative refinement
    this.refinementLoop = new IterativeRefinementLoop({
      maxIterations: options.maxIterations ?? 5,
      autoAccept: true,
      previewPort,
    });

    const iteration = await this.refinementLoop.iterate(
      options.prompt,
      analysis.stackRecommendation,
      fileTree,
      outputDir,
      previewPort,
    );

    return {
      id,
      prompt: analysis,
      stack: analysis.stackRecommendation,
      files: iteration.generatedFiles,
      fileTree,
      iterations: [iteration],
      previewUrl: `http://localhost:${previewPort}`,
      generatedAt: Date.now(),
      durationMs: Date.now() - startedAt,
    };
  }

  /**
   * Refine an existing generation with feedback.
   */
  async refine(
    feedback: string,
    currentResult: GenerationResult,
  ): Promise<GenerationResult> {
    if (!this.refinementLoop) {
      this.refinementLoop = new IterativeRefinementLoop({ maxIterations: 5, autoAccept: false, previewPort: 5173 });
    }

    const iteration = this.refinementLoop.applyFeedback(
      feedback,
      currentResult.stack,
      currentResult.fileTree,
      currentResult.id ? join(process.cwd(), '.generated-apps', currentResult.id) : currentResult.fileTree.name,
    );

    return {
      ...currentResult,
      files: iteration.generatedFiles,
      iterations: [...currentResult.iterations, iteration],
      generatedAt: Date.now(),
      durationMs: Date.now() - currentResult.generatedAt,
    };
  }

  /**
   * Stop any running preview server.
   */
  async cleanup(): Promise<void> {
    await this.refinementLoop?.stopPreview();
  }
}

// ---------------------------------------------------------------------------
// Convenience exports
// ---------------------------------------------------------------------------

export function quickAnalyze(prompt: string): PromptAnalysis {
  return new PromptAnalyzer().analyze(prompt);
}

export function quickScaffold(prompt: string, outputDir: string): GenerationResult {
  const generator = new AppGenerator();
  const analysis = generator['promptAnalyzer'].analyze(prompt);
  const tree = generator['treeGenerator'].generate(analysis.stackRecommendation, {
    includeTests: true,
    includeStyles: true,
    includeStorybook: false,
    includeE2E: false,
    routes: ['home'],
    componentNames: [],
  });

  const codeGen = new CodeGenerator();
  const files: GeneratedFile[] = [];

  const walk = (node: FileTreeNode, currentPath: string) => {
    const nodePath = currentPath ? `${currentPath}/${node.name}` : node.name;
    if (node.type === 'directory' && node.children) {
      for (const child of node.children) walk(child, nodePath);
    } else {
      files.push({
        path: nodePath,
        content: codeGen.generateFile(node, analysis.stackRecommendation),
        type: node.fileType || 'source',
        generatedBy: 'quick-scaffold',
      });
    }
  };
  walk(tree, '');

  return {
    id: `quick-${randomUUID().slice(0, 8)}`,
    prompt: analysis,
    stack: analysis.stackRecommendation,
    files,
    fileTree: tree,
    iterations: [],
    generatedAt: Date.now(),
    durationMs: 0,
  };
}
