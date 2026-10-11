import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';

// ─── Types ─────────────────────────────────────────────────────────────────

export interface FigmaIntegrationConfig {
  accessToken: string;
  baseUrl?: string;
  cacheDir?: string;
}

export interface FigmaFileMeta {
  key: string;
  name: string;
  lastModified: string;
  thumbnailUrl: string;
  version: string;
}

export interface FigmaComponentMeta {
  nodeId: string;
  name: string;
  key: string;
  description: string;
  containingFrame?: string;
}

export interface FigmaStyleMeta {
  id: string;
  name: string;
  styleType: 'FILL' | 'TEXT' | 'EFFECT' | 'GRID';
  description: string;
  fillColor?: string;
  fontFamily?: string;
  fontWeight?: number;
  fontSize?: number;
  lineHeight?: number;
}

export interface DesignToken {
  name: string;
  value: string | number;
  type: 'color' | 'typography' | 'spacing' | 'radius' | 'shadow' | 'opacity';
  group?: string;
  cssVar: string;
}

export interface ComponentCodeMapping {
  figmaNodeId: string;
  figmaNodeName: string;
  figmaNodeType: string;
  suggestedComponentName: string;
  suggestedCodePath: string;
  mappingHints: string[];
  properties: Record<string, string | number>;
  children: ComponentCodeMapping[];
}

export interface DesignDiffEntry {
  property: string;
  designValue: string | number;
  codeValue: string | number;
  file: string;
  line?: number;
  severity: 'error' | 'warning' | 'info';
}

export interface DesignDiffReport {
  fileKey: string;
  fileName: string;
  generatedAt: Date;
  entries: DesignDiffEntry[];
  summary: {
    total: number;
    errors: number;
    warnings: number;
    infos: number;
  };
}

export interface FigmaNode {
  id: string;
  name: string;
  type: string;
  visible?: boolean;
  children?: FigmaNode[];
  absoluteBoundingBox?: { x: number; y: number; width: number; height: number };
  layoutMode?: 'HORIZONTAL' | 'VERTICAL' | 'NONE';
  primaryAxisAlignItems?: string;
  counterAxisAlignItems?: string;
  paddingLeft?: number;
  paddingRight?: number;
  paddingTop?: number;
  paddingBottom?: number;
  itemSpacing?: number;
  fills?: Array<{ type: string; color?: { r: number; g: number; b: number; a: number } }>;
  strokes?: Array<{ type: string; color?: { r: number; g: number; b: number; a: number } }>;
  cornerRadius?: number;
  effects?: Array<{ type: string; color?: { r: number; g: number; b: number; a: number }; offset?: { x: number; y: number }; radius: number }>;
  characters?: string;
  style?: Record<string, unknown>;
  opacity?: number;
}

// ─── Figma REST API Client ─────────────────────────────────────────────────

export class FigmaApiClient {
  private accessToken: string;
  private baseUrl: string;

  constructor(config: FigmaIntegrationConfig) {
    this.accessToken = config.accessToken;
    this.baseUrl = config.baseUrl || 'https://api.figma.com/v1';
  }

  private headers(): Record<string, string> {
    return {
      'X-Figma-Token': this.accessToken,
      'Content-Type': 'application/json',
    };
  }

  async getFile(fileKey: string, options?: { nodeId?: string; depth?: number }): Promise<{
    name: string; lastModified: string; version: string; document: FigmaNode;
    components: Record<string, { key: string; name: string; description: string }>;
    styles: Record<string, { key: string; name: string; style_type: string; description: string }>;
  }> {
    let url = `${this.baseUrl}/files/${fileKey}`;
    const params: string[] = [];
    if (options?.nodeId) params.push(`ids=${options.nodeId}`);
    if (options?.depth !== undefined) params.push(`depth=${options.depth}`);
    if (params.length) url += '?' + params.join('&');

    const resp = await fetch(url, { headers: this.headers() });
    if (!resp.ok) throw new Error(`Figma API error (${resp.status}): ${await resp.text()}`);

    const data = await resp.json() as {
      name: string; lastModified: string; version: string; document: FigmaNode;
      components: Record<string, { key: string; name: string; description: string }>;
      styles: Record<string, { key: string; name: string; style_type: string; description: string }>;
    };
    return {
      name: data.name, lastModified: data.lastModified, version: data.version,
      document: data.document, components: data.components || {}, styles: data.styles || {},
    };
  }

