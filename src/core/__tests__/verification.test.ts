import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { parseVerificationOutput, formatFixInstructions } from '../verification.js';

describe('parseVerificationOutput', () => {
  it('parses TypeScript errors correctly', () => {
    const output = 'src/test.ts(5,10): error TS2322: Type "number" is not assignable to type "string".';
    const errors = parseVerificationOutput(output, 'typescript');
    assert.equal(errors.length, 1);
    assert.equal(errors[0].file, 'src/test.ts');
    assert.equal(errors[0].line, 5);
    assert.equal(errors[0].code, 'TS2322');
    assert.equal(errors[0].source, 'typescript');
  });

  it('parses ESLint output', () => {
    const output = 'src/app.ts:10:5: error Unexpected console statement (no-console)';
    const errors = parseVerificationOutput(output, 'eslint');
    assert.equal(errors.length, 1);
    assert.equal(errors[0].file, 'src/app.ts');
    assert.equal(errors[0].line, 10);
    assert.equal(errors[0].source, 'eslint');
  });

  it('parses test failure output', () => {
    const output = 'FAIL src/__tests__/app.test.ts\n● should return correct value\nExpected: 5\nReceived: 3';
    const errors = parseVerificationOutput(output, 'test');
    assert.ok(errors.length > 0);
  });

  it('returns empty array for clean output', () => {
    const errors = parseVerificationOutput('', 'typescript');
    assert.equal(errors.length, 0);
  });
});

describe('formatFixInstructions', () => {
  it('creates structured prompt from errors', () => {
    const errors = [
      { file: 'src/test.ts', line: 5, column: 10, message: 'Type mismatch', code: 'TS2322', source: 'typescript' as const },
    ];
    const result = formatFixInstructions(errors);
    assert.ok(result.includes('src/test.ts:5'));
    assert.ok(result.includes('TS2322'));
    assert.ok(result.includes('Type mismatch'));
  });

  it('returns empty string for no errors', () => {
    assert.equal(formatFixInstructions([]), '');
  });
});
