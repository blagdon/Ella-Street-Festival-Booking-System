// @ts-check
import { ESF_PUBLIC_CONFIG } from '../supabase-public.js';
/**
 * config.js
 * Central configuration constants for the application.
 */

/**
 * Resolves the active event's booking prefix from localStorage or configuration fallback.
 */
export function getActiveBookingPrefix() {
    if (typeof localStorage !== 'undefined') {
        try {
            const cached = localStorage.getItem('ESF_ACTIVE_EVENT');
            if (cached) {
                const parsed = JSON.parse(cached);
                if (parsed && parsed.booking_prefix) return parsed.booking_prefix;
            }
        } catch (e) {
            // fallback to default
        }
    }
    return ESF_PUBLIC_CONFIG?.BOOKING_PREFIX || "ESF26";
}

export const CONFIG = {
    // Database Prefixes (Strictly enforces data separation)
    get INSTANCE_MAP() {
        const prefix = getActiveBookingPrefix();
        return {
            'DEV': `${prefix}-DEV-`,
            'FOOD': `${prefix}-FOOD-`,
            'GENERAL': `${prefix}-NONFOOD-`, // 'General' maps to Non-Food data
            'MISC': `${prefix}-MISC-`        // 'MISC' for non-bookable facilities
        };
    },

    // Regulatory Authority (V1.1 Sprint 1, Issue 2) — empty until loaded from
    // the settings table (regulatory_authority_name/insurance_minimum_amount)
    // via applySettingsToConfig(). No hardcoded default: callers fall back to
    // generic wording when empty, same pattern as SENTRY_BROWSER_LOADER_URL
    // above.
    REGULATORY_AUTHORITY_NAME: '',
    INSURANCE_MINIMUM_AMOUNT: '',

    // Displayed in the admin header (js/nav.js). Falls back to this default
    // until overridden by the festival_display_name settings-table value.
    FESTIVAL_DISPLAY_NAME: 'Ella Street Festival',

    // Deployment URLs
    // ⚠️  Single source of truth is supabase-public.js (or the settings table).
    //     If the Vercel deployment URL changes, update it there.
    URLS: {
        BASE: ESF_PUBLIC_CONFIG.BASE_URL,
        CANCEL_URL: ESF_PUBLIC_CONFIG.CANCEL_URL,
        PORTAL_URL: ESF_PUBLIC_CONFIG.PORTAL_URL
    },

    // Structured bank-transfer details used to build the {{bank_details}}
    // email placeholder — single source of truth is the settings table
    // (bank_account_name/bank_sort_code/bank_account_number), the same
    // fields shown on the Bank Transfer Payment Details settings card.
    BANK_ACCOUNT_NAME: '',
    BANK_SORT_CODE: '',
    BANK_ACCOUNT_NUMBER: '',

    // Error monitoring — empty until loaded from the settings table
    // (sentry_browser_loader_url) via applySettingsToConfig(). No hardcoded
    // default: this app ships with monitoring off until an admin configures
    // it via settings.html, same as every other integration here.
    SENTRY_BROWSER_LOADER_URL: '',

    // Organisation branding — empty until loaded from the org-scoped settings
    // table (logo_url/logo_light_url) via applySettingsToConfig(), the same
    // per-org settings fetch loadStallCosts() already performs on every admin
    // page load. No hardcoded default: js/nav.js falls back to the plain text
    // FESTIVAL_DISPLAY_NAME header when LOGO_URL is empty, exactly as it did
    // before any organisation had a logo configured.
    BRANDING: {
        LOGO_URL: '',
        LOGO_LIGHT_URL: ''
    },

    // UI Configuration
    UI: {
        // No hardcoded defaults — populated entirely from the settings table
        // (stall_cost_food/general/dev) via loadStallCosts(). getStallCost()
        // below falls back to 0 if a value hasn't loaded yet.
        STALL_COST: {
            FOOD: null,
            GENERAL: null,
            DEV: null
        },
        STATUS_LIST: ['Pending', 'Payment Requested', 'Confirmed', 'Rejected', 'Cancelled'],
        // No hardcoded defaults — populated entirely from the settings table
        // (allowed_stall_types) via loadStallCosts()/applySettingsToConfig().
        ALLOWED_TYPES: [],
        STATUS_COLORS: {
            'Pending': 'bg-yellow-100 text-yellow-700',
            'Payment Requested': 'bg-indigo-100 text-indigo-700',
            'Confirmed': 'bg-green-100 text-green-700',
            'Rejected': 'bg-red-100 text-red-700',
            'Cancelled': 'bg-gray-100 text-gray-700'
        }
    },

    // Supabase Credentials (Public/Anon — used by admin pages via ES module import)
    // ⚠️  Single source of truth is /supabase-public.js.
    //     If you rotate the anon key or change the URL, update it in supabase-public.js only.
    SUPABASE: {
        get URL() {
            return (typeof window !== 'undefined' && window.ESF_PUBLIC_CONFIG?.SUPABASE_URL) || ESF_PUBLIC_CONFIG.SUPABASE_URL;
        },
        get KEY() {
            return (typeof window !== 'undefined' && window.ESF_PUBLIC_CONFIG?.SUPABASE_KEY) || ESF_PUBLIC_CONFIG.SUPABASE_KEY;
        }
    }
};

