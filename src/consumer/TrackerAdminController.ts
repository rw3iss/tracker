import {
    BadRequestException, Body, Controller, ForbiddenException,
    HttpCode, Inject, Optional, Post, Req,
} from '@nestjs/common';
import * as crypto from 'node:crypto';
import { TrackerService } from './TrackerService';
import { TRACKER_ADMIN_KEY } from './constants';
import type { ITrackerStorageFilter } from './storage/ITrackerStorage';

/**
 * Body shape accepted by `POST /api/admin/clear-events`.
 *
 * Every field is optional — empty body means "delete everything",
 * which the controller requires `confirm: true` to authorise so an
 * accidentally-fired curl with the right key doesn't wipe the table.
 */
interface ClearEventsBody {
    appId?:       string;
    appIds?:      string[];
    type?:        ITrackerStorageFilter['type'];
    types?:       ITrackerStorageFilter['types'];
    status?:      ITrackerStorageFilter['status'];
    category?:    string;
    categories?:  string[];
    userId?:      string;
    environment?: string;
    /** Unix ms — only events with `receivedAt >= from` are deleted. */
    from?:        number;
    /** Unix ms — only events with `receivedAt <= to` are deleted. */
    to?:          number;
    /** Required when no filter narrows the delete; protects against accidental wipes. */
    confirm?:     boolean;
}

/**
 * Admin endpoints that mutate stored events.
 *
 * Mounted at `<routePrefix>/admin/*` (default `/api/admin/*`). Auth is
 * a separate header (`X-Tracker-Admin-Key`) and a separate config
 * value from the ingest API keys — admin operations have a different
 * threat model and shouldn't share secrets with read/write traffic.
 *
 * The controller is registered only when `adminKey` is configured on
 * `TrackerModule.register({ adminKey })`. With no key, the route
 * simply doesn't exist.
 */
@Controller('admin')
export class TrackerAdminController {
    /** SHA-256 of the configured key. Raw value never lives in memory. */
    private readonly keyHash: string | null;

    constructor(
        @Inject(TrackerService) private readonly service: TrackerService,
        @Optional() @Inject(TRACKER_ADMIN_KEY) adminKey: string | null = null,
    ) {
        this.keyHash = adminKey
            ? crypto.createHash('sha256').update(adminKey).digest('hex')
            : null;
    }

    /**
     * Delete events. Without a filter, requires `confirm: true` in the
     * body so an empty POST can't wipe the database by accident.
     *
     * @example
     * ```http
     * POST /api/admin/clear-events
     * X-Tracker-Admin-Key: …
     *
     * { "appId": "dev-alt-rw3iss", "type": "debug" }
     * ```
     */
    @Post('clear-events')
    @HttpCode(200)
    async clearEvents(
        @Req()  req: any, // eslint-disable-line @typescript-eslint/no-explicit-any
        @Body() body: ClearEventsBody = {},
    ): Promise<{ ok: true; deleted: number }> {
        this.requireAdmin(req);

        const filters = bodyToFilter(body);
        const isFullWipe =
            !filters.appId && !filters.appIds?.length &&
            !filters.type && !filters.types?.length &&
            !filters.status &&
            !filters.category && !filters.categories?.length &&
            !filters.userId && !filters.environment &&
            filters.from === undefined && filters.to === undefined;

        if (isFullWipe && body.confirm !== true) {
            throw new BadRequestException(
                'Refusing to delete every event without explicit { confirm: true }. ' +
                'Either narrow the filter or include "confirm": true in the body.',
            );
        }

        const deleted = await this.service.clearEvents(filters);
        return { ok: true, deleted };
    }

    /**
     * Compare the request's `X-Tracker-Admin-Key` against the
     * configured hash. No key configured → the controller wouldn't be
     * mounted, so reaching here means a key IS expected; missing or
     * mismatched header is a 403.
     */
    private requireAdmin(req: any): void { // eslint-disable-line @typescript-eslint/no-explicit-any
        if (!this.keyHash) {
            // Defensive — module shouldn't have mounted us without a key.
            throw new ForbiddenException('Admin key not configured');
        }
        const header =
            req.headers?.['x-tracker-admin-key'] ?? req.raw?.headers?.['x-tracker-admin-key'];
        if (!header) {
            throw new ForbiddenException('Admin key required');
        }
        const incoming = crypto.createHash('sha256').update(String(header)).digest('hex');
        // Constant-time compare — guards against timing oracle even
        // though Buffer.compare on hex digests is also fine.
        const a = Buffer.from(incoming, 'hex');
        const b = Buffer.from(this.keyHash, 'hex');
        if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
            throw new ForbiddenException('Invalid admin key');
        }
    }
}

function bodyToFilter(body: ClearEventsBody): ITrackerStorageFilter {
    const filter: ITrackerStorageFilter = {};
    if (body.appId)       filter.appId       = body.appId;
    if (body.appIds)      filter.appIds      = body.appIds;
    if (body.type)        filter.type        = body.type;
    if (body.types)       filter.types       = body.types;
    if (body.status)      filter.status      = body.status;
    if (body.category)    filter.category    = body.category;
    if (body.categories)  filter.categories  = body.categories;
    if (body.userId)      filter.userId      = body.userId;
    if (body.environment) filter.environment = body.environment;
    if (body.from !== undefined) filter.from = Number(body.from);
    if (body.to   !== undefined) filter.to   = Number(body.to);
    return filter;
}
