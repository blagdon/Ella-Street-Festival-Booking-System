// @ts-check
import { initAdminPage } from './supabase.js';
import { initEmailAdmin } from './page-email-admin.js';
import { initSmsAdmin } from './page-sms-admin.js';

// Drives comms_admin.html — the merged Communication Templates page
// (formerly separate email_admin.html / sms_admin.html pages). Both panes'
// data-loading/save/preview logic lives entirely in page-email-admin.js and
// page-sms-admin.js unchanged; this module only owns the tab switch and
// calls initAdminPage() exactly once for the whole page. Calling it twice
// (once per pane's own module, as each did when it was a standalone page)
// would re-run initNavigation() and re-attach the nav header's Sign Out /
// instance-selector listeners a second time.
const TABS = ['email', 'sms'];

function activeTabFromUrl() {
    const t = new URLSearchParams(location.search).get('tab');
    return TABS.includes(t) ? t : 'email';
}

// Mirrors audit_log.html's ?target=<bookingId> deep-link convention, applied
// to which tab is open — so a link/bookmark to ?tab=sms opens straight into
// the SMS pane instead of always defaulting to Email.
function setActiveTab(tab) {
    for (const t of TABS) {
        document.getElementById(`${t}-pane`).classList.toggle('hidden', t !== tab);
        document.getElementById(`tab-btn-${t}`).classList.toggle('tab-active', t === tab);
    }
    const url = new URL(location.href);
    url.searchParams.set('tab', tab);
    history.replaceState(null, '', url);
}

function init() {
    // Both panes' data load regardless of which tab is visible — cheap, and
    // simpler than teaching either module to lazily init on first activation.
    initEmailAdmin();
    initSmsAdmin();

    // One delegated listener on document.body, matching the data-action
    // convention used throughout this app (see HANDOVER's "No inline event
    // handlers" — CSP has no 'unsafe-inline' for script-src).
    document.body.addEventListener('click', (e) => {
        const target = /** @type {Element} */ (e.target);
        const btn = target.closest('[data-tab]');
        if (btn instanceof HTMLElement) setActiveTab(btn.dataset.tab);
    });

    setActiveTab(activeTabFromUrl());
}

initAdminPage(init);
