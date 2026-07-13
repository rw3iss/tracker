/* ──────────────────────────────────────────────────────────────────────────────
   @rw3iss/tracker — docs UX patches
   Preserve sidebar scroll position across page navigations.
   TypeDoc generates static HTML per page, so every click rebuilds the DOM —
   we persist `.site-menu` scrollTop in sessionStorage and restore it on load.
   ────────────────────────────────────────────────────────────────────────────── */

(function () {
    const SCROLL_KEY = 'rw3iss-tracker-docs:sidebar-scroll';

    function getSidebar() {
        return document.querySelector('.site-menu');
    }

    function restore() {
        const sidebar = getSidebar();
        if (!sidebar) return;
        const saved = sessionStorage.getItem(SCROLL_KEY);
        if (saved !== null) sidebar.scrollTop = parseInt(saved, 10) || 0;
    }

    function save() {
        const sidebar = getSidebar();
        if (sidebar) sessionStorage.setItem(SCROLL_KEY, String(sidebar.scrollTop));
    }

    // Restore as early as possible — run on DOMContentLoaded and once more
    // after layout settles (images/fonts can shift scrollHeight).
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', restore, { once: true });
    } else {
        restore();
    }
    window.addEventListener('load', restore, { once: true });

    // Save on any sidebar scroll (throttled via rAF)
    let ticking = false;
    document.addEventListener(
        'scroll',
        (e) => {
            const t = e.target;
            // The scroll event target for an element scroller is the element itself (not a Node that supports closest)
            if (!t || !(t instanceof Element) || !t.classList?.contains('site-menu')) return;
            if (ticking) return;
            ticking = true;
            requestAnimationFrame(() => {
                save();
                ticking = false;
            });
        },
        true, // capture — internal scroll events don't bubble
    );

    // Save right before we navigate (covers clicks on sidebar links and anywhere else)
    window.addEventListener('beforeunload', save);
    document.addEventListener(
        'click',
        (e) => {
            const link = e.target?.closest?.('a');
            if (link && link.href && !link.target) save();
        },
        true,
    );
})();
