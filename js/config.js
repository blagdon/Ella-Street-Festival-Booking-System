import { ESF_PUBLIC_CONFIG } from '../supabase-public.js';
/**
 * config.js
 * Central configuration constants for the application.
 */

export const CONFIG = {
    // Database Prefixes (Strictly enforces data separation)
    INSTANCE_MAP: {
        'DEV': 'ESF26-DEV-',
        'FOOD': 'ESF26-FOOD-',
        'GENERAL': 'ESF26-NONFOOD-', // 'General' maps to Non-Food data
        'MISC': 'ESF26-MISC-'        // 'MISC' for non-bookable facilities
    },

    HCC_COUNCIL_EMAIL: 'Foodand.Health&Safety@hullcc.gov.uk',

    // Deployment URLs
    // ⚠️  If the Vercel deployment URL changes, update here AND in /email_templates.js (EmailConfig.CANCEL_URL)
    //     email_templates.js cannot use ES module imports so the URL is duplicated there.
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
        STALL_COST: {
            FOOD: 50.00,
            GENERAL: 25.00,
            DEV: 90.00
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
    // ⚠️  KEEP IN SYNC WITH /supabase-public.js
    //     Public pages cannot use ES modules, so the credentials are duplicated there.
    //     If you rotate the anon key or change the URL, update BOTH files.
    SUPABASE: {
        URL: ESF_PUBLIC_CONFIG.SUPABASE_URL,
        KEY: ESF_PUBLIC_CONFIG.SUPABASE_KEY
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

    if (prefixOrKey) {
        const p = prefixOrKey.toUpperCase();
        if (p.includes('FOOD') && !p.includes('NONFOOD')) return costs.FOOD;
        if (p.includes('NONFOOD') || p === 'GENERAL') return costs.GENERAL;
        if (p.includes('DEV')) return costs.DEV;
    }
    return costs[current] || costs.FOOD;
}

/**
 * Asynchronously loads stall costs from Supabase settings table and overrides local CONFIG values.
 * Uses default configurations as fallback in case of errors.
 * @param {object} sb - The active Supabase client instance
 */
export async function loadStallCosts(sb) {
    try {
        const { data, error } = await sb.from('settings').select('key, value');
        if (error) throw error;
        if (data) {
            data.forEach(item => {
                const num = parseFloat(item.value);
                if (!isNaN(num)) {
                    if (item.key === 'stall_cost_food') {
                        CONFIG.UI.STALL_COST.FOOD = num;
                    } else if (item.key === 'stall_cost_general') {
                        CONFIG.UI.STALL_COST.GENERAL = num;
                    } else if (item.key === 'stall_cost_dev') {
                        CONFIG.UI.STALL_COST.DEV = num;
                    }
                }
            });
        }
    } catch (e) {
        console.warn("Failed to load stall costs from database settings, using defaults:", e);
    }
}