  async getProjectFiles(projectId: string): Promise<FigmaFileMeta[]> {
    const url = `${this.baseUrl}/projects/${projectId}/files`;
    const resp = await fetch(url, { headers: this.headers() });
    if (!resp.ok) throw new Error(`Figma project error (${resp.status})`);

    const data = await resp.json() as {
      files: Array<{ key: string; name: string; last_modified: string; thumbnail_url: string; version: string }>;
    };
    return (data.files || []).map(f => ({
      key: f.key, name: f.name, lastModified: f.last_modified,
      thumbnailUrl: f.thumbnail_url, version: f.version,
    }));
  }

  async getComponents(fileKey: string): Promise<FigmaComponentMeta[]> {
    const url = `${this.baseUrl}/files/${fileKey}/components`;
    const resp = await fetch(url, { headers: this.headers() });
    if (!resp.ok) throw new Error(`Figma components error (${resp.status})`);

    const data = await resp.json() as {
      meta: { components: Array<{ node_id: string; name: string; key: string; description: string; containing_frame?: { name: string } }> };
    };
    return (data.meta?.components || []).map(c => ({
      nodeId: c.node_id, name: c.name, key: c.key,
      description: c.description, containingFrame: c.containing_frame?.name,
    }));
  }

  async getStyles(fileKey: string): Promise<FigmaStyleMeta[]> {
    const url = `${this.baseUrl}/files/${fileKey}/styles`;
    const resp = await fetch(url, { headers: this.headers() });
    if (!resp.ok) throw new Error(`Figma styles error (${resp.status})`);

    const data = await resp.json() as {
      meta: { styles: Array<{ node_id: string; name: string; style_type: string; description: string }> };
    };
    return (data.meta?.styles || []).map(s => ({
      id: s.node_id, name: s.name,
      styleType: s.style_type as FigmaStyleMeta['styleType'],
      description: s.description,
    }));
  }

  async getImageUrls(fileKey: string, nodeIds: string[], format: 'png' | 'svg' = 'png'): Promise<Record<string, string>> {
    const ids = nodeIds.join(',');
    const url = `${this.baseUrl}/images/${fileKey}?ids=${ids}&format=${format}`;
    const resp = await fetch(url, { headers: this.headers() });
    if (!resp.ok) throw new Error(`Figma images error (${resp.status})`);
    const data = await resp.json() as { images: Record<string, string> };
    return data.images || {};
  }

  async getNodes(fileKey: string, nodeIds: string[]): Promise<Record<string, FigmaNode>> {
    const ids = nodeIds.join(',');
    const url = `${this.baseUrl}/files/${fileKey}/nodes?ids=${ids}`;
    const resp = await fetch(url, { headers: this.headers() });
    if (!resp.ok) throw new Error(`Figma nodes error (${resp.status})`);
    const data = await resp.json() as { nodes: Record<string, { document: FigmaNode }> };
    const result: Record<string, FigmaNode> = {};
    for (const [key, val] of Object.entries(data.nodes || {})) {
      result[key] = val.document;
    }
    return result;
  }
}

// ─── Design-Token Extractor ────────────────────────────────────────────────

