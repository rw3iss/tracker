/**
 * @jest-environment node
 */
import { serializeError } from '../../../src/emitter/serialize-error';

describe('serializeError', () => {
  it('captures name, message, and stack', () => {
    const out = serializeError(new TypeError('bad type'));
    expect(out.name).toBe('TypeError');
    expect(out.message).toBe('bad type');
    expect(typeof out.stack).toBe('string');
  });

  it('parses file and line from a V8-style stack', () => {
    const err = new Error('boom');
    err.stack = [
      'Error: boom',
      '    at doThing (/app/src/things.js:42:7)',
      '    at main (/app/src/index.js:10:3)',
    ].join('\n');
    const out = serializeError(err);
    expect(out.file).toBe('/app/src/things.js');
    expect(out.line).toBe(42);
  });

  it('parses file and line from a SpiderMonkey-style stack', () => {
    const err = new Error('boom');
    err.stack = [
      'doThing@/app/src/things.js:42:7',
      'main@/app/src/index.js:10:3',
    ].join('\n');
    const out = serializeError(err);
    expect(out.file).toBe('/app/src/things.js');
    expect(out.line).toBe(42);
  });

  it('extracts numeric `code` from a custom Error subclass', () => {
    class HttpError extends Error { code = 404; }
    const out = serializeError(new HttpError('not found'));
    expect(out.code).toBe(404);
  });

  it('extracts string `code` from a Node SystemError-style error', () => {
    const err = Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' });
    const out = serializeError(err);
    expect(out.code).toBe('ENOENT');
  });

  it('walks Error.cause into a previous chain (outermost-first)', () => {
    const root   = new Error('root cause');
    const middle = Object.assign(new Error('wrapper'),   { cause: root });
    const outer  = Object.assign(new Error('outermost'), { cause: middle });

    const out = serializeError(outer);
    expect(out.previous).toBeDefined();
    expect(out.previous).toHaveLength(2);
    expect(out.previous?.[0].message).toBe('wrapper');
    expect(out.previous?.[1].message).toBe('root cause');
  });

  it('omits previous when there is no cause chain', () => {
    const out = serializeError(new Error('lonely'));
    expect(out.previous).toBeUndefined();
  });

  it('caps previous-chain depth to protect against pathological cases', () => {
    // Build a 10-deep chain — only 5 should survive (MAX_PREVIOUS_DEPTH).
    let cause: Error = new Error('level-0');
    for (let i = 1; i <= 10; i++) {
      cause = Object.assign(new Error(`level-${i}`), { cause });
    }
    const out = serializeError(cause);
    expect(out.previous?.length).toBe(5);
  });

  it('handles cyclic causes without looping forever', () => {
    const a: Error = new Error('a');
    const b: Error = new Error('b');
    (a as { cause?: unknown }).cause = b;
    (b as { cause?: unknown }).cause = a;

    const out = serializeError(a);
    // No assertion on the exact contents — just that it terminates.
    expect(Array.isArray(out.previous)).toBe(true);
  });

  it('falls back gracefully for non-Error values', () => {
    const out = serializeError('just a string');
    expect(out.name).toBe('Error');
    expect(out.message).toBe('just a string');
    expect(out.stack).toBeUndefined();
  });

  describe('enrichment modes', () => {
    function makeRichError(): Error {
      const err = Object.assign(new Error('boom'), { code: 'ECONNREFUSED' });
      err.stack = ['Error: boom', '    at doThing (/app/src/things.js:42:7)'].join('\n');
      (err as { cause?: unknown }).cause = new Error('root cause');
      return err;
    }

    it('false / minimal both strip every optional field', () => {
      for (const mode of ['minimal' as const, false as const]) {
        const out = serializeError(makeRichError(), mode);
        expect(out.name).toBe('Error');
        expect(out.message).toBe('boom');
        expect(out.stack).toContain('things.js');
        expect(out.file).toBeUndefined();
        expect(out.line).toBeUndefined();
        expect(out.code).toBeUndefined();
        expect(out.previous).toBeUndefined();
      }
    });

    it('true / full both emit every optional field', () => {
      for (const mode of ['full' as const, true as const]) {
        const out = serializeError(makeRichError(), mode);
        expect(out.file).toBe('/app/src/things.js');
        expect(out.line).toBe(42);
        expect(out.code).toBe('ECONNREFUSED');
        expect(out.previous).toHaveLength(1);
      }
    });

    it('object: per-field overrides drop only the specified fields', () => {
      const out = serializeError(makeRichError(), { previous: false, code: false });
      expect(out.file).toBe('/app/src/things.js');
      expect(out.line).toBe(42);
      expect(out.code).toBeUndefined();
      expect(out.previous).toBeUndefined();
    });
  });
});
