import { initAdminPage } from './supabase.js';
import { initEmailQueue } from './page-email-queue.js';
import { initSmsQueue } from './page-sms-queue.js';

// Drives message_queue.html — the merged Message Queue page (formerly
// separate email_queue.html / sms_queue.html pages). Both panes' data
// loading/search/retry logic lives entirely in page-email-queue.js and
// page-sms-queue.js unchanged; this module only owns the tab switch and
// calls initAdminPage() exactly once for the whole page — see
// page-comms-admin.js's identical rationale.
const TABS = ['email', 'sms'];

function activeTabFromUrl() {
    const t = new URLSearchParams(location.search).get('tab');
    return TABS.includes(t) ? t : 'email';
}

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
    initEmailQueue();
    initSmsQueue();

    document.body.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-tab]');
        if (btn) setActiveTab(btn.dataset.tab);
    });

    setActiveTab(activeTabFromUrl());
}

initAdminPage(init);
