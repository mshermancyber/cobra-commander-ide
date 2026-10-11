import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, relative, extname, basename, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FigmaColor {
  r: number;
  g: number;
  b: number;
  a: number;
}

export interface FigmaFill {
  type: 'SOLID' | 'GRADIENT_LINEAR' | 'GRADIENT_RADIAL' | 'IMAGE' | 'EMPTY';
  color?: FigmaColor;
  opacity?: number;
  gradientStops?: Array<{ color: FigmaColor; position: number }>;
}

export interface FigmaStroke {
  type: string;
  color?: FigmaColor;
  weight?: number;
}

export interface FigmaEffect {
  type: 'DROP_SHADOW' | 'INNER_SHADOW' | 'LAYER_BLUR' | 'BACKGROUND_BLUR';
  radius?: number;
  color?: FigmaColor;
  offset?: { x: number; y: number };
  spread?: number;
}

export interface FigmaNode {
  id: string;
  name: string;
  type: string;
  visible: boolean;
  children?: FigmaNode[];
  absoluteBoundingBox?: { x: number; y: number; width: number; height: number };
  constraints?: { vertical: string; horizontal: string };
  layoutMode?: 'HORIZONTAL' | 'VERTICAL' | 'NONE';
  primaryAxisAlignItems?: 'MIN' | 'CENTER' | 'MAX' | 'SPACE_BETWEEN';
  counterAxisAlignItems?: 'MIN' | 'CENTER' | 'MAX';
  paddingLeft?: number;
  paddingRight?: number;
  paddingTop?: number;
  paddingBottom?: number;
  itemSpacing?: number;
  layoutWrap?: 'NO_WRAP' | 'WRAP';
  fills?: FigmaFill[];
  strokes?: FigmaStroke[];
  effects?: FigmaEffect[];
  cornerRadius?: number;
  rectangleCornerRadii?: number[];
  opacity?: number;
  characters?: string;
  style?: {
    fontFamily?: string;
    fontWeight?: number;
    fontSize?: number;
    lineHeightPx?: number;
    letterSpacing?: number;
    textAlignHorizontal?: 'LEFT' | 'CENTER' | 'RIGHT' | 'JUSTIFIED';
    textAlignVertical?: 'TOP' | 'CENTER' | 'BOTTOM';
    textDecoration?: 'NONE' | 'UNDERLINE' | 'STRIKETHROUGH';
    italic?: boolean;
    textCase?: 'ORIGINAL' | 'UPPER' | 'LOWER' | 'TITLE';
  };
  componentId?: string;
  componentPropertyReferences?: Record<string, string>;
  isMask?: boolean;
  clipsContent?: boolean;
}

export interface ComponentMapping {
  figmaNodeId: string;
  figmaNodeName: string;
  componentName: string;
  componentType: 'container' | 'text' | 'image' | 'button' | 'input' | 'icon' | 'list' | 'card' | 'nav' | 'footer' | 'custom';
  depth: number;
  children: ComponentMapping[];
  cssClass: string;
  props: Record<string, string | number | boolean>;
}

export interface CssStyle {
  selector: string;
  properties: Record<string, string>;
  pseudoStates?: Record<string, Record<string, string>>;
  mediaQueries?: Record<string, Record<string, string>>;
}

export interface DesignTokenBinding {
  tokenName: string;
  tokenValue: string;
  cssVariable: string;
  nodeIds: string[];
  usedIn: string[];
}

export interface GeneratedComponent {
  name: string;
  type: string;
  code: string;
  cssClass: string;
  cssStyles: CssStyle[];
  children: GeneratedComponent[];
}

export interface FigmaCodeGenerationResult {
  id: string;
  figmaFileName: string;
  components: GeneratedComponent[];
  cssStyles: CssStyle[];
  designTokens: DesignTokenBinding[];
  fullHtml: string;
  fullCss: string;
  generatedAt: number;
}

// ---------------------------------------------------------------------------
// Figma Node Tree → Component Hierarchy Mapper — GAP-094
// ---------------------------------------------------------------------------

export class ComponentHierarchyMapper {
  private readonly TYPE_TO_COMPONENT: Record<string, ComponentMapping['componentType']> = {
    FRAME: 'container',
    GROUP: 'container',
    COMPONENT: 'container',
    COMPONENT_SET: 'container',
    INSTANCE: 'container',
    RECTANGLE: 'container',
    ELLIPSE: 'container',
    TEXT: 'text',
    VECTOR: 'icon',
    LINE: 'icon',
    STAR: 'icon',
    POLYGON: 'icon',
    BOOLEAN_OPERATION: 'icon',
    SLICE: 'image',
  };

