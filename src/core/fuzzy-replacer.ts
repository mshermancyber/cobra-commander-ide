/**
 * Fuzzy string replacement for edit_file fallback.
 *
 * When exact string matching fails, try progressively fuzzier strategies.
 * Each strategy returns the first unique match found, with a safety check
 * that the matched region does not span more than 3x the lines of oldString.
 */

interface FuzzyResult {
  result: string;
  matched: boolean;
  strategy: string;
}

const MAX_LINE_RATIO = 3;
const MAX_CHAR_RATIO = 4;

/**
 * Attempt fuzzy replacement with progressively relaxed matching strategies.
 *
 * Strategies (tried in order):
 *   exact               — plain indexOf
 *   trimmed             — trim leading/trailing whitespace from each line
 *   whitespace-normalized — collapse all whitespace runs to single spaces
 *   indentation-flexible — strip all leading whitespace, match, re-indent
 *   line-anchor         — use first/last non-empty lines as anchors
 *
 * Safety: if a fuzzy match spans more than 3x the lines of oldString, reject it.
 */
export function fuzzyReplace(content: string, oldString: string, newString: string): FuzzyResult {
  let r: FuzzyResult;

  r = tryExact(content, oldString, newString);
  if (r.matched) return r;

  r = tryTrimmed(content, oldString, newString);
  if (r.matched) return r;

  r = tryWhitespaceNormalized(content, oldString, newString);
  if (r.matched) return r;

  r = tryIndentationFlexible(content, oldString, newString);
  if (r.matched) return r;

  r = tryLineAnchor(content, oldString, newString);
  if (r.matched) return r;

  r = tryEscapeNormalized(content, oldString, newString);
  if (r.matched) return r;

  r = tryBlockAnchor(content, oldString, newString);
  if (r.matched) return r;

  r = tryContextAware(content, oldString, newString);
  if (r.matched) return r;

  r = tryMultiOccurrence(content, oldString, newString);
  if (r.matched) return r;

  return { result: content, matched: false, strategy: 'none' };
}

// ---------------------------------------------------------------------------
// Strategy implementations
// ---------------------------------------------------------------------------

function tryExact(content: string, oldStr: string, newStr: string): FuzzyResult {
  const idx = content.indexOf(oldStr);
  if (idx === -1) return { result: content, matched: false, strategy: 'exact' };
  // Must be unique
  const count = content.split(oldStr).length - 1;
  if (count !== 1) return { result: content, matched: false, strategy: 'exact' };
  return {
    result: content.slice(0, idx) + newStr + content.slice(idx + oldStr.length),
    matched: true,
    strategy: 'exact',
  };
}

function tryTrimmed(content: string, oldStr: string, newStr: string): FuzzyResult {
  const contentLines = content.split('\n');
  const oldLines = oldStr.split('\n');
  const oldTrimmed = oldLines.map((l) => l.trimEnd());
  const contentTrimmed = contentLines.map((l) => l.trimEnd());

  const matchStart = findSequence(contentTrimmed, oldTrimmed);
  if (matchStart === -1) return { result: content, matched: false, strategy: 'trimmed' };

  const matchEnd = matchStart + oldLines.length;
  const matchedChars = contentLines.slice(matchStart, matchEnd).join('\n').length;
  if (!safetyCheck(oldLines.length, matchEnd - matchStart, oldStr.length, matchedChars)) {
    return { result: content, matched: false, strategy: 'trimmed' };
  }

  // Determine the minimum shared leading whitespace on oldStr lines (for re-indenting newStr)
  const indent = detectSharedIndent(oldLines);

  // Re-indent newStr lines to match the content's indentation at match position
  const contentIndent = detectLineIndent(contentLines[matchStart]);
  const reindentedNew = reindent(newStr, indent, contentIndent);

  const result =
    contentLines.slice(0, matchStart).join('\n') +
    (matchStart > 0 ? '\n' : '') +
    reindentedNew +
    (matchEnd < contentLines.length ? '\n' : '') +
    contentLines.slice(matchEnd).join('\n');

  return { result, matched: true, strategy: 'trimmed' };
}

function tryWhitespaceNormalized(content: string, oldStr: string, newStr: string): FuzzyResult {
  const contentLines = content.split('\n');
  const oldLines = oldStr.split('\n');

  // Normalize: collapse whitespace runs within each line, trim
  const normOld = oldLines.map(normalizeLine);
  const normContent = contentLines.map(normalizeLine);

  const matchStart = findSequence(normContent, normOld);
  if (matchStart === -1) return { result: content, matched: false, strategy: 'whitespace-normalized' };

  const matchEnd = matchStart + oldLines.length;
  const matchedChars = contentLines.slice(matchStart, matchEnd).join('\n').length;
  if (!safetyCheck(oldLines.length, matchEnd - matchStart, oldStr.length, matchedChars)) {
    return { result: content, matched: false, strategy: 'whitespace-normalized' };
  }

  const indent = detectSharedIndent(oldLines);
  const contentIndent = detectLineIndent(contentLines[matchStart]);
  const reindentedNew = reindent(newStr, indent, contentIndent);

  const result =
    contentLines.slice(0, matchStart).join('\n') +
    (matchStart > 0 ? '\n' : '') +
    reindentedNew +
    (matchEnd < contentLines.length ? '\n' : '') +
    contentLines.slice(matchEnd).join('\n');

  return { result, matched: true, strategy: 'whitespace-normalized' };
}

