// @ts-check
/**
 * js/public-context.js
 *
 * Epic 4, Phase 4A — the public, anonymous-visitor equivalent of Platform
 * Context (js/config.js's getPlatformContext()). Resolves an organisation
 * slug + event slug (from the URL) to the organisation/event/branding an
 * anonymous visitor is looking at.
 *
 * Reads only through the anon-safe public_organisations_info/
 * public_events_info views and the existing anon-readable settings
 * allow-list — never the base organisations/events tables, which have no
 * anon policy at all. The browser never decides tenant identity here: the
 * slug is just a lookup key, and the server (RLS-gated views) is what
 * actually says which organisation/event it maps to.
 */
import { getPublicSupabaseClient, loadPublicSettings, ESF_PUBLIC_CONFIG } from '../supabase-public.js';

/**
 * @typedef {{id: string, slug: string, name: string, website: string|null}} PublicOrg
 * @typedef {{id: string, org_id: string, slug: string, name: string, status: string, booking_prefix: string, is_active: boolean}} PublicEvent
 * @typedef {{org: PublicOrg, event: PublicEvent, branding: Record<string, string>}} PublicContext
 */

/**
 * @param {string} orgSlug
 * @param {string} eventSlug
 * @returns {Promise<PublicContext|null>} null if either slug doesn't resolve
 *   (including an event that exists but isn't published — draft events are
 *   excluded from public_events_info entirely, not just hidden client-side)
 */
export async function resolvePublicContext(orgSlug, eventSlug) {
    if (!orgSlug || !eventSlug) return null;
    const sb = getPublicSupabaseClient();

    const { data: org, error: orgErr } = await sb
        .from('public_organisations_info')
        .select('id, slug, name, website')
        .eq('slug', orgSlug)
        .maybeSingle();
    if (orgErr || !org) return null;

    const { data: event, error: eventErr } = await sb
        .from('public_events_info')
        .select('id, org_id, slug, name, status, booking_prefix, is_active')
        .eq('org_id', org.id)
        .eq('slug', eventSlug)
        .maybeSingle();
    if (eventErr || !event) return null;

    // Same allow-listed settings keys js/config.js's applySettingsToConfig()
    // reads for the admin side, filtered to this org only — not a new
    // mechanism, the existing anon settings policy already covers these rows.
    const { data: settingsRows } = await sb
        .from('settings')
        .select('key, value')
        .eq('org_id', org.id);

    // Event rows override org rows for the same key, same precedence as
    // js/config.js's loadStallCosts() — org applied first, event second.
    const { data: eventSettingsRows } = await sb
        .from('event_settings')
        .select('key, value')
        .eq('event_id', event.id);

    const branding = /** @type {Record<string, string>} */ ({});
    (settingsRows || []).forEach((r) => { branding[r.key] = r.value; });
    (eventSettingsRows || []).forEach((r) => { branding[r.key] = r.value; });

    return { org, event, branding };
}

/**
 * Resolves the org/event a public booking form (Phase 4D) should submit
 * against, from the page URL. Reuses resolvePublicContext()/
 * readSlugsFromLocation() as-is rather than introducing a second resolution
 * path - the only new thing here is the booking-form-specific default: no
 * org/event slug in the URL is not an error, it's the legacy single-tenant
 * case every booking form supported before Phase 4D, so it resolves to
 * { org: null, event: null } instead of calling resolvePublicContext() at
 * all. resolvePublicContext() alone can't make that distinction - a missing
 * slug and a broken slug both resolve falsy - but a booking form needs to
 * tell them apart: one proceeds exactly as it always has, the other means
 * "this link is no longer valid" and must not silently fall back to the
 * default organisation's form. org/event are null together, never one
 * without the other - a plain nullable-field shape narrows cleanly on
 * `if (ctx.event)`, unlike a custom isDefault discriminant.
 * @param {Location} [loc]
 * @returns {Promise<{org: PublicOrg, event: PublicEvent, branding: Record<string, string>} | {org: null, event: null} | null>}
 *   null means a slug WAS present in the URL but didn't resolve to a real
 *   organisation/event - a broken or stale link, not the default case.
 */
export async function resolveBookingFormContext(loc = window.location) {
    const { orgSlug, eventSlug } = readSlugsFromLocation(loc);
    if (!orgSlug || !eventSlug) return { org: null, event: null };

    const ctx = await resolvePublicContext(orgSlug, eventSlug);
    if (!ctx) return null;
    return ctx;
}