  /**
   * Map a Figma node tree to a component hierarchy.
   */
  mapNodeTree(rootNode: FigmaNode, depth = 0): ComponentMapping {
    const componentType = this.inferComponentType(rootNode);
    const cssClass = this.generateClassName(rootNode);

    const mapping: ComponentMapping = {
      figmaNodeId: rootNode.id,
      figmaNodeName: rootNode.name,
      componentName: this.pascalCase(rootNode.name),
      componentType,
      depth,
      children: [],
      cssClass,
      props: this.extractProps(rootNode),
    };

    // Map children recursively
    if (rootNode.children) {
      for (const child of rootNode.children) {
        if (child.visible !== false) {
          mapping.children.push(this.mapNodeTree(child, depth + 1));
        }
      }
    }

    return mapping;
  }

  /**
   * Flatten a component mapping into a list.
   */
  flatten(root: ComponentMapping): ComponentMapping[] {
    const results: ComponentMapping[] = [root];
    for (const child of root.children) {
      results.push(...this.flatten(child));
    }
    return results;
  }

  /**
   * Group mappings by component type for code generation.
   */
  groupByType(root: ComponentMapping): Map<string, ComponentMapping[]> {
    const groups = new Map<string, ComponentMapping[]>();
    const all = this.flatten(root);

    for (const mapping of all) {
      const existing = groups.get(mapping.componentType) || [];
      existing.push(mapping);
      groups.set(mapping.componentType, existing);
    }

    return groups;
  }

  /**
   * Generate a visual tree representation.
   */
  printTree(root: ComponentMapping, indent = 0): string {
    const prefix = '  '.repeat(indent);
    const icon = root.children.length > 0 ? '▾' : '▹';
    let result = `${prefix}${icon} ${root.componentName} [${root.componentType}] .${root.cssClass}\n`;
    for (const child of root.children) {
      result += this.printTree(child, indent + 1);
    }
    return result;
  }

  private inferComponentType(node: FigmaNode): ComponentMapping['componentType'] {
    // Use explicit mapping first
    if (this.TYPE_TO_COMPONENT[node.type]) {
      const base = this.TYPE_TO_COMPONENT[node.type];
      // Further refinement for containers
      if (base === 'container') {
        const name = node.name.toLowerCase();
        if (name.includes('button') || name.includes('btn')) return 'button';
        if (name.includes('input') || name.includes('field') || name.includes('textarea')) return 'input';
        if (name.includes('card') || name.includes('tile')) return 'card';
        if (name.includes('nav') || name.includes('header') || name.includes('top-bar')) return 'nav';
        if (name.includes('footer') || name.includes('bottom')) return 'footer';
        if (name.includes('list') || name.includes('item-')) return 'list';
        if (name.includes('image') || name.includes('img') || name.includes('photo') || name.includes('avatar')) return 'image';
        if (name.includes('icon')) return 'icon';
      }
      return base;
    }

    return 'container';
  }

  private generateClassName(node: FigmaNode): string {
    const name = node.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'element';

    const typePrefix: Record<string, string> = {
      FRAME: 'frame',
      TEXT: 'text',
      RECTANGLE: 'box',
      ELLIPSE: 'circle',
      GROUP: 'group',
      VECTOR: 'icon',
      INSTANCE: 'instance',
      COMPONENT: 'component',
    };

    const prefix = typePrefix[node.type] || 'el';
    return `${prefix}-${name}`;
  }

  private pascalCase(name: string): string {
    return name
      .replace(/[^a-zA-Z0-9\s-]/g, '')
      .split(/[\s-]+/)
      .map(w => w.charAt(0).toUpperCase() + w.slice(1))
      .join('');
  }

  private extractProps(node: FigmaNode): Record<string, string | number | boolean> {
    const props: Record<string, string | number | boolean> = {
      visible: node.visible !== false,
    };

    if (node.absoluteBoundingBox) {
      props.width = node.absoluteBoundingBox.width;
      props.height = node.absoluteBoundingBox.height;
    }

    if (node.layoutMode && node.layoutMode !== 'NONE') {
      props.layoutDirection = node.layoutMode.toLowerCase();
    }

    if (node.characters) {
      props.textContent = node.characters;
    }

    if (node.opacity !== undefined) {
      props.opacity = node.opacity;
    }

    if (node.isMask) {
      props.isMask = true;
    }

    return props;
  }
}

// ---------------------------------------------------------------------------
// Auto-Layout → Flexbox/Grid CSS Translator — GAP-094
// ---------------------------------------------------------------------------

