import { dirname, join, parse } from 'node:path';
import { existsSync } from 'node:fs';

export function findUp(filename: string, startDir: string): string | null {
  let dir = startDir;
  const { root } = parse(dir);

  while (true) {
    const candidate = join(dir, filename);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir || dir === root) return null;
    dir = parent;
  }
}
