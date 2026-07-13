#!/usr/bin/env node
/**
 * tracker-cli — standalone CLI for @rw3iss/tracker
 *
 * Commands:
 *   tail    — stream events via SSE (fallback: poll every 3s)
 *   query   — fetch events with optional filters
 *   status  — update an event's status
 *   replay  — re-POST events in a time range back to the same endpoint
 *
 * Uses only built-in Node modules + native fetch (Node 18+). No external deps.
 */

// ── ANSI colours ──────────────────────────────────────────────────────────────
const C = {
  red:    '\x1b[31m',
  yellow: '\x1b[33m',
  blue:   '\x1b[34m',
  green:  '\x1b[32m',
  gray:   '\x1b[90m',
  bold:   '\x1b[1m',
  reset:  '\x1b[0m',
} as const;

type EventType = 'error' | 'warning' | 'info' | 'debug' | 'event';

function colorForType(type: EventType | string): string {
  switch (type) {
    case 'error':   return C.red;
    case 'debug':   return C.gray;
    case 'warning': return C.yellow;
    case 'info':    return C.blue;
    case 'event':   return C.green;
    default:        return C.gray;
  }
}

// ── Argument parsing ──────────────────────────────────────────────────────────
interface ParsedArgs {
  command: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  let i = 0;

  // First non-flag arg is the command
  let command = '';
  while (i < argv.length) {
    const arg = argv[i];
    if (!command && !arg.startsWith('-')) {
      command = arg;
      i++;
    } else if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i += 2;
      } else {
        flags[key] = true;
        i++;
      }
    } else if (!arg.startsWith('-')) {
      positional.push(arg);
      i++;
    } else {
      i++;
    }
  }

  return { command, positional, flags };
}

// ── Time parsing ──────────────────────────────────────────────────────────────
function parseTime(str: string | boolean | undefined): number | undefined {
  if (!str || typeof str === 'boolean') return undefined;

  // Relative: -1h, -30m, -1d, -7d
  const rel = str.match(/^(-?\d+)([smhd])$/);
  if (rel) {
    const n = parseInt(rel[1], 10);
    const unit = rel[2];
    const multipliers: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
    return Date.now() + n * (multipliers[unit] ?? 1000);
  }

  // Also handle "1h" without minus prefix as "last N"
  const relPos = str.match(/^(\d+)([smhd])$/);
  if (relPos) {
    const n = parseInt(relPos[1], 10);
    const unit = relPos[2];
    const multipliers: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
    return Date.now() - n * (multipliers[unit] ?? 1000);
  }

  // ISO or epoch
  const d = new Date(str);
  if (!isNaN(d.getTime())) return d.getTime();

  return undefined;
}

// ── Query string builder ──────────────────────────────────────────────────────
function buildQS(params: Record<string, string | number | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '') p.set(k, String(v));
  }
  const s = p.toString();
  return s ? '?' + s : '';
}

