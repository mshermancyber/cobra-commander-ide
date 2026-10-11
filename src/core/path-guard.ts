import { resolve, normalize } from 'node:path';

export function resolveSafePath(root: string, filePath: string): string {
  const normalizedRoot = normalize(resolve(root));
  const resolved = normalize(resolve(normalizedRoot, filePath));

  if (!resolved.startsWith(normalizedRoot + '/') && resolved !== normalizedRoot) {
    throw new Error(`Path traversal detected: '${filePath}' resolves outside root '${root}'`);
  }

  return resolved;
}