export class DesignTokenExtractor {
  extractFromNodes(nodes: FigmaNode[]): DesignToken[] {
    const tokens: DesignToken[] = [];
    const seenColors = new Set<string>();
    const seenSpacing = new Set<number>();
    const seenRadii = new Set<number>();

    const walk = (node: FigmaNode) => {
      // Colors from fills
      if (node.fills) {
        for (const fill of node.fills) {
          if (fill.type === 'SOLID' && fill.color) {
            const hex = this.rgbToHex(fill.color.r, fill.color.g, fill.color.b);
            if (!seenColors.has(hex)) {
              seenColors.add(hex);
              const tokenName = 'color-' + hex.replace('#', '');
              tokens.push({
                name: tokenName,
                value: hex,
                type: 'color',
                group: 'auto-extracted',
                cssVar: `--${tokenName}`,
              });
            }
          }
        }
      }

      // Spacing
      if (node.paddingLeft && !seenSpacing.has(node.paddingLeft)) {
        seenSpacing.add(node.paddingLeft);
        tokens.push({
          name: `spacing-${node.paddingLeft}`,
          value: node.paddingLeft,
          type: 'spacing',
          group: 'auto-extracted',
          cssVar: `--spacing-${node.paddingLeft}`,
        });
      }

      // Radius
      if (node.cornerRadius && node.cornerRadius > 0 && !seenRadii.has(node.cornerRadius)) {
        seenRadii.add(node.cornerRadius);
        tokens.push({
          name: `radius-${node.cornerRadius}`,
          value: node.cornerRadius,
          type: 'radius',
          group: 'auto-extracted',
          cssVar: `--radius-${node.cornerRadius}`,
        });
      }

      // Typography from text nodes
      if (node.type === 'TEXT' && node.style) {
        const style = node.style;
        if (style.fontFamily) {
          const fontName = (style.fontFamily as string).toLowerCase().replace(/\s+/g, '-');
          tokens.push({
            name: `font-family-${fontName}`,
            value: style.fontFamily as string,
            type: 'typography',
            group: 'auto-extracted',
            cssVar: `--font-family-${fontName}`,
          });
        }
        if (style.fontSize) {
          tokens.push({
            name: `font-size-${style.fontSize}`,
            value: `${style.fontSize}px`,
            type: 'typography',
            group: 'auto-extracted',
            cssVar: `--font-size-${style.fontSize}`,
          });
        }
        if (style.fontWeight) {
          tokens.push({
            name: `font-weight-${style.fontWeight}`,
            value: style.fontWeight as number,
            type: 'typography',
            group: 'auto-extracted',
            cssVar: `--font-weight-${style.fontWeight}`,
          });
        }
      }

      // Shadow effects
      if (node.effects) {
        for (const effect of node.effects) {
          if (effect.type === 'DROP_SHADOW' && effect.color) {
            const x = effect.offset?.x || 0;
            const y = effect.offset?.y || 0;
            const r = effect.radius || 0;
            const c = effect.color;
            tokens.push({
              name: `shadow-${x}-${y}-${r}`,
              value: `${x}px ${y}px ${r}px rgba(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)},${c.a})`,
              type: 'shadow',
              group: 'auto-extracted',
              cssVar: `--shadow-${x}-${y}-${r}`,
            });
          }
        }
      }

      // Opacity
      if (node.opacity !== undefined && node.opacity !== 1) {
        tokens.push({
          name: `opacity-${Math.round(node.opacity * 100)}`,
          value: node.opacity,
          type: 'opacity',
          group: 'auto-extracted',
          cssVar: `--opacity-${Math.round(node.opacity * 100)}`,
        });
      }

      if (node.children) {
        for (const child of node.children) walk(child);
      }
    };

    for (const node of nodes) walk(node);
    return tokens;
  }

  extractFromStyles(styles: FigmaStyleMeta[]): DesignToken[] {
    const tokens: DesignToken[] = [];
    for (const style of styles) {
      const parts = style.name.split('/');
      const group = parts.length > 1 ? parts[0] : undefined;
      const name = (parts[parts.length - 1] || style.name).toLowerCase().replace(/\s+/g, '-');

      if (style.styleType === 'FILL' && style.fillColor) {
        tokens.push({
          name: `${name}-color`,
          value: style.fillColor,
          type: 'color',
          group,
          cssVar: `--${group ? group + '-' : ''}${name}-color`,
        });
      }
      if (style.styleType === 'TEXT') {
        if (style.fontFamily) {
          tokens.push({
            name: `${name}-font-family`,
            value: style.fontFamily,
            type: 'typography',
            group,
            cssVar: `--${group ? group + '-' : ''}${name}-font-family`,
          });
        }
        if (style.fontSize) {
          tokens.push({
            name: `${name}-font-size`,
            value: `${style.fontSize}px`,
            type: 'typography',
            group,
            cssVar: `--${group ? group + '-' : ''}${name}-font-size`,
          });
        }
        if (style.fontWeight) {
          tokens.push({
            name: `${name}-font-weight`,
            value: style.fontWeight,
            type: 'typography',
            group,
            cssVar: `--${group ? group + '-' : ''}${name}-font-weight`,
          });
        }
      }
    }
    return tokens;
  }

