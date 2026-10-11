import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, createReadStream, createWriteStream } from 'node:fs';
import { join, dirname, basename, relative, resolve, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { installRoot } from '../core/env-file.js';

// ──────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────

export type Edition = 'oss' | 'enterprise';

export interface FeatureFlag {
  name: string;
  description: string;
  edition: Edition;
  enabled: boolean;
  enterpriseOnly: boolean;
}

export interface FeatureMatrix {
  edition: Edition;
  flags: FeatureFlag[];
  /** Maps feature name → feature flag */
  byName: Record<string, FeatureFlag>;
}

export interface BuildArtifact {
  edition: Edition;
  version: string;
  hash: string;
  files: string[];
  excludedFeatures: string[];
  generatedAt: string;
  licenseType: 'GPL-3.0-or-later' | 'Commercial';
}

export interface BuildConfig {
  /** File patterns to include in OSS build */
  include: string[];
  /** File patterns to exclude from OSS build */
  exclude: string[];
  /** Enterprise-only source directories */
  enterpriseDirs: string[];
  /** Enterprise-only features (by feature flag name) */
  enterpriseFeatures: string[];
  /** Output directory for stripped build */
  outputDir: string;
}

// ──────────────────────────────────────────────
// Feature Definitions
// ──────────────────────────────────────────────

export const OSS_FEATURES: FeatureFlag[] = [
  { name: 'code-completion', description: 'AI-powered code completions', edition: 'oss', enabled: true, enterpriseOnly: false },
  { name: 'inline-chat', description: 'Inline chat with AI assistant', edition: 'oss', enabled: true, enterpriseOnly: false },
  { name: 'terminal-integration', description: 'Integrated terminal with AI', edition: 'oss', enabled: true, enterpriseOnly: false },
  { name: 'git-diff-viewer', description: 'Side-by-side diff viewer', edition: 'oss', enabled: true, enterpriseOnly: false },
  { name: 'local-models', description: 'Run models locally', edition: 'oss', enabled: true, enterpriseOnly: false },
  { name: 'plugin-system', description: 'Extensible plugin architecture', edition: 'oss', enabled: true, enterpriseOnly: false },
  { name: 'custom-commands', description: 'User-defined slash commands', edition: 'oss', enabled: true, enterpriseOnly: false },
  { name: 'basic-search', description: 'File and symbol search', edition: 'oss', enabled: true, enterpriseOnly: false },
  { name: 'project-rules', description: 'Project-level AI rules', edition: 'oss', enabled: true, enterpriseOnly: false },
  { name: 'session-history', description: 'Persistent session history', edition: 'oss', enabled: true, enterpriseOnly: false },
  { name: 'tab-completion', description: 'AI tab completions', edition: 'oss', enabled: true, enterpriseOnly: false },
  { name: 'community-support', description: 'Community forum support', edition: 'oss', enabled: true, enterpriseOnly: false },
  { name: 'multi-model', description: 'Use multiple AI providers', edition: 'oss', enabled: true, enterpriseOnly: false },
  { name: 'offline-mode', description: 'Work without internet', edition: 'oss', enabled: true, enterpriseOnly: false },
  { name: 'pr-review', description: 'Automated PR reviews', edition: 'oss', enabled: true, enterpriseOnly: false },
];

export const ENTERPRISE_FEATURES: FeatureFlag[] = [
  { name: 'cloud-agents', description: 'Cloud-based AI agents', edition: 'enterprise', enabled: true, enterpriseOnly: true },
  { name: 'team-sharing', description: 'Team-based sharing and collaboration', edition: 'enterprise', enabled: true, enterpriseOnly: true },
  { name: 'priority-support', description: 'Priority support with SLA', edition: 'enterprise', enabled: true, enterpriseOnly: true },
  { name: 'saml-sso', description: 'SAML Single Sign-On', edition: 'enterprise', enabled: true, enterpriseOnly: true },
  { name: 'audit-logging', description: 'Enterprise audit logs', edition: 'enterprise', enabled: true, enterpriseOnly: true },
  { name: 'compliance-reports', description: 'Compliance reporting', edition: 'enterprise', enabled: true, enterpriseOnly: true },
  { name: 'role-based-access', description: 'Role-based access control', edition: 'enterprise', enabled: true, enterpriseOnly: true },
  { name: 'enterprise-policies', description: 'Organization-wide policies', edition: 'enterprise', enabled: true, enterpriseOnly: true },
  { name: 'multi-workspace', description: 'Multiple workspace support', edition: 'enterprise', enabled: true, enterpriseOnly: true },
  { name: 'remote-agents', description: 'Remote execution agents', edition: 'enterprise', enabled: true, enterpriseOnly: true },
  { name: 'usage-billing', description: 'Usage-based billing', edition: 'enterprise', enabled: true, enterpriseOnly: true },
  { name: 'procurement-billing', description: 'Procurement-friendly billing', edition: 'enterprise', enabled: true, enterpriseOnly: true },
  { name: 'ticketing-system', description: 'Support ticketing system', edition: 'enterprise', enabled: true, enterpriseOnly: true },
  { name: 'slack-integration', description: 'Slack bot integration', edition: 'enterprise', enabled: true, enterpriseOnly: true },
  { name: 'airgap-mode', description: 'Air-gapped deployment', edition: 'enterprise', enabled: true, enterpriseOnly: true },
  { name: 'content-exclusion', description: 'Content exclusion rules', edition: 'enterprise', enabled: true, enterpriseOnly: true },
  { name: 'custom-models', description: 'Custom model hosting', edition: 'enterprise', enabled: true, enterpriseOnly: true },
  { name: 'advanced-analytics', description: 'Advanced usage analytics', edition: 'enterprise', enabled: true, enterpriseOnly: true },
  { name: 'free-tier-management', description: 'Free tier management', edition: 'enterprise', enabled: false, enterpriseOnly: true },
];

const ALL_FEATURES = [...OSS_FEATURES, ...ENTERPRISE_FEATURES];

// ──────────────────────────────────────────────
// Feature Flag Gating Engine
// ──────────────────────────────────────────────

export class FeatureFlagGate {
  private flags: Map<string, FeatureFlag> = new Map();
  private edition: Edition;

  constructor(edition: Edition = 'oss') {
    this.edition = edition;
    this.loadFlags();
  }

  private loadFlags(): void {
    for (const flag of ALL_FEATURES) {
      const effective = { ...flag };
      if (this.edition === 'oss' && effective.enterpriseOnly) {
        effective.enabled = false;
      }
      this.flags.set(flag.name, effective);
    }
  }

  /**
   * Check if a feature is available in the current edition.
   */
  isEnabled(featureName: string): boolean {
    const flag = this.flags.get(featureName);
    if (!flag) return false;
    return flag.enabled;
  }

  /**
   * Get all features for the current edition.
   */
  getFeatures(): FeatureFlag[] {
    return Array.from(this.flags.values());
  }

  /**
   * Get only enabled features.
   */
  getEnabledFeatures(): FeatureFlag[] {
    return Array.from(this.flags.values()).filter(f => f.enabled);
  }

  /**
   * Get only enterprise-only features.
   */
  getEnterpriseFeatures(): FeatureFlag[] {
    return Array.from(this.flags.values()).filter(f => f.enterpriseOnly);
  }

  /**
   * Get only OSS features.
   */
  getOssFeatures(): FeatureFlag[] {
    return Array.from(this.flags.values()).filter(f => !f.enterpriseOnly);
  }

  /**
   * Get the feature matrix.
   */
  getMatrix(): FeatureMatrix {
    const byName: Record<string, FeatureFlag> = {};
    for (const [name, flag] of this.flags) {
      byName[name] = flag;
    }

    return {
      edition: this.edition,
      flags: this.getFeatures(),
      byName,
    };
  }

  /**
   * Get the current edition.
   */
  getEdition(): Edition {
    return this.edition;
  }

  /**
   * Verify that only OSS features are active. Returns blocked enterprise features.
   */
  verifyOssCompliance(): { compliant: boolean; blockedFeatures: string[] } {
    const blockedFeatures: string[] = [];
    for (const flag of this.flags.values()) {
      if (flag.enterpriseOnly && flag.enabled) {
        blockedFeatures.push(flag.name);
      }
    }
    return {
      compliant: blockedFeatures.length === 0,
      blockedFeatures,
    };
  }
}

// ──────────────────────────────────────────────
// Stripped Build Pipeline
// ──────────────────────────────────────────────

const DEFAULT_BUILD_CONFIG: BuildConfig = {
  include: [
    'src/**/*.ts',
    'src/**/*.json',
    'package.json',
    'tsconfig.json',
    'README.md',
    'LICENSE',
    'CONTRIBUTING.md',
    'CHANGELOG.md',
    'FEATURES.md',
  ],
  exclude: [
    // Enterprise source directories
    'src/enterprise/**',
    'src/billing/**',
    'src/support/**',
    'src/agents/cloud-background.ts',
    'src/agents/cloud-sdk.ts',
    'src/tiers/free-tier.ts',
    'src/core/saml-sso.ts',
    'src/core/cloud-agents.ts',
    'src/core/cloud-agent.ts',
    'src/core/cloud-vm.ts',
    'src/core/cloud-sdk.ts',
    'src/core/cloud-sync.ts',
    'src/core/support-ticketing.ts',
    'src/core/procurement-billing.ts',
    'src/core/free-tier.ts',
    'src/core/team-licensing.ts',
    'src/core/team-sharing.ts',
    'src/core/enterprise-audit.ts',
    'src/core/compliance-framework.ts',
    // Test files for enterprise features
    'src/enterprise/**/*.test.ts',
  ],
  enterpriseDirs: [
    'src/enterprise',
    'src/billing',
    'src/support',
    'src/tiers',
    'src/oss',
  ],
  enterpriseFeatures: ENTERPRISE_FEATURES.map(f => f.name),
  outputDir: 'dist-oss',
};

export class StrippedBuildPipeline {
  private config: BuildConfig;

  constructor(config?: Partial<BuildConfig>) {
    this.config = { ...DEFAULT_BUILD_CONFIG, ...config };
  }

  getConfig(): BuildConfig {
    return { ...this.config };
  }

  /**
   * Generate the list of files that would be included in the OSS build.
   */
  resolveOssFiles(rootDir: string = '.'): string[] {
    const files: string[] = [];
    const absoluteRoot = resolve(rootDir);

    for (const pattern of this.config.include) {
      // Glob is expensive — use a simplified matcher for common patterns
      if (pattern.includes('**')) {
        const base = pattern.split('/**')[0];
        const ext = pattern.split('.').pop();
        this.collectFiles(join(absoluteRoot, base), ext ? `.${ext}` : '', files, absoluteRoot);
      } else {
        const fullPath = join(absoluteRoot, pattern);
        if (existsSync(fullPath)) {
          files.push(pattern);
        }
      }
    }

    // Filter out excluded files
    return files.filter(f => !this.isExcluded(f));
  }

  private collectFiles(dir: string, ext: string, results: string[], root: string): void {
    if (!existsSync(dir)) return;
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        const relativePath = relative(root, fullPath);

        if (entry.isDirectory()) {
          if (!this.isExcludedDir(relativePath)) {
            this.collectFiles(fullPath, ext, results, root);
          }
        } else {
          if (!ext || entry.name.endsWith(ext)) {
            if (!this.isExcluded(relativePath)) {
              results.push(relativePath);
            }
          }
        }
      }
    } catch { /* skip inaccessible directories */ }
  }

  private isExcluded(relativePath: string): boolean {
    for (const pattern of this.config.exclude) {
      if (this.matchPattern(relativePath, pattern)) return true;
    }
    return false;
  }

  private isExcludedDir(relativePath: string): boolean {
    for (const dir of this.config.enterpriseDirs) {
      if (relativePath === dir || relativePath.startsWith(dir + sep)) {
        return true;
      }
    }
    return false;
  }

  private matchPattern(candidate: string, pattern: string): boolean {
    // Simple glob matching for common patterns
    const regexStr = pattern
      .replace(/\./g, '\\.')
      .replace(/\*\*/g, '___GLOBSTAR___')
      .replace(/\*/g, '[^/]*')
      .replace(/___GLOBSTAR___/g, '.*');
    return new RegExp(`^${regexStr}$`).test(candidate);
  }

  /**
   * Produce a stripped build manifest (metadata about what the OSS artifact would contain).
   */
  generateBuildManifest(version: string): BuildArtifact {
    const files = this.resolveOssFiles();
    const fileContents = files.sort().join('\n');
    const hash = createHash('sha256').update(fileContents).digest('hex').slice(0, 16);

    return {
      edition: 'oss',
      version,
      hash,
      files,
      excludedFeatures: [...this.config.enterpriseFeatures],
      generatedAt: new Date().toISOString(),
      licenseType: 'GPL-3.0-or-later',
    };
  }

  /**
   * Package the OSS artifact as a tarball (simulated — returns manifest).
   */
  async createOssArtifact(version: string, outputPath?: string): Promise<{ manifest: BuildArtifact; outputPath: string }> {
    const manifest = this.generateBuildManifest(version);
    const outPath = outputPath || join(this.config.outputDir, `cobra-commander-oss-${version}.tar.gz`);

    // Ensure output dir exists
    const outDir = dirname(resolve(outPath));
    if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

    // Write manifest
    const manifestPath = join(outDir, `manifest-${version}.json`);
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    return { manifest, outputPath: outPath };
  }

  /**
   * Generate a diff report between OSS and Enterprise builds.
   */
  diffWithEnterprise(): { ossFileCount: number; enterpriseOnlyFiles: string[]; enterpriseFeatures: string[] } {
    const ossFiles = this.resolveOssFiles();

    // Enterprise-only features
    const enterpriseOnlyFiles = this.config.exclude
      .filter(e => !e.includes('*'))
      .filter(e => existsSync(e));

    return {
      ossFileCount: ossFiles.length,
      enterpriseOnlyFiles,
      enterpriseFeatures: [...this.config.enterpriseFeatures],
    };
  }
}