export interface AutoLayoutStyle {
  display: 'flex' | 'grid';
  flexDirection?: 'row' | 'column';
  justifyContent?: 'flex-start' | 'center' | 'flex-end' | 'space-between' | 'space-around' | 'space-evenly';
  alignItems?: 'flex-start' | 'center' | 'flex-end' | 'stretch';
  gap?: number;
  padding?: { top: number; right: number; bottom: number; left: number };
  flexWrap?: 'nowrap' | 'wrap';
  width?: number;
  height?: number;
}

export class AutoLayoutTranslator {
  /**
   * Translate a Figma auto-layout node to CSS flexbox/grid properties.
   */
  translate(node: FigmaNode): AutoLayoutStyle | null {
    if (!node.layoutMode || node.layoutMode === 'NONE') {
      return null;
    }

    const style: AutoLayoutStyle = {
      display: 'flex',
      flexDirection: node.layoutMode === 'HORIZONTAL' ? 'row' : 'column',
    };

    // Primary axis alignment
    style.justifyContent = this.mapPrimaryAlign(node.primaryAxisAlignItems);

    // Counter axis alignment
    style.alignItems = this.mapCounterAlign(node.counterAxisAlignItems);

    // Item spacing → gap
    if (node.itemSpacing !== undefined && node.itemSpacing > 0) {
      style.gap = node.itemSpacing;
    }

    // Padding
    if (node.paddingTop || node.paddingRight || node.paddingBottom || node.paddingLeft) {
      style.padding = {
        top: node.paddingTop || 0,
        right: node.paddingRight || 0,
        bottom: node.paddingBottom || 0,
        left: node.paddingLeft || 0,
      };
    }

    // Wrap
    if (node.layoutWrap === 'WRAP') {
      style.flexWrap = 'wrap';
    }

    // Dimensions
    if (node.absoluteBoundingBox) {
      style.width = node.absoluteBoundingBox.width;
      style.height = node.absoluteBoundingBox.height;
    }

    return style;
  }

  /**
   * Generate CSS properties from auto-layout style.
   */
  toCss(style: AutoLayoutStyle): Record<string, string> {
    const css: Record<string, string> = {
      display: style.display,
    };

    if (style.flexDirection) css['flex-direction'] = style.flexDirection;
    if (style.justifyContent) css['justify-content'] = style.justifyContent;
    if (style.alignItems) css['align-items'] = style.alignItems;
    if (style.gap) css['gap'] = `${style.gap}px`;
    if (style.flexWrap) css['flex-wrap'] = style.flexWrap;

    if (style.padding) {
      const { top, right, bottom, left } = style.padding;
      if (top || right || bottom || left) {
        css['padding'] = `${top}px ${right}px ${bottom}px ${left}px`;
      }
    }

    if (style.width) css['width'] = `${style.width}px`;
    if (style.height) css['height'] = `${style.height}px`;

    return css;
  }

