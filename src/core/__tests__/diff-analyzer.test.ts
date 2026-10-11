import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { parseDiff } from '../diff-analyzer.js';

describe('parseDiff', () => {
  it('extracts file names from unified diff', () => {
    const diff = `diff --git a/src/test.ts b/src/test.ts
index abc..def 100644
--- a/src/test.ts
+++ b/src/test.ts
@@ -1,3 +1,4 @@
 line1
-line2
+line2 modified
+line3
 line4`;
    const chunks = parseDiff(diff);
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0].file, 'src/test.ts');
  });

  it('identifies new files', () => {
    const diff = `diff --git a/newfile.ts b/newfile.ts
new file mode 100644
index 000..abc
--- /dev/null
+++ b/newfile.ts
@@ -0,0 +1,3 @@
+line1
+line2
+line3`;
    const chunks = parseDiff(diff);
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0].isNew, true);
    assert.equal(chunks[0].file, 'newfile.ts');
  });

  it('identifies deleted files', () => {
    const diff = `diff --git a/oldfile.ts b/oldfile.ts
deleted file mode 100644
index abc..000
--- a/oldfile.ts
+++ /dev/null
@@ -1,3 +0,0 @@
-line1
-line2
-line3`;
    const chunks = parseDiff(diff);
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0].isDeleted, true);
    assert.equal(chunks[0].file, 'oldfile.ts');
  });

  it('extracts hunk line numbers', () => {
    const diff = `diff --git a/src/test.ts b/src/test.ts
--- a/src/test.ts
+++ b/src/test.ts
@@ -10,4 +10,5 @@
 context
-changed
+new
 more`;
    const chunks = parseDiff(diff);
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0].hunks.length, 1);
    assert.equal(chunks[0].hunks[0].oldStart, 10);
    assert.equal(chunks[0].hunks[0].newStart, 10);
  });

  it('returns empty array for empty input', () => {
    assert.equal(parseDiff('').length, 0);
    assert.equal(parseDiff(null as unknown as string).length, 0);
  });
});