  generateCSSVariables(tokens: DesignToken[]): string {
    const lines = [':root {'];
    for (const token of tokens) {
      lines.push(`  ${token.cssVar}: ${token.value};`);
    }
    lines.push('}');
    return lines.join('\n');
  }

  generateTailwindConfig(tokens: DesignToken[]): string {
    const colors: Record<string, string> = {};
    const spacing: Record<string, string> = {};
    const borderRadius: Record<string, string> = {};
    const fontFamily: Record<string, string[]> = {};
    const fontSize: Record<string, string> = {};
    const fontWeight: Record<string, string> = {};
    const boxShadow: Record<string, string> = {};

    for (const token of tokens) {
      switch (token.type) {
        case 'color':
          colors[token.name] = token.value as string;
          break;
        case 'spacing':
          spacing[token.name.replace('spacing-', '')] = `${token.value}px`;
          break;
        case 'radius':
          borderRadius[token.name.replace('radius-', '')] = `${token.value}px`;
          break;
        case 'typography':
          if (token.name.includes('font-family')) {
            fontFamily[token.name.replace('-font-family', '')] = [token.value as string];
          } else if (token.name.includes('font-size')) {
            fontSize[token.name.replace('-font-size', '')] = token.value as string;
          } else if (token.name.includes('font-weight')) {
            fontWeight[token.name.replace('-font-weight', '')] = String(token.value);
          }
          break;
        case 'shadow':
          boxShadow[token.name] = token.value as string;
          break;
      }
    }

    const config: string[] = [];
    config.push('// tailwind.config.js extension — merge with your existing config');
    config.push('module.exports = {');
    config.push('  theme: {');
    config.push('    extend: {');

    if (Object.keys(colors).length > 0) {
      config.push('      colors: ' + JSON.stringify(colors, null, 6).replace(/^/gm, '      ') + ',');
    }
    if (Object.keys(spacing).length > 0) {
      config.push('      spacing: ' + JSON.stringify(spacing, null, 6).replace(/^/gm, '      ') + ',');
    }
    if (Object.keys(borderRadius).length > 0) {
      config.push('      borderRadius: ' + JSON.stringify(borderRadius, null, 6).replace(/^/gm, '      ') + ',');
    }
    if (Object.keys(fontFamily).length > 0) {
      config.push('      fontFamily: ' + JSON.stringify(fontFamily, null, 6).replace(/^/gm, '      ') + ',');
    }
    if (Object.keys(fontSize).length > 0) {
      config.push('      fontSize: ' + JSON.stringify(fontSize, null, 6).replace(/^/gm, '      ') + ',');
    }
    if (Object.keys(fontWeight).length > 0) {
      config.push('      fontWeight: ' + JSON.stringify(fontWeight, null, 6).replace(/^/gm, '      ') + ',');
    }
    if (Object.keys(boxShadow).length > 0) {
      config.push('      boxShadow: ' + JSON.stringify(boxShadow, null, 6).replace(/^/gm, '      ') + ',');
    }

    config.push('    },');
    config.push('  },');
    config.push('};');
    return config.join('\n');
  }

  private rgbToHex(r: number, g: number, b: number): string {
    const toHex = (v: number) => Math.round(v * 255).toString(16).padStart(2, '0');
    return '#' + toHex(r) + toHex(g) + toHex(b);
  }
}

// ─── Component-to-Code Mapping ─────────────────────────────────────────────

