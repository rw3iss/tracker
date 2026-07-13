import { Injectable, Logger } from '@nestjs/common';
import {
    ConnectedSocket,
    MessageBody,
    OnGatewayConnection,
    SubscribeMessage,
    WebSocketGateway,
} from '@nestjs/websockets';
import { TrackerService } from './TrackerService';
import type { TrackerEvent } from '../common/types';
import type { IngestContext } from './ITrackerPlugin';

/**
 * Socket.IO gateway for tracker event ingestion.
 *
 * Mounts on the `/tracker` namespace so it doesn't interfere with the
 * host application's main WebSocket gateway (typically at `/ws`).
 *
 * Client usage:
 *   ```typescript
 *   import { io } from 'socket.io-client';
 *   const socket = io('http://api-host/tracker');
 *   socket.emit('ingest', { type: 'error', message: 'something failed', timestamp: Date.now() });
 *   // or batch:
 *   socket.emit('ingest', [event1, event2]);
 *   ```
 *
 * This gateway is enabled by setting `socketGateway: true` in
 * `TrackerModule.register(options)` or `TrackerModule.registerAsync(options)`.
 * When not enabled, only the HTTP endpoints (`POST /tracker/events`) are available.
 */
@Injectable()
@WebSocketGateway({ namespace: '/tracker', cors: true })
export class TrackerSocketIoGateway implements OnGatewayConnection {
    private readonly logger = new Logger(TrackerSocketIoGateway.name);

    constructor(private readonly trackerService: TrackerService) {}

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- socket.io Socket type is an optional peer dep
    handleConnection(client: any): void {
        this.logger.log(`Tracker WS client connected: ${client.id as string}`);
    }

    /**
     * Ingest one or more tracker events over Socket.IO.
     *
     * Returns `{ ok: true, count }` where count is the number of successfully
     * processed events. Events that fail validation are silently skipped.
     */
    @SubscribeMessage('ingest')
    async handleIngest(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- socket.io Socket is optional peer dep
        @ConnectedSocket() client: any,
        @MessageBody() body: TrackerEvent | TrackerEvent[],
    ): Promise<{ ok: boolean; count: number }> {
        const events = Array.isArray(body) ? body : [body];

        const ctx: IngestContext = {
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
            ip: (client.handshake?.address as string | undefined) ??
                // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
                (client.handshake?.headers?.['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim(),
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
            headers: client.handshake?.headers as Record<string, string> | undefined,
        };

        let count = 0;
        for (const event of events) {
            try {
                await this.trackerService.track(event, ctx);
                count++;
            } catch (err) {
                this.logger.warn(`Failed to ingest tracker event via WS: ${(err as Error).message}`);
            }
        }

        return { ok: true, count };
    }
}