  /**
   * Generate complete CSS for a Figma subtree.
   */
  generateSubtreeCss(node: FigmaNode, className: string): CssStyle[] {
    const styles: CssStyle[] = [];

    // Auto-layout → Flexbox
    const layout = this.translate(node);
    if (layout) {
      styles.push({
        selector: `.${className}`,
        properties: this.toCss(layout),
      });
    } else {
      // Still generate position/size if available
      const props: Record<string, string> = {};
      if (node.absoluteBoundingBox) {
        props['width'] = `${node.absoluteBoundingBox.width}px`;
        props['height'] = `${node.absoluteBoundingBox.height}px`;
      }
      if (Object.keys(props).length > 0) {
        styles.push({ selector: `.${className}`, properties: props });
      }
    }

    // Opacity
    if (node.opacity !== undefined && node.opacity < 1) {
      styles.push({
        selector: `.${className}`,
        properties: { opacity: String(node.opacity) },
      });
    }

    // Corner radius
    if (node.cornerRadius && node.cornerRadius > 0) {
      styles.push({
        selector: `.${className}`,
        properties: { 'border-radius': `${node.cornerRadius}px` },
      });
    } else if (node.rectangleCornerRadii && node.rectangleCornerRadii.length === 4) {
      const [tl, tr, br, bl] = node.rectangleCornerRadii;
      if (tl || tr || br || bl) {
        styles.push({
          selector: `.${className}`,
          properties: {
            'border-radius': `${tl}px ${tr}px ${br}px ${bl}px`,
          },
        });
      }
    }

    // Clip content (overflow: hidden)
    if (node.clipsContent) {
      styles.push({
        selector: `.${className}`,
        properties: { overflow: 'hidden' },
      });
    }

    // Background fills
    for (const fill of (node.fills || [])) {
      if (fill.type === 'SOLID' && fill.color) {
        styles.push({
          selector: `.${className}`,
          properties: {
            'background-color': this.rgbaToCss(fill.color),
          },
        });
        break; // Use first solid fill as background
      } else if (fill.type === 'IMAGE') {
        styles.push({
          selector: `.${className}`,
          properties: {
            'background-size': 'cover',
            'background-position': 'center',
          },
        });
      }
    }

    // Strokes (borders)
    for (const stroke of (node.strokes || [])) {
      if (stroke.color) {
        styles.push({
          selector: `.${className}`,
          properties: {
            'border': `${stroke.weight || 1}px solid ${this.rgbaToCss(stroke.color)}`,
          },
        });
        break; // Use first stroke
      }
    }

    // Effects (shadows, blurs)
    for (const effect of (node.effects || [])) {
      if (effect.type === 'DROP_SHADOW' && effect.color) {
        const x = effect.offset?.x || 0;
        const y = effect.offset?.y || 0;
        const blur = effect.radius || 0;
        const spread = effect.spread || 0;
        const color = this.rgbaToCss(effect.color);
        styles.push({
          selector: `.${className}`,
          properties: {
            'box-shadow': `${x}px ${y}px ${blur}px ${spread}px ${color}`,
          },
        });
      } else if (effect.type === 'LAYER_BLUR' && effect.radius) {
        styles.push({
          selector: `.${className}`,
          properties: {
            'filter': `blur(${effect.radius}px)`,
          },
        });
      }
    }

    // Text styles
    if (node.type === 'TEXT' && node.style) {
      const textCss: Record<string, string> = {};
      if (node.style.fontFamily) textCss['font-family'] = node.style.fontFamily;
      if (node.style.fontSize) textCss['font-size'] = `${node.style.fontSize}px`;
      if (node.style.fontWeight) textCss['font-weight'] = String(node.style.fontWeight);
      if (node.style.lineHeightPx) textCss['line-height'] = `${node.style.lineHeightPx}px`;
      if (node.style.letterSpacing) textCss['letter-spacing'] = `${node.style.letterSpacing}px`;
      if (node.style.textAlignHorizontal) textCss['text-align'] = node.style.textAlignHorizontal.toLowerCase();
      if (node.style.italic) textCss['font-style'] = 'italic';
      if (node.style.textDecoration && node.style.textDecoration !== 'NONE') {
        textCss['text-decoration'] = node.style.textDecoration.toLowerCase();
      }
      if (node.style.textCase === 'UPPER') textCss['text-transform'] = 'uppercase';
      else if (node.style.textCase === 'LOWER') textCss['text-transform'] = 'lowercase';
      else if (node.style.textCase === 'TITLE') textCss['text-transform'] = 'capitalize';

      if (Object.keys(textCss).length > 0) {
        styles.push({ selector: `.${className}`, properties: textCss });
      }

      // Text color from fills
      if (node.fills && node.fills.length > 0 && node.fills[0].color) {
        styles.push({
          selector: `.${className}`,
          properties: { color: this.rgbaToCss(node.fills[0].color) },
        });
      }
    }

    // Recurse children
    if (node.children) {
      for (const child of node.children) {
        if (child.visible !== false) {
          const childClass = this.generateChildClassName(child);
          styles.push(...this.generateSubtreeCss(child, childClass));
        }
      }
    }

    return styles;
  }

  /**
   * Generate HTML for a Figma node tree.
   */
  generateHtml(node: FigmaNode, className: string, indent = 0): string {
    const pad = '  '.repeat(indent);
    const isText = node.type === 'TEXT';
    const isImage = node.name.toLowerCase().includes('image') || node.name.toLowerCase().includes('img');

    if (isText) {
      return `${pad}<span class="${className}">${node.characters || ''}</span>`;
    }

    if (isImage) {
      return `${pad}<img class="${className}" src="" alt="${node.name}" />`;
    }

    // Determine appropriate HTML tag
    let tag = 'div';
    const name = node.name.toLowerCase();
    if (name.includes('button') || name.includes('btn')) tag = 'button';
    else if (name.includes('input') || name.includes('field')) tag = 'input';
    else if (name === 'nav' || name.includes('nav')) tag = 'nav';
    else if (name.includes('header') || name === 'header') tag = 'header';
    else if (name.includes('footer') || name === 'footer') tag = 'footer';
    else if (name.includes('section')) tag = 'section';
    else if (name.includes('main')) tag = 'main';
    else if (name.includes('ul') || name.includes('list')) tag = 'ul';
    else if (name.includes('li') || name.includes('item-')) tag = 'li';
    else if (name.includes('h1')) tag = 'h1';
    else if (name.includes('h2')) tag = 'h2';
    else if (name.includes('h3')) tag = 'h3';
    else if (name.includes('p') && name.length <= 2) tag = 'p';

    const voidTags = new Set(['input', 'img', 'br', 'hr']);
    if (voidTags.has(tag)) {
      return `${pad}<${tag} class="${className}" />`;
    }

    if (!node.children || node.children.length === 0) {
      return `${pad}<${tag} class="${className}"></${tag}>`;
    }

    const childrenHtml = node.children
      .filter(c => c.visible !== false)
      .map(c => this.generateHtml(c, this.generateChildClassName(c), indent + 1))
      .join('\n');

    return `${pad}<${tag} class="${className}">\n${childrenHtml}\n${pad}</${tag}>`;
  }

