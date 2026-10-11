import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, basename } from 'node:path';

export interface Rule {
  name: string;
  glob?: string;
  content: string;
  alwaysApply: boolean;
}

function simpleGlobMatch(pattern: string, path: string): boolean {
  // Convert glob pattern to regex
  const regexStr = pattern
    .replace(/\./g, '\\.')
    .replace(/\*\*/g, '{{GLOBSTAR}}')
    .replace(/\*/g, '[^/]*')
    .replace(/{{GLOBSTAR}}/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${regexStr}$`).test(path);
}

/**
 * Parse a rule file. Rules are markdown files with optional YAML-like frontmatter:
 * ---
 * glob: "src/api/**"
 * alwaysApply: false
 * ---
 * Rule content here...
 */
function parseRuleFile(filePath: string): Rule | null {
  try {
    const raw = readFileSync(filePath, 'utf-8');
    const name = basename(filePath, '.md');
    let glob: string | undefined;
    let alwaysApply = false;
    let content = raw;

    // Parse frontmatter
    if (raw.startsWith('---')) {
      const endIdx = raw.indexOf('---', 3);
      if (endIdx > 0) {
        const frontmatter = raw.slice(3, endIdx).trim();
        content = raw.slice(endIdx + 3).trim();

        for (const line of frontmatter.split('\n')) {
          const [key, ...valParts] = line.split(':');
          const val = valParts.join(':').trim().replace(/^["']|["']$/g, '');
          if (key.trim() === 'glob') glob = val;
          if (key.trim() === 'alwaysApply') alwaysApply = val === 'true';
        }
      }
    }

    return { name, glob, content, alwaysApply };
  } catch {
    return null;
  }
}

export function loadRules(workDir: string): Rule[] {
  const rulesDir = join(workDir, '.cobra-commander', 'rules');
  if (!existsSync(rulesDir)) return [];

  return readdirSync(rulesDir)
    .filter(f => f.endsWith('.md'))
    .map(f => parseRuleFile(join(rulesDir, f)))
    .filter((r): r is Rule => r !== null);
}

/**
 * Get rules that apply to a given task based on file paths mentioned in it.
 * Always-apply rules are always included.
 * Glob-matched rules are included if any mentioned file matches the glob.
 */
export function getApplicableRules(rules: Rule[], taskText: string, workDir: string): Rule[] {
  const applicable: Rule[] = [];

  // Extract file paths from the task text
  const pathPattern = /(?:^|\s|["'`])((?:src|lib|test|tests|app|pages|components|api|config|scripts)\/[\w.\/-]+)/g;
  const mentionedPaths: string[] = [];
  let match;
  while ((match = pathPattern.exec(taskText)) !== null) {
    mentionedPaths.push(match[1]);
  }

  for (const rule of rules) {
    if (rule.alwaysApply) {
      applicable.push(rule);
      continue;
    }

    if (rule.glob && mentionedPaths.length > 0) {
      for (const p of mentionedPaths) {
        if (simpleGlobMatch(rule.glob, p)) {
          applicable.push(rule);
          break;
        }
      }
    }
  }

  return applicable;
}

export function formatRulesForPrompt(rules: Rule[]): string {
  if (rules.length === 0) return '';
  const parts = rules.map(r => `### Rule: ${r.name}${r.glob ? ` (applies to: ${r.glob})` : ''}
${r.content}`);
  return '\n\n## Project Rules\n\n' + parts.join('\n\n');
}