function tryIndentationFlexible(content: string, oldStr: string, newStr: string): FuzzyResult {
  const contentLines = content.split('\n');
  const oldLines = oldStr.split('\n');

  // Strip all leading whitespace
  const oldStripped = oldLines.map((l) => l.replace(/^[ \t]+/, ''));
  const contentStripped = contentLines.map((l) => l.replace(/^[ \t]+/, ''));

  const matchStart = findSequence(contentStripped, oldStripped);
  if (matchStart === -1) return { result: content, matched: false, strategy: 'indentation-flexible' };

  const matchEnd = matchStart + oldLines.length;
  const matchedChars = contentLines.slice(matchStart, matchEnd).join('\n').length;
  if (!safetyCheck(oldLines.length, matchEnd - matchStart, oldStr.length, matchedChars)) {
    return { result: content, matched: false, strategy: 'indentation-flexible' };
  }

  // Use the indentation from the content at the match position
  const contentIndent = detectLineIndent(contentLines[matchStart]);
  const indent = detectSharedIndent(oldLines);
  const reindentedNew = reindent(newStr, indent, contentIndent);

  const result =
    contentLines.slice(0, matchStart).join('\n') +
    (matchStart > 0 ? '\n' : '') +
    reindentedNew +
    (matchEnd < contentLines.length ? '\n' : '') +
    contentLines.slice(matchEnd).join('\n');

  return { result, matched: true, strategy: 'indentation-flexible' };
}

function tryLineAnchor(content: string, oldStr: string, newStr: string): FuzzyResult {
  const contentLines = content.split('\n');
  const oldLines = oldStr.split('\n');

  // Find first and last non-empty (after trimming) lines
  const oldNonEmpty = oldLines.map((l) => l.trim()).filter((l) => l.length > 0);
  if (oldNonEmpty.length === 0) return { result: content, matched: false, strategy: 'line-anchor' };

  const firstAnchor = oldNonEmpty[0];
  const lastAnchor = oldNonEmpty[oldNonEmpty.length - 1];

  // Find all occurrences of first anchor
  const firstCandidates: number[] = [];
  for (let i = 0; i < contentLines.length; i++) {
    if (contentLines[i].trim() === firstAnchor) {
      firstCandidates.push(i);
    }
  }

  if (firstCandidates.length === 0) return { result: content, matched: false, strategy: 'line-anchor' };

  // Find all occurrences of last anchor
  const lastCandidates: number[] = [];
  for (let i = 0; i < contentLines.length; i++) {
    if (contentLines[i].trim() === lastAnchor) {
      lastCandidates.push(i);
    }
  }

  if (lastCandidates.length === 0) return { result: content, matched: false, strategy: 'line-anchor' };

  // Pair them up: find a pair where last > first and the span is reasonable
  const maxSpan = oldLines.length * MAX_LINE_RATIO;
  let bestFirst = -1;
  let bestLast = -1;

  for (const first of firstCandidates) {
    for (const last of lastCandidates) {
      if (last <= first) continue;
      const span = last - first + 1;
      if (span <= maxSpan) {
        // Found a candidate — prefer the smallest span
        if (bestFirst === -1 || span < (bestLast - bestFirst + 1)) {
          bestFirst = first;
          bestLast = last;
        }
      }
    }
  }

  if (bestFirst === -1) return { result: content, matched: false, strategy: 'line-anchor' };

  const matchStart = bestFirst;
  const matchEnd = bestLast + 1;

  const matchedChars = contentLines.slice(matchStart, matchEnd).join('\n').length;
  if (matchedChars > oldStr.length * MAX_CHAR_RATIO) {
    return { result: content, matched: false, strategy: 'line-anchor' };
  }

  // Determine indentation for re-indenting newStr
  const contentIndent = detectLineIndent(contentLines[matchStart]);
  const indent = detectSharedIndent(oldLines);
  const reindentedNew = reindent(newStr, indent, contentIndent);

  const result =
    contentLines.slice(0, matchStart).join('\n') +
    (matchStart > 0 ? '\n' : '') +
    reindentedNew +
    (matchEnd < contentLines.length ? '\n' : '') +
    contentLines.slice(matchEnd).join('\n');

  return { result, matched: true, strategy: 'line-anchor' };
}