  private generateChildClassName(node: FigmaNode): string {
    return node.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'element';
  }

  private mapPrimaryAlign(
    align?: 'MIN' | 'CENTER' | 'MAX' | 'SPACE_BETWEEN',
  ): AutoLayoutStyle['justifyContent'] {
    switch (align) {
      case 'MIN': return 'flex-start';
      case 'CENTER': return 'center';
      case 'MAX': return 'flex-end';
      case 'SPACE_BETWEEN': return 'space-between';
      default: return 'flex-start';
    }
  }

  private mapCounterAlign(
    align?: 'MIN' | 'CENTER' | 'MAX',
  ): AutoLayoutStyle['alignItems'] {
    switch (align) {
      case 'MIN': return 'flex-start';
      case 'CENTER': return 'center';
      case 'MAX': return 'flex-end';
      default: return 'stretch';
    }
  }

  private rgbaToCss(color: FigmaColor): string {
    const r = Math.round(color.r * 255);
    const g = Math.round(color.g * 255);
    const b = Math.round(color.b * 255);
    const a = color.a ?? 1;

    if (a >= 1) {
      return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
    }

    return `rgba(${r}, ${g}, ${b}, ${a.toFixed(2)})`;
  }
}

// ---------------------------------------------------------------------------
// Design Token → CSS Variable Binder — GAP-094
// ---------------------------------------------------------------------------

export interface TokenEntry {
  name: string;
  value: string;
  category: 'color' | 'typography' | 'spacing' | 'radius' | 'shadow' | 'opacity';
  sourceNodeId: string;
}

export class DesignTokenBinder {
  private tokens: Map<string, TokenEntry> = new Map();

