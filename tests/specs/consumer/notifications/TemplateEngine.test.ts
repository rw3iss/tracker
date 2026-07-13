import { renderTemplate, buildTemplateContext } from '../../../../src/consumer/notifications/TemplateEngine';
import { TrackerEventStatus } from '../../../../src/common/types';
import type { StoredTrackerEvent } from '../../../../src/common/types';

function makeEvent(overrides: Partial<StoredTrackerEvent> = {}): StoredTrackerEvent {
  return {
    id:         'evt-1',
    type:       'error',
    message:    'something broke',
    status:     TrackerEventStatus.New,
    timestamp:  1_700_000_000_000,
    receivedAt: 1_700_000_000_000,
    appId:      'test-app',
    ...overrides,
  };
}

describe('renderTemplate', () => {
  it('resolves a top-level path', () => {
    const ctx = { event: makeEvent(), greeting: 'hello' };
    expect(renderTemplate('{{greeting}}', ctx)).toBe('hello');
  });

  it('resolves a nested path', () => {
    const ctx = buildTemplateContext(makeEvent());
    expect(renderTemplate('Event type: {{event.type}}', ctx)).toBe('Event type: error');
  });

  it('resolves deeply nested path', () => {
    const ctx = buildTemplateContext(makeEvent());
    expect(renderTemplate('App: {{event.appId}}', ctx)).toBe('App: test-app');
  });

  it('returns empty string for missing path', () => {
    const ctx = buildTemplateContext(makeEvent());
    expect(renderTemplate('{{event.nonExistent}}', ctx)).toBe('');
  });

  it('returns empty string for null/undefined mid-path', () => {
    const ctx = buildTemplateContext(makeEvent());
    expect(renderTemplate('{{event.context.userId}}', ctx)).toBe('');
  });

  it('renders multiple placeholders in one string', () => {
    const ctx = buildTemplateContext(makeEvent());
    const tpl = 'App {{event.appId}} received {{event.type}}';
    expect(renderTemplate(tpl, ctx)).toBe('App test-app received error');
  });

  it('passes through template with no placeholders', () => {
    const ctx = buildTemplateContext(makeEvent());
    expect(renderTemplate('no placeholders here', ctx)).toBe('no placeholders here');
  });

  it('handles extra fields from buildTemplateContext', () => {
    const ctx = buildTemplateContext(makeEvent(), { env: 'production' });
    expect(renderTemplate('{{env}}', ctx)).toBe('production');
  });
});

describe('buildTemplateContext', () => {
  it('places the event under ctx.event', () => {
    const event = makeEvent();
    const ctx   = buildTemplateContext(event);
    expect(ctx.event).toBe(event);
  });

  it('merges extra fields at the top level', () => {
    const ctx = buildTemplateContext(makeEvent(), { foo: 'bar', num: 42 });
    expect(ctx.foo).toBe('bar');
    expect(ctx.num).toBe(42);
  });
});