// ===================================================================
// === PLATFORM FOUNDATION — Phase 1 constants ===
// ===================================================================

/**
 * The ID of the organisation that owns this deployment.
 *
 * Phase 1: always 'org_default' — there is only one organisation.
 * Phase 2: derived from the authenticated user's JWT claims or an
 *           organisation_members lookup, allowing the same codebase
 *           to serve multiple tenant organisations.
 */
export function getCurrentOrgId() {
    return (typeof localStorage !== 'undefined' && localStorage.getItem('ESF_ORG_ID'))
        ? localStorage.getItem('ESF_ORG_ID')
        : 'org_default';
}

/**
 * Sets the active organisation ID in localStorage.
 * @param {string} orgId
 */
export function setCurrentOrgId(orgId) {
    if (typeof localStorage !== 'undefined') {
        if (orgId && orgId !== 'org_default') {
            localStorage.setItem('ESF_ORG_ID', orgId);
        } else {
            localStorage.removeItem('ESF_ORG_ID');
        }
        localStorage.removeItem('ESF_EVENT_ID');
        localStorage.removeItem('ESF_ACTIVE_EVENT');
    }
}

/**
 * The ID of the active event for this deployment.
 *
 * Phase 1: always 'event_default' — there is only one event.
 * Phase 2: derived from active event selection in localStorage.
 */
export function getCurrentEventId() {
    return (typeof localStorage !== 'undefined' && localStorage.getItem('ESF_EVENT_ID'))
        ? localStorage.getItem('ESF_EVENT_ID')
        : 'event_default';
}

export const CURRENT_ORG_ID = 'org_default';
export const CURRENT_EVENT_ID = 'event_default';

/**
 * First-class Platform Context Module resolver.
 * Encapsulates User, Organisation, Event, Roles, and Settings context.
 * Invariant 1: Browser clients never decide tenant org_id directly.
 * Invariant 7: RLS and server-side context resolution are the final authority.
 *
 * @param {Object} [authSession] - Optional Supabase Auth session
 * @returns {{orgId: string, eventId: string, instance: string, userId: string|null, userRole: string|null, urls: Object}}
 */
export function getPlatformContext(authSession = null) {
    const orgId = getCurrentOrgId();
    const eventId = getCurrentEventId();
    const instance = getCurrentInstance();
    const userId = authSession?.user?.id || null;
    const userRole = authSession?.user?.user_metadata?.role || null;

    return {
        orgId,
        eventId,
        instance,
        userId,
        userRole,
        urls: CONFIG.URLS
    };
}

/**
 * Get the current instance from localStorage, defaulting to FOOD.
 *
 * DEV was retired from the App Hub's instance selector (Phase 3) - it is no
 * longer a selectable option, but a browser that had ESF_INSTANCE=DEV stored
 * from before the removal would otherwise keep silently reading it back here
 * forever, since nothing else in the app clears the key. Treating a stored
 * 'DEV' the same as "unset" (falling through to the real default) is the one
 * change needed to stop that: every caller of this function already goes
 * through it, so this is the single point that guarantees no one is left in
 * a hidden, unselectable DEV-filtered view. FOOD, not DEV, is now the
 * fallback - it's the first real option in both instance selectors
 * (js/nav.js) and this app's flagship booking type.
 */
