import type { Server as HttpServer } from 'node:http';
import type { Server as HttpsServer } from 'node:https';
import type { TrackerService } from './TrackerService';
import type { IngestContext } from './ITrackerPlugin';
import type { TrackerEvent } from '../common/types';

export interface WsIngestGatewayOptions {
  path?: string;
}

interface WssLike {
  close(cb?: () => void): void;
}

export class WsIngestGateway {
  private wss: WssLike | null = null;

  constructor(
    private readonly service: TrackerService,
    private readonly opts?: WsIngestGatewayOptions,
  ) {}

  attach(server: HttpServer | HttpsServer): void {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- optional peer dep, loaded at runtime
    const ws = require('ws') as { WebSocketServer: new (opts: Record<string, unknown>) => WssLike & { on(event: string, handler: (...args: unknown[]) => void): void } };
    const { WebSocketServer } = ws;

    const wss = new WebSocketServer({
      server: server as unknown as Record<string, unknown>,
      path:   this.opts?.path ?? '/tracker/ws',
    });

    this.wss = wss;

    wss.on('connection', (...args: unknown[]) => {
      const socket = args[0] as { send(data: string): void; on(event: string, handler: (...a: unknown[]) => void): void };
      const req    = args[1] as { headers: Record<string, string | string[] | undefined>; socket: { remoteAddress?: string } };

      const forwardedFor = req.headers['x-forwarded-for'];
      const ip: string | undefined =
        typeof forwardedFor === 'string'
          ? forwardedFor.split(',')[0]?.trim()
          : (req.socket.remoteAddress ?? undefined);

      socket.on('message', async (...msgArgs: unknown[]) => {
        const raw   = msgArgs[0] as { toString(): string };
        const ctx: IngestContext = { ip };
        let parsed: unknown;

        try {
          parsed = JSON.parse(raw.toString());
        } catch {
          socket.send(JSON.stringify({ ok: false, error: 'Invalid JSON' }));
          return;
        }

        const events: TrackerEvent[] = Array.isArray(parsed) ? parsed : [parsed as TrackerEvent];
        let count = 0;

        for (const event of events) {
          try {
            await this.service.track(event, ctx);
            count++;
          } catch {
            // skip invalid events
          }
        }

        socket.send(JSON.stringify({ ok: true, count }));
      });
    });
  }

  close(): void {
    this.wss?.close();
    this.wss = null;
  }
}
