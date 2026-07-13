import 'reflect-metadata';
import { createSourceMapEnricher } from '../../../../src/consumer/enrichers/SourceMapEnricher';
import type { TrackerEvent } from '../../../../src/common/types';

function makeErrorEvent(stack: string): TrackerEvent {
  return {
    type:      'error',
    message:   'boom',
    timestamp: 1,
    error: { name: 'Error', message: 'boom', stack },
  };
}

describe('createSourceMapEnricher', () => {
  it('returns event unchanged when error has no stack', async () => {
    const fetchSourceMap = jest.fn().mockResolvedValue(null);
    const enricher = createSourceMapEnricher({ fetchSourceMap });
    const event: TrackerEvent = { type: 'error', message: 'oops', timestamp: 1 };
    const result = await enricher(event);
    expect(result).toBe(event);
    expect(fetchSourceMap).not.toHaveBeenCalled();
  });

  it('returns event unchanged when stack has no parseable frames', async () => {
    const fetchSourceMap = jest.fn().mockResolvedValue(null);
    const enricher = createSourceMapEnricher({ fetchSourceMap });
    const event = makeErrorEvent('Error: boom\n  no valid frame here');
    const result = await enricher(event);
    expect(result).toBe(event);
  });

  it('passes frames through unchanged when fetchSourceMap returns null', async () => {
    const fetchSourceMap = jest.fn().mockResolvedValue(null);
    const enricher = createSourceMapEnricher({ fetchSourceMap });
    const stack = '  at myFn (app.js:10:5)\n  at anotherFn (app.js:20:3)';
    const event  = makeErrorEvent(stack);
    const result = await enricher(event);
    expect(result.error!.stack).toContain('app.js:10:5');
    expect(result.error!.stack).toContain('app.js:20:3');
  });

  it('calls fetchSourceMap with the frame file URL', async () => {
    const fetchSourceMap = jest.fn().mockResolvedValue(null);
    const enricher = createSourceMapEnricher({ fetchSourceMap });
    const event    = makeErrorEvent('  at myFn (https://cdn.example.com/app.min.js:1:500)');
    await enricher(event);
    expect(fetchSourceMap).toHaveBeenCalledWith('https://cdn.example.com/app.min.js');
  });

  it('annotates frames when fetchSourceMap returns a source map reference', async () => {
    const fetchSourceMap = jest.fn().mockResolvedValue('src/app.ts:10:5');
    const enricher = createSourceMapEnricher({ fetchSourceMap });
    const event    = makeErrorEvent('  at myFn (app.min.js:1:500)');
    const result   = await enricher(event);
    expect(result.error!.stack).toContain('=> src/app.ts:10:5');
  });

  it('caches the source map per file URL (calls fetchSourceMap once per file)', async () => {
    const fetchSourceMap = jest.fn().mockResolvedValue('src/app.ts');
    const enricher = createSourceMapEnricher({ fetchSourceMap });
    const stack    = '  at fn1 (app.js:1:1)\n  at fn2 (app.js:2:1)';
    await enricher(makeErrorEvent(stack));
    expect(fetchSourceMap).toHaveBeenCalledTimes(1);
  });

  it('respects maxFrames option', async () => {
    const fetchSourceMap = jest.fn().mockResolvedValue(null);
    const enricher = createSourceMapEnricher({ fetchSourceMap, maxFrames: 2 });
    const stack = [
      '  at fn1 (app.js:1:1)',
      '  at fn2 (app.js:2:1)',
      '  at fn3 (app.js:3:1)',
    ].join('\n');
    const result = await enricher(makeErrorEvent(stack));
    // Only 2 frames should appear in the resolved stack
    const lines  = result.error!.stack!.split('\n').filter(Boolean);
    expect(lines).toHaveLength(2);
  });
});
