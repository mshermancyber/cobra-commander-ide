import { describe, it, expect } from 'vitest';
import {
  parseErrors,
  parseTscErrors,
  parseEslintErrors,
  parseTestErrors,
  parseGenericErrors,
  buildFixPrompt,
} from '../src/core/error-parser.js';

describe('error-parser', () => {
  describe('parseTscErrors', () => {
    it('should parse TypeScript errors in TS2345 format', () => {
      const output = `src/foo.ts(12,5): error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.`;
      const errors = parseTscErrors(output);
      expect(errors).toHaveLength(1);
      expect(errors[0].file).toBe('src/foo.ts');
      expect(errors[0].line).toBe(12);
      expect(errors[0].column).toBe(5);
      expect(errors[0].code).toBe('TS2345');
      expect(errors[0].severity).toBe('error');
    });

    it('should parse multiple TypeScript errors', () => {
      const output = [
        'src/a.ts(1,1): error TS2322: Type "x" is not assignable.',
        'src/b.ts(5,10): warning TS6133: "x" is declared but never used.',
      ].join('\n');
      const errors = parseTscErrors(output);
      expect(errors).toHaveLength(2);
      expect(errors[0].file).toBe('src/a.ts');
      expect(errors[1].file).toBe('src/b.ts');
      expect(errors[1].severity).toBe('warning');
    });

    it('should return empty array for non-matching output', () => {
      const errors = parseTscErrors('Everything looks good!');
      expect(errors).toHaveLength(0);
    });
  });

  describe('parseEslintErrors', () => {
    it('should parse ESLint errors', () => {
      const output = `  12:5  error  Unexpected console statement  no-console`;
      const errors = parseEslintErrors(output);
      expect(errors).toHaveLength(1);
      expect(errors[0].line).toBe(12);
      expect(errors[0].column).toBe(5);
      expect(errors[0].code).toBe('no-console');
      expect(errors[0].severity).toBe('error');
    });

    it('should parse ESLint warnings', () => {
      const output = `  3:1  warning  Missing JSDoc comment  require-jsdoc`;
      const errors = parseEslintErrors(output);
      expect(errors).toHaveLength(1);
      expect(errors[0].severity).toBe('warning');
      expect(errors[0].code).toBe('require-jsdoc');
    });
  });

  describe('parseTestErrors', () => {
    it('should parse test failure locations', () => {
      const output = `  at Object.<anonymous> (src/foo.test.ts:12:5)`;
      const errors = parseTestErrors(output);
      expect(errors).toHaveLength(1);
      expect(errors[0].file).toBe('src/foo.test.ts');
      expect(errors[0].line).toBe(12);
      expect(errors[0].column).toBe(5);
    });
  });

  describe('parseGenericErrors', () => {
    it('should parse generic file:line: message patterns', () => {
      const output = `src/main.ts:42: error: something went wrong`;
      const errors = parseGenericErrors(output);
      expect(errors).toHaveLength(1);
      expect(errors[0].file).toBe('src/main.ts');
      expect(errors[0].line).toBe(42);
      expect(errors[0].message).toContain('error');
    });
  });

  describe('parseErrors (auto-detect)', () => {
    it('should handle empty input gracefully', () => {
      const errors = parseErrors('');
      expect(errors).toHaveLength(0);
    });

    it('should auto-detect TypeScript errors', () => {
      const output = `src/bar.ts(3,1): error TS2554: Expected 1 arguments, but got 0.`;
      const errors = parseErrors(output);
      expect(errors).toHaveLength(1);
      expect(errors[0].code).toBe('TS2554');
    });

    it('should fall back to generic parsing', () => {
      const output = `src/app.js:10: Uncaught ReferenceError: x is not defined`;
      const errors = parseErrors(output);
      expect(errors.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('buildFixPrompt', () => {
    it('should return original task when no errors', () => {
      const prompt = buildFixPrompt([], 'Add a function');
      expect(prompt).toBe('Add a function');
    });

    it('should include error details in fix prompt', () => {
      const errors = [
        { file: 'src/a.ts', line: 1, column: 5, code: 'TS2322', message: 'Type mismatch', severity: 'error' as const },
      ];
      const prompt = buildFixPrompt(errors, 'Fix the code');
      expect(prompt).toContain('TS2322');
      expect(prompt).toContain('src/a.ts:1:5');
      expect(prompt).toContain('Fix the code');
    });
  });
});