// ── Fetch helper ──────────────────────────────────────────────────────────────
async function apiFetch(url: string, options?: RequestInit): Promise<unknown> {
  const res = await fetch(url, options);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} ${res.statusText}${text ? ': ' + text : ''}`);
  }
  return res.json();
}

// ── Event formatter ───────────────────────────────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function formatPretty(ev: any): string {
  const ts    = new Date(ev.timestamp || ev.receivedAt || 0).toISOString();
  const type  = String(ev.type ?? 'event').toUpperCase().padEnd(7);
  const app   = String(ev.appId ?? '—').padEnd(16).slice(0, 16);
  const msg   = String(ev.message ?? '');
  const id    = ev.id ? ` (id: ${ev.id})` : '';
  const col   = colorForType(ev.type);
  return `${C.gray}[${ts}]${C.reset} ${col}${type}${C.reset} ${C.bold}${app}${C.reset} ${msg}${C.gray}${id}${C.reset}`;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function printEvent(ev: any, format: string): void {
  if (format === 'json') {
    process.stdout.write(JSON.stringify(ev) + '\n');
  } else {
    process.stdout.write(formatPretty(ev) + '\n');
  }
}

// ── tail ──────────────────────────────────────────────────────────────────────
async function cmdTail(flags: Record<string, string | boolean>): Promise<void> {
  const endpt  = String(flags['endpoint'] || 'http://localhost:3000').replace(/\/$/, '');
  const format = String(flags['format']   || 'pretty');
  const qs = buildQS({
    appId:  flags['appId']  as string | undefined,
    type:   flags['type']   as string | undefined,
  });

  const sseUrl = `${endpt}/tracker/events/stream${qs}`;
  process.stderr.write(`${C.gray}Connecting to SSE: ${sseUrl}${C.reset}\n`);

  let usedSSE = false;

  // Try SSE via fetch streaming (Node 18+)
  try {
    const controller = new AbortController();
    process.on('SIGINT', () => { controller.abort(); process.exit(0); });

    const res = await fetch(sseUrl, {
      headers: { 'Accept': 'text/event-stream' },
      signal: controller.signal,
    });

    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);

    // Confirm SSE content type
    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('text/event-stream')) throw new Error('Not an SSE endpoint');

    usedSSE = true;
    process.stderr.write(`${C.green}SSE connected. Press Ctrl+C to stop.${C.reset}\n`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE messages are separated by double newlines
      const parts = buffer.split('\n\n');
      buffer = parts.pop() ?? '';  // keep incomplete chunk

      for (const part of parts) {
        const lines = part.split('\n');
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6).trim();
            if (!data) continue;
            try {
              const ev = JSON.parse(data);
              printEvent(ev, format);
            } catch {
              // skip non-JSON (keepalive etc.)
            }
          }
        }
      }
    }
  } catch (err: unknown) {
    if (usedSSE) {
      process.stderr.write(`${C.yellow}SSE disconnected: ${(err as Error).message}${C.reset}\n`);
    } else {
      process.stderr.write(`${C.yellow}SSE unavailable (${(err as Error).message}), falling back to polling every 3s.${C.reset}\n`);
    }
  }

  // Fallback: poll
  if (!usedSSE) {
    const pollUrl = `${endpt}/tracker/events${qs}`;
    process.stderr.write(`${C.gray}Polling: ${pollUrl}${C.reset}\n`);

    const seen = new Set<string>();

    process.on('SIGINT', () => { process.exit(0); });

    const doPoll = async () => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const data = await apiFetch(pollUrl) as any[];
        for (const ev of data) {
          if (!seen.has(ev.id)) {
            seen.add(ev.id);
            printEvent(ev, format);
          }
        }
      } catch (e: unknown) {
        process.stderr.write(`${C.red}Poll error: ${(e as Error).message}${C.reset}\n`);
      }
      setTimeout(doPoll, 3000);
    };

    await doPoll();
    await new Promise(() => {/* run until SIGINT */});
  }
}

// ── query ─────────────────────────────────────────────────────────────────────
async function cmdQuery(flags: Record<string, string | boolean>): Promise<void> {
  const endpt  = String(flags['endpoint'] || 'http://localhost:3000').replace(/\/$/, '');
  const format = String(flags['format']   || 'pretty');

  const fromMs = parseTime(flags['from']);
  const toMs   = parseTime(flags['to']);

  const qs = buildQS({
    appId:  flags['appId']  as string | undefined,
    type:   flags['type']   as string | undefined,
    from:   fromMs,
    to:     toMs,
    limit:  flags['limit']  ? String(flags['limit']) : '50',
  });

  const url = `${endpt}/tracker/events${qs}`;
  process.stderr.write(`${C.gray}GET ${url}${C.reset}\n`);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data = await apiFetch(url) as any[];

  if (data.length === 0) {
    process.stdout.write(`${C.gray}No events found.${C.reset}\n`);
    return;
  }

  for (const ev of data) {
    printEvent(ev, format);
  }
  process.stderr.write(`${C.gray}${data.length} event(s).${C.reset}\n`);
}

// ── status ────────────────────────────────────────────────────────────────────
async function cmdStatus(
  positional: string[],
  flags: Record<string, string | boolean>,
): Promise<void> {
  const [eventId, status] = positional;
  if (!eventId || !status) {
    process.stderr.write(`${C.red}Usage: tracker-cli status <event-id> <status>${C.reset}\n`);
    process.exit(1);
  }

  const validStatuses = ['new', 'viewed', 'acknowledged', 'in_progress', 'resolved', 'wont_fix', 'archived'];
  if (!validStatuses.includes(status)) {
    process.stderr.write(`${C.red}Invalid status. Must be one of: ${validStatuses.join(', ')}${C.reset}\n`);
    process.exit(1);
  }

  const endpt = String(flags['endpoint'] || 'http://localhost:3000').replace(/\/$/, '');
  const url   = `${endpt}/tracker/events/${eventId}/status`;

  process.stderr.write(`${C.gray}PATCH ${url} → ${status}${C.reset}\n`);

  await apiFetch(url, {
    method:  'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ status }),
  });

  process.stdout.write(`${C.green}Status updated: ${eventId} → ${status}${C.reset}\n`);
}

// ── replay ────────────────────────────────────────────────────────────────────
async function cmdReplay(flags: Record<string, string | boolean>): Promise<void> {
  const endpt  = String(flags['endpoint'] || 'http://localhost:3000').replace(/\/$/, '');
  const dryRun = Boolean(flags['dry-run']);

  const fromMs = parseTime(flags['from']);
  const toMs   = parseTime(flags['to']);

  const qs = buildQS({
    appId: flags['appId'] as string | undefined,
    from:  fromMs,
    to:    toMs,
    limit: '500',
  });

  const fetchUrl = `${endpt}/tracker/events${qs}`;
  process.stderr.write(`${C.gray}Fetching events: GET ${fetchUrl}${C.reset}\n`);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data = await apiFetch(fetchUrl) as any[];
  if (data.length === 0) {
    process.stdout.write(`${C.gray}No events to replay.${C.reset}\n`);
    return;
  }

  process.stderr.write(`${C.gray}${data.length} event(s) to replay${dryRun ? ' (dry-run)' : ''}.${C.reset}\n`);

  const postUrl = `${endpt}/tracker/events`;
  let ok = 0;
  let failed = 0;

  for (const ev of data) {
    // Strip server-assigned fields before re-posting
    const { id: _id, status: _status, receivedAt: _recv, count: _count, ...event } = ev;
    void _id; void _status; void _recv; void _count;  // silence unused vars

    if (dryRun) {
      process.stdout.write(`${C.gray}[dry-run]${C.reset} would POST: ${formatPretty(ev)}\n`);
      ok++;
      continue;
    }

    try {
      await apiFetch(postUrl, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(event),
      });
      process.stdout.write(`${C.green}replayed${C.reset} ${formatPretty(ev)}\n`);
      ok++;
    } catch (e: unknown) {
      process.stderr.write(`${C.red}failed${C.reset} ${ev.id}: ${(e as Error).message}\n`);
      failed++;
    }
  }

  process.stderr.write(`\n${C.bold}Replay complete:${C.reset} ${C.green}${ok} ok${C.reset}, ${failed > 0 ? C.red : C.gray}${failed} failed${C.reset}\n`);
}

// ── Help ──────────────────────────────────────────────────────────────────────
function printHelp(): void {
  process.stdout.write(`
