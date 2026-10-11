import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { installRoot } from './env-file.js';

const CONTENT_DIR = join(installRoot(), 'content');
const CSV_PATH = join(CONTENT_DIR, 'projects.csv');

export interface ProjectEntry {
  projectName: string;
  folderPath: string;
  contentFolder: string;
}

const ALIASES: Record<string, string> = {
  'sbom-visualizer': 'sbom-visualizer',
  'cobra-commander': 'multi-ide',
  'cobra commander': 'multi-ide',
  'cc': 'multi-ide',
  'cobra-commander-mobile': 'cobra-commander-mobile',
  'cc-mobile': 'cobra-commander-mobile',
};

function ensureContentDir(): void {
  if (!existsSync(CONTENT_DIR)) {
    mkdirSync(CONTENT_DIR, { recursive: true });
  }
}

function parseCSV(content: string): ProjectEntry[] {
  const lines = content.trim().split('\n');
  if (lines.length < 2) return [];
  return lines.slice(1)
    .filter(line => line.trim().length > 0)
    .map(line => {
      const [projectName, folderPath, contentFolder] = line.split(',').map(s => s.trim());
      return { projectName, folderPath, contentFolder };
    })
    .filter(e => e.projectName && e.folderPath && e.contentFolder);
}

function serializeCSV(entries: ProjectEntry[]): string {
  const header = 'project_name,folder_path,content_folder';
  const rows = entries.map(e => `${e.projectName},${e.folderPath},${e.contentFolder}`);
  return [header, ...rows].join('\n') + '\n';
}

export function listProjects(): ProjectEntry[] {
  if (!existsSync(CSV_PATH)) return [];
  try {
    return parseCSV(readFileSync(CSV_PATH, 'utf-8'));
  } catch {
    return [];
  }
}

export function getProjectProfile(projectName: string): string | null {
  const entry = findProject(projectName);
  if (!entry) return null;
  const profilePath = join(CONTENT_DIR, entry.contentFolder, 'profile.md');
  if (!existsSync(profilePath)) return null;
  try {
    return readFileSync(profilePath, 'utf-8');
  } catch {
    return null;
  }
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/[-_\s]+/g, '');
}

export function findProject(query: string, opts?: { strict?: boolean }): ProjectEntry | null {
  const projects = listProjects();
  const norm = normalize(query);

  const aliasTarget = ALIASES[query.toLowerCase()] || ALIASES[norm];
  if (aliasTarget) {
    const byAlias = projects.find(p => normalize(p.projectName) === normalize(aliasTarget));
    if (byAlias) return byAlias;
  }

  const exact = projects.find(p => normalize(p.projectName) === norm);
  if (exact) return exact;

  const contentMatch = projects.find(p => normalize(p.contentFolder) === norm);
  if (contentMatch) return contentMatch;

  const folderMatch = projects.find(p => {
    const folderName = p.folderPath.split('/').filter(Boolean).pop() || '';
    return normalize(folderName) === norm;
  });
  if (folderMatch) return folderMatch;

  // Loose substring fallback. This is what causes false enhancement detection
  // when scanning individual prompt words: "attack" (from "MITRE ATT&CK")
  // substring-matches a longer project slug (e.g. "graph" matching
  // "attack-path-graph"). Callers that scan single prompt words MUST
  // pass { strict: true } so an incidental word can't hijack the match.
  if (opts?.strict) return null;

  const partial = projects.find(p =>
    normalize(p.projectName).includes(norm) || norm.includes(normalize(p.projectName))
  );
  if (partial) return partial;

  return null;
}

export function registerProject(entry: { projectName: string; folderPath: string; profile: string }): void {
  ensureContentDir();
  const contentFolder = entry.projectName.toLowerCase().replace(/\s+/g, '-');
  const projects = listProjects();

  const existing = projects.find(p => normalize(p.projectName) === normalize(entry.projectName));
  if (!existing) {
    projects.push({
      projectName: entry.projectName,
      folderPath: entry.folderPath,
      contentFolder,
    });
    writeFileSync(CSV_PATH, serializeCSV(projects), 'utf-8');
  }

  const folderPath = join(CONTENT_DIR, contentFolder);
  if (!existsSync(folderPath)) {
    mkdirSync(folderPath, { recursive: true });
  }

  writeFileSync(join(folderPath, 'profile.md'), entry.profile, 'utf-8');
}

export function updateProjectProfile(projectName: string, profile: string): boolean {
  const entry = findProject(projectName);
  if (!entry) return false;

  const profilePath = join(CONTENT_DIR, entry.contentFolder, 'profile.md');
  const folderPath = join(CONTENT_DIR, entry.contentFolder);
  if (!existsSync(folderPath)) {
    mkdirSync(folderPath, { recursive: true });
  }

  writeFileSync(profilePath, profile, 'utf-8');
  return true;
}

export function getProjectsSummary(): string {
  const projects = listProjects();
  if (projects.length === 0) return 'No known projects.';
  const header = 'project_name,folder_path,content_folder';
  const rows = projects.map(p => `${p.projectName},${p.folderPath},${p.contentFolder}`);
  return [header, ...rows].join('\n');
}
