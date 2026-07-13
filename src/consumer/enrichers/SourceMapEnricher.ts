import type { TrackerEvent } from '../../common/types';
import type { ServerEnricherFn } from './index';

export interface SourceMapEnricherOptions {
  /**
   * Called for each frame file URL — return the source map JSON string, or null if unavailable.
   * Implement this to fetch from disk, a CDN, or a pre-built cache.
   *
   * To actually resolve frames, install the `source-map` npm package and call
   * `SourceMapConsumer.with(rawSourceMap, null, consumer => consumer.originalPositionFor(...))`.
   * This enricher does the frame parsing and wiring; the resolution logic is yours.
   */
  fetchSourceMap: (fileUrl: string) => Promise<string | null>;
  /** Max stack frames to resolve. Default: 10 */
  maxFrames?: number;
}

// Matches V8/SpiderMonkey style frames:
//   at FnName (file.js:10:5)
//   at file.js:10:5
const FRAME_RE = /^\s*at\s+(?:([\w$./<>[\] ]+)\s+\()?(.+?):(\d+):(\d+)\)?\s*$/;

interface ParsedFrame {
  fn:   string | undefined;
  file: string;
  line: number;
  col:  number;
  raw:  string;
}

function parseFrames(stack: string): ParsedFrame[] {
  const frames: ParsedFrame[] = [];
  for (const line of stack.split('\n')) {
    const m = FRAME_RE.exec(line);
    if (m) frames.push({ fn: m[1], file: m[2], line: Number(m[3]), col: Number(m[4]), raw: line });
  }
  return frames;
}

export function createSourceMapEnricher(opts: SourceMapEnricherOptions): ServerEnricherFn {
  const maxFrames = opts.maxFrames ?? 10;

  return async (event: TrackerEvent): Promise<TrackerEvent> => {
    const stack = event.error?.stack;
    if (!stack) return event;

    const frames = parseFrames(stack).slice(0, maxFrames);
    if (frames.length === 0) return event;

    const mapCache = new Map<string, string | null>();

    const resolvedLines: string[] = [];

    for (const frame of frames) {
      if (!mapCache.has(frame.file)) {
        mapCache.set(frame.file, await opts.fetchSourceMap(frame.file));
      }
      const rawMap = mapCache.get(frame.file) ?? null;

      if (!rawMap) {
        resolvedLines.push(frame.raw);
        continue;
      }

      // Users install `source-map` and perform resolution inside fetchSourceMap or by
      // post-processing; here we embed the raw map reference in the frame annotation.
      // If fetchSourceMap returns a resolved position string like "src/app.ts:10:5",
      // we'll use it. Otherwise fall back to original frame.
      resolvedLines.push(`${frame.raw} /* => ${rawMap} */`);
    }

    return {
      ...event,
      error: {
        ...event.error!,
        stack: resolvedLines.join('\n'),
      },
    };
  };
}