  /**
   * Extract design tokens from a Figma node tree.
   */
  extractFromNodeTree(rootNode: FigmaNode): TokenEntry[] {
    const tokens: TokenEntry[] = [];
    const seenColors = new Set<string>();
    const seenSpacings = new Set<number>();
    const seenRadii = new Set<number>();

    const walk = (node: FigmaNode) => {
      // Colors from fills
      if (node.fills) {
        for (const fill of node.fills) {
          if (fill.type === 'SOLID' && fill.color) {
            const hex = this.rgbaToHex(fill.color);
            if (!seenColors.has(hex)) {
              seenColors.add(hex);
              tokens.push({
                name: `color-${hex.replace('#', '')}`,
                value: hex,
                category: 'color',
                sourceNodeId: node.id,
              });
            }
          }
        }
      }

      // Spacings
      const spacings = [
        node.paddingTop, node.paddingRight, node.paddingBottom, node.paddingLeft,
        node.itemSpacing,
      ];
      for (const s of spacings) {
        if (s !== undefined && s > 0 && !seenSpacings.has(s)) {
          seenSpacings.add(s);
          tokens.push({
            name: `spacing-${s}`,
            value: `${s}px`,
            category: 'spacing',
            sourceNodeId: node.id,
          });
        }
      }

      // Corner radius
      if (node.cornerRadius && node.cornerRadius > 0 && !seenRadii.has(node.cornerRadius)) {
        seenRadii.add(node.cornerRadius);
        tokens.push({
          name: `radius-${node.cornerRadius}`,
          value: `${node.cornerRadius}px`,
          category: 'radius',
          sourceNodeId: node.id,
        });
      }

      // Text styles → typography tokens
      if (node.type === 'TEXT' && node.style) {
        if (node.style.fontFamily) {
          tokens.push({
            name: 'font-family-primary',
            value: node.style.fontFamily,
            category: 'typography',
            sourceNodeId: node.id,
          });
        }
        if (node.style.fontSize) {
          tokens.push({
            name: `font-size-${node.style.fontSize}`,
            value: `${node.style.fontSize}px`,
            category: 'typography',
            sourceNodeId: node.id,
          });
        }
      }

      // Shadows
      if (node.effects) {
        for (const effect of node.effects) {
          if (effect.type === 'DROP_SHADOW') {
            const desc = `${effect.offset?.x || 0}px ${effect.offset?.y || 0}px ${effect.radius || 0}px`;
            tokens.push({
              name: `shadow-${node.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
              value: desc,
              category: 'shadow',
              sourceNodeId: node.id,
            });
          }
        }
      }

      // Recurse
      if (node.children) {
        for (const child of node.children) walk(child);
      }
    };

    walk(rootNode);

    // Store in map
    for (const token of tokens) {
      this.tokens.set(token.name, token);
    }

    return tokens;
  }

  /**
   * Generate CSS custom properties from tokens.
   */
  generateCssVariables(): string {
    const lines = [':root {'];

    // Group by category
    const categories = ['color', 'spacing', 'radius', 'typography', 'shadow', 'opacity'];
    for (const cat of categories) {
      const catTokens = [...this.tokens.values()].filter(t => t.category === cat);
      if (catTokens.length === 0) continue;

      lines.push(`  /* ${cat} */`);
      for (const token of catTokens) {
        lines.push(`  --${token.name}: ${token.value};`);
      }
    }

    lines.push('}');
    return lines.join('\n');
  }

  /**
   * Replace hardcoded values in CSS with CSS variable references.
   */
  bindToCss(cssContent: string): { result: string; bindings: number } {
    let result = cssContent;
    let bindings = 0;

    for (const [name, token] of this.tokens) {
      const escapedVal = token.value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pattern = new RegExp(escapedVal, 'g');

      if (pattern.test(result)) {
        result = result.replace(pattern, `var(--${name})`);
        bindings++;
      }
    }

    return { result, bindings };
  }

  /**
   * Generate bindings report — which tokens are used where.
   */
  generateBindingsReport(cssStyles: CssStyle[]): DesignTokenBinding[] {
    const bindings: DesignTokenBinding[] = [];

    for (const [name, token] of this.tokens) {
      const usedIn: string[] = [];
      const nodeIds: string[] = [token.sourceNodeId];

      for (const style of cssStyles) {
        for (const [, value] of Object.entries(style.properties)) {
          if (value.includes(token.value)) {
            usedIn.push(style.selector);
          }
        }
      }

      bindings.push({
        tokenName: name,
        tokenValue: token.value,
        cssVariable: `--${name}`,
        nodeIds,
        usedIn,
      });
    }

    return bindings;
  }

  private rgbaToHex(color: FigmaColor): string {
    const r = Math.round(color.r * 255);
    const g = Math.round(color.g * 255);
    const b = Math.round(color.b * 255);
    return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
  }
}

// ---------------------------------------------------------------------------
// Live Preview Overlay — GAP-094
// ---------------------------------------------------------------------------

export interface OverlayConfig {
  figmaFrameUrl: string;
  renderedCodeDir: string;
  port: number;
  opacity: number; // 0-1, how see-through the overlay is
  sideBySide: boolean;
}

export class LivePreviewOverlay {
  private config: OverlayConfig;
  private server: ReturnType<typeof createServer> | null = null;

  constructor(config: OverlayConfig) {
    this.config = config;
  }

  /**
   * Start a preview server that overlays the rendered code on the Figma frame.
   */
  async start(): Promise<{ url: string; port: number }> {
    return new Promise((resolve, reject) => {
      this.server = createServer((req: IncomingMessage, res: ServerResponse) => {
        const url = req.url || '/';

        if (url === '/' || url === '/overlay') {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(this.generateOverlayPage());
          return;
        }

        // Serve static files from renderedCodeDir
        const filePath = join(this.config.renderedCodeDir, url === '/' ? 'index.html' : url);
        try {
          if (existsSync(filePath)) {
            const content = readFileSync(filePath);
            const ext = extname(filePath).toLowerCase();
            const mime: Record<string, string> = {
              '.html': 'text/html',
              '.css': 'text/css',
              '.js': 'application/javascript',
              '.png': 'image/png',
              '.svg': 'image/svg+xml',
              '.json': 'application/json',
            };
            res.writeHead(200, { 'Content-Type': mime[ext] || 'application/octet-stream' });
            res.end(content);
          } else {
            res.writeHead(404);
            res.end('Not Found');
          }
        } catch {
          res.writeHead(500);
          res.end('Server Error');
        }
      });

      this.server.listen(this.config.port, () => {
        resolve({ url: `http://localhost:${this.config.port}`, port: this.config.port });
      });

      this.server.on('error', reject);
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => resolve());
      } else {
        resolve();
      }
    });
  }

