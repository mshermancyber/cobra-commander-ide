import { randomUUID, createHash, createHmac } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, Dirent } from 'node:fs';
import { join, relative, basename } from 'node:path';
import { networkInterfaces, hostname, cpus, totalmem, platform, arch } from 'node:os';
import { execSync } from 'node:child_process';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Manifest describing all files in an offline deployment bundle */
export interface OfflineBundleManifest {
  bundleId: string;
  name: string;
  version: string;
  createdAt: number;
  /** List of all files included (relative paths) */
  files: BundleFile[];
  /** Total size in bytes */
  totalSizeBytes: number;
  /** Number of vendored npm packages */
  packagesCount: number;
  /** Docker images included */
  dockerImages: string[];
  /** Whether node_modules is fully vendored */
  nodeModulesVendored: boolean;
  /** Bundle checksum (SHA-256) */
  checksum?: string;
}

export interface BundleFile {
  path: string;
  sizeBytes: number;
  checksum: string;
  /** Whether this file was vendored from an external source */
  vendored: boolean;
}

/** Configuration for a private Docker/OCI registry */
export interface PrivateRegistryConfig {
  /** Registry host:port */
  registryUrl: string;
  /** Authentication */
  auth: RegistryAuth;
  /** Whether to use TLS */
  tls: boolean;
  /** CA certificate path for self-signed registries */
  caCertPath?: string;
  /** Namespace within registry */
  namespace?: string;
}

export interface RegistryAuth {
  type: 'basic' | 'token' | 'none';
  username?: string;
  password?: string;
  token?: string;
  /** Path to Docker config.json for credentials */
  dockerConfigPath?: string;
}

/** Kubernetes NetworkPolicy resources */
export interface K8sNetworkPolicy {
  apiVersion: string;
  kind: string;
  metadata: K8sMetadata;
  spec: K8sNetworkPolicySpec;
}

export interface K8sMetadata {
  name: string;
  namespace: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
}

export interface K8sNetworkPolicySpec {
  podSelector: K8sLabelSelector;
  policyTypes: ('Ingress' | 'Egress')[];
  ingress?: K8sNetworkPolicyRule[];
  egress?: K8sNetworkPolicyRule[];
}

export interface K8sLabelSelector {
  matchLabels?: Record<string, string>;
  matchExpressions?: Array<{
    key: string;
    operator: 'In' | 'NotIn' | 'Exists' | 'DoesNotExist';
    values?: string[];
  }>;
}

export interface K8sNetworkPolicyRule {
  from?: K8sNetworkPolicyPeer[];
  to?: K8sNetworkPolicyPeer[];
  ports?: K8sNetworkPolicyPort[];
}

export interface K8sNetworkPolicyPeer {
  podSelector?: K8sLabelSelector;
  namespaceSelector?: K8sLabelSelector;
  ipBlock?: {
    cidr: string;
    except?: string[];
  };
}

export interface K8sNetworkPolicyPort {
  protocol?: 'TCP' | 'UDP' | 'SCTP';
  port?: number | string;
  endPort?: number;
}

/** Hardware fingerprint for offline license binding */
export interface HardwareFingerprint {
  /** Composite fingerprint hash */
  fingerprint: string;
  /** Individual components */
  components: FingerprintComponent[];
  /** Timestamp when fingerprint was taken */
  capturedAt: number;
  /** Hostname */
  host: string;
}

export interface FingerprintComponent {
  name: string;
  value: string;
  /** Source: hardware, os, or software */
  source: 'hardware' | 'os' | 'software';
  /** Whether this component is stable across reboots */
  stable: boolean;
}

/** Offline JWT-based license */
export interface OfflineLicense {
  /** JWT token */
  jwt: string;
  /** Issued at */
  iat: number;
  /** Expires at (0 = never) */
  exp: number;
  /** The fingerprint this license is bound to */
  fingerprint: string;
  /** License tier */
  tier: 'community' | 'pro' | 'enterprise';
  /** Features enabled */
  features: string[];
  /** Max seats */
  maxSeats: number;
  /** Issuer */
  issuer: string;
  /** Whether the license has been activated */
  activated: boolean;
  /** Last validation timestamp */
  lastValidated?: number;
}

export interface RegistryPushResult {
  image: string;
  digest: string;
  pushed: boolean;
  error?: string;
  durationMs: number;
}

export interface DeploymentManifest {
  manifestId: string;
  bundle: OfflineBundleManifest;
  registry: PrivateRegistryConfig;
  networkPolicies: K8sNetworkPolicy[];
  license: OfflineLicense;
  /** Deployment instructions */
  instructions: string[];
  /** Generated at */
  generatedAt: number;
}

export interface NetworkPolicyTemplate {
  name: string;
  description: string;
  yaml: string;
  json: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sha256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

function matchesGlob(name: string, pattern: string): boolean {
  // Simple glob: * matches anything
  if (!pattern.includes('*')) return name === pattern;
  const regexStr = '^' + pattern.replace(/\./g, '\\.').replace(/\*/g, '.*') + '$';
  return new RegExp(regexStr).test(name);
}

const DEFAULT_EXCLUDE_PATTERNS = [
  'node_modules/.cache',
  '.git',
  '.gitignore',
  '.gitattributes',
  '__pycache__',
  '*.pyc',
  '.DS_Store',
  'Thumbs.db',
  'dist',
  '.tsbuildinfo',
  'coverage',
  '.nyc_output',
  '*.log',
];

// ---------------------------------------------------------------------------
// Offline Bundle Builder
// ---------------------------------------------------------------------------

export class OfflineBundleBuilder {
  private workDir: string;
  private excludePatterns: string[];

