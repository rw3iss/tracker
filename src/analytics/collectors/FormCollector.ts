import { ANALYTICS_CATEGORY, AnalyticsEvent } from '../vocabulary';
import type { ICollector, CollectorEmit } from './ICollector';
import type { FormConfig } from '../types';

/**
 * Emits `form_start` (first focus) and `form_submit` for every `<form>` on
 * the page.
 *
 * Implementation notes:
 * - Listeners are delegated at the document root so dynamically-added forms
 *   are tracked without re-binding.
 * - Per-form "started" tracking uses a `WeakSet` keyed by the form element,
 *   so closing/re-opening a form doesn't leak entries.
 * - The form's identifier is resolved from configured precedence
 *   (default: `name` → `id` → `action`). Forms with no identifier still
 *   emit but with `form_id: undefined`.
 *
 * **Privacy:** field values are never captured. `form_submit` reports
 * `field_count` and (optionally) the submit button's text/id, nothing more.
 */
export class FormCollector implements ICollector {
  private readonly identifyAttrs: string[];
  private readonly emitStart: boolean;
  private readonly emitSubmit: boolean;
  private startedForms = new WeakSet<HTMLFormElement>();
  private focusListener: ((e: FocusEvent) => void) | null = null;
  private submitListener: ((e: SubmitEvent) => void) | null = null;
  private installed = false;

  constructor(private readonly emit: CollectorEmit, config: FormConfig | true | undefined) {
    if (config === true || config === undefined) {
      this.emitStart = true;
      this.emitSubmit = true;
      this.identifyAttrs = ['name', 'id', 'action'];
    } else {
      this.emitStart = config.start ?? true;
      this.emitSubmit = config.submit ?? true;
      this.identifyAttrs = (config.identify ?? 'name|id|action').split('|').map(s => s.trim()).filter(Boolean);
    }
  }

  install(): void {
    if (this.installed || typeof document === 'undefined') return;
    this.installed = true;

    if (this.emitStart) {
      const onFocus = (event: FocusEvent): void => this.handleFocus(event);
      this.focusListener = onFocus;
      document.addEventListener('focusin', onFocus, { capture: true });
    }

    if (this.emitSubmit) {
      const onSubmit = (event: SubmitEvent): void => this.handleSubmit(event);
      this.submitListener = onSubmit;
      document.addEventListener('submit', onSubmit, { capture: true });
    }
  }

  uninstall(): void {
    if (!this.installed) return;
    this.installed = false;
    if (this.focusListener && typeof document !== 'undefined') {
      document.removeEventListener('focusin', this.focusListener, { capture: true } as EventListenerOptions);
    }
    if (this.submitListener && typeof document !== 'undefined') {
      document.removeEventListener('submit', this.submitListener, { capture: true } as EventListenerOptions);
    }
    this.focusListener = null;
    this.submitListener = null;
    this.startedForms = new WeakSet();
  }

  // ── Internals ──────────────────────────────────────────────────────────

  private handleFocus(event: FocusEvent): void {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const form = target.closest('form') as HTMLFormElement | null;
    if (!form) return;
    if (this.startedForms.has(form)) return;
    this.startedForms.add(form);
    this.emit({
      message:  AnalyticsEvent.FormStart,
      category: ANALYTICS_CATEGORY,
      payload: {
        form_id: this.resolveId(form),
        // Field count at start — useful as a baseline; submit reports it again.
        field_count: form.elements.length,
      },
    });
  }

  private handleSubmit(event: SubmitEvent): void {
    const form = (event.target instanceof HTMLFormElement) ? event.target : null;
    if (!form) return;
    const submitter = (event.submitter instanceof HTMLButtonElement || event.submitter instanceof HTMLInputElement)
      ? event.submitter : null;
    this.emit({
      message:  AnalyticsEvent.FormSubmit,
      category: ANALYTICS_CATEGORY,
      payload: {
        form_id:        this.resolveId(form),
        field_count:    form.elements.length,
        submit_text:    submitter ? truncate(((submitter as HTMLInputElement).value ?? submitter.textContent ?? '').trim(), 128) : undefined,
        submit_id:      submitter?.id || undefined,
      },
    });
    // Reset on submit — if the form is re-rendered post-submit, a new focus
    // can re-emit `form_start`.
    this.startedForms.delete(form);
  }

  private resolveId(form: HTMLFormElement): string | undefined {
    for (const attr of this.identifyAttrs) {
      const value = form.getAttribute(attr);
      if (value) return value;
    }
    return undefined;
  }
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
