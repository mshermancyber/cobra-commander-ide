import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PRInfo {
  title: string;
  body: string;
  branch: string;
  baseBranch: string;
  files: string[];
  additions: number;
  deletions: number;
}

export interface GitHubConfig {
  token?: string;
  owner?: string;
  repo?: string;
  baseUrl?: string; // for GitHub Enterprise, default: https://api.github.com
}

export interface GitHubIssue {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  assignees: string[];
  createdAt: string;
  updatedAt: string;
  htmlUrl: string;
}

export interface GitHubPR {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed' | 'merged';
  headBranch: string;
  baseBranch: string;
  author: string;
  createdAt: string;
  updatedAt: string;
  htmlUrl: string;
  draft: boolean;
}

export interface ReviewComment {
  path: string;
  line: number;
  body: string;
  side?: 'LEFT' | 'RIGHT';
  startLine?: number;
}

export interface GitHubCheckRun {
  name: string;
  status: 'queued' | 'in_progress' | 'completed';
  conclusion?: 'success' | 'failure' | 'neutral' | 'cancelled' | 'skipped' | 'timed_out';
  output?: {
    title: string;
    summary: string;
    text?: string;
  };
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

let defaultConfig: GitHubConfig = {};

export function setGitHubConfig(config: GitHubConfig): void {
  defaultConfig = { ...defaultConfig, ...config };
}

export function getGitHubConfig(): GitHubConfig {
  return { ...defaultConfig };
}

// ---------------------------------------------------------------------------
// Auth resolution
// ---------------------------------------------------------------------------

function resolveToken(config?: GitHubConfig): string | null {
  const token = config?.token || defaultConfig.token || process.env.GITHUB_TOKEN || process.env.GH_TOKEN || null;
  return token;
}

function resolveRepo(config?: GitHubConfig): { owner: string; repo: string } | null {
  const owner = config?.owner || defaultConfig.owner;
  const repo = config?.repo || defaultConfig.repo;

  if (owner && repo) {
    return { owner, repo };
  }

  // Try to detect from git remote
  try {
    const remote = execSync('git remote get-url origin 2>/dev/null', {
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();
    const match = remote.match(/[:/]([^/]+)\/([^/]+?)(?:\.git)?$/);
    if (match) {
      return { owner: match[1], repo: match[2] };
    }
  } catch {
    // not a git repo
  }

  return null;
}

function resolveBaseUrl(config?: GitHubConfig): string {
  return config?.baseUrl || defaultConfig.baseUrl || 'https://api.github.com';
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

async function githubFetch(
  path: string,
  config?: GitHubConfig,
  options: RequestInit = {},
): Promise<{ ok: boolean; status: number; data: unknown; headers: Headers }> {
  const token = resolveToken(config);
  const baseUrl = resolveBaseUrl(config);
  const url = `${baseUrl}${path}`;

  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
    'User-Agent': 'cobra-commander',
    ...(options.headers as Record<string, string>),
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const resp = await fetch(url, {
    ...options,
    headers,
    signal: AbortSignal.timeout(30000),
  });

  let data: unknown = null;
  const contentType = resp.headers.get('content-type') || '';
  if (contentType.includes('json')) {
    data = await resp.json();
  } else {
    data = await resp.text();
  }

  return { ok: resp.ok, status: resp.status, data, headers: resp.headers };
}

// ---------------------------------------------------------------------------
// Issues
// ---------------------------------------------------------------------------

export async function listIssues(
  config?: GitHubConfig,
  options: { state?: 'open' | 'closed' | 'all'; labels?: string[]; assignee?: string; perPage?: number } = {},
): Promise<GitHubIssue[]> {
  const repo = resolveRepo(config);
  if (!repo) return [];

  const params = new URLSearchParams();
  if (options.state) params.set('state', options.state);
  if (options.labels?.length) params.set('labels', options.labels.join(','));
  if (options.assignee) params.set('assignee', options.assignee);
  params.set('per_page', String(options.perPage || 30));

  const result = await githubFetch(
    `/repos/${repo.owner}/${repo.repo}/issues?${params.toString()}`,
    config,
  );

  if (!result.ok) return [];
  const issues = result.data as Array<Record<string, unknown>>;

  return issues.map((i) => ({
    number: i.number as number,
    title: i.title as string,
    body: (i.body as string) || '',
    state: (i.state as 'open' | 'closed') || 'open',
    labels: ((i.labels as Array<{ name: string }>) || []).map((l) => l.name),
    assignees: ((i.assignees as Array<{ login: string }>) || []).map((a) => a.login),
    createdAt: i.created_at as string,
    updatedAt: i.updated_at as string,
    htmlUrl: i.html_url as string,
  }));
}

export async function createIssue(
  title: string,
  body: string,
  config?: GitHubConfig,
  options: { labels?: string[]; assignees?: string[]; milestone?: number } = {},
): Promise<{ success: boolean; issue?: GitHubIssue; error?: string }> {
  const repo = resolveRepo(config);
  if (!repo) return { success: false, error: 'Could not resolve repository' };

  const result = await githubFetch(`/repos/${repo.owner}/${repo.repo}/issues`, config, {
    method: 'POST',
    body: JSON.stringify({
      title,
      body,
      labels: options.labels || [],
      assignees: options.assignees || [],
      milestone: options.milestone || null,
    }),
  });

  if (!result.ok) {
    return { success: false, error: `HTTP ${result.status}: ${JSON.stringify(result.data)}` };
  }

  const i = result.data as Record<string, unknown>;
  return {
    success: true,
    issue: {
      number: i.number as number,
      title: i.title as string,
      body: (i.body as string) || '',
      state: (i.state as 'open' | 'closed') || 'open',
      labels: ((i.labels as Array<{ name: string }>) || []).map((l) => l.name),
      assignees: ((i.assignees as Array<{ login: string }>) || []).map((a) => a.login),
      createdAt: i.created_at as string,
      updatedAt: i.updated_at as string,
      htmlUrl: i.html_url as string,
    },
  };
}

export async function closeIssue(
  issueNumber: number,
  config?: GitHubConfig,
): Promise<{ success: boolean; error?: string }> {
  const repo = resolveRepo(config);
  if (!repo) return { success: false, error: 'Could not resolve repository' };

  const result = await githubFetch(
    `/repos/${repo.owner}/${repo.repo}/issues/${issueNumber}`,
    config,
    {
      method: 'PATCH',
      body: JSON.stringify({ state: 'closed' }),
    },
  );

  return { success: result.ok, error: result.ok ? undefined : `HTTP ${result.status}` };
}

// ---------------------------------------------------------------------------
// Pull Requests
// ---------------------------------------------------------------------------

export async function listPRs(
  config?: GitHubConfig,
  options: { state?: 'open' | 'closed' | 'all'; perPage?: number } = {},
): Promise<GitHubPR[]> {
  const repo = resolveRepo(config);
  if (!repo) return [];

  const params = new URLSearchParams();
  if (options.state) params.set('state', options.state);
  params.set('per_page', String(options.perPage || 30));

  const result = await githubFetch(
    `/repos/${repo.owner}/${repo.repo}/pulls?${params.toString()}`,
    config,
  );

  if (!result.ok) return [];
  const prs = result.data as Array<Record<string, unknown>>;

  return prs.map((p) => ({
    number: p.number as number,
    title: p.title as string,
    body: (p.body as string) || '',
    state: (p.state as 'open' | 'closed' | 'merged') || 'open',
    headBranch: (p.head as Record<string, unknown>).ref as string,
    baseBranch: (p.base as Record<string, unknown>).ref as string,
    author: ((p.user as Record<string, unknown>)?.login as string) || '',
    createdAt: p.created_at as string,
    updatedAt: p.updated_at as string,
    htmlUrl: p.html_url as string,
    draft: (p.draft as boolean) || false,
  }));
}

export async function createPR(
  title: string,
  headBranch: string,
  baseBranch: string,
  body: string,
  config?: GitHubConfig,
  options: { draft?: boolean } = {},
): Promise<{ success: boolean; pr?: GitHubPR; error?: string }> {
  const repo = resolveRepo(config);
  if (!repo) return { success: false, error: 'Could not resolve repository' };

  const result = await githubFetch(`/repos/${repo.owner}/${repo.repo}/pulls`, config, {
    method: 'POST',
    body: JSON.stringify({
      title,
      head: headBranch,
      base: baseBranch,
      body,
      draft: options.draft || false,
    }),
  });

  if (!result.ok) {
    return { success: false, error: `HTTP ${result.status}: ${JSON.stringify(result.data)}` };
  }

  const p = result.data as Record<string, unknown>;
  return {
    success: true,
    pr: {
      number: p.number as number,
      title: p.title as string,
      body: (p.body as string) || '',
      state: (p.state as 'open' | 'closed' | 'merged') || 'open',
      headBranch: (p.head as Record<string, unknown>).ref as string,
      baseBranch: (p.base as Record<string, unknown>).ref as string,
      author: ((p.user as Record<string, unknown>)?.login as string) || '',
      createdAt: p.created_at as string,
      updatedAt: p.updated_at as string,
      htmlUrl: p.html_url as string,
      draft: (p.draft as boolean) || false,
    },
  };
}

// ---------------------------------------------------------------------------
// Review Comments
// ---------------------------------------------------------------------------

export async function postReviewComments(
  prNumber: number,
  comments: ReviewComment[],
  config?: GitHubConfig,
  bodyComment?: string,
): Promise<{ success: boolean; reviewId?: number; error?: string }> {
  const repo = resolveRepo(config);
  if (!repo) return { success: false, error: 'Could not resolve repository' };

  const result = await githubFetch(
    `/repos/${repo.owner}/${repo.repo}/pulls/${prNumber}/reviews`,
    config,
    {
      method: 'POST',
      body: JSON.stringify({
        body: bodyComment || 'Automated review by Cobra Commander',
        event: 'COMMENT',
        comments: comments.map((c) => ({
          path: c.path,
          line: c.line,
          side: c.side || 'RIGHT',
          start_line: c.startLine,
          body: c.body,
        })),
      }),
    },
  );

  if (!result.ok) {
    return { success: false, error: `HTTP ${result.status}: ${JSON.stringify(result.data)}` };
  }

  const review = result.data as Record<string, unknown>;
  return { success: true, reviewId: review.id as number };
}

export async function postSingleReviewComment(
  prNumber: number,
  comment: ReviewComment,
  config?: GitHubConfig,
): Promise<{ success: boolean; error?: string }> {
  return postReviewComments(prNumber, [comment], config);
}

// Format a review comment
export function formatReviewComment(
  file: string,
  line: number,
  comment: string,
  severity: 'info' | 'warning' | 'error',
): string {
  const icons: Record<string, string> = { info: 'ℹ️', warning: '⚠️', error: '🔴' };
  return `${icons[severity] || ''} **${file}:${line}**\n\n${comment}`;
}

// ---------------------------------------------------------------------------
// GitHub Actions
// ---------------------------------------------------------------------------

export async function triggerWorkflow(
  workflowFileName: string,
  ref: string,
  config?: GitHubConfig,
  inputs: Record<string, string> = {},
): Promise<{ success: boolean; error?: string }> {
  const repo = resolveRepo(config);
  if (!repo) return { success: false, error: 'Could not resolve repository' };

  const result = await githubFetch(
    `/repos/${repo.owner}/${repo.repo}/actions/workflows/${workflowFileName}/dispatches`,
    config,
    {
      method: 'POST',
      body: JSON.stringify({ ref, inputs }),
    },
  );

  return { success: result.ok, error: result.ok ? undefined : `HTTP ${result.status}` };
}

export async function listWorkflowRuns(
  config?: GitHubConfig,
  options: { branch?: string; status?: string; perPage?: number } = {},
): Promise<Array<Record<string, unknown>>> {
  const repo = resolveRepo(config);
  if (!repo) return [];

  const params = new URLSearchParams();
  if (options.branch) params.set('branch', options.branch);
  if (options.status) params.set('status', options.status);
  params.set('per_page', String(options.perPage || 20));

  const result = await githubFetch(
    `/repos/${repo.owner}/${repo.repo}/actions/runs?${params.toString()}`,
    config,
  );

  if (!result.ok) return [];
  const data = result.data as { workflow_runs?: Array<Record<string, unknown>> };
  return data.workflow_runs || [];
}

// ---------------------------------------------------------------------------
// Check Runs
// ---------------------------------------------------------------------------

export async function createCheckRun(
  check: GitHubCheckRun,
  headSha: string,
  config?: GitHubConfig,
): Promise<{ success: boolean; checkRunId?: number; error?: string }> {
  const repo = resolveRepo(config);
  if (!repo) return { success: false, error: 'Could not resolve repository' };

  const result = await githubFetch(
    `/repos/${repo.owner}/${repo.repo}/check-runs`,
    config,
    {
      method: 'POST',
      body: JSON.stringify({
        name: check.name,
        head_sha: headSha,
        status: check.status,
        conclusion: check.conclusion,
        output: check.output,
      }),
    },
  );

  if (!result.ok) {
    return { success: false, error: `HTTP ${result.status}: ${JSON.stringify(result.data)}` };
  }

  const data = result.data as Record<string, unknown>;
  return { success: true, checkRunId: data.id as number };
}

// ---------------------------------------------------------------------------
// Link issues to PRs
// ---------------------------------------------------------------------------

export function buildClosingKeyword(issueNumber: number): string {
  return `Closes #${issueNumber}`;
}

export function buildLinkingBody(prBody: string, issues: number[]): string {
  const closing = issues.map((n) => `Closes #${n}`).join('\n');
  return `${prBody}\n\n${closing}`;
}

// ---------------------------------------------------------------------------
// Git-based helpers (keep existing functionality)
// ---------------------------------------------------------------------------

// Generate PR description from git diff
export function generatePRDescription(workDir: string, baseBranch: string = 'main'): PRInfo {
  const branch = execSync('git rev-parse --abbrev-ref HEAD', {
    cwd: workDir,
    encoding: 'utf-8',
  }).trim();
  const diffStat = execSync(`git diff --stat ${baseBranch}...HEAD`, {
    cwd: workDir,
    encoding: 'utf-8',
  }).trim();
  const commitLog = execSync(`git log --oneline ${baseBranch}...HEAD`, {
    cwd: workDir,
    encoding: 'utf-8',
  }).trim();
  const diffNumstat = execSync(`git diff --numstat ${baseBranch}...HEAD`, {
    cwd: workDir,
    encoding: 'utf-8',
  }).trim();

  const files: string[] = [];
  let additions = 0;
  let deletions = 0;

  for (const line of diffNumstat.split('\n').filter(Boolean)) {
    const [add, del, file] = line.split('\t');
    files.push(file);
    additions += parseInt(add) || 0;
    deletions += parseInt(del) || 0;
  }

  const commits = commitLog.split('\n').filter(Boolean);
  const title =
    commits.length === 1
      ? commits[0].split(' ').slice(1).join(' ')
      : `${branch}: ${commits.length} commits`;

  const body = `## Summary\n\n${commits.map((c) => `- ${c}`).join('\n')}\n\n## Changes\n\n${diffStat}\n\n**${additions} additions, ${deletions} deletions across ${files.length} files**`;

  return { title, body, branch, baseBranch, files, additions, deletions };
}

// Get list of changed files between branches
export function getChangedFiles(workDir: string, baseBranch: string = 'main'): string[] {
  try {
    const output = execSync(`git diff --name-only ${baseBranch}...HEAD`, {
      cwd: workDir,
      encoding: 'utf-8',
    }).trim();
    return output ? output.split('\n') : [];
  } catch {
    return [];
  }
}

// Get commit messages for changelog
export function getCommitMessages(
  workDir: string,
  since?: string,
): Array<{ hash: string; message: string; author: string; date: string }> {
  try {
    const sinceFlag = since ? `--since="${since}"` : '-50';
    const format = '%H|%s|%an|%ai';
    const log = execSync(`git log ${sinceFlag} --format="${format}"`, {
      cwd: workDir,
      encoding: 'utf-8',
    }).trim();
    return log.split('\n').filter(Boolean).map((line) => {
      const [hash, message, author, date] = line.split('|');
      return { hash, message, author, date };
    });
  } catch {
    return [];
  }
}

// Push branch to remote
export function pushBranch(workDir: string, branch: string, remote: string = 'origin'): boolean {
  try {
    execSync(`git push -u ${remote} ${branch}`, { cwd: workDir, encoding: 'utf-8', timeout: 30000 });
    return true;
  } catch {
    return false;
  }
}

// Get current branch name
export function getCurrentBranch(workDir: string): string {
  try {
    return execSync('git rev-parse --abbrev-ref HEAD', {
      cwd: workDir,
      encoding: 'utf-8',
    }).trim();
  } catch {
    return 'unknown';
  }
}
