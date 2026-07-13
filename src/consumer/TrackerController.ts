import {
  BadRequestException, Body, Controller, ForbiddenException, Get, HttpCode,
  Inject, NotFoundException, Optional, Param, Patch, Post, Query, Req, Res,
} from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { TrackEventDto } from './dto/track-event.dto';
import { UpdateStatusDto } from './dto/update-status.dto';
import { TrackerService } from './TrackerService';
import { TRACKER_API_KEY, TRACKER_DISTINCT_CACHE_TTL_MS } from './constants';
import type { DistinctField, ITrackerStorageFilter } from './storage/ITrackerStorage';
import { DISTINCT_FIELDS } from './storage/ITrackerStorage';
import type { IngestContext } from './ITrackerPlugin';
import type { TrackerEvent } from '../common/types';
import * as readline from 'node:readline';
import { createHash } from 'node:crypto';

/**
 * Compute the SHA-256 hex digest of a string. Hoisted to module scope so
 * it doesn't go through a per-request `require()` cache lookup on every
 * ingestion call.
 */
function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function buildStorageFilter(query: Record<string, string>): ITrackerStorageFilter {
  const filters: ITrackerStorageFilter = {};
  // String filters from the HTTP API map to the *Contains substring fields
  // — the dashboard expects loose matching ("dev" → "dev-portal",
  // "dev-server", …). Programmatic callers that need exact match should
  // hit the storage layer directly with the bare `appId`/`category` fields.
  if (query['appId'])       filters.appIdContains       = query['appId'];
  if (query['appIds']) {
    // Comma-separated list from the dashboard's multi-select dropdown.
    // Empty entries are dropped so trailing commas don't sneak through.
    const list = query['appIds'].split(',').map(s => s.trim()).filter(Boolean);
    if (list.length > 0) filters.appIds = list;
  }
  if (query['type'])        filters.type                = query['type'] as ITrackerStorageFilter['type'];
  if (query['types']) {
    // Comma-separated list from the dashboard's type multi-select.
    const list = query['types'].split(',').map(s => s.trim()).filter(Boolean) as ITrackerStorageFilter['types'];
    if (list && list.length > 0) filters.types = list;
  }
  if (query['status'])      filters.status              = query['status'] as ITrackerStorageFilter['status'];
  if (query['userId'])      filters.userIdContains      = query['userId'];
  if (query['environment']) filters.environmentContains = query['environment'];
  if (query['category'])    filters.categoryContains    = query['category'];
  if (query['categories']) {
    // Comma-separated list from the dashboard's category multi-select.
    const list = query['categories'].split(',').map(s => s.trim()).filter(Boolean);
    if (list.length > 0) filters.categories = list;
  }
  // `q` is the dashboard's free-text search box. Maps to messageContains —
  // `message ILIKE '%q%'`, accelerated by a pg_trgm GIN index when the
  // extension is available. Trim so leading/trailing whitespace doesn't
  // make the query mysteriously return no results.
  if (query['q'] && query['q'].trim()) filters.messageContains = query['q'].trim();
  if (query['from'])        filters.from        = Number(query['from']);
  if (query['to'])          filters.to          = Number(query['to']);
  if (query['limit'])       filters.limit       = Number(query['limit']);
  if (query['offset'])      filters.offset      = Number(query['offset']);
  if (query['sortBy'])      filters.sortBy      = query['sortBy'];
  if (query['sortDir'])     filters.sortDir     = query['sortDir'] as 'asc' | 'desc';

  // Parse payload.* params into payloadFilters
  const payloadFilters: Record<string, string> = {};
  for (const key of Object.keys(query)) {
    if (key.startsWith('payload.')) {
      const payloadKey = key.slice('payload.'.length);
      if (payloadKey) payloadFilters[payloadKey] = query[key];
    }
  }
  if (Object.keys(payloadFilters).length > 0) {
    filters.payloadFilters = payloadFilters;
  }

  return filters;
}