function tryEscapeNormalized(content: string, oldStr: string, newStr: string): FuzzyResult {
  const unescape = (s: string) => s.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\r/g, '\r');
  const unescapedOld = unescape(oldStr);
  const unescapedContent = unescape(content);

  const idx = unescapedContent.indexOf(unescapedOld);
  if (idx === -1) return { result: content, matched: false, strategy: 'escape-normalized' };
  const count = unescapedContent.split(unescapedOld).length - 1;
  if (count !== 1) return { result: content, matched: false, strategy: 'escape-normalized' };

  // Map position in unescaped back to original content
  // Find the match in the original content by unescaping and tracking
  const oldLines = oldStr.split('\n');
  const matchedLines = unescapedOld.split('\n').length;
  const matchedChars = unescapedOld.length;
  if (!safetyCheck(oldLines.length, matchedLines, oldStr.length, matchedChars)) {
    return { result: content, matched: false, strategy: 'escape-normalized' };
  }

  // Apply replacement on unescaped content and return
  const result = unescapedContent.slice(0, idx) + newStr + unescapedContent.slice(idx + unescapedOld.length);
  return { result, matched: true, strategy: 'escape-normalized' };
}

function tryBlockAnchor(content: string, oldStr: string, newStr: string): FuzzyResult {
  const contentLines = content.split('\n');
  const oldLines = oldStr.split('\n');

  const oldNonEmpty = oldLines.filter((l) => l.trim().length > 0);
  if (oldNonEmpty.length < 2) return { result: content, matched: false, strategy: 'block-anchor' };

  const firstAnchor = oldNonEmpty[0].trim();
  const lastAnchor = oldNonEmpty[oldNonEmpty.length - 1].trim();

  // Find candidates for first and last anchors
  const firstCandidates: number[] = [];
  const lastCandidates: number[] = [];
  for (let i = 0; i < contentLines.length; i++) {
    if (contentLines[i].trim() === firstAnchor) firstCandidates.push(i);
    if (contentLines[i].trim() === lastAnchor) lastCandidates.push(i);
  }

  if (firstCandidates.length === 0 || lastCandidates.length === 0) {
    return { result: content, matched: false, strategy: 'block-anchor' };
  }

  const maxSpan = oldLines.length * MAX_LINE_RATIO;
  let bestFirst = -1;
  let bestLast = -1;

  for (const first of firstCandidates) {
    for (const last of lastCandidates) {
      if (last <= first) continue;
      const span = last - first + 1;
      if (span > maxSpan) continue;
      // Check similarity of region to oldString
      const regionLines = contentLines.slice(first, last + 1);
      const similarity = lineSimilarity(regionLines, oldLines);
      if (similarity >= 0.6) {
        if (bestFirst === -1 || span < (bestLast - bestFirst + 1)) {
          bestFirst = first;
          bestLast = last;
        }
      }
    }
  }

  if (bestFirst === -1) return { result: content, matched: false, strategy: 'block-anchor' };

  const matchStart = bestFirst;
  const matchEnd = bestLast + 1;
  const matchedChars = contentLines.slice(matchStart, matchEnd).join('\n').length;
  if (!safetyCheck(oldLines.length, matchEnd - matchStart, oldStr.length, matchedChars)) {
    return { result: content, matched: false, strategy: 'block-anchor' };
  }

  const contentIndent = detectLineIndent(contentLines[matchStart]);
  const indent = detectSharedIndent(oldLines);
  const reindentedNew = reindent(newStr, indent, contentIndent);

  const result =
    contentLines.slice(0, matchStart).join('\n') +
    (matchStart > 0 ? '\n' : '') +
    reindentedNew +
    (matchEnd < contentLines.length ? '\n' : '') +
    contentLines.slice(matchEnd).join('\n');

  return { result, matched: true, strategy: 'block-anchor' };
}