export function getCurrentInstance() {
    const stored = (typeof localStorage !== 'undefined') ? localStorage.getItem('ESF_INSTANCE') : null;
    return (stored && stored !== 'DEV') ? stored : 'FOOD';
}


/**
 * Whether an instance prefix or booking instance_prefix (e.g. "RAM26-FOOD-",
 * "RAM26-NONFOOD-") denotes a food stall. Deliberately guards against
 * "NONFOOD" containing "FOOD" as a substring - a plain `.includes('FOOD')`
 * miscategorises every General/Non-Food booking as food (see the RC
 * operational certification's Finding 5; submit-booking/index.ts and
 * summary.js both had the unguarded version independently). Mirrored (not
 * imported - different runtimes) in
 * supabase/functions/_shared/booking-type.ts for the server side.
 * @param {string} prefix
 * @returns {boolean}
 */
export function isFoodPrefix(prefix) {
    if (!prefix) return false;
    const p = prefix.toUpperCase();
    return p.includes('FOOD') && !p.includes('NONFOOD');
}

/**
 * Resolves the stall cost based on instance prefix or key.
 */
export function getStallCost(prefixOrKey) {
    const costs = CONFIG.UI.STALL_COST;
    const current = getCurrentInstance();

    let cost;
    if (prefixOrKey) {
        const p = prefixOrKey.toUpperCase();
        if (isFoodPrefix(p)) cost = costs.FOOD;
        else if (p.includes('NONFOOD') || p === 'GENERAL') cost = costs.GENERAL;
        else if (p.includes('DEV')) cost = costs.DEV;
    }
    if (cost === undefined || cost === null) cost = costs[current];
    if (cost === undefined || cost === null) cost = costs.FOOD;

    if (cost === undefined || cost === null || isNaN(cost)) {
        console.warn('getStallCost(): stall cost not yet loaded from the settings table, defaulting to 0.');
        return 0;
    }
    return cost;
}

export function applySettingsToConfig(data) {
    if (!data) return;
    data.forEach(item => {
        const val = item.value;
        if (item.key === 'stall_cost_food') {
            const num = parseFloat(val);
            if (!isNaN(num)) CONFIG.UI.STALL_COST.FOOD = num;
        } else if (item.key === 'stall_cost_general') {
            const num = parseFloat(val);
            if (!isNaN(num)) CONFIG.UI.STALL_COST.GENERAL = num;
        } else if (item.key === 'stall_cost_dev') {
            const num = parseFloat(val);
            if (!isNaN(num)) CONFIG.UI.STALL_COST.DEV = num;
        } else if (item.key === 'turnstile_site_key') {
            ESF_PUBLIC_CONFIG.TURNSTILE_SITE_KEY = val;
        } else if (item.key === 'bank_account_name') {
            CONFIG.BANK_ACCOUNT_NAME = val;
        } else if (item.key === 'bank_sort_code') {
            CONFIG.BANK_SORT_CODE = val;
        } else if (item.key === 'bank_account_number') {
            CONFIG.BANK_ACCOUNT_NUMBER = val;
        } else if (item.key === 'base_url') {
            ESF_PUBLIC_CONFIG.BASE_URL = val;
            CONFIG.URLS.BASE = val;
        } else if (item.key === 'cancel_url') {
            ESF_PUBLIC_CONFIG.CANCEL_URL = val;
            CONFIG.URLS.CANCEL_URL = val;
        } else if (item.key === 'portal_url') {
            ESF_PUBLIC_CONFIG.PORTAL_URL = val;
            CONFIG.URLS.PORTAL_URL = val;
        } else if (item.key === 'bucket_name') {
            ESF_PUBLIC_CONFIG.BUCKET_NAME = val;
        } else if (item.key === 'festival_display_name') {
            // V1.1 Sprint 2: Settings -> General no longer pre-fills this
            // field with 'Ella Street Festival' for an org that hasn't set
            // one (js/page-admin.js), so an explicit empty save is now a
            // real possibility, not just a hypothetical. An empty value
            // keeps the hardcoded CONFIG default above rather than blanking
            // the nav header/page titles - every other org/event settings
            // pair in this app already treats "row exists but empty" the
            // same as "no row" for exactly this reason.
            if (val) CONFIG.FESTIVAL_DISPLAY_NAME = val;
        } else if (item.key === 'allowed_stall_types') {
            CONFIG.UI.ALLOWED_TYPES = val.split(',').map(s => s.trim()).filter(Boolean);
        } else if (item.key === 'booking_prefix') {
            ESF_PUBLIC_CONFIG.BOOKING_PREFIX = val;
        } else if (item.key === 'sentry_browser_loader_url') {
            CONFIG.SENTRY_BROWSER_LOADER_URL = val;
        } else if (item.key === 'logo_url') {
            CONFIG.BRANDING.LOGO_URL = val;
        } else if (item.key === 'logo_light_url') {
            CONFIG.BRANDING.LOGO_LIGHT_URL = val;
        } else if (item.key === 'regulatory_authority_name') {
            CONFIG.REGULATORY_AUTHORITY_NAME = val;
        } else if (item.key === 'insurance_minimum_amount') {
            CONFIG.INSURANCE_MINIMUM_AMOUNT = val;
        } else {
            // Not a silent no-op: settings/event_settings are free-form
            // key/value rows, so a typo'd key (or a key not yet wired into
            // CONFIG) would otherwise vanish with no signal at all.
            console.warn(`applySettingsToConfig(): unrecognized settings key "${item.key}" — ignored.`);
        }
    });
}