function extractIp(req: // eslint-disable-next-line @typescript-eslint/no-explicit-any -- raw Fastify/Express request
                        any): string | undefined {
  const forwarded = req.headers?.['x-forwarded-for'];
  if (typeof forwarded === 'string') return forwarded.split(',')[0]?.trim();
  return req.socket?.remoteAddress ?? req.connection?.remoteAddress ?? undefined;
}

/**
 * HTTP controller for tracker event ingestion, querying, and management.
 *
 * Exposes the following endpoints (all prefixed by {@link TrackerModuleOptions.routePrefix},
 * default `'tracker'`):
 *
 * | Method | Path | Description |
 * |---|---|---|
 * | POST | `/events` | Ingest single event or batch |
 * | POST | `/events/stream` | NDJSON streaming batch ingest |
 * | GET | `/events` | Query stored events with filters |
 * | GET | `/events/stream` | SSE live event stream |
 * | PATCH | `/events/:id/status` | Update event lifecycle status |
 * | GET | `/metrics` | Prometheus metrics |
 *
 * The self-hosted HTML dashboard is served by `@vendidit/tracker-server`'s
 * own `TrackerDashboardController` — it's not part of this library.
 *
 * @remarks
 * API key validation is performed via SHA-256 hashed comparison.
 * When `publicIngestion` is true, the controller is decorated with
 * `@SetMetadata('isPublic', true)` to bypass JWT guards.
 *
 * @see {@link TrackerService}
 * @see {@link TrackerModuleOptions}
 */
@Controller('tracker') // Default; overridden by TrackerModule.register({ routePrefix })
export class TrackerController {
  /** Pre-hashed set of valid API keys — O(1) lookup, no raw keys in memory. */
  private readonly validKeyHashes: Set<string>;

  /**
   * In-process TTL cache for `GET /events/distinct?field=…`. The set is
   * tiny (one entry per allow-listed field) and recomputable cheaply, so
   * a `Map` plus an `expiresAt` per entry is enough — no LRU, no eviction
   * worry. Cache is keyed by field name; TTL is configurable (default 60s).
   */
  private readonly distinctCache = new Map<
    string,
    { expiresAt: number; value: Array<{ value: string; count: number }> }
  >();

  /** Configured cache TTL in ms. Set in the constructor. */
  private readonly distinctTtlMs: number;

  constructor(
    @Inject(TrackerService) private readonly service: TrackerService,
    @Optional() @Inject(TRACKER_API_KEY) private readonly apiKeys: string[] | string | null = null,
    @Optional() @Inject(TRACKER_DISTINCT_CACHE_TTL_MS) ttlMs: number | null = null,
  ) {
    // Build the hashed key set at construction time (once)
    this.validKeyHashes = TrackerController.buildKeySet(apiKeys);
    // Default 60s — small enough that "new app appeared" is felt within a
    // minute, large enough that the SELECT DISTINCT amortizes well.
    this.distinctTtlMs = typeof ttlMs === 'number' && ttlMs >= 0 ? ttlMs : 60_000;
  }

  /**
   * Hash raw API keys into a Set for O(1) lookup.
   * Keys are SHA-256 hashed — raw values are never stored in memory after init.
   *
   * Accepts either:
   *   - `string[]`  — one key per element
   *   - `string`    — comma/newline/whitespace separated; lines starting
   *                   with `#` are treated as comments. Lets the env file
   *                   use a multi-line quoted form for readability:
   *                     TRACKER_API_KEYS="
   *                     # auction api-server
   *                     <key1>
   *                     # colleague-app
   *                     <key2>
   *                     "
   */
  private static buildKeySet(keys: string[] | string | null): Set<string> {
    if (!keys) return new Set();
    // Split on newlines and commas only (NOT all whitespace) so comment
    // lines like `# auction api-server (dev / stg / prod)` are captured
    // intact and filtered out via the `#` prefix check below — splitting
    // on spaces would let words after the `#` leak through as fake keys.
    const list = Array.isArray(keys)
      ? keys
      : keys.split(/[\n,]/);
    // Set<string> -> O(1) average-case membership test on the
    // SHA-256 hex digest (raw keys are never retained).
    const set = new Set<string>();
    for (const key of list) {
      const trimmed = key.trim();
      if (trimmed && !trimmed.startsWith('#')) {
        set.add(sha256Hex(trimmed));
      }
    }
    return set;
  }