${C.bold}tracker-cli${C.reset} — @rw3iss/tracker CLI

${C.bold}Usage:${C.reset}
  tracker-cli <command> [options]

${C.bold}Commands:${C.reset}
  ${C.green}tail${C.reset}     Stream live events via SSE (falls back to polling)
  ${C.green}query${C.reset}    Fetch events with filters
  ${C.green}status${C.reset}   Update an event's status
  ${C.green}replay${C.reset}   Re-POST events in a time range back to the endpoint

${C.bold}Common options:${C.reset}
  --endpoint <url>    API base URL (default: http://localhost:3000)
  --appId <id>        Filter by app ID
  --type <type>       error | warning | info | debug | event
  --format <fmt>      json | pretty  (default: pretty)

${C.bold}tail options:${C.reset}
  (same as above)

${C.bold}query options:${C.reset}
  --from <time>       e.g. -1h, -30m, -1d, or ISO date
  --to <time>         e.g. -1h, or ISO date
  --limit <n>         Max results (default: 50)

${C.bold}status <event-id> <status>${C.reset}
  Status values: new, viewed, acknowledged, in_progress, resolved, wont_fix, archived

${C.bold}replay options:${C.reset}
  --from <time>
  --to <time>
  --appId <id>
  --dry-run           Print what would be replayed without sending

${C.bold}Examples:${C.reset}
  tracker-cli tail --endpoint http://localhost:3000 --type error
  tracker-cli query --from -1h --limit 100 --format json
  tracker-cli status abc123 resolved
  tracker-cli replay --from -1d --dry-run
`);
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const { command, positional, flags } = parseArgs(process.argv.slice(2));

  if (!command || command === 'help' || flags['help'] || flags['h']) {
    printHelp();
    process.exit(0);
  }

  try {
    switch (command) {
      case 'tail':
        await cmdTail(flags);
        break;
      case 'query':
        await cmdQuery(flags);
        break;
      case 'status':
        await cmdStatus(positional, flags);
        break;
      case 'replay':
        await cmdReplay(flags);
        break;
      default:
        process.stderr.write(`${C.red}Unknown command: ${command}${C.reset}\n`);
        printHelp();
        process.exit(1);
    }
  } catch (err: unknown) {
    process.stderr.write(`${C.red}Error: ${(err as Error).message}${C.reset}\n`);
    process.exit(1);
  }
}

main();
