import { sep, extname } from 'node:path';

export const IGNORE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', '.nuxt',
  'coverage', '.nyc_output', '__pycache__', '.tox', 'target',
  'vendor', '.cache', '.turbo', '.parcel-cache',
]);

export const IGNORE_EXTENSIONS = new Set([
  '.log', '.lock', '.map', '.min.js', '.min.css', '.chunk.js', '.d.ts',
]);

export function shouldIgnore(filePath: string): boolean {
  const segments = filePath.split(sep === '\\' ? /[\\/]/ : '/');

  for (const segment of segments) {
    if (IGNORE_DIRS.has(segment)) {
      return true;
    }
  }

  const ext = extname(filePath);
  if (IGNORE_EXTENSIONS.has(ext)) {
    return true;
  }

  // Handle compound extensions like .min.js, .min.css, .chunk.js, .d.ts
  const base = filePath.toLowerCase();
  if (base.endsWith('.min.js') || base.endsWith('.min.css') ||
      base.endsWith('.chunk.js') || base.endsWith('.d.ts')) {
    return true;
  }

  return false;
}