function tryContextAware(content: string, oldStr: string, newStr: string): FuzzyResult {
  const contentLines = content.split('\n');
  const oldLines = oldStr.split('\n');

  if (oldLines.length < 4) return { result: content, matched: false, strategy: 'context-aware' };

  const first2 = oldLines.slice(0, 2).map((l) => l.trim());
  const last2 = oldLines.slice(-2).map((l) => l.trim());

  // Find region that starts with lines similar to first2 and ends with lines similar to last2
  let matchStart = -1;
  let matchEnd = -1;

  for (let i = 0; i <= contentLines.length - 4; i++) {
    if (contentLines[i].trim() === first2[0] && contentLines[i + 1].trim() === first2[1]) {
      // Found start anchors, now find end anchors
      const maxEnd = Math.min(i + oldLines.length * MAX_LINE_RATIO, contentLines.length);
      for (let j = i + 3; j < maxEnd; j++) {
        if (contentLines[j].trim() === last2[1] && contentLines[j - 1].trim() === last2[0]) {
          matchStart = i;
          matchEnd = j + 1;
          break;
        }
      }
      if (matchStart !== -1) break;
    }
  }

  if (matchStart === -1) return { result: content, matched: false, strategy: 'context-aware' };

  const matchedChars = contentLines.slice(matchStart, matchEnd).join('\n').length;
  if (!safetyCheck(oldLines.length, matchEnd - matchStart, oldStr.length, matchedChars)) {
    return { result: content, matched: false, strategy: 'context-aware' };
  }

  const contentIndent = detectLineIndent(contentLines[matchStart]);
  const indent = detectSharedIndent(oldLines);
  const reindentedNew = reindent(newStr, indent, contentIndent);

  const result =
    contentLines.slice(0, matchStart).join('\n') +
    (matchStart > 0 ? '\n' : '') +
    reindentedNew +
    (matchEnd < contentLines.length ? '\n' : '') +
    contentLines.slice(matchEnd).join('\n');

  return { result, matched: true, strategy: 'context-aware' };
}

function tryMultiOccurrence(content: string, oldStr: string, newStr: string): FuzzyResult {
  const count = content.split(oldStr).length - 1;
  if (count < 2) return { result: content, matched: false, strategy: 'multi-occurrence' };

  const oldLines = oldStr.split('\n');
  const matchedChars = oldStr.length;
  if (!safetyCheck(oldLines.length, oldLines.length, oldStr.length, matchedChars)) {
    return { result: content, matched: false, strategy: 'multi-occurrence' };
  }

  const result = content.split(oldStr).join(newStr);
  return { result, matched: true, strategy: `multi-occurrence (${count} replacements)` };
}

/**
 * Compare two arrays of lines. Count matching lines (by trimmed equality)
 * and return the ratio of matches to total lines in the longer array.
 */
function lineSimilarity(a: string[], b: string[]): number {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  let matches = 0;
  const minLen = Math.min(a.length, b.length);
  for (let i = 0; i < minLen; i++) {
    if (a[i].trim() === b[i].trim()) matches++;
  }
  return matches / maxLen;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Find a sequence of lines (needle) within another array (haystack).
 * Returns the starting index or -1.
 */
function findSequence(haystack: string[], needle: string[]): number {
  if (needle.length === 0) return -1;
  for (let i = 0; i <= haystack.length - needle.length; i++) {
    let match = true;
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) {
        match = false;
        break;
      }
    }
    if (match) return i;
  }
  return -1;
}

/**
 * Collapse all runs of whitespace (spaces, tabs) within a line to a single space
 * and trim the result. Returns empty string for blank/whitespace-only lines.
 */
function normalizeLine(line: string): string {
  return line.replace(/[ \t]+/g, ' ').trim();
}

/**
 * Detect the shared leading whitespace across all non-empty lines.
 * Returns the shortest leading whitespace string (or '' if none).
 */
function detectSharedIndent(lines: string[]): string {
  let shared: string | null = null;
  for (const line of lines) {
    if (line.trim().length === 0) continue;
    const leading = line.match(/^[ \t]*/)?.[0] || '';
    if (shared === null) {
      shared = leading;
    } else if (leading.length < shared.length) {
      shared = leading;
    }
  }
  return shared || '';
}

/**
 * Detect the leading whitespace (indentation) of a single line.
 */
function detectLineIndent(line: string): string {
  return line.match(/^[ \t]*/)?.[0] || '';
}

/**
 * Re-indent newStr: strip the shared indentation from each line,
 * then apply the target indentation.
 */
function reindent(text: string, oldIndent: string, newIndent: string): string {
  const lines = text.split('\n');
  return lines
    .map((line, i) => {
      if (line.trim().length === 0) {
        // Preserve blank lines but strip trailing whitespace
        return i === lines.length - 1 && line === '' ? '' : '';
      }
      // Strip old indent
      let stripped = line;
      if (oldIndent && line.startsWith(oldIndent)) {
        stripped = line.slice(oldIndent.length);
      } else {
        stripped = line.replace(/^[ \t]+/, '');
      }
      return newIndent + stripped;
    })
    .join('\n');
}

/**
 * Safety check: the matched region must not span more than
 * MAX_LINE_RATIO × the number of lines in oldString, and must not
 * contain more than MAX_CHAR_RATIO × the character count of oldString.
 */
function safetyCheck(oldLineCount: number, matchLineCount: number, oldCharCount?: number, matchCharCount?: number): boolean {
  if (matchLineCount > oldLineCount * MAX_LINE_RATIO) return false;
  if (oldCharCount !== undefined && matchCharCount !== undefined) {
    if (matchCharCount > oldCharCount * MAX_CHAR_RATIO) return false;
  }
  return true;
}