  /**
   * Validate X-Tracker-Key header against the hashed key set.
   * - No keys configured → allow all (public ingestion mode)
   * - Header absent + keys configured → 403 (endpoint is no longer public)
   * - Header present + valid → allow
   * - Header present + invalid → 403
   *
   * Configuring `apiKey` (or the env-loaded equivalent) flips this
   * controller out of public-ingestion mode regardless of the
   * `publicIngestion` flag — that flag only controls whether the
   * usual JWT guard is removed; it does NOT bypass key auth.
   */
  private validateApiKey(req: any): void {
    if (this.validKeyHashes.size === 0) return; // no keys configured
    const header = req.headers?.['x-tracker-key'] ?? req.raw?.headers?.['x-tracker-key'];
    if (!header) {
      throw new ForbiddenException(
        'Missing tracker API key (X-Tracker-Key header required when keys are configured)',
      );
    }
    // O(1) Set membership test against the precomputed SHA-256 hex set.
    if (!this.validKeyHashes.has(sha256Hex(header))) {
      throw new ForbiddenException('Invalid tracker API key');
    }
  }

  /**
   * Ingest one or more tracker events.
   *
   * Accepts a single event object or an array of events in the request body.
   * Each event is validated against `TrackEventDto` before processing.
   *
   * @param body - Single event or array of events to ingest.
   * @param req - Raw HTTP request (for API key validation).
   * @returns `{ ok: true }` on success.
   * @throws BadRequestException if validation fails.
   * @throws ForbiddenException if an invalid API key is provided.
   *
   * @example
   * ```
   * POST /tracker/events
   * Content-Type: application/json
   *
   * { "type": "error", "message": "Something failed", "timestamp": 1700000000000 }
   * ```
   */
  @Post('events')
  @HttpCode(201)
  async track(@Body() body: unknown, @Req() req: any): Promise<{ ok: boolean }> {
    this.validateApiKey(req);
    const raw = Array.isArray(body) ? body : [body];
    const dtos = raw.map((e) => plainToInstance(TrackEventDto, e));

    for (const dto of dtos) {
      const errors = await validate(dto, { whitelist: true });
      if (errors.length > 0) {
        throw new BadRequestException(
          errors.map((e) => Object.values(e.constraints ?? {}).join(', ')),
        );
      }
    }

    await this.service.trackBatch(dtos as TrackerEvent[]);
    return { ok: true };
  }

  /**
   * Streaming batch ingest via NDJSON (newline-delimited JSON).
   *
   * Reads the request body as a stream, parsing each line as a JSON event.
   * Invalid lines are counted as errors but do not abort the stream.
   *
   * @param req - Raw HTTP request (streaming body).
   * @param res - Raw HTTP response (manual write).
   * @returns JSON response: `{ ok: true, processed: number, errors: number }`.
   *
   * @example
   * ```
   * POST /tracker/events/stream
   * Content-Type: application/x-ndjson
   *
   * {"type":"info","message":"event 1","timestamp":1700000000000}
   * {"type":"error","message":"event 2","timestamp":1700000000001}
   * ```
   */
  @Post('events/stream')
  @HttpCode(200)
  async trackStream(
    @Req()  req: // eslint-disable-next-line @typescript-eslint/no-explicit-any -- raw Node request needed for streaming
                 any,
    @Res({ passthrough: false }) res: // eslint-disable-next-line @typescript-eslint/no-explicit-any -- raw response for manual send
                                      any,
  ): Promise<void> {
    const ctx: IngestContext = {
      ip:      extractIp(req),
      url:     req.url,
      headers: req.headers as Record<string, string>,
    };

    let processed = 0;
    let errors    = 0;

    const raw: import('node:stream').Readable = req.raw ?? req;

    await new Promise<void>((resolve) => {
      const rl = readline.createInterface({ input: raw, crlfDelay: Infinity });

      rl.on('line', async (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;

        try {
          const event = JSON.parse(trimmed) as TrackerEvent;
          await this.service.track(event, ctx);
          processed++;
        } catch {
          errors++;
        }
      });

      rl.on('close', resolve);
      rl.on('error', () => resolve());
    });

    const resRaw = res.raw ?? res;
    resRaw.writeHead(200, { 'Content-Type': 'application/json' });
    resRaw.end(JSON.stringify({ ok: true, processed, errors }));
  }