/**
 * Full bootstrap for a public booking form page (General_Booking.html /
 * Food_Stall_booking.html): resolves org/event context from the URL, loads
 * that organisation's public settings (so ESF_PUBLIC_CONFIG reflects the
 * right organisation before the caller reads it), and gates the form on the
 * same two conditions submit-booking enforces server-side - the org-level
 * open/closed toggle and, when a real event was resolved, its lifecycle
 * status. Both checks here are UX only; the server is the actual
 * enforcement and re-checks independently, never trusting anything this
 * function returns.
 * @param {string} settingsKey - 'general_bookings_open' or 'food_bookings_open'
 * @returns {Promise<
 *   | { ok: true, orgSlug: string|undefined, eventSlug: string|undefined, bookingPrefix: string, orgName: string|undefined, eventName: string|undefined, regulatoryAuthorityName: string|undefined, insuranceMinimumAmount: string|undefined }
 *   | { ok: false, reason: 'not_found' }
 *   | { ok: false, reason: 'event_not_open', eventStatus: string }
 *   | { ok: false, reason: 'toggle_closed' }
 * >}
 */
export async function initPublicBookingForm(settingsKey) {
    const ctx = await resolveBookingFormContext();
    if (ctx === null) return { ok: false, reason: 'not_found' };

    const orgId = ctx.org ? ctx.org.id : 'org_default';
    await loadPublicSettings(orgId);

    if (ctx.event && ctx.event.status !== 'open') {
        return { ok: false, reason: 'event_not_open', eventStatus: ctx.event.status };
    }

    const sb = getPublicSupabaseClient();
    const { data, error } = await sb.from('settings').select('value').eq('org_id', orgId).eq('key', settingsKey).maybeSingle();
    if (!error && data && data.value !== 'true') {
        return { ok: false, reason: 'toggle_closed' };
    }

    // Version 1.1 Sprint 1, Issue 2 (Regulatory Authority) — org row first,
    // event row overrides it, same precedence as every other org/event
    // settings pair in this app (js/config.js's loadStallCosts() comment
    // documents the same order). Both keys are optional: a org with no row
    // for either gets undefined here, and the caller falls back to generic
    // wording rather than ever inventing a specific authority/amount.
    const declarationSettings = /** @type {Record<string, string>} */ ({});
    const { data: orgDeclRows } = await sb
        .from('settings')
        .select('key, value')
        .eq('org_id', orgId)
        .in('key', ['regulatory_authority_name', 'insurance_minimum_amount']);
    (orgDeclRows || []).forEach((r) => { declarationSettings[r.key] = r.value; });

    if (ctx.event) {
        const { data: eventDeclRows } = await sb
            .from('event_settings')
            .select('key, value')
            .eq('event_id', ctx.event.id)
            .in('key', ['regulatory_authority_name', 'insurance_minimum_amount']);
        (eventDeclRows || []).forEach((r) => { declarationSettings[r.key] = r.value; });
    }

    return {
        ok: true,
        orgSlug: ctx.org ? ctx.org.slug : undefined,
        eventSlug: ctx.event ? ctx.event.slug : undefined,
        // events.booking_prefix is the authoritative source once a real event
        // is resolved (see Phase 4B.1's reasoning for keeping it off
        // settings/event_settings entirely) - ESF_PUBLIC_CONFIG.BOOKING_PREFIX
        // (settings-derived) is only the legacy default-event fallback.
        bookingPrefix: (ctx.event ? ctx.event.booking_prefix : ESF_PUBLIC_CONFIG?.BOOKING_PREFIX) || 'ESF26',
        // undefined (not a fallback string) for the legacy default case - the
        // page's own static "Ella Street Festival 2026" copy is already
        // correct for that case, so the caller only touches the DOM when
        // there's a real resolved name to show instead of it.
        orgName: ctx.org ? ctx.org.name : undefined,
        eventName: ctx.event ? ctx.event.name : undefined,
        regulatoryAuthorityName: declarationSettings.regulatory_authority_name || undefined,
        insuranceMinimumAmount: declarationSettings.insurance_minimum_amount || undefined,
    };
}

/**
 * Reads {orgSlug, eventSlug} from the current URL: path segments first (the
 * pretty /{orgSlug}/{eventSlug} form served once a rewrite maps it to this
 * page while the address bar keeps the pretty path — see vercel.json and
 * scripts/dev-server.mjs), falling back to ?org=&event= query params for
 * direct access without a rewrite in place.
 * @param {Location} [loc]
 */
export function readSlugsFromLocation(loc = window.location) {
    const segments = loc.pathname.split('/').filter(Boolean);
    if (segments.length >= 2) {
        return { orgSlug: decodeURIComponent(segments[0]), eventSlug: decodeURIComponent(segments[1]) };
    }
    const params = new URLSearchParams(loc.search);
    return { orgSlug: params.get('org') || '', eventSlug: params.get('event') || '' };
}
