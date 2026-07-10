/**
 * supabase-public.js
 * Supabase credentials for PUBLIC-FACING pages (non-module script).
 * Used by: General_Booking.html, Food_Stall_booking.html, cancel_booking.html
 *
 * ⚠️  KEEP IN SYNC WITH js/config.js (SUPABASE.URL and SUPABASE.KEY)
 *     These two files contain the same credentials because public pages
 *     cannot use ES module imports. If you rotate the anon key or change
 *     the Supabase URL, you MUST update BOTH this file AND js/config.js.
 *
 * The anon key is intentionally client-facing.
 * Security is enforced by Row Level Security (RLS) on Supabase tables.
 */

export const ESF_PUBLIC_CONFIG = {
    SUPABASE_URL: "https://rsnxhuhibglieofikkpo.supabase.co",
    SUPABASE_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJzbnhodWhpYmdsaWVvZmlra3BvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njk2Nzg5MjcsImV4cCI6MjA4NTI1NDkyN30.QNrMVCc9FFdIAR4wRv6g4V4p2JA8pbCoaf8zLRuu0fw",
    BUCKET_NAME: "esf-documents",
    TURNSTILE_SITE_KEY: "0x4AAAAAACZTfDIHzMhGqnER",
    BANK_DETAILS: "Bank: Ella Street Residents Association | Sort: 30-99-50 | Acc: 51276368",
    BASE_URL: "https://stallbookingstailwinds.vercel.app",
    CANCEL_URL: "https://stallbookingstailwinds.vercel.app/cancel_booking.html",
    PORTAL_URL: "https://www.ellastreet.co.uk/fest26/portal",
    BOOKING_PREFIX: "ESF26"
};

if (typeof window !== 'undefined') {
    window.ESF_PUBLIC_CONFIG = ESF_PUBLIC_CONFIG;
}

/**
 * Creates and returns a Supabase client using the public config.
 * Caches the client so it's only created once per page.
 */
let _publicSbClient = null;
export function getPublicSupabaseClient() {
    if (!_publicSbClient) {
        if (typeof supabase === 'undefined') {
            throw new Error("Supabase JS library not loaded. Check your script tags.");
        }
        _publicSbClient = supabase.createClient(
            ESF_PUBLIC_CONFIG.SUPABASE_URL,
            ESF_PUBLIC_CONFIG.SUPABASE_KEY
        );
    }
    return _publicSbClient;
}

if (typeof window !== 'undefined') {
    window.getPublicSupabaseClient = getPublicSupabaseClient;
}

export function applyPublicSettings(data) {
    if (!data) return;
    data.forEach(item => {
        const val = item.value;
        if (item.key === 'turnstile_site_key') {
            ESF_PUBLIC_CONFIG.TURNSTILE_SITE_KEY = val;
        } else if (item.key === 'bank_details') {
            ESF_PUBLIC_CONFIG.BANK_DETAILS = val;
        } else if (item.key === 'base_url') {
            ESF_PUBLIC_CONFIG.BASE_URL = val;
        } else if (item.key === 'cancel_url') {
            ESF_PUBLIC_CONFIG.CANCEL_URL = val;
        } else if (item.key === 'portal_url') {
            ESF_PUBLIC_CONFIG.PORTAL_URL = val;
        } else if (item.key === 'bucket_name') {
            ESF_PUBLIC_CONFIG.BUCKET_NAME = val;
        } else if (item.key === 'booking_prefix') {
            ESF_PUBLIC_CONFIG.BOOKING_PREFIX = val;
        }
    });
}

export async function loadPublicSettings() {
    if (typeof sessionStorage !== 'undefined') {
        const cached = sessionStorage.getItem('ESF_SETTINGS_CACHE');
        if (cached) {
            try {
                const data = JSON.parse(cached);
                applyPublicSettings(data);
                return;
            } catch (e) {}
        }
    }

    try {
        const sb = getPublicSupabaseClient();
        const { data, error } = await sb.from('settings').select('key, value');
        if (error) throw error;
        if (data) {
            applyPublicSettings(data);
            if (typeof sessionStorage !== 'undefined') {
                sessionStorage.setItem('ESF_SETTINGS_CACHE', JSON.stringify(data));
            }
        }
    } catch (e) {
        console.warn("Failed to load public settings from database, using defaults:", e);
    }
}

export function initPublicSettingsSync() {
    if (typeof sessionStorage !== 'undefined') {
        const cached = sessionStorage.getItem('ESF_SETTINGS_CACHE');
        if (cached) {
            try {
                const data = JSON.parse(cached);
                applyPublicSettings(data);
            } catch (e) {}
        }
    }
}

if (typeof window !== 'undefined') {
    window.loadPublicSettings = loadPublicSettings;
    window.initPublicSettingsSync = initPublicSettingsSync;
}