  /**
   * Update the lifecycle status of a stored event.
   *
   * @param id - The UUID of the event to update.
   * @param dto - Request body containing the new `TrackerEventStatus`.
   * @returns `{ ok: true }` on success.
   *
   * @example
   * ```
   * PATCH /tracker/events/550e8400-e29b-41d4-a716-446655440000/status
   * Content-Type: application/json
   *
   * { "status": "resolved" }
   * ```
   */
  @Patch('events/:id/status')
  async updateStatus(
    @Param('id') id: string,
    @Body() dto: UpdateStatusDto,
  ): Promise<{ ok: boolean }> {
    await this.service.updateStatus(id, dto.status);
    return { ok: true };
  }

  /**
   * Query stored events with optional filters.
   *
   * Supports filtering by appId, type, status, userId, environment, category,
   * date range (from/to as Unix ms), pagination (limit/offset), sorting
   * (sortBy/sortDir), and payload field matching (payload.key=value).
   *
   * @param query - Query string parameters parsed into {@link ITrackerStorageFilter}.
   * @returns Array of matching `StoredTrackerEvent`s.
   *
   * @example
   * ```
   * GET /tracker/events?type=error&appId=api-server&limit=50&sortDir=desc
   * ```
   */
  @Get('events')
  async query(@Query() query: Record<string, string>): Promise<unknown[]> {
    return this.service.query(buildStorageFilter(query));
  }

  /**
   * Distinct values + counts for a single allow-listed column.
   * Powers the dashboard's app picker (and category/environment/… as they
   * graduate to dropdowns). Cached in process for `distinctCacheTtlMs`.
   *
   * @example
   * ```
   * GET /tracker/events/distinct?field=appId
   * → [{ "value": "api-server", "count": 1234 }, …]
   * ```
   */
  @Get('events/distinct')
  async distinct(
    @Query('field') rawField?: string,
    @Query('limit') rawLimit?: string,
  ): Promise<Array<{ value: string; count: number }>> {
    const field = rawField as DistinctField | undefined;
    if (!field || !DISTINCT_FIELDS.includes(field)) {
      throw new BadRequestException(
        `field must be one of: ${DISTINCT_FIELDS.join(', ')}`,
      );
    }
    const limit = rawLimit ? Math.max(1, Math.min(Number(rawLimit), 2000)) : undefined;

    const cacheKey = `${field}:${limit ?? 500}`;
    const now = Date.now();
    const hit = this.distinctCache.get(cacheKey);
    if (hit && hit.expiresAt > now) return hit.value;

    const value = await this.service.queryDistinct(field, { limit });
    this.distinctCache.set(cacheKey, { value, expiresAt: now + this.distinctTtlMs });
    return value;
  }

  /**
   * Manually invalidate the distinct cache. Useful for ingest plugins to
   * call after seeing an unknown appId so the next dashboard refresh
   * picks it up immediately rather than waiting out the TTL.
   *
   * Public so plugins / tests can call it via `TrackerService.instance()`
   * → controller-by-introspection. Not exposed as an HTTP route.
   */
  invalidateDistinct(field?: DistinctField): void {
    if (!field) {
      this.distinctCache.clear();
      return;
    }
    for (const key of this.distinctCache.keys()) {
      if (key.startsWith(field + ':')) this.distinctCache.delete(key);
    }
  }

  /**
   * Fetch a single stored event by UUID. Returns 404 when not found
   * so the dashboard's deep-link UX can show a "not found" state in
   * the detail panel rather than a generic error.
   *
   * Declared after `events/distinct` and `events/stream` so those
   * static suffixes match first — Nest's path-to-regexp ordering
   * picks longer literal prefixes over `:id` placeholders, but the
   * declaration-order heuristic is the safest defence in depth.
   *
   * @example
   * ```
   * GET /api/events/c4f9a0e8-…
   * ```
   */
  @Get('events/:id')
  async findOne(@Param('id') id: string): Promise<unknown> {
    const event = await this.service.queryOne(id);
    if (!event) throw new NotFoundException(`Event ${id} not found`);
    return event;
  }

