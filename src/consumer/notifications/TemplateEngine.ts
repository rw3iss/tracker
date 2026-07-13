import type { StoredTrackerEvent } from '../../common/types';

export interface TemplateContext {
  event: StoredTrackerEvent;
  [key: string]: unknown;
}

export interface NotificationTemplates {
  email?: {
    subject?: string;
    html?:    string;
    text?:    string;
  };
}

/**
 * Render a template string, resolving `{{path.to.value}}` from ctx.
 * Missing paths resolve to an empty string.
 */
export function renderTemplate(template: string, ctx: TemplateContext): string {
  return template.replace(/\{\{([^}]+)\}\}/g, (_match, path: string) => {
    const parts = path.trim().split('.');
    let value: unknown = ctx;
    for (const part of parts) {
      if (value == null || typeof value !== 'object') return '';
      value = (value as Record<string, unknown>)[part];
    }
    return value == null ? '' : String(value);
  });
}

/**
 * Build a TemplateContext from a stored event, with optional extra fields.
 */
export function buildTemplateContext(
  event: StoredTrackerEvent,
  extra?: Record<string, unknown>,
): TemplateContext {
  return { event, ...extra };
}
