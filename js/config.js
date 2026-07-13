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

    // Deployment URLs
    // ⚠️  Single source of truth is supabase-public.js (or the settings table).
    //     If the Vercel deployment URL changes, update it there.
    URLS: {
        BASE: ESF_PUBLIC_CONFIG.BASE_URL,
        CANCEL_URL: ESF_PUBLIC_CONFIG.CANCEL_URL,
        PORTAL_URL: ESF_PUBLIC_CONFIG.PORTAL_URL
    },

    // Bank account details used in confirmation emails
    // Update here if account details change — this is the single source of truth
    BANK_DETAILS: ESF_PUBLIC_CONFIG.BANK_DETAILS,

    // Limits
    EMAIL_RATE_LIMIT: 10,
    EMAIL_RATE_WINDOW_MS: 60000,

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
        STATUS_LIST: ['Pending', 'Confirmed', 'Rejected', 'Cancelled', 'On Hold', 'HCC Checks'],
        ALLOWED_TYPES: ["Dev", "Food", "Non-Food", "Attraction", "Barrier", "Ramp", "First Aid", "Beach", "Music", "Green", "Police", "Fire Engine", "Toilet", "Spoken Word", "Ice Cream Van"],
        STATUS_COLORS: {
            'Pending': 'bg-yellow-100 text-yellow-700',
            'Confirmed': 'bg-green-100 text-green-700',
            'Rejected': 'bg-red-100 text-red-700',
            'Cancelled': 'bg-gray-100 text-gray-700',
            'On Hold': 'bg-purple-100 text-purple-700',
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
        } else if (item.key === 'bank_details') {
            ESF_PUBLIC_CONFIG.BANK_DETAILS = val;
            CONFIG.BANK_DETAILS = val;
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
        } else if (item.key === 'email_rate_limit') {
            const num = parseInt(val, 10);
            if (!isNaN(num)) CONFIG.EMAIL_RATE_LIMIT = num;
        } else if (item.key === 'email_rate_window_ms') {
            const num = parseInt(val, 10);
            if (!isNaN(num)) CONFIG.EMAIL_RATE_WINDOW_MS = num;
        } else if (item.key === 'booking_prefix') {
            ESF_PUBLIC_CONFIG.BOOKING_PREFIX = val;
        }
    });
}

export async function loadStallCosts(sb) {
    if (typeof sessionStorage !== 'undefined') {
        const cached = sessionStorage.getItem('ESF_SETTINGS_CACHE');
        if (cached) {
            try {
                const data = JSON.parse(cached);
                applySettingsToConfig(data);
                return;
            } catch (e) {}
        }
    }

    try {
        const { data, error } = await sb.from('settings').select('key, value');
        if (error) throw error;
        if (data) {
            applySettingsToConfig(data);
            if (typeof sessionStorage !== 'undefined') {
                sessionStorage.setItem('ESF_SETTINGS_CACHE', JSON.stringify(data));
            }
        }
    } catch (e) {
        console.warn("Failed to load settings from database, using defaults:", e);
    }
}



