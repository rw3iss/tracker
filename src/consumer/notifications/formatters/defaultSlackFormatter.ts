import type { NotificationData } from '../types';
import type { StoredTrackerEvent } from '../../../common/types';

export type SlackBlock =
  | { type: 'header'; text: { type: 'plain_text'; text: string; emoji?: boolean } }
  | { type: 'section'; text: { type: 'mrkdwn'; text: string } }
  | { type: 'context'; elements: Array<{ type: 'mrkdwn'; text: string }> }
  | { type: 'divider' };

export interface SlackPayload {
  text:        string;
  blocks:      SlackBlock[];
  username?:   string;
  icon_emoji?: string;
}

export type SlackFormatter = (data: NotificationData) => SlackPayload;

function stackFirstLines(stack: string, count: number): string {
  return stack.split('\n').slice(0, count).join('\n');
}

export function defaultSlackFormatter(data: NotificationData): SlackPayload {
  const event  = data.body as StoredTrackerEvent;
  const type   = event.type.toUpperCase();
  const blocks: SlackBlock[] = [];

  blocks.push({
    type: 'header',
    text: { type: 'plain_text', text: `[${type}] ${event.message}`, emoji: true },
  });

  blocks.push({ type: 'divider' });

  blocks.push({
    type: 'section',
    text: { type: 'mrkdwn', text: `*Message:* ${event.message}` },
  });

  if (event.error?.stack) {
    const snippet = stackFirstLines(event.error.stack, 3);
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*Stack trace:*\n\`\`\`${snippet}\`\`\`` },
    });
  }

  const contextParts: string[] = [
    `*App:* ${event.appId ?? 'unknown'}`,
    `*Timestamp:* ${new Date(event.timestamp).toISOString()}`,
    `*Status:* ${event.status}`,
  ];
  if (event.category) contextParts.push(`*Category:* ${event.category}`);

  blocks.push({
    type: 'context',
    elements: contextParts.map(text => ({ type: 'mrkdwn' as const, text })),
  });

  return {
    text:   `[${type}] ${event.message}`,
    blocks,
  };
}
