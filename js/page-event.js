// @ts-check
/**
 * js/page-event.js
 * Epic 4, Phase 4A — minimal public landing page proving org/event
 * resolution end to end (organisation slug + event slug -> Public Context ->
 * branding). Deliberately not a booking page: Phase 4D (Public Booking)
 * replaces the hardcoded org_default routing separately; this page only
 * demonstrates that the resolver correctly identifies who a visitor is
 * looking at and shows their branding.
 */
import { resolvePublicContext, readSlugsFromLocation } from './public-context.js';
import { escapeHtml } from './utils.js';

const STATUS_LABELS = {
    ready: 'Coming soon',
    open: 'Bookings open',
    closed: 'Bookings closed',
    archived: 'Past event'
};

function renderNotFound(root) {
    root.innerHTML = `
    <h1 class="text-xl font-bold text-gray-900 mb-2">Event not found</h1>
    <p class="text-sm text-gray-500">This link doesn't match a published event. Check the address, or contact the organiser who sent it to you.</p>
    `; // innerhtml-safe: static content, no interpolation
}

function renderEvent(root, ctx) {
    const { org, event, branding } = ctx;
    const primaryColor = branding.brand_primary_color || '#1d4ed8';
    const statusLabel = STATUS_LABELS[event.status] || event.status;

    const logoHtml = branding.logo_url
        ? `<img id="eventOrgLogo" src="${escapeHtml(branding.logo_url)}" alt="${escapeHtml(org.name)}" class="h-14 w-auto max-w-full object-contain mx-auto mb-4">`
        : '';

    root.innerHTML = `
    ${logoHtml}
    <p class="text-xs font-bold uppercase tracking-wider text-gray-500 mb-1">${escapeHtml(org.name)}</p>
    <h1 class="text-2xl font-extrabold text-gray-900 mb-2">${escapeHtml(event.name)}</h1>
    <span class="inline-flex items-center px-3 py-1 rounded-full text-xs font-bold" style="background-color:${escapeHtml(primaryColor)}1a; color:${escapeHtml(primaryColor)};">${escapeHtml(statusLabel)}</span>
    ${branding.org_support_email ? `<p class="text-sm text-gray-500 mt-6">Questions? <a href="mailto:${escapeHtml(branding.org_support_email)}" class="underline">${escapeHtml(branding.org_support_email)}</a></p>` : ''}
    `; // innerhtml-safe: every interpolated value passed through escapeHtml

    // addEventListener, not an inline onerror= attribute — this app's CSP
    // has no 'unsafe-inline' for script-src, so an inline handler would be
    // silently blocked (see HANDOVER.md's "No inline event handlers" gotcha;
    // js/nav.js's org-logo fix hit exactly this same mistake once already).
    document.getElementById('eventOrgLogo')?.addEventListener('error', function () {
        this.remove();
    });

    document.title = `${event.name} — ${org.name}`;
}

(async function init() {
    const root = document.getElementById('eventRoot');
    if (!root) return;

    const { orgSlug, eventSlug } = readSlugsFromLocation();
    const ctx = await resolvePublicContext(orgSlug, eventSlug);

    if (!ctx) {
        renderNotFound(root);
        return;
    }
    renderEvent(root, ctx);
})();
