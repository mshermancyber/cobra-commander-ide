// Off-brief / regression guard: given the pre-edit baseline of an existing file
// and its post-edit content, detect functionality that was NET-REMOVED — named
// top-level definitions or large contiguous blocks — so a worker cannot silently
// delete unrelated code its task never asked it to touch.
//
// Deterministic and low-false-positive by design: additions and in-place
// modifications never trip it; only content that is genuinely gone from the file
// (not merely moved or reindented) counts.

const BLOCK_MIN_LINES = 15; // a removed block trips only when > this many substantive lines vanish

export interface Removal {
  id: string;
  kind: 'definition' | 'block';
  name?: string;
  lines: number;
  /** the removed content — used for task-reference and justification checks */
  text: string;
  /** human-readable description for the corrective message */
  label: string;
}

const DEF_PATTERNS: RegExp[] = [
  /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/,                       // python def
  /^\s*(?:export\s+(?:default\s+)?)?class\s+([A-Za-z_]\w*)/,     // class (py/ts)
  /^\s*export\s+(?:async\s+)?function\s+([A-Za-z_]\w*)/,         // export function
  /^\s*(?:async\s+)?function\s+([A-Za-z_]\w*)/,                  // function
  /^\s*export\s+const\s+([A-Za-z_]\w*)\s*=/,                     // export const NAME =
  /^\s*const\s+([A-Za-z_]\w*)\s*=\s*(?:async\s*)?(?:\(|function)/, // const NAME = (arrow|function)
  /^\s*export\s+(?:interface|type|enum)\s+([A-Za-z_]\w*)/,       // export interface/type/enum
];

function extractDefs(content: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const line of content.split('\n')) {
    for (const re of DEF_PATTERNS) {
      const m = re.exec(line);
      if (m && m[1]) {
        counts.set(m[1], (counts.get(m[1]) || 0) + 1);
        break;
      }
    }
  }
  return counts;
}

function substantive(line: string): boolean {
  const t = line.trim();
  if (t.length === 0) return false;
  if (/^[)\]}{(,;]+$/.test(t)) return false;
  if (t.startsWith('//') || t.startsWith('#') || t.startsWith('*') || t.startsWith('/*')) return false;
  return true;
}

function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

type DiffOp = { op: 'same' | 'del' | 'add'; line: string };

function fallbackOps(before: string[], after: string[]): DiffOp[] {
  const counts = new Map<string, number>();
  for (const l of after) counts.set(l, (counts.get(l) || 0) + 1);
  const ops: DiffOp[] = [];
  for (const l of before) {
    const c = counts.get(l) || 0;
    if (c > 0) { counts.set(l, c - 1); ops.push({ op: 'same', line: l }); }
    else ops.push({ op: 'del', line: l });
  }
  return ops;
}

function diffOps(before: string[], after: string[]): DiffOp[] {
  const n = before.length, m = after.length;
  if (n === 0 || m === 0 || n * m > 4_000_000) return fallbackOps(before, after);

  // LCS length table, then backtrack into an edit script.
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = before[i] === after[j]
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops: DiffOp[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (before[i] === after[j]) { ops.push({ op: 'same', line: before[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push({ op: 'del', line: before[i] }); i++; }
    else { ops.push({ op: 'add', line: after[j] }); j++; }
  }
  while (i < n) { ops.push({ op: 'del', line: before[i] }); i++; }
  while (j < m) { ops.push({ op: 'add', line: after[j] }); j++; }
  return ops;
}

function detectRemovedBlocks(before: string, after: string): Removal[] {
  const afterTrim = new Set<string>();
  for (const l of after.split('\n')) { const t = l.trim(); if (t) afterTrim.add(t); }

  const ops = diffOps(before.split('\n'), after.split('\n'));
  const removals: Removal[] = [];
  let run: string[] = [];

  const flush = () => {
    if (run.length) {
      // Count only lines that are genuinely gone (not present elsewhere in the
      // new file even after reindent/reformat) so moves/reformatting don't trip.
      const gone = run.filter(l => substantive(l) && !afterTrim.has(l.trim()));
      if (gone.length > BLOCK_MIN_LINES) {
        removals.push({
          id: 'block:' + hash(gone.map(l => l.trim()).join('\n')),
          kind: 'block',
          lines: gone.length,
          text: gone.join('\n'),
          label: `a ${gone.length}-line block ("${gone[0].trim().slice(0, 60)}"…)`,
        });
      }
    }
    run = [];
  };

  for (const op of ops) {
    if (op.op === 'del') run.push(op.line);
    else flush();
  }
  flush();
  return removals;
}

/** Everything net-removed going from `before` to `after`: named defs + large blocks. */
export function detectRemovals(before: string, after: string): Removal[] {
  const removals: Removal[] = [];
  const beforeDefs = extractDefs(before);
  const afterDefs = extractDefs(after);
  for (const [name, cnt] of beforeDefs) {
    if (cnt > 0 && (afterDefs.get(name) || 0) === 0) {
      removals.push({
        id: 'def:' + name,
        kind: 'definition',
        name,
        lines: 1,
        text: name,
        label: `the definition \`${name}\``,
      });
    }
  }
  for (const b of detectRemovedBlocks(before, after)) removals.push(b);
  return removals;
}

const STOPWORDS = new Set([
  'return', 'const', 'function', 'value', 'self', 'none', 'true', 'false', 'import',
  'export', 'from', 'this', 'that', 'with', 'then', 'else', 'elif', 'print', 'async',
  'await', 'class', 'void', 'type', 'interface', 'string', 'number', 'boolean',
  'length', 'result', 'error', 'throw', 'catch', 'continue', 'break', 'default',
  'public', 'private', 'static', 'while', 'yield', 'super', 'params', 'args',
]);

function distinctiveTokens(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const re = /[a-z_][a-z0-9_]{3,}/g;
  const lower = text.toLowerCase();
  let m: RegExpExecArray | null;
  while ((m = re.exec(lower)) !== null) {
    const t = m[0];
    if (STOPWORDS.has(t) || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= 40) break;
  }
  return out;
}

/**
 * True when the removal is NOT plausibly referenced by the task — i.e. off-brief.
 * A named def is referenced when the task names it. A block is referenced when the
 * task mentions two or more of its distinctive identifiers.
 */
export function isOffBrief(removal: Removal, taskText: string): boolean {
  const task = taskText.toLowerCase();
  if (removal.kind === 'definition' && removal.name) {
    return !task.includes(removal.name.toLowerCase());
  }
  let hits = 0;
  for (const t of distinctiveTokens(removal.text)) {
    if (task.includes(t) && ++hits >= 2) return false;
  }
  return true;
}

const JUSTIFY_VERB = /\b(remov\w*|delet\w*|dropp?\w*|replac\w*|deprecat\w*|obsolet\w*|unused|no longer|consolidat\w*|merg\w*|refactor\w*)\b/;

/**
 * True when the worker's own rationale (its assistant message accompanying the
 * edit) explicitly justifies this removal: a removal verb plus a concrete
 * reference to what is being removed. Lets a documented refactor through while a
 * silent deletion (the incident class) still trips.
 */
export function isJustified(removal: Removal, rationale: string): boolean {
  if (!rationale) return false;
  const r = rationale.toLowerCase();
  if (!JUSTIFY_VERB.test(r)) return false;
  if (removal.kind === 'definition' && removal.name) {
    return r.includes(removal.name.toLowerCase());
  }
  let hits = 0;
  for (const t of distinctiveTokens(removal.text)) {
    if (r.includes(t) && ++hits >= 2) return true;
  }
  return false;
}
