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
import { getPublicSupabaseClient } from '../supabase-public.js';

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
