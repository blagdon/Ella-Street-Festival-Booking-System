// @ts-check
import { ESF_PUBLIC_CONFIG } from '../supabase-public.js';
/**
 * config.js
 * Central configuration constants for the application.
 */

export const CONFIG = {
    // Database Prefixes (Strictly enforces data separation)
    get INSTANCE_MAP() {
        const prefix = ESF_PUBLIC_CONFIG?.BOOKING_PREFIX || "ESF26";
        return {
            'DEV': `${prefix}-DEV-`,
            'FOOD': `${prefix}-FOOD-`,
            'GENERAL': `${prefix}-NONFOOD-`, // 'General' maps to Non-Food data
            'MISC': `${prefix}-MISC-`        // 'MISC' for non-bookable facilities
        };
    },

    HCC_COUNCIL_EMAIL: 'Foodand.Health&Safety@hullcc.gov.uk',

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
        STATUS_LIST: ['Pending', 'Payment Requested', 'Confirmed', 'Rejected', 'Cancelled', 'HCC Checks'],
        // No hardcoded defaults — populated entirely from the settings table
        // (allowed_stall_types) via loadStallCosts()/applySettingsToConfig().
        ALLOWED_TYPES: [],
        STATUS_COLORS: {
            'Pending': 'bg-yellow-100 text-yellow-700',
            'Payment Requested': 'bg-indigo-100 text-indigo-700',
            'Confirmed': 'bg-green-100 text-green-700',
            'Rejected': 'bg-red-100 text-red-700',
            'Cancelled': 'bg-gray-100 text-gray-700',
            'HCC Checks': 'bg-orange-100 text-orange-700'
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
 * Get the current instance from localStorage or default to DEV.
 */
export function getCurrentInstance() {
    return (typeof localStorage !== 'undefined' && localStorage.getItem('ESF_INSTANCE'))
        ? localStorage.getItem('ESF_INSTANCE')
        : 'DEV';
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
        if (p.includes('FOOD') && !p.includes('NONFOOD')) cost = costs.FOOD;
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
        } else if (item.key === 'hcc_council_email') {
            CONFIG.HCC_COUNCIL_EMAIL = val;
        } else if (item.key === 'festival_display_name') {
            CONFIG.FESTIVAL_DISPLAY_NAME = val;
        } else if (item.key === 'allowed_stall_types') {
            CONFIG.UI.ALLOWED_TYPES = val.split(',').map(s => s.trim()).filter(Boolean);
        } else if (item.key === 'booking_prefix') {
            ESF_PUBLIC_CONFIG.BOOKING_PREFIX = val;
        } else if (item.key === 'sentry_browser_loader_url') {
            CONFIG.SENTRY_BROWSER_LOADER_URL = val;
        }
    });
}

// sessionStorage survives a plain reload (only tab close clears it), and
// settings.html only removeItem()s this key in the SAME tab that saved a
// change - any OTHER already-open tab (a second window, another admin's own
// session) keeps serving whatever it first cached until it's closed. This
// TTL bounds that: worst case, a settings edit reaches every open tab within
// SETTINGS_CACHE_TTL_MS, not "whenever that tab happens to be closed".
// supabase-public.js's loadPublicSettings/initPublicSettingsSync read and
// write this SAME sessionStorage key for public pages - keep the constant
// and the {data, timestamp} shape in sync with those.
const SETTINGS_CACHE_TTL_MS = 5 * 60 * 1000;

export async function loadStallCosts(sb, orgId = getCurrentOrgId()) {
    if (typeof sessionStorage !== 'undefined') {
        const cacheKey = `ESF_SETTINGS_CACHE_${orgId}`;
        const cached = sessionStorage.getItem(cacheKey);
        if (cached) {
            try {
                const { data, timestamp } = JSON.parse(cached);
                if (data && Date.now() - timestamp < SETTINGS_CACHE_TTL_MS) {
                    applySettingsToConfig(data);
                    return;
                }
            } catch (e) {
                // Corrupt/stale cache - fall through to a fresh fetch below.
                console.warn('Failed to parse cached settings, refetching:', e.message);
            }
        }
    }

    try {
        const { data, error } = await sb.from('settings').select('key, value').eq('org_id', orgId);
        if (error) throw error;
        if (data) {
            applySettingsToConfig(data);
            if (typeof sessionStorage !== 'undefined') {
                const cacheKey = `ESF_SETTINGS_CACHE_${orgId}`;
                sessionStorage.setItem(cacheKey, JSON.stringify({ data, timestamp: Date.now() }));
            }
        }
    } catch (e) {
        console.warn("Failed to load settings from database, using defaults:", e);
    }
}