// ──────────────────────────────────────────────
// Community Edition Manager
// ──────────────────────────────────────────────

export class CommunityEditionManager {
  private featureGate: FeatureFlagGate;
  private buildPipeline: StrippedBuildPipeline;

  constructor(edition?: Edition) {
    this.featureGate = new FeatureFlagGate(edition || 'oss');
    this.buildPipeline = new StrippedBuildPipeline();
  }

  getFeatureGate(): FeatureFlagGate {
    return this.featureGate;
  }

  getBuildPipeline(): StrippedBuildPipeline {
    return this.buildPipeline;
  }

  /**
   * Get the full feature matrix for the current edition.
   */
  getFeatureMatrix(): FeatureMatrix {
    return this.featureGate.getMatrix();
  }

  /**
   * Verify OSS compliance — ensures no enterprise features are enabled in OSS edition.
   */
  verifyCompliance(): { compliant: boolean; blockedFeatures: string[]; report: string } {
    const { compliant, blockedFeatures } = this.featureGate.verifyOssCompliance();
    const report = compliant
      ? '✅ OSS Compliance: All enterprise features are properly gated.'
      : `❌ OSS Compliance FAILED: The following enterprise features are incorrectly enabled:\n${blockedFeatures.map(f => `  - ${f}`).join('\n')}`;

    return { compliant, blockedFeatures, report };
  }

