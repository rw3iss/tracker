import type { NotificationData } from '../types';
import type { StoredTrackerEvent } from '../../../common/types';
import type { EventType } from '../../../common/types';

export interface DiscordEmbed {
  title:       string;
  description: string;
  /** Decimal color: error=red(15158332), warning=yellow(16776960), info=blue(3447003), event=green(5763719) */
  color:       number;
  fields:      Array<{ name: string; value: string; inline?: boolean }>;
  timestamp:   string; // ISO 8601
}

export interface DiscordPayload {
  content?:    string;
  username?:   string;
  avatar_url?: string;
  embeds:      DiscordEmbed[];
}

export type DiscordFormatter = (data: NotificationData) => DiscordPayload;

const COLORS: Record<EventType, number> = {
  error:   15158332, // red
  warning: 16776960, // yellow
  info:    3447003,  // blue
  debug:   9807270,  // grey
  event:   5763719,  // green
};

export function defaultDiscordFormatter(data: NotificationData): DiscordPayload {
  const event  = data.body as StoredTrackerEvent;
  const color  = COLORS[event.type] ?? COLORS.info;
  const fields: DiscordEmbed['fields'] = [
    { name: 'App',       value: event.appId ?? 'unknown',                       inline: true },
    { name: 'Status',    value: event.status,                                   inline: true },
    { name: 'Timestamp', value: new Date(event.timestamp).toISOString(),         inline: false },
  ];

  if (event.category) {
    fields.push({ name: 'Category', value: event.category, inline: true });
  }
  if (event.tags?.length) {
    fields.push({ name: 'Tags', value: event.tags.join(', '), inline: true });
  }
  if (event.error) {
    fields.push({ name: 'Error', value: `${event.error.name}: ${event.error.message}`, inline: false });
  }

  const embed: DiscordEmbed = {
    title:       `[${event.type.toUpperCase()}] ${event.message}`,
    description: data.subject,
    color,
    fields,
    timestamp:   new Date(event.timestamp).toISOString(),
  };

  return { embeds: [embed] };
}
