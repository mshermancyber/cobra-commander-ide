const BOM = '﻿';

export function hasBom(content: string): boolean {
  return content.startsWith(BOM);
}

export function stripBom(content: string): string {
  return hasBom(content) ? content.slice(1) : content;
}

export function addBom(content: string): string {
  return hasBom(content) ? content : BOM + content;
}

export function preserveBom(original: string, modified: string): string {
  return hasBom(original) ? addBom(modified) : stripBom(modified);
}