// sessionStorage survives a plain reload (only tab close clears it), and
// settings.html only removeItem()s this key in the SAME tab that saved a
// change - any OTHER already-open tab (a second window, another admin's own
// session) keeps serving whatever it first cached until it's closed. This
// TTL bounds that: worst case, a settings edit reaches every open tab within
// SETTINGS_CACHE_TTL_MS, not "whenever that tab happens to be closed".
// NOTE: supabase-public.js's loadPublicSettings/initPublicSettingsSync use
// their own ESF_SETTINGS_CACHE_<orgId> keys for pre-auth public pages -
// despite the similar name/shape this is a SEPARATE cache with a separate
// consumer, not the same key this function reads/writes. Both share the
// ESF_SETTINGS_CACHE_ prefix, though, which is what clearSettingsCache()
// below sweeps by.
const SETTINGS_CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Clears every settings cache entry this browser tab holds - this file's own
 * ESF_SETTINGS_CACHE_<org>_<event> keys and supabase-public.js's
 * ESF_SETTINGS_CACHE_<org> keys, both under the same prefix. Call after
 * saving a settings change so the SAME tab reflects it immediately, rather
 * than waiting out SETTINGS_CACHE_TTL_MS (other already-open tabs still
 * wait out the TTL, same as before - see the comment above).
 */
export function clearSettingsCache() {
    if (typeof sessionStorage === 'undefined') return;
    Object.keys(sessionStorage)
        .filter((k) => k.startsWith('ESF_SETTINGS_CACHE_'))
        .forEach((k) => sessionStorage.removeItem(k));
}

export async function loadStallCosts(sb, orgId = getCurrentOrgId(), eventId = getCurrentEventId()) {
    const cacheKey = `ESF_SETTINGS_CACHE_${orgId}_${eventId}`;

    if (typeof sessionStorage !== 'undefined') {
        const cached = sessionStorage.getItem(cacheKey);
        if (cached) {
            try {
                const { orgData, eventData, timestamp } = JSON.parse(cached);
                if (orgData && Date.now() - timestamp < SETTINGS_CACHE_TTL_MS) {
                    applySettingsToConfig(orgData);
                    applySettingsToConfig(eventData);
                    return;
                }
            } catch (e) {
                // Corrupt/stale cache - fall through to a fresh fetch below.
                console.warn('Failed to parse cached settings, refetching:', e.message);
            }
        }
    }

    try {
        const { data: orgData, error: orgError } = await sb.from('settings').select('key, value').eq('org_id', orgId);
        if (orgError) throw orgError;
        const { data: eventData, error: eventError } = await sb.from('event_settings').select('key, value').eq('event_id', eventId);
        if (eventError) throw eventError;

        // Org rows first, event rows second: an event row for the same key
        // wins. applySettingsToConfig() doesn't know or care which layer a
        // row came from - same function, called twice.
        applySettingsToConfig(orgData);
        applySettingsToConfig(eventData);

        if (typeof sessionStorage !== 'undefined') {
            sessionStorage.setItem(cacheKey, JSON.stringify({ orgData, eventData: eventData || [], timestamp: Date.now() }));
        }
    } catch (e) {
        console.warn("Failed to load settings from database, using defaults:", e);
    }
}