export class ComponentCodeMapper {
  /** Map Figma node types to suggested React component names. */
  private typeToComponent: Record<string, string> = {
    FRAME: 'Box',
    GROUP: 'Container',
    TEXT: 'Typography',
    RECTANGLE: 'Box',
    ELLIPSE: 'Avatar',
    VECTOR: 'SvgIcon',
    INSTANCE: 'Component',
    COMPONENT: 'Component',
    COMPONENT_SET: 'ComponentGroup',
    LINE: 'Divider',
    BOOLEAN_OPERATION: 'SvgShape',
    STAR: 'Icon',
    POLYGON: 'SvgShape',
    SECTION: 'Section',
  };

  /** Generate code mapping hints from a Figma node tree. */
  mapToCode(node: FigmaNode, parentPath: string = 'src/components'): ComponentCodeMapping {
    const componentName = this.inferComponentName(node);
    const codePath = `${parentPath}/${componentName}.tsx`;
    const hints = this.generateHints(node);

    const children = (node.children || []).map(child =>
      this.mapToCode(child, `${parentPath}/${componentName}`),
    );

    return {
      figmaNodeId: node.id,
      figmaNodeName: node.name,
      figmaNodeType: node.type,
      suggestedComponentName: componentName,
      suggestedCodePath: codePath,
      mappingHints: hints,
      properties: this.extractProperties(node),
      children,
    };
  }

  /** Find mappings for specific Figma component nodes. */
  mapComponents(components: Array<{ nodeId: string; name: string; description: string }>): ComponentCodeMapping[] {
    return components.map(c => ({
      figmaNodeId: c.nodeId,
      figmaNodeName: c.name,
      figmaNodeType: 'COMPONENT',
      suggestedComponentName: this.toPascalCase(c.name),
      suggestedCodePath: `src/components/${this.toPascalCase(c.name)}.tsx`,
      mappingHints: c.description
        ? [c.description]
        : ['Reusable component — extract to shared component library'],
      properties: {},
      children: [],
    }));
  }

  /** Render the mapping as a tree for IDE display. */
  renderMappingTree(root: ComponentCodeMapping, indent: number = 0): string {
    const prefix = '  '.repeat(indent);
    const icon = root.children.length > 0 ? '▸' : '▪';
    let result = `${prefix}${icon} ${root.figmaNodeName} → ${root.suggestedComponentName} [${root.figmaNodeType}]\n`;
    if (root.mappingHints.length > 0) {
      result += `${prefix}  💡 ${root.mappingHints[0]}\n`;
    }
    for (const child of root.children) {
      result += this.renderMappingTree(child, indent + 1);
    }
    return result;
  }

  private inferComponentName(node: FigmaNode): string {
    // If name looks like a meaningful component name, use it
    const cleanName = node.name.replace(/[^a-zA-Z0-9\s_-]/g, '').trim();
    if (cleanName.length > 0 && !/^(Frame|Group|Rectangle|Ellipse|Line|Vector)\s?\d*$/i.test(cleanName)) {
      return this.toPascalCase(cleanName);
    }
    // Fall back to type-based naming
    const base = this.typeToComponent[node.type] || 'Element';
    return base + (node.name.match(/\d+/) ? node.name.match(/\d+/)![0] : '');
  }

  private generateHints(node: FigmaNode): string[] {
    const hints: string[] = [];

    if (node.layoutMode === 'HORIZONTAL') {
      hints.push('Use flexbox: display="flex" flexDirection="row"');
    } else if (node.layoutMode === 'VERTICAL') {
      hints.push('Use flexbox: display="flex" flexDirection="column"');
    }

    if (node.paddingLeft || node.paddingRight || node.paddingTop || node.paddingBottom) {
      const p = [
        node.paddingTop || 0, node.paddingRight || 0,
        node.paddingBottom || 0, node.paddingLeft || 0,
      ];
      hints.push(`Apply padding: ${p[0]}px ${p[1]}px ${p[2]}px ${p[3]}px`);
    }

    if (node.itemSpacing && node.itemSpacing > 0) {
      hints.push(`Gap between children: ${node.itemSpacing}px (use gap property)`);
    }

    if (node.cornerRadius && node.cornerRadius > 0) {
      hints.push(`Border radius: ${node.cornerRadius}px`);
    }

    if (node.fills && node.fills.length > 0) {
      const solidFills = node.fills.filter(f => f.type === 'SOLID' && f.color);
      if (solidFills.length > 0) {
        const c = solidFills[0].color!;
        hints.push(`Background: rgba(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)},${c.a.toFixed(2)})`);
      }
    }

    if (node.characters) {
      const truncated = node.characters.length > 60 ? node.characters.slice(0, 57) + '...' : node.characters;
      hints.push(`Text content: "${truncated}"`);
    }

    return hints;
  }

