import { join } from 'node:path';
import { existsSync } from 'node:fs';

export interface FormatterInfo {
  name: string;
  command: string;
  args: string[];
}

interface FormatterRule {
  files: string[];
  info: FormatterInfo;
}

const rules: FormatterRule[] = [
  {
    files: ['.prettierrc', '.prettierrc.json', '.prettierrc.js', 'prettier.config.js'],
    info: { name: 'prettier', command: 'npx', args: ['prettier', '--write'] },
  },
  {
    files: ['biome.json', 'biome.jsonc'],
    info: { name: 'biome', command: 'npx', args: ['biome', 'format', '--write'] },
  },
  {
    files: ['.clang-format'],
    info: { name: 'clang-format', command: 'clang-format', args: ['-i'] },
  },
  {
    files: ['rustfmt.toml', '.rustfmt.toml'],
    info: { name: 'rustfmt', command: 'rustfmt', args: [] },
  },
];

export function detectFormatter(workDir: string): FormatterInfo | null {
  for (const rule of rules) {
    for (const file of rule.files) {
      if (existsSync(join(workDir, file))) {
        return rule.info;
      }
    }
  }
  return null;
}