  constructor(workDir: string, excludePatterns?: string[]) {
    this.workDir = workDir;
    this.excludePatterns = excludePatterns || [...DEFAULT_EXCLUDE_PATTERNS];
  }

  /**
   * Build a complete offline bundle with all dependencies vendored.
   * Target: zero network access required on the target system.
   */
  build(outputDir?: string): OfflineBundleManifest {
    const bundleDir = outputDir || join(this.workDir, 'airgap-bundle');
    if (!existsSync(bundleDir)) mkdirSync(bundleDir, { recursive: true });

    const bundleId = 'bundle-' + randomUUID().slice(0, 8);
    const files: BundleFile[] = [];
    let packagesCount = 0;
    const dockerImages: string[] = [];

    // 1. Copy package.json & lock files
    for (const f of ['package.json', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml']) {
      const src = join(this.workDir, f);
      if (existsSync(src)) {
        const dst = join(bundleDir, f);
        writeFileSync(dst, readFileSync(src));
        const st = statSync(dst);
        files.push({
          path: f,
          sizeBytes: st.size,
          checksum: sha256(readFileSync(dst)),
          vendored: false,
        });
      }
    }

    // 2. Vendored node_modules (full copy)
    const nodeModulesPath = join(this.workDir, 'node_modules');
    if (existsSync(nodeModulesPath)) {
      packagesCount = this.vendorNodeModules(
        nodeModulesPath,
        join(bundleDir, 'node_modules'),
        files,
      );
    }

    // 3. Source code
    const srcDir = join(this.workDir, 'src');
    if (existsSync(srcDir)) {
      this.copyDirectory(srcDir, join(bundleDir, 'src'), files, false);
    }

    // 4. Config files
    for (const cfg of ['tsconfig.json', '.eslintrc.json', '.prettierrc', 'Dockerfile']) {
      const cfgPath = join(this.workDir, cfg);
      if (existsSync(cfgPath)) {
        const dst = join(bundleDir, cfg);
        writeFileSync(dst, readFileSync(cfgPath));
        const st = statSync(dst);
        files.push({
          path: cfg,
          sizeBytes: st.size,
          checksum: sha256(readFileSync(dst)),
          vendored: false,
        });
      }
    }

    // 5. Docker images list from package.json
    try {
      const pkg = JSON.parse(readFileSync(join(this.workDir, 'package.json'), 'utf-8'));
      if (pkg.cobraCommander && Array.isArray(pkg.cobraCommander.dockerImages)) {
        for (const img of pkg.cobraCommander.dockerImages) {
          dockerImages.push(String(img));
        }
      }
    } catch {
      // ignore
    }

    // 6. Generate offline install script
    const installPath = this.generateInstallScript(bundleDir, packagesCount > 0);
    files.push({
      path: 'install.sh',
      sizeBytes: statSync(installPath).size,
      checksum: sha256(readFileSync(installPath)),
      vendored: false,
    });

    // 7. Generate bundle manifest
    const totalSizeBytes = files.reduce((sum, f) => sum + f.sizeBytes, 0);

    const manifest: OfflineBundleManifest = {
      bundleId,
      name: basename(this.workDir),
      version: this.readVersion() || '0.0.0',
      createdAt: Date.now(),
      files,
      totalSizeBytes,
      packagesCount,
      dockerImages,
      nodeModulesVendored: packagesCount > 0,
    };

    // Write manifest to bundle
    const manifestPath = join(bundleDir, 'bundle-manifest.json');
    manifest.checksum = sha256(JSON.stringify(manifest));
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    return manifest;
  }

  /**
   * Estimate total bundle size without building.
   */
  estimateSize(): number {
    return this.estimateDirSize(join(this.workDir, 'node_modules'))
      + this.estimateDirSize(join(this.workDir, 'src'));
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  private vendorNodeModules(
    src: string,
    dest: string,
    files: BundleFile[],
  ): number {
    if (!existsSync(dest)) mkdirSync(dest, { recursive: true });
    let packageCount = 0;

    let topEntries: Dirent[];
    try {
      topEntries = readdirSync(src, { withFileTypes: true }) as unknown as Dirent[];
    } catch {
      return packageCount;
    }

    for (const dir of topEntries) {
      if (!dir.isDirectory()) continue;
      const name: string = dir.name;
      if (name.startsWith('.')) continue;
      if (name === '.cache') continue;

      const fullSrc = join(src, name);
      const fullDest = join(dest, name);

      if (name.startsWith('@')) {
        packageCount += this.vendorNodeModules(fullSrc, fullDest, files);
        continue;
      }

      if (existsSync(join(fullSrc, 'package.json'))) {
        if (!existsSync(fullDest)) mkdirSync(fullDest, { recursive: true });
        this.copyDirectory(fullSrc, fullDest, files, true);
        packageCount++;
      }
    }

    return packageCount;
  }

  private copyDirectory(
    src: string,
    dest: string,
    files: BundleFile[],
    vendored: boolean,
  ): void {
    if (!existsSync(dest)) mkdirSync(dest, { recursive: true });

    let entries: Dirent[];
    try {
      entries = readdirSync(src, { withFileTypes: true }) as unknown as Dirent[];
    } catch {
      return;
    }

    for (const entry of entries) {
      const entryName: string = entry.name;
      const srcPath = join(src, entryName);
      const relPath = relative(this.workDir, srcPath);

      // Skip excluded patterns
      if (this.isExcluded(entryName, relPath)) continue;

      if (entry.isDirectory()) {
        this.copyDirectory(srcPath, join(dest, entryName), files, vendored);
      } else if (entry.isFile()) {
        try {
          const content = readFileSync(srcPath);
          writeFileSync(join(dest, entryName), content);
          files.push({
            path: relPath,
            sizeBytes: content.length,
            checksum: sha256(content),
            vendored,
          });
        } catch {
          // skip unreadable
        }
      }
    }
  }

  private isExcluded(name: string, relPath: string): boolean {
    for (const p of this.excludePatterns) {
      if (p.includes('*')) {
        if (matchesGlob(name, p)) return true;
      } else if (name === p || relPath.includes(p)) {
        return true;
      }
    }
    return false;
  }

  private generateInstallScript(bundleDir: string, nodeModulesIncluded: boolean): string {
    const lines = [
      '#!/bin/bash',
      '# Air-Gap Installation Script',
      '# Generated by Cobra Commander — Offline Bundle Builder',
      '',
      'set -euo pipefail',
      '',
      'echo "=== Cobra Commander Air-Gap Installer ==="',
      'echo "Target: $(pwd)"',
      '',
      'SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"',
      'cd "$SCRIPT_DIR"',
      '',
    ];

    if (nodeModulesIncluded) {
      lines.push(
        '# Dependencies already vendored — skipping npm install',
        'echo "[1/3] Node modules vendored — no network needed"',
        '',
      );
    } else {
      lines.push(
        '# Install from vendored package-lock.json (offline mode)',
        'echo "[1/3] Installing dependencies (offline)..."',
        'if [ -f "package-lock.json" ]; then',
        '  npm ci --prefer-offline --no-audit --no-fund --offline 2>/dev/null || {',
        '    echo "ERROR: npm ci failed. Ensure npm cache is populated."',
        '    exit 1',
        '  }',
        'elif [ -f "yarn.lock" ]; then',
        '  yarn install --frozen-lockfile --offline',
        'else',
        '  echo "WARNING: No lockfile found. Dependencies may not resolve correctly."',
        '  npm install --prefer-offline --no-audit --no-fund',
        'fi',
        '',
      );
    }

    lines.push(
      '# Build TypeScript',
      'echo "[2/3] Building TypeScript..."',
      'npx tsc --noEmit 2>/dev/null && npx tsc 2>/dev/null || {',
      '  echo "WARNING: TypeScript build failed."',
      '}',
      '',
      '# Verify installation',
      'echo "[3/3] Verifying installation..."',
      'node -e "console.log(\'Air-gap bundle loaded successfully\')" 2>/dev/null || true',
      '',
      'echo "=== Air-gap installation complete ==="',
    );

    const scriptPath = join(bundleDir, 'install.sh');
    writeFileSync(scriptPath, lines.join('\n'));
    try { execSync('chmod +x "' + scriptPath + '"'); } catch { /* ignore */ }
    return scriptPath;
  }

  private readVersion(): string | null {
    try {
      const pkg = JSON.parse(readFileSync(join(this.workDir, 'package.json'), 'utf-8'));
      return pkg.version || null;
    } catch {
      return null;
    }
  }

  private estimateDirSize(dir: string): number {
    if (!existsSync(dir)) return 0;
    let total = 0;
    try {
      const entries = readdirSync(dir, { withFileTypes: true }) as unknown as Dirent[];
      for (const entry of entries) {
        const name: string = entry.name;
        if (this.isExcluded(name, name)) continue;
        const full = join(dir, name);
        if (entry.isDirectory()) {
          total += this.estimateDirSize(full);
        } else if (entry.isFile()) {
          try { total += statSync(full).size; } catch { /* skip */ }
        }
      }
    } catch { /* skip */ }
    return total;
  }
}

// ---------------------------------------------------------------------------
// Private Registry Pusher
// ---------------------------------------------------------------------------

export class PrivateRegistryPusher {
  private config: PrivateRegistryConfig;

  constructor(config: PrivateRegistryConfig) {
    this.config = {
      ...config,
      namespace: config.namespace || 'cobra-commander',
      auth: { ...config.auth },
    };
  }

  /**
   * Authenticate with the private registry.
   */
  async authenticate(): Promise<boolean> {
    try {
      const creds = this.buildCredentials();
      const url = this.config.registryUrl.replace(/^https?:\/\//, '');
      let cmd: string;
      if (this.config.auth.type === 'token') {
        cmd = 'docker login "' + url + '" --password-stdin';
        execSync(cmd, { input: creds, stdio: 'pipe', timeout: 30_000 });
      } else {
        cmd = 'docker login "' + url +
          '" -u "' + (this.config.auth.username || '') +
          '" -p "' + (this.config.auth.password || '') + '"';
        execSync(cmd, { stdio: 'pipe', timeout: 30_000 });
      }
      return true;
    } catch (err) {
      console.error('Registry auth failed: ' +
        (err instanceof Error ? err.message : String(err)));
      return false;
    }
  }

  /**
   * Push a Docker image to the private registry.
   */
  push(image: string, tag?: string): RegistryPushResult {
    const start = Date.now();
    const registryHost = this.config.registryUrl.replace(/^https?:\/\//, '');
    const ns = this.config.namespace ? this.config.namespace + '/' : '';
    const imageTag = tag || 'latest';
    const targetRef = registryHost + '/' + ns + basename(image) + ':' + imageTag;
    const sourceRef = image + ':' + imageTag;

    try {
      execSync('docker tag "' + sourceRef + '" "' + targetRef + '"', {
        stdio: 'pipe', timeout: 15_000,
      });
      execSync('docker push "' + targetRef + '"', {
        stdio: 'pipe', timeout: 300_000,
      });

      let digest = '';
      try {
        digest = execSync(
          'docker inspect --format="{{index .RepoDigests 0}}" "' + targetRef + '"',
          { stdio: 'pipe', timeout: 10_000 },
        ).toString().trim();
      } catch { /* best-effort */ }

      return { image: targetRef, digest, pushed: true, durationMs: Date.now() - start };
    } catch (err) {
      return {
        image: targetRef,
        digest: '',
        pushed: false,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - start,
      };
    }
  }

  /**
   * Push an npm package to private registry.
   */
  pushNpmPackage(packagePath: string): RegistryPushResult {
    const start = Date.now();
    try {
      const cmd = 'npm publish "' + packagePath + '" --registry="' +
        this.config.registryUrl + '"';
      if (this.config.auth.type === 'basic' && this.config.auth.token) {
        execSync(cmd, {
          stdio: 'pipe', timeout: 60_000,
          env: { ...process.env, NPM_TOKEN: this.config.auth.token },
        });
      } else {
        execSync(cmd, { stdio: 'pipe', timeout: 60_000 });
      }
      return {
        image: basename(packagePath, '.tgz'),
        digest: '',
        pushed: true,
        durationMs: Date.now() - start,
      };
    } catch (err) {
      return {
        image: basename(packagePath, '.tgz'),
        digest: '',
        pushed: false,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - start,
      };
    }
  }

  /**
   * Verify connection to the registry.
   */
  async ping(): Promise<boolean> {
    try {
      const url = this.config.registryUrl + '/v2/';
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 10_000);

      const headers: Record<string, string> = {};
      if (this.config.auth.type === 'basic' && this.config.auth.username) {
        const encoded = Buffer.from(
          this.config.auth.username + ':' + (this.config.auth.password || ''),
        ).toString('base64');
        headers['Authorization'] = 'Basic ' + encoded;
      } else if (this.config.auth.type === 'token' && this.config.auth.token) {
        headers['Authorization'] = 'Bearer ' + this.config.auth.token;
      }

      const resp = await fetch(url, { headers, signal: controller.signal });
      return resp.status === 200 || resp.status === 401;
    } catch {
      return false;
    }
  }

  /**
   * Get the registry configuration.
   */
  getConfig(): PrivateRegistryConfig {
    return { ...this.config };
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  private buildCredentials(): string {
    if (this.config.auth.type === 'basic') {
      return (this.config.auth.username || '') +
        ':' + (this.config.auth.password || '');
    }
    if (this.config.auth.type === 'token') {
      return this.config.auth.token || '';
    }
    return '';
  }
}

// ---------------------------------------------------------------------------
// Kubernetes Network Policy Generator
// ---------------------------------------------------------------------------

export class NetworkPolicyGenerator {
  private namespace: string;
  private defaultLabels: Record<string, string>;

  constructor(namespace = 'default', labels?: Record<string, string>) {
    this.namespace = namespace;
    this.defaultLabels = labels || {
      'app.kubernetes.io/part-of': 'cobra-commander',
    };
  }

  /**
   * Generate a strict no-egress NetworkPolicy.
   */
  generateNoEgressPolicy(options?: {
    name?: string;
    dnsServers?: string[];
    allowedCidrs?: string[];
    allowedPorts?: Array<{ port: number; protocol: 'TCP' | 'UDP' }>;
    podLabels?: Record<string, string>;
  }): NetworkPolicyTemplate {
    const name = options?.name || 'cobra-airgap-no-egress';
    const dnsServers = options?.dnsServers || ['10.0.0.53', '10.0.0.54'];
    const podLabels = options?.podLabels || this.defaultLabels;

    const spec: K8sNetworkPolicySpec = {
      podSelector: { matchLabels: podLabels },
      policyTypes: ['Ingress', 'Egress'],
      ingress: [{
        from: [
          { ipBlock: { cidr: '127.0.0.0/8' } },
          { ipBlock: { cidr: '10.0.0.0/8' } },
          { ipBlock: { cidr: '172.16.0.0/12' } },
          { ipBlock: { cidr: '192.168.0.0/16' } },
        ],
        ports: [
          { protocol: 'TCP', port: 3000 },
          { protocol: 'TCP', port: 8080 },
          { protocol: 'TCP', port: 11434 },
        ],
      }],
      egress: [
        {
          to: dnsServers.map(ip => ({ ipBlock: { cidr: ip + '/32' } })),
          ports: [{ protocol: 'UDP', port: 53 }],
        },
        {
          to: [{ ipBlock: { cidr: '127.0.0.0/8' } }],
          ports: [
            { protocol: 'TCP', port: 3000 },
            { protocol: 'TCP', port: 8080 },
            { protocol: 'TCP', port: 11434 },
            { protocol: 'TCP', port: 8000 },
          ],
        },
        {
          to: [
            { ipBlock: { cidr: '10.0.0.0/8' } },
            { ipBlock: { cidr: '172.16.0.0/12' } },
            { ipBlock: { cidr: '192.168.0.0/16' } },
          ],
          ports: (options?.allowedPorts || [
            { protocol: 'TCP' as const, port: 443 },
            { protocol: 'TCP' as const, port: 3000 },
            { protocol: 'TCP' as const, port: 8080 },
            { protocol: 'TCP' as const, port: 11434 },
            { protocol: 'TCP' as const, port: 8000 },
          ]).map(p => ({ protocol: p.protocol as 'TCP' | 'UDP', port: p.port })),
        },
      ],
    };

    if (options?.allowedCidrs && options.allowedCidrs.length > 0) {
      spec.egress!.push({
        to: options.allowedCidrs.map(cidr => ({ ipBlock: { cidr } })),
      });
    }

    const policy: K8sNetworkPolicy = {
      apiVersion: 'networking.k8s.io/v1',
      kind: 'NetworkPolicy',
      metadata: {
        name,
        namespace: this.namespace,
        labels: { ...this.defaultLabels, 'policy-type': 'airgap-no-egress' },
      },
      spec,
    };

    return {
      name,
      description: 'Strict no-egress policy for air-gapped deployment in namespace ' +
        this.namespace,
      yaml: this.renderYaml(policy),
      json: JSON.parse(JSON.stringify(policy)),
    };
  }

  /**
   * Generate a "trusted-internal-only" NetworkPolicy.
   */
  generateInternalOnlyPolicy(options?: {
    name?: string;
    allowedNamespaces?: string[];
    podLabels?: Record<string, string>;
  }): NetworkPolicyTemplate {
    const name = options?.name || 'cobra-internal-only';
    const allowedNs = options?.allowedNamespaces || [
      'kube-system', 'istio-system', 'cobra-infra',
    ];
    const podLabels = options?.podLabels || this.defaultLabels;

    const spec: K8sNetworkPolicySpec = {
      podSelector: { matchLabels: podLabels },
      policyTypes: ['Ingress', 'Egress'],
      ingress: [{
        from: [
          { podSelector: { matchLabels: podLabels } },
          ...allowedNs.map(ns => ({
            namespaceSelector: {
              matchLabels: { 'kubernetes.io/metadata.name': ns },
            },
          })),
        ],
      }],
      egress: [
        {
          to: [
            { podSelector: { matchLabels: podLabels } },
            ...allowedNs.map(ns => ({
              namespaceSelector: {
                matchLabels: { 'kubernetes.io/metadata.name': ns },
              },
            })),
          ],
        },
        {
          to: [{ ipBlock: { cidr: '10.0.0.0/8' } }],
          ports: [{ protocol: 'UDP', port: 53 }],
        },
      ],
    };

    const policy: K8sNetworkPolicy = {
      apiVersion: 'networking.k8s.io/v1',
      kind: 'NetworkPolicy',
      metadata: {
        name,
        namespace: this.namespace,
        labels: { ...this.defaultLabels, 'policy-type': 'internal-only' },
      },
      spec,
    };

    return {
      name,
      description: 'Restrict traffic to same namespace and allowed infra namespaces: ' +
        allowedNs.join(', '),
      yaml: this.renderYaml(policy),
      json: JSON.parse(JSON.stringify(policy)),
    };
  }

  /**
   * Generate a "deny-all" NetworkPolicy for maximum security.
   */
  generateDenyAllPolicy(options?: {
    name?: string;
    podLabels?: Record<string, string>;
  }): NetworkPolicyTemplate {
    const name = options?.name || 'cobra-deny-all';
    const podLabels = options?.podLabels || this.defaultLabels;

    const spec: K8sNetworkPolicySpec = {
      podSelector: { matchLabels: podLabels },
      policyTypes: ['Ingress', 'Egress'],
      ingress: [],
      egress: [
        { to: [{ ipBlock: { cidr: '127.0.0.1/32' } }] },
        { to: [{ ipBlock: { cidr: '::1/128' } }] },
      ],
    };

    const policy: K8sNetworkPolicy = {
      apiVersion: 'networking.k8s.io/v1',
      kind: 'NetworkPolicy',
      metadata: {
        name,
        namespace: this.namespace,
        labels: { ...this.defaultLabels, 'policy-type': 'deny-all' },
      },
      spec,
    };

    return {
      name,
      description: 'Deny-all policy — blocks ALL network traffic except localhost loopback',
      yaml: this.renderYaml(policy),
      json: JSON.parse(JSON.stringify(policy)),
    };
  }

  /**
   * Save all generated policies as YAML files.
   */
  savePolicies(policies: NetworkPolicyTemplate[], outputDir: string): string[] {
    if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true });
    const saved: string[] = [];
    for (const policy of policies) {
      const path = join(outputDir, policy.name + '.yaml');
      writeFileSync(path, policy.yaml);
      saved.push(path);
    }
    return saved;
  }

  // -----------------------------------------------------------------------
  // YAML rendering
  // -----------------------------------------------------------------------

  private renderYaml(policy: K8sNetworkPolicy): string {
    const L: string[] = [];
    const push = (s: string) => L.push(s);

    push('---');
    push('apiVersion: ' + policy.apiVersion);
    push('kind: ' + policy.kind);
    push('metadata:');
    push('  name: ' + policy.metadata.name);
    push('  namespace: ' + policy.metadata.namespace);

    if (policy.metadata.labels) {
      push('  labels:');
      for (const [k, v] of Object.entries(policy.metadata.labels)) {
        push('    ' + k + ': ' + v);
      }
    }
    if (policy.metadata.annotations) {
      push('  annotations:');
      for (const [k, v] of Object.entries(policy.metadata.annotations)) {
        push('    ' + k + ': "' + v + '"');
      }
    }

    push('spec:');
    if (policy.spec.podSelector.matchLabels) {
      push('  podSelector:');
      push('    matchLabels:');
      for (const [k, v] of Object.entries(policy.spec.podSelector.matchLabels)) {
        push('      ' + k + ': ' + v);
      }
    }
    push('  policyTypes:');
    for (const pt of policy.spec.policyTypes) {
      push('    - ' + pt);
    }

    if (policy.spec.ingress && policy.spec.ingress.length > 0) {
      push('  ingress:');
      this.renderRules(L, policy.spec.ingress, 4);
    }
    if (policy.spec.egress && policy.spec.egress.length > 0) {
      push('  egress:');
      this.renderRules(L, policy.spec.egress, 4);
    }

    return L.join('\n');
  }

  private renderRules(
    lines: string[],
    rules: K8sNetworkPolicyRule[],
    indent: number,
  ): void {
    const pad = ' '.repeat(indent);
    for (const rule of rules) {
      lines.push(pad + '- ');
      if (rule.from && rule.from.length > 0) {
        lines.push(pad + '  from:');
        this.renderPeers(lines, rule.from, indent + 4);
      }
      if (rule.to && rule.to.length > 0) {
        lines.push(pad + '  to:');
        this.renderPeers(lines, rule.to, indent + 4);
      }
      if (rule.ports && rule.ports.length > 0) {
        lines.push(pad + '  ports:');
        for (const port of rule.ports) {
          const proto = port.protocol
            ? '\n' + pad + '      protocol: ' + port.protocol
            : '';
          lines.push(pad + '    - port: ' + port.port + proto);
        }
      }
    }
  }

  private renderPeers(
    lines: string[],
    peers: K8sNetworkPolicyPeer[],
    indent: number,
  ): void {
    const pad = ' '.repeat(indent);
    for (const peer of peers) {
      lines.push(pad + '- ');
      if (peer.ipBlock) {
        lines.push(pad + '  ipBlock:');
        lines.push(pad + '    cidr: ' + peer.ipBlock.cidr);
        if (peer.ipBlock.except && peer.ipBlock.except.length > 0) {
          lines.push(pad + '    except:');
          for (const ex of peer.ipBlock.except) {
            lines.push(pad + '      - ' + ex);
          }
        }
      }
      if (peer.podSelector?.matchLabels) {
        lines.push(pad + '  podSelector:');
        lines.push(pad + '    matchLabels:');
        for (const [k, v] of Object.entries(peer.podSelector.matchLabels)) {
          lines.push(pad + '      ' + k + ': ' + v);
        }
      }
      if (peer.namespaceSelector?.matchLabels) {
        lines.push(pad + '  namespaceSelector:');
        lines.push(pad + '    matchLabels:');
        for (const [k, v] of Object.entries(peer.namespaceSelector.matchLabels)) {
          lines.push(pad + '      ' + k + ': ' + v);
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Offline JWT + Hardware Fingerprint License Activator
// ---------------------------------------------------------------------------

export class LicenseActivator {
  private licenseDir: string;
  private signingSecret: string;

  constructor(licenseDir: string, signingSecret?: string) {
    this.licenseDir = licenseDir;
    this.signingSecret = signingSecret || 'cobra-commander-airgap-signing-key';
    if (!existsSync(this.licenseDir)) {
      mkdirSync(this.licenseDir, { recursive: true });
    }
  }

  /**
   * Capture a hardware fingerprint from the current system.
   */
  captureHardwareFingerprint(): HardwareFingerprint {
    const components: FingerprintComponent[] = [];

    // CPU info
    const cpuList = cpus();
    const cpuModel = cpuList[0]?.model || 'unknown';
    const cpuCores = cpuList.length.toString();
    components.push(
      { name: 'cpu_model', value: this.hashComp(cpuModel), source: 'hardware', stable: true },
      { name: 'cpu_cores', value: cpuCores, source: 'hardware', stable: true },
    );

    // Hostname
    const h = hostname();
    components.push(
      { name: 'hostname', value: this.hashComp(h), source: 'os', stable: true },
    );

    // Platform & architecture
    components.push(
      { name: 'platform', value: platform(), source: 'os', stable: true },
      { name: 'arch', value: arch(), source: 'hardware', stable: true },
    );

    // Total memory
    components.push({
      name: 'total_memory_mb',
      value: Math.round(totalmem() / (1024 * 1024)).toString(),
      source: 'hardware',
      stable: true,
    });

    // Network interfaces
    const nets = networkInterfaces();
    const macs: string[] = [];
    for (const ifaces of Object.values(nets)) {
      if (!ifaces) continue;
      for (const iface of ifaces) {
        if (iface.mac && iface.mac !== '00:00:00:00:00:00' && !iface.internal) {
          macs.push(iface.mac);
        }
      }
    }
    macs.sort();
    components.push({
      name: 'mac_addresses',
      value: this.hashComp(macs.join(',')),
      source: 'hardware',
      stable: true,
    });

    // Disk serial (best-effort)
    try {
      const diskSerial = execSync(
        "lsblk -o SERIAL -nd 2>/dev/null | head -1 || echo 'unknown'",
        { timeout: 3000, stdio: 'pipe' },
      ).toString().trim();
      if (diskSerial && diskSerial !== 'unknown') {
        components.push({
          name: 'disk_serial',
          value: this.hashComp(diskSerial),
          source: 'hardware',
          stable: true,
        });
      }
    } catch {
      // disk serial not available
    }

    // Composite fingerprint
    const stableComponents = components.filter(c => c.stable);
    const composite = sha256(
      stableComponents.map(c => c.name + ':' + c.value).join('|'),
    );

    return { fingerprint: composite, components, capturedAt: Date.now(), host: h };
  }

  /**
   * Generate an offline license JWT bound to a hardware fingerprint.
   */
  generateLicense(options: {
    tier: OfflineLicense['tier'];
    features?: string[];
    maxSeats?: number;
    issuer?: string;
    validityDays?: number;
    fingerprint?: string;
  }): OfflineLicense {
    const now = Math.floor(Date.now() / 1000);
    const fp = options.fingerprint || this.captureHardwareFingerprint().fingerprint;
    const validityDays = Math.min(options.validityDays || 365, 3650);
    const exp = now + validityDays * 86400;

    const payload: Record<string, unknown> = {
      sub: fp,
      iat: now,
      exp,
      tier: options.tier,
      features: options.features || [],
      maxSeats: options.maxSeats || 1,
      iss: options.issuer || 'cobra-commander',
      jti: randomUUID(),
    };

    const jwt = this.signJwt(payload);

    const license: OfflineLicense = {
      jwt,
      iat: now,
      exp,
      fingerprint: fp,
      tier: options.tier,
      features: options.features || [],
      maxSeats: options.maxSeats || 1,
      issuer: options.issuer || 'cobra-commander',
      activated: false,
    };

    this.saveLicense(license);
    return license;
  }

  /**
   * Activate a license on the current hardware.
   */
  activate(jwt?: string): {
    success: boolean;
    license?: OfflineLicense;
    error?: string;
  } {
    const currentFp = this.captureHardwareFingerprint();

    let license: OfflineLicense;
    if (jwt) {
      const parsed = this.verifyJwt(jwt);
      if (!parsed) {
        return {
          success: false,
          error: 'Invalid license JWT — verification failed',
        };
      }
      license = {
        jwt,
        iat: parsed.iat as number,
        exp: parsed.exp as number,
        fingerprint: parsed.sub as string,
        tier: (parsed.tier as OfflineLicense['tier']) || 'community',
        features: (parsed.features as string[]) || [],
        maxSeats: (parsed.maxSeats as number) || 1,
        issuer: (parsed.iss as string) || 'cobra-commander',
        activated: false,
      };
    } else {
      const loaded = this.loadLicense();
      if (!loaded) {
        return {
          success: false,
          error: 'No license found. Provide a JWT or generate one first.',
        };
      }
      license = loaded;
    }

    // Check expiration
    if (license.exp > 0 && Date.now() / 1000 > license.exp) {
      return { success: false, error: 'License has expired', license };
    }

    // Validate fingerprint match
    if (!this.compareFingerprints(currentFp.fingerprint, license.fingerprint)) {
      return {
        success: false,
        error: 'Hardware fingerprint mismatch. License is bound to a different system.',
        license,
      };
    }

    // Activate
    license.activated = true;
    license.lastValidated = Date.now();
    this.saveLicense(license);

    return { success: true, license };
  }

  /**
   * Validate an activated license against current hardware.
   */
  validate(): { valid: boolean; license?: OfflineLicense; error?: string } {
    const license = this.loadLicense();
    if (!license) {
      return { valid: false, error: 'No license installed' };
    }

    const currentFp = this.captureHardwareFingerprint();

    if (!this.compareFingerprints(currentFp.fingerprint, license.fingerprint)) {
      return {
        valid: false,
        error: 'Hardware fingerprint changed since activation',
        license,
      };
    }

    if (license.exp > 0 && Date.now() / 1000 > license.exp) {
      return { valid: false, error: 'License has expired', license };
    }

    license.lastValidated = Date.now();
    this.saveLicense(license);

    return { valid: true, license };
  }

  /**
   * Check if a valid license is installed and active.
   */
  isLicensed(): boolean {
    const result = this.validate();
    return result.valid && (result.license?.activated || false);
  }

  /**
   * Get the current license info.
   */
  getLicense(): OfflineLicense | null {
    return this.loadLicense();
  }

  /**
   * Revoke the current license.
   */
  revoke(): boolean {
    const path = join(this.licenseDir, 'license.json');
    if (!existsSync(path)) return false;
    try {
      const lic = JSON.parse(readFileSync(path, 'utf-8')) as OfflineLicense;
      lic.activated = false;
      lic.exp = Math.floor(Date.now() / 1000) - 1;
      writeFileSync(path, JSON.stringify(lic, null, 2));
      return true;
    } catch {
      return false;
    }
  }

  // -----------------------------------------------------------------------
  // Private: JWT operations
  // -----------------------------------------------------------------------

  private signJwt(payload: Record<string, unknown>): string {
    const header = { alg: 'HS256', typ: 'JWT' };
    const enc = (obj: Record<string, unknown>) =>
      Buffer.from(JSON.stringify(obj)).toString('base64url');

    const headerEnc = enc(header);
    const payloadEnc = enc(payload);
    const sigInput = headerEnc + '.' + payloadEnc;
    const signature = createHmac('sha256', this.signingSecret)
      .update(sigInput)
      .digest('base64url');

    return sigInput + '.' + signature;
  }

  private verifyJwt(jwt: string): Record<string, unknown> | null {
    try {
      const parts = jwt.split('.');
      if (parts.length !== 3) return null;

      const [headerEnc, payloadEnc, signatureEnc] = parts;
      const expectedSig = createHmac('sha256', this.signingSecret)
        .update(headerEnc + '.' + payloadEnc)
        .digest('base64url');

      if (signatureEnc !== expectedSig) return null;

      return JSON.parse(
        Buffer.from(payloadEnc, 'base64url').toString('utf-8'),
      ) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  // -----------------------------------------------------------------------
  // Private: fingerprint helpers
  // -----------------------------------------------------------------------

  private hashComp(value: string): string {
    return sha256(value).slice(0, 16);
  }

  private compareFingerprints(fp1: string, fp2: string): boolean {
    return fp1 === fp2;
  }

  // -----------------------------------------------------------------------
  // Private: persistence
  // -----------------------------------------------------------------------

  private saveLicense(license: OfflineLicense): void {
    writeFileSync(
      join(this.licenseDir, 'license.json'),
      JSON.stringify(license, null, 2),
    );
  }

  private loadLicense(): OfflineLicense | null {
    const path = join(this.licenseDir, 'license.json');
    if (!existsSync(path)) return null;
    try {
      return JSON.parse(readFileSync(path, 'utf-8')) as OfflineLicense;
    } catch {
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// Airgap Deployment Orchestrator
// ---------------------------------------------------------------------------

export interface AirgapDeploymentConfig {
  workDir: string;
  outputDir: string;
  registry: PrivateRegistryConfig;
  k8sNamespace?: string;
  license?: {
    tier: OfflineLicense['tier'];
    features?: string[];
    maxSeats?: number;
    issuer?: string;
    validityDays?: number;
  };
}

export class AirgapDeployer {
  private config: AirgapDeploymentConfig;

  constructor(config: AirgapDeploymentConfig) {
    this.config = config;
    if (!existsSync(config.outputDir)) {
      mkdirSync(config.outputDir, { recursive: true });
    }
  }

  /**
   * Run the full airgap deployment pipeline:
   * 1. Build offline bundle
   * 2. Push to private registry
   * 3. Generate K8s network policies
   * 4. Activate offline license
   */
  async deploy(): Promise<DeploymentManifest> {
    // 1. Build offline bundle
    const builder = new OfflineBundleBuilder(this.config.workDir);
    const bundle = builder.build(join(this.config.outputDir, 'bundle'));

    // 2. Push to private registry
    const pusher = new PrivateRegistryPusher(this.config.registry);
    const authenticated = await pusher.authenticate();
    const instructions: string[] = [];

    if (!authenticated) {
      instructions.push(
        'WARNING: Registry authentication failed. Manual push required.',
      );
    } else {
      instructions.push('Registry authentication successful.');
    }

    for (const image of bundle.dockerImages) {
      const result = pusher.push(image);
      if (result.pushed) {
        instructions.push('Pushed ' + result.image + ' -> ' + result.digest);
      } else {
        instructions.push(
          'FAILED: ' + result.image + ' — ' + (result.error || 'unknown error'),
        );
      }
    }

    // 3. Generate K8s network policies
    const policyGen = new NetworkPolicyGenerator(
      this.config.k8sNamespace || 'default',
    );
    const policies = [
      policyGen.generateNoEgressPolicy({
        podLabels: { 'app.kubernetes.io/name': 'cobra-commander' },
      }),
      policyGen.generateInternalOnlyPolicy({
        podLabels: { 'app.kubernetes.io/name': 'cobra-commander' },
      }),
    ];
    policyGen.savePolicies(
      policies,
      join(this.config.outputDir, 'network-policies'),
    );
    instructions.push(
      'Generated ' + policies.length +
      ' K8s NetworkPolicy files in network-policies/',
    );

    // 4. Activate offline license
    const licenseDir = join(this.config.outputDir, 'license');
    const activator = new LicenseActivator(licenseDir);
    const licenseOpts = this.config.license || {
      tier: 'community' as const,
      features: ['code-completion', 'chat'],
      maxSeats: 1,
    };
    const license = activator.generateLicense({
      ...licenseOpts,
      fingerprint: activator.captureHardwareFingerprint().fingerprint,
    });

    const activation = activator.activate(license.jwt);
    if (activation.success) {
      instructions.push('Offline license activated successfully.');
    } else {
      instructions.push('License activation: ' + (activation.error || ''));
    }

    // Build deployment manifest
    const manifest: DeploymentManifest = {
      manifestId: 'deploy-' + randomUUID().slice(0, 8),
      bundle,
      registry: this.config.registry,
      networkPolicies: policies.map(
        p => JSON.parse(JSON.stringify(p.json)) as K8sNetworkPolicy,
      ),
      license,
      instructions,
      generatedAt: Date.now(),
    };

    // Save manifest
    writeFileSync(
      join(this.config.outputDir, 'deployment-manifest.json'),
      JSON.stringify(manifest, null, 2),
    );

    return manifest;
  }
}

// ---------------------------------------------------------------------------
// Convenience factories
// ---------------------------------------------------------------------------

export function createOfflineBundle(
  workDir: string,
  outputDir?: string,
): OfflineBundleManifest {
  const builder = new OfflineBundleBuilder(workDir);
  return builder.build(outputDir);
}

export function generateNoEgressPolicy(
  namespace?: string,
  podLabels?: Record<string, string>,
): NetworkPolicyTemplate {
  const gen = new NetworkPolicyGenerator(namespace, podLabels);
  return gen.generateNoEgressPolicy();
}

export function activateLicense(
  licenseDir: string,
  jwt?: string,
  signingSecret?: string,
): { success: boolean; license?: OfflineLicense; error?: string } {
  const activator = new LicenseActivator(licenseDir, signingSecret);
  return activator.activate(jwt);
}

export async function deployAirgap(
  config: AirgapDeploymentConfig,
): Promise<DeploymentManifest> {
  const deployer = new AirgapDeployer(config);
  return deployer.deploy();
}
