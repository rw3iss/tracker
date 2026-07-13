/**
 * @jest-environment jsdom
 */
import { AutoCtaTracker } from '../../../src/ga/AutoCtaTracker';

describe('AutoCtaTracker', () => {
  let emitted: Array<{ name: string; params: Record<string, unknown> }>;
  let trackers: AutoCtaTracker[];
  const emit = (name: string, params: Record<string, unknown>): void => {
    emitted.push({ name, params });
  };
  /** Helper: create + auto-track for cleanup in afterEach. */
  const make = (opts?: ConstructorParameters<typeof AutoCtaTracker>[1]): AutoCtaTracker => {
    const t = new AutoCtaTracker(emit, opts);
    trackers.push(t);
    return t;
  };

  beforeEach(() => {
    emitted = [];
    trackers = [];
    document.body.innerHTML = '';
  });
  afterEach(() => {
    for (const t of trackers) t.uninstall();
  });

  it('emits cta_click with cta_id from data-cta-id attribute', () => {
    document.body.innerHTML = `
      <button data-cta-id="hero-signup">Sign up</button>
    `;
    const tracker = make();
    tracker.install();

    document.querySelector('button')!.click();
    expect(emitted).toHaveLength(1);
    expect(emitted[0].name).toBe('cta_click');
    expect(emitted[0].params.cta_id).toBe('hero-signup');
    expect(emitted[0].params.cta_text).toBe('Sign up');
    expect(emitted[0].params.cta_tag).toBe('button');
  });

  it('matches via closest() — click on a child triggers the wrapper', () => {
    document.body.innerHTML = `
      <button data-cta-id="card-cta">
        <span class="icon">→</span>
        <span class="label">Read more</span>
      </button>
    `;
    make().install();
    document.querySelector('span.icon')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(emitted).toHaveLength(1);
    expect(emitted[0].params.cta_id).toBe('card-cta');
  });

  it('captures data-* attributes as cta_<name>', () => {
    document.body.innerHTML = `
      <button data-cta-id="checkout-confirm" data-cta-section="hero" data-cta-variant="A">Buy</button>
    `;
    make().install();
    document.querySelector('button')!.click();
    expect(emitted[0].params.cta_section).toBe('hero');
    expect(emitted[0].params.cta_variant).toBe('A');
  });

  it('falls back to id when data-cta-id is missing', () => {
    document.body.innerHTML = `<button data-cta id="login-btn">Log in</button>`;
    make().install();
    document.querySelector('button')!.click();
    expect(emitted[0].params.cta_id).toBe('login-btn');
  });

  it('falls back to slugified text when no id either', () => {
    document.body.innerHTML = `
      <a href="/about" data-cta>About Us — Learn More!</a>
    `;
    make().install();
    document.querySelector('a')!.click();
    expect(emitted[0].params.cta_id).toBe('about-us-learn-more');
  });

  it('captures href on anchor elements', () => {
    document.body.innerHTML = `<a href="/contact" data-cta-id="footer-contact">Contact</a>`;
    make().install();
    document.querySelector('a')!.click();
    expect(emitted[0].params.cta_href).toMatch(/\/contact$/);
  });

  it('skips elements not matching the selector', () => {
    document.body.innerHTML = `
      <button>Untracked</button>
      <button data-cta-id="tracked">Tracked</button>
    `;
    make().install();
    (document.querySelectorAll('button')[0] as HTMLButtonElement).click();
    expect(emitted).toHaveLength(0);
    (document.querySelectorAll('button')[1] as HTMLButtonElement).click();
    expect(emitted).toHaveLength(1);
  });

  it('honors a custom selector — track all buttons + links', () => {
    document.body.innerHTML = `
      <button id="b1">Click 1</button>
      <a href="/x" id="l1">Click 2</a>
    `;
    make({ selector: 'button, a', fallback: ['id', 'text'] }).install();
    (document.querySelector('#b1') as HTMLButtonElement).click();
    (document.querySelector('#l1') as HTMLAnchorElement).click();
    expect(emitted).toHaveLength(2);
    expect(emitted[0].params.cta_id).toBe('b1');
    expect(emitted[1].params.cta_id).toBe('l1');
  });

  it('skips when filter returns false', () => {
    document.body.innerHTML = `<button data-cta-id="internal">Internal</button>`;
    make({
      filter: (el) => el.getAttribute('data-cta-id') !== 'internal',
    }).install();
    document.querySelector('button')!.click();
    expect(emitted).toHaveLength(0);
  });

  it('merges enrich() output into payload, drops on null', () => {
    document.body.innerHTML = `
      <div data-step="3"><button data-cta-id="next">Next</button></div>
      <button data-cta-id="skip">Skip</button>
    `;
    make({
      enrich: (el) => {
        if (el.getAttribute('data-cta-id') === 'skip') return null;
        const step = el.closest<HTMLElement>('[data-step]')?.dataset.step;
        return step ? { checkout_step: step } : null;
      },
    }).install();
    (document.querySelectorAll('button')[0] as HTMLButtonElement).click();
    (document.querySelectorAll('button')[1] as HTMLButtonElement).click();
    expect(emitted).toHaveLength(1);
    expect(emitted[0].params.checkout_step).toBe('3');
  });

  it('uninstall() detaches the listener', () => {
    document.body.innerHTML = `<button data-cta-id="x">x</button>`;
    const tracker = make();
    tracker.install();
    tracker.uninstall();
    document.querySelector('button')!.click();
    expect(emitted).toHaveLength(0);
  });

  // ── cta-id (no data- prefix) — alias coverage ────────────────────────
  it("matches the bare 'cta-id' attribute via the default selector", () => {
    document.body.innerHTML = `<button cta-id="hero-buy">Buy</button>`;
    make().install();
    document.querySelector('button')!.click();
    expect(emitted).toHaveLength(1);
    expect(emitted[0].params.cta_id).toBe('hero-buy');
  });

  it("falls back to the bare 'cta-id' attribute when data-cta-id is missing", () => {
    // Element has both `data-cta` (matches selector, empty value) and a
    // populated `cta-id`. The fallback chain should resolve via cta-id.
    document.body.innerHTML = `<button data-cta cta-id="footer-contact">Contact</button>`;
    make().install();
    document.querySelector('button')!.click();
    expect(emitted[0].params.cta_id).toBe('footer-contact');
  });

  it("accepts 'cta-id', 'data-cta-id', 'data-cta' as bare fallback names", () => {
    document.body.innerHTML = `
      <button id="row1" data-cta-id="primary">A</button>
      <button id="row2" data-cta="secondary">B</button>
      <button id="row3" cta-id="tertiary">C</button>
    `;
    make({
      selector: 'button',
      // No need for the `attr:` prefix — these names are recognised directly.
      fallback: ['data-cta-id', 'data-cta', 'cta-id', 'id'],
    }).install();
    (document.querySelectorAll('button')[0] as HTMLButtonElement).click();
    (document.querySelectorAll('button')[1] as HTMLButtonElement).click();
    (document.querySelectorAll('button')[2] as HTMLButtonElement).click();
    expect(emitted.map((e) => e.params.cta_id)).toEqual(['primary', 'secondary', 'tertiary']);
  });
});