  private extractProperties(node: FigmaNode): Record<string, string | number> {
    const props: Record<string, string | number> = {};
    if (node.absoluteBoundingBox) {
      props.width = node.absoluteBoundingBox.width;
      props.height = node.absoluteBoundingBox.height;
    }
    if (node.layoutMode) props.layoutMode = node.layoutMode;
    if (node.visible === false) props.hidden = 1;
    return props;
  }

  private toPascalCase(str: string): string {
    return str
      .split(/[\s_-]+/)
      .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
      .join('');
  }
}

// ─── Design vs Code Diff Viewer ────────────────────────────────────────────

export class DesignDiffViewer {
  /** Compare extracted design tokens against existing CSS/Tailwind files. */
  diffTokens(
    designTokens: DesignToken[],
    codeFiles: Array<{ path: string; content: string }>,
  ): DesignDiffReport {
    const entries: DesignDiffEntry[] = [];

    for (const token of designTokens) {
      let found = false;
      for (const file of codeFiles) {
        const tokenValue = String(token.value);
        if (file.content.includes(tokenValue)) {
          found = true;
          break;
        }
        // Also check CSS variable usage
        if (file.content.includes(token.cssVar)) {
          found = true;
          break;
        }
      }

      if (!found) {
        entries.push({
          property: token.name,
          designValue: token.value,
          codeValue: 'NOT FOUND',
          file: codeFiles[0]?.path || 'unknown',
          severity: token.type === 'color' ? 'error' : 'warning',
        });
      }
    }

    // Check for hardcoded values in code that don't match any design token
    for (const file of codeFiles) {
      const colorMatches = file.content.match(/#[0-9a-fA-F]{6}|rgba?\([^)]+\)/g) || [];
      for (const match of colorMatches) {
        const designHasIt = designTokens.some(t => String(t.value).toLowerCase() === match.toLowerCase());
        if (!designHasIt) {
          entries.push({
            property: 'hardcoded-color',
            designValue: 'NO MATCHING TOKEN',
            codeValue: match,
            file: file.path,
            severity: 'warning',
          });
        }
      }
    }

    const summary = {
      total: entries.length,
      errors: entries.filter(e => e.severity === 'error').length,
      warnings: entries.filter(e => e.severity === 'warning').length,
      infos: entries.filter(e => e.severity === 'info').length,
    };

    return {
      fileKey: 'design-diff',
      fileName: 'Design vs Code Diff',
      generatedAt: new Date(),
      entries,
      summary,
    };
  }

  /** Render the diff report as a formatted string. */
  renderDiffReport(report: DesignDiffReport): string {
    const lines = [
      `# Design vs Code Diff Report`,
      `> Generated: ${report.generatedAt.toISOString()}`,
      `> ${report.summary.total} differences: ${report.summary.errors} errors, ${report.summary.warnings} warnings`,
      '',
      '| Property | Design Value | Code Value | File | Severity |',
      '|----------|-------------|------------|------|----------|',
    ];

    for (const entry of report.entries) {
      const sevIcon = entry.severity === 'error' ? '🔴' : entry.severity === 'warning' ? '🟡' : '🔵';
      lines.push(
        `| ${entry.property} | ${entry.designValue} | ${entry.codeValue} | ${basename(entry.file)} | ${sevIcon} ${entry.severity} |`,
      );
    }

    return lines.join('\n');
  }
}

// ─── FigmaIntegration (Facade) ──────────────────────────────────────────────

export class FigmaIntegration {
  client: FigmaApiClient;
  tokenExtractor: DesignTokenExtractor;
  codeMapper: ComponentCodeMapper;
  diffViewer: DesignDiffViewer;
  private cacheDir: string;