  /**
   * Generate a stripped build manifest.
   */
  generateBuildManifest(version: string): BuildArtifact {
    return this.buildPipeline.generateBuildManifest(version);
  }

  /**
   * Create OSS artifact.
   */
  async createOssArtifact(version: string, outputPath?: string): Promise<{ manifest: BuildArtifact; outputPath: string }> {
    return this.buildPipeline.createOssArtifact(version, outputPath);
  }
}

// ──────────────────────────────────────────────
// License Management
// ──────────────────────────────────────────────

/**
 * Return the project's license text. The canonical copy is LICENSE in the
 * repository root — never a second copy embedded in source, which is how a
 * package ends up shipping a license that contradicts the project's own.
 */
export function getLicenseText(): string {
  const licensePath = join(installRoot(), 'LICENSE');
  if (existsSync(licensePath)) {
    try {
      return readFileSync(licensePath, 'utf-8');
    } catch { /* fall through to the notice below */ }
  }

  return [
    'Cobra Commander',
    'Copyright (C) 2026 Mark Sherman',
    '',
    'This program is free software: you can redistribute it and/or modify it under',
    'the terms of the GNU General Public License as published by the Free Software',
    'Foundation, either version 3 of the License, or (at your option) any later',
    'version.',
    '',
    'This program is distributed in the hope that it will be useful, but WITHOUT ANY',
    'WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A',
    'PARTICULAR PURPOSE. See the GNU General Public License for more details.',
    '',
    'You should have received a copy of the GNU General Public License along with',
    'this program. If not, see <https://www.gnu.org/licenses/>.',
    '',
  ].join('\n');
}

// ──────────────────────────────────────────────

let defaultManager: CommunityEditionManager | null = null;

export function getCommunityEditionManager(): CommunityEditionManager {
  if (!defaultManager) defaultManager = new CommunityEditionManager();
  return defaultManager;
}

export function initCommunityEditionManager(edition?: Edition): CommunityEditionManager {
  defaultManager = new CommunityEditionManager(edition);
  return defaultManager;
}
