export function detectLineEnding(content: string): '\r\n' | '\n' {
  const crlfCount = (content.match(/\r\n/g) || []).length;
  const lfOnly = (content.match(/(?<!\r)\n/g) || []).length;
  return crlfCount > lfOnly ? '\r\n' : '\n';
}

export function normalizeForMatching(content: string): string {
  return content.replace(/\r\n/g, '\n');
}

export function restoreLineEndings(content: string, ending: '\r\n' | '\n'): string {
  const normalized = content.replace(/\r\n/g, '\n');
  if (ending === '\r\n') {
    return normalized.replace(/\n/g, '\r\n');
  }
  return normalized;
}