  constructor(config: FigmaIntegrationConfig) {
    this.client = new FigmaApiClient(config);
    this.tokenExtractor = new DesignTokenExtractor();
    this.codeMapper = new ComponentCodeMapper();
    this.diffViewer = new DesignDiffViewer();
    this.cacheDir = config.cacheDir || join(homedir(), '.cobra-commander', 'figma');
    if (!existsSync(this.cacheDir)) mkdirSync(this.cacheDir, { recursive: true });
  }

  /** Fetch a file and extract design tokens. */
  async analyzeFile(fileKey: string): Promise<{
    name: string;
    version: string;
    components: FigmaComponentMeta[];
    tokens: DesignToken[];
    componentTree?: ComponentCodeMapping;
  }> {
    const data = await this.client.getFile(fileKey, { depth: 3 });
    const components = await this.client.getComponents(fileKey);
    const styles = await this.client.getStyles(fileKey);

    const nodeTokens = this.tokenExtractor.extractFromNodes(data.document.children || []);
    const styleTokens = this.tokenExtractor.extractFromStyles(styles);
    const allTokens = [...nodeTokens, ...styleTokens];

    const componentTree = data.document.children
      ? this.codeMapper.mapToCode(data.document.children[0])
      : undefined;

    return {
      name: data.name,
      version: data.version,
      components,
      tokens: allTokens,
      componentTree,
    };
  }

  /** Extract design tokens and generate CSS variables + Tailwind config. */
  async generateDesignSystem(fileKey: string): Promise<{
    cssPath: string;
    tailwindPath: string;
    tokens: DesignToken[];
  }> {
    const analysis = await this.analyzeFile(fileKey);

    const cssVars = this.tokenExtractor.generateCSSVariables(analysis.tokens);
    const cssPath = join(this.cacheDir, `${fileKey}-tokens.css`);
    writeFileSync(cssPath, cssVars);

    const tailwindConfig = this.tokenExtractor.generateTailwindConfig(analysis.tokens);
    const tailwindPath = join(this.cacheDir, `${fileKey}-tailwind.config.js`);
    writeFileSync(tailwindPath, tailwindConfig);

    return { cssPath, tailwindPath, tokens: analysis.tokens };
  }

  /** Generate component-to-code mapping hints. */
  async generateCodeMapping(fileKey: string): Promise<ComponentCodeMapping | null> {
    const data = await this.client.getFile(fileKey, { depth: 5 });
    if (!data.document.children || data.document.children.length === 0) return null;

    const mapping = this.codeMapper.mapToCode(data.document.children[0]);
    const visPath = join(this.cacheDir, `${fileKey}-component-map.txt`);
    writeFileSync(visPath, this.codeMapper.renderMappingTree(mapping));

    return mapping;
  }

  /** Run design diff against code files. */
  async runDesignDiff(
    fileKey: string,
    codeFiles: Array<{ path: string; content: string }>,
  ): Promise<DesignDiffReport> {
    const analysis = await this.analyzeFile(fileKey);
    const report = this.diffViewer.diffTokens(analysis.tokens, codeFiles);
    (report as unknown as Record<string, unknown>).fileKey = fileKey;
    (report as unknown as Record<string, unknown>).fileName = analysis.name;
    return report;
  }

  /** List project files. */
  async listProjectFiles(projectId: string): Promise<FigmaFileMeta[]> {
    return this.client.getProjectFiles(projectId);
  }

  /** Get cached tokens from a previous analysis. */
  getCachedTokens(fileKey: string): DesignToken[] | null {
    const path = join(this.cacheDir, `${fileKey}-tokens.json`);
    if (!existsSync(path)) return null;
    try {
      return JSON.parse(readFileSync(path, 'utf-8'));
    } catch {
      return null;
    }
  }

  /** Cache design tokens for later diffing. */
  cacheTokens(fileKey: string, tokens: DesignToken[]): void {
    writeFileSync(join(this.cacheDir, `${fileKey}-tokens.json`), JSON.stringify(tokens, null, 2));
  }
}