  /**
   * Server-Sent Events (SSE) live stream of tracker events.
   *
   * Opens a long-lived connection that polls for new events every 2 seconds
   * and sends them as SSE `data:` frames. Sends keepalive comments when idle.
   *
   * @param query - Query string filters (same as {@link TrackerController.query | query()}).
   * @param req - Raw HTTP request (for connection close detection).
   * @param res - Raw HTTP response (for SSE stream writing).
   *
   * @example
   * ```
   * GET /tracker/events/stream?type=error&appId=api-server
   *
   * // Response:
   * data: {"id":"...","type":"error","message":"..."}
   *
   * : keepalive
   * ```
   */
  @Get('events/stream')
  async streamEvents(
    @Query() query: Record<string, string>,
    @Req()   req: // eslint-disable-next-line @typescript-eslint/no-explicit-any -- raw request for close event
                  any,
    @Res({ passthrough: false }) res: // eslint-disable-next-line @typescript-eslint/no-explicit-any -- raw response for SSE
                                      any,
  ): Promise<void> {
    const filters = buildStorageFilter(query);
    const resRaw = res.raw ?? res;
    const reqRaw = req.raw ?? req;

    resRaw.writeHead(200, {
      'Content-Type':  'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection':    'keep-alive',
      // nginx-aware: tells the reverse proxy not to buffer this response.
      // Without it, default proxy_buffering eats the keepalive frames
      // (each ~13 bytes) until the buffer fills (~8 KB), which can take
      // minutes — by then the browser has already given up on EventSource
      // (5-second open timeout) and fallen back to polling. Cloudflare
      // and most other proxies honor the same header.
      'X-Accel-Buffering': 'no',
    });
    resRaw.flushHeaders?.();

    // Immediate first-byte flush. Some proxies / browsers don't fire
    // `onopen` until the body produces data, even after the headers
    // arrive — sending an SSE comment now keeps the dashboard from
    // false-failing its 5-second open timeout while waiting for the
    // first poll cycle to hit (2s later) on a quiet system.
    resRaw.write(': connected\n\n');

    let lastSeen = Date.now();
    let closed   = false;

    reqRaw.on('close', () => { closed = true; });

    const sendEvent = (data: string) => {
      resRaw.write(`data: ${data}\n\n`);
    };

    const keepalive = () => {
      resRaw.write(': keepalive\n\n');
    };

    const poll = async () => {
      if (closed) return;

      try {
        const all = await this.service.query({ ...filters, from: lastSeen });
        if (all.length > 0) {
          lastSeen = Date.now();
          for (const event of all) {
            sendEvent(JSON.stringify(event));
          }
        } else {
          keepalive();
        }
      } catch {
        keepalive();
      }

      if (!closed) {
        setTimeout(poll, 2_000);
      }
    };

    setTimeout(poll, 2_000);
  }

  /**
   * Prometheus metrics endpoint.
   *
   * Returns metrics in Prometheus text exposition format (version 0.0.4).
   * Metrics are provided by plugins that register via
   * {@link TrackerService.registerMetricsProvider}.
   *
   * @param res - Raw HTTP response (for content-type header).
   *
   * @example
   * ```
   * GET /tracker/metrics
   * # Response: text/plain; version=0.0.4
   * ```
   */
  @Get('metrics')
  getMetrics(
    @Res({ passthrough: false }) res: // eslint-disable-next-line @typescript-eslint/no-explicit-any -- raw response for content-type
                                      any,
  ): void {
    const body = this.service.getMetrics();
    const resRaw = res.raw ?? res;
    resRaw.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' });
    resRaw.end(body);
  }

  // The self-hosted HTML dashboard is served by `@vendidit/tracker-server`'s
  // `TrackerDashboardController`, mounted at its own path independently
  // of `routePrefix`. It's intentionally not part of this library.
}