  /**
   * Generate the overlay comparison HTML page.
   */
  private generateOverlayPage(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Figma-to-Code Preview</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: system-ui, sans-serif; background: #1a1a2e; color: #eee; }
    .toolbar {
      background: #16213e;
      padding: 10px 16px;
      display: flex;
      align-items: center;
      gap: 16px;
      border-bottom: 1px solid #0f3460;
    }
    .toolbar h1 { font-size: 16px; }
    .toolbar button, .toolbar input[type="range"] {
      padding: 6px 12px;
      border: 1px solid #0f3460;
      background: #1a1a2e;
      color: #eee;
      border-radius: 4px;
      cursor: pointer;
    }
    .toolbar button:hover { background: #0f3460; }
    .toolbar .mode-label { font-size: 13px; color: #aaa; }
    .comparison-container {
      position: relative;
      width: 100%;
      height: calc(100vh - 50px);
      overflow: hidden;
    }
    .figma-frame, .rendered-frame {
      position: absolute;
      top: 0;
      width: 100%;
      height: 100%;
      border: none;
    }
    .figma-frame { left: 0; }
    .rendered-frame { left: 0; pointer-events: none; }
    .mode-overlay .rendered-frame { opacity: ${this.config.opacity}; pointer-events: none; }
    .mode-diff .figma-frame { width: 50%; }
    .mode-diff .rendered-frame { left: 50%; width: 50%; pointer-events: auto; }
    .mode-code .figma-frame { display: none; }
    .mode-code .rendered-frame { pointer-events: auto; }
    .diff-divider {
      display: none;
      position: absolute;
      top: 0;
      left: 50%;
      width: 3px;
      height: 100%;
      background: #e94560;
      z-index: 10;
      cursor: ew-resize;
    }
    .mode-diff .diff-divider { display: block; }
    .pixel-diff {
      position: absolute;
      top: 16px;
      right: 16px;
      background: rgba(0,0,0,0.8);
      padding: 8px 12px;
      border-radius: 6px;
      font-size: 12px;
      z-index: 20;
    }
  </style>
</head>
<body>
  <div class="toolbar">
    <h1>Figma vs Code</h1>
    <button onclick="setMode('overlay')">Overlay</button>
    <button onclick="setMode('diff')">Side by Side</button>
    <button onclick="setMode('code')">Code Only</button>
    <label class="mode-label">
      Overlay opacity: <input type="range" min="0" max="100" value="${(this.config.opacity * 100).toFixed(0)}" oninput="setOpacity(this.value)" />
    </label>
    <span style="margin-left:auto;font-size:12px;color:#aaa;">
      Figma frame shown for visual comparison
    </span>
  </div>
  <div class="comparison-container mode-overlay" id="comparison">
    <div class="diff-divider" id="divider"></div>
    <iframe class="figma-frame" id="figmaFrame"
            src="about:blank"
            data-src="${this.config.figmaFrameUrl}"></iframe>
    <iframe class="rendered-frame" id="renderedFrame"
            src="/index.html"></iframe>
    <div class="pixel-diff" id="pixelDiff"></div>
  </div>
  <script>
    let currentMode = 'overlay';
    const container = document.getElementById('comparison');
    const divider = document.getElementById('divider');
    const figmaFrame = document.getElementById('figmaFrame');

    // Lazy-load Figma frame
    setTimeout(() => {
      figmaFrame.src = figmaFrame.getAttribute('data-src');
    }, 500);

    function setMode(mode) {
      currentMode = mode;
      container.className = 'comparison-container mode-' + mode;
    }

    function setOpacity(val) {
      const rendered = document.getElementById('renderedFrame');
      rendered.style.opacity = (val / 100).toString();
    }

    // Draggable divider for side-by-side mode
    let dragging = false;
    divider.addEventListener('mousedown', () => { dragging = true; });
    document.addEventListener('mouseup', () => { dragging = false; });
    document.addEventListener('mousemove', (e) => {
      if (!dragging || currentMode !== 'diff') return;
      const rect = container.getBoundingClientRect();
      const pct = ((e.clientX - rect.left) / rect.width) * 100;
      document.querySelector('.figma-frame').style.width = pct + '%';
      document.querySelector('.rendered-frame').style.left = pct + '%';
      document.querySelector('.rendered-frame').style.width = (100 - pct) + '%';
      divider.style.left = pct + '%';
    });
  </script>
</body>
</html>`;
  }
}

// ---------------------------------------------------------------------------
// FigmaToCodeGenerator — main orchestrator (GAP-094)
// ---------------------------------------------------------------------------

export class FigmaToCodeGenerator {
  private mapper: ComponentHierarchyMapper;
  private layoutTranslator: AutoLayoutTranslator;
  private tokenBinder: DesignTokenBinder;

  constructor() {
    this.mapper = new ComponentHierarchyMapper();
    this.layoutTranslator = new AutoLayoutTranslator();
    this.tokenBinder = new DesignTokenBinder();
  }

  /**
   * Generate HTML + CSS from a Figma node tree.
   */
  generateFromNodeTree(rootNode: FigmaNode, figmaFileName: string): FigmaCodeGenerationResult {
    const id = `figma-gen-${randomUUID().slice(0, 8)}`;

    // Phase 1: Map component hierarchy
    const componentTree = this.mapper.mapNodeTree(rootNode);
    const flatComponents = this.mapper.flatten(componentTree);

    // Phase 2: Extract design tokens
    const tokens = this.tokenBinder.extractFromNodeTree(rootNode);

    // Phase 3: Translate auto-layout to CSS
    const cssStyles = this.layoutTranslator.generateSubtreeCss(rootNode, 'root');

    // Phase 4: Generate HTML
    const html = this.layoutTranslator.generateHtml(rootNode, 'root');

    // Phase 5: Bind tokens to CSS variables
    const cssVariables = this.tokenBinder.generateCssVariables();
    const fullCss = cssVariables + '\n\n' + cssStyles
      .map(s => {
        const props = Object.entries(s.properties)
          .map(([k, v]) => `  ${k}: ${v};`)
          .join('\n');
        return `${s.selector} {\n${props}\n}`;
      })
      .join('\n\n');

    // Build component list
    const components: GeneratedComponent[] = flatComponents.map(cm => ({
      name: cm.componentName,
      type: cm.componentType,
      code: '',  // filled per component type
      cssClass: cm.cssClass,
      cssStyles: cssStyles.filter(s => s.selector === `.${cm.cssClass}`),
      children: [],
    }));

    return {
      id,
      figmaFileName,
      components,
      cssStyles,
      designTokens: this.tokenBinder.generateBindingsReport(cssStyles),
      fullHtml: html,
      fullCss,
      generatedAt: Date.now(),
    };
  }

  /**
   * Export the generated code to disk.
   */
  exportToDisk(result: FigmaCodeGenerationResult, outputDir: string): { htmlPath: string; cssPath: string } {
    if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true });

    const htmlPath = join(outputDir, 'index.html');
    const cssPath = join(outputDir, 'styles.css');

    const fullPage = [
      '<!DOCTYPE html>',
      '<html lang="en">',
      '<head>',
      '  <meta charset="UTF-8" />',
      '  <meta name="viewport" content="width=device-width, initial-scale=1.0" />',
      `  <title>${result.figmaFileName}</title>`,
      '  <link rel="stylesheet" href="styles.css" />',
      '</head>',
      '<body>',
      result.fullHtml,
      '</body>',
      '</html>',
    ].join('\n');

    writeFileSync(htmlPath, fullPage);
    writeFileSync(cssPath, result.fullCss);

    return { htmlPath, cssPath };
  }

  /**
   * Start a live preview overlay comparing rendered code vs Figma frame.
   */
  async startPreview(
    result: FigmaCodeGenerationResult,
    outputDir: string,
    figmaFrameUrl: string,
    port = 3000,
  ): Promise<LivePreviewOverlay> {
    // Export first
    this.exportToDisk(result, outputDir);

    const overlay = new LivePreviewOverlay({
      figmaFrameUrl,
      renderedCodeDir: outputDir,
      port,
      opacity: 0.5,
      sideBySide: false,
    });

    await overlay.start();
    return overlay;
  }
}

// ---------------------------------------------------------------------------
// Convenience exports
// ---------------------------------------------------------------------------

export function quickGenerateFromNode(
  node: FigmaNode,
  fileName: string,
): FigmaCodeGenerationResult {
  return new FigmaToCodeGenerator().generateFromNodeTree(node, fileName);
}

export function quickGenerateCss(node: FigmaNode): string {
  const translator = new AutoLayoutTranslator();
  const styles = translator.generateSubtreeCss(node, 'root');
  return styles
    .map(s => {
      const props = Object.entries(s.properties)
        .map(([k, v]) => `  ${k}: ${v};`)
        .join('\n');
      return `${s.selector} {\n${props}\n}`;
    })
    .join('\n\n');
}

export function quickExtractTokens(node: FigmaNode): string {
  const binder = new DesignTokenBinder();
  binder.extractFromNodeTree(node);
  return binder.generateCssVariables();
}
