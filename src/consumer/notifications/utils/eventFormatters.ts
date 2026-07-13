import type { StoredTrackerEvent } from '../../../common/types';

export function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 3) + '...';
}

export function serializeEventToText(event: StoredTrackerEvent): string {
  const lines: string[] = [
    `ID:         ${event.id}`,
    `Type:       ${event.type}`,
    `Message:    ${event.message}`,
    `App:        ${event.appId ?? 'unknown'}`,
    `Timestamp:  ${new Date(event.timestamp).toISOString()}`,
    `ReceivedAt: ${new Date(event.receivedAt).toISOString()}`,
    `Status:     ${event.status}`,
  ];
  if (event.category)     lines.push(`Category:   ${event.category}`);
  if (event.tags?.length) lines.push(`Tags:       ${event.tags.join(', ')}`);
  if (event.error)        lines.push(`Error:      ${event.error.name}: ${event.error.message}`);
  if (event.error?.stack) lines.push(`Stack:\n${event.error.stack}`);
  if (event.payload)      lines.push(`Payload:    ${JSON.stringify(event.payload, null, 2)}`);
  if (event.context)      lines.push(`Context:    ${JSON.stringify(event.context, null, 2)}`);
  return lines.join('\n');
}

export function serializeEventToHtml(event: StoredTrackerEvent): string {
  const esc = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const rows = (pairs: [string, string][]) =>
    pairs
      .map(
        ([k, v]) =>
          `<tr><td style="font-weight:bold;padding:4px 8px;vertical-align:top">${esc(k)}</td>` +
          `<td style="padding:4px 8px"><pre style="margin:0">${esc(v)}</pre></td></tr>`,
      )
      .join('');

  const pairs: [string, string][] = [
    ['ID',         event.id],
    ['Type',       event.type],
    ['Message',    event.message],
    ['App',        event.appId ?? 'unknown'],
    ['Timestamp',  new Date(event.timestamp).toISOString()],
    ['ReceivedAt', new Date(event.receivedAt).toISOString()],
    ['Status',     event.status],
  ];
  if (event.category)     pairs.push(['Category',  event.category]);
  if (event.tags?.length) pairs.push(['Tags', event.tags.join(', ')]);
  if (event.error)        pairs.push(['Error', `${event.error.name}: ${event.error.message}`]);
  if (event.error?.stack) pairs.push(['Stack', event.error.stack]);
  if (event.payload)      pairs.push(['Payload', JSON.stringify(event.payload, null, 2)]);
  if (event.context)      pairs.push(['Context', JSON.stringify(event.context, null, 2)]);

  return `
<html><body style="font-family:monospace;font-size:13px">
<h2 style="color:#c0392b">[${esc(event.type.toUpperCase())}] ${esc(event.message)}</h2>
<table style="border-collapse:collapse">${rows(pairs)}</table>
</body></html>`.trim();
}
