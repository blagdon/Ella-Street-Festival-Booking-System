/**
 * supabase-public.js
 * Supabase credentials for PUBLIC-FACING pages (non-module script).
 * Used by: General_Booking.html, Food_Stall_booking.html, cancel_booking.html
 *
 * ⚠️  This file is the single source of truth for public configurations and credentials.
 *     js/config.js imports and references this file directly, so you do NOT need to
 *     update credentials in js/config.js when you rotate the anon key or change the URL.
 *
 * The anon key is intentionally client-facing.
 * Security is enforced by Row Level Security (RLS) on Supabase tables.
 */

export const ESF_PUBLIC_CONFIG = {
    SUPABASE_URL: "https://qeplpcnrkgpaawfyliap.supabase.co",
    SUPABASE_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFlcGxwY25ya2dwYWF3ZnlsaWFwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njk5NTIwNDQsImV4cCI6MjA4NTUyODA0NH0.5XJdJEw8-bfhcPteMQsIG-Tk5DwtUIVdbbJGnmW1ZbM",
    BUCKET_NAME: "esf-documents",
    TURNSTILE_SITE_KEY: "0x4AAAAAACZTfDIHzMhGqnER",
    BASE_URL: "https://app.ellastreet.co.uk",
    CANCEL_URL: "https://app.ellastreet.co.uk/cancel_booking.html",
    PORTAL_URL: "https://www.ellastreet.co.uk/fest26/portal",
    BOOKING_PREFIX: "ESF26",
    MAP_CENTER_LAT: 53.760672928799394,
    MAP_CENTER_LNG: -0.362403011338408,
    MAP_DEFAULT_ZOOM: 18
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
        } else if (item.key === 'map_center_lat') {
            const num = parseFloat(val);
            if (!isNaN(num)) ESF_PUBLIC_CONFIG.MAP_CENTER_LAT = num;
        } else if (item.key === 'map_center_lng') {
            const num = parseFloat(val);
            if (!isNaN(num)) ESF_PUBLIC_CONFIG.MAP_CENTER_LNG = num;
        } else if (item.key === 'map_default_zoom') {
            const num = parseInt(val, 10);
            if (!isNaN(num)) ESF_PUBLIC_CONFIG.MAP_DEFAULT_ZOOM = num;
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

/**
 * Shared bootstrap for public (unauthenticated) page entry modules — the
 * public-page counterpart of initAdminPage() in js/supabase.js.
 *
 * Rule: new page-*.js entry files must bootstrap via initAdminPage() or
 * initPublicPage() — never a bare DOMContentLoaded listener. A bare listener
 * only works because module scripts are deferred; this helper also runs the
 * callback when the script executes after DOMContentLoaded has already fired
 * (e.g. via dynamic import), and captures init errors uniformly instead of
 * letting a throw leave the page half-initialized silently.
 *
 * Settings idiom — there is exactly one: loadPublicSettings() is awaited
 * before the page callback runs. It applies the sessionStorage cache
 * synchronously when present (no network round-trip) and only queries the
 * database on a cold cache, so by the time the callback runs
 * ESF_PUBLIC_CONFIG already reflects the configured values. Pages that must
 * not apply DB-loaded settings opt out explicitly with
 * { loadSettings: false } — a deviation is a visible choice, not drift.
 *
 * @param {Function} initCallback - The page-specific initialization function.
 * @param {{ loadSettings?: boolean }} [options]
 */
export function initPublicPage(initCallback, { loadSettings = true } = {}) {
    const runInit = async () => {
        try {
            if (loadSettings) await loadPublicSettings();
            if (typeof initCallback === 'function') await initCallback();
        } catch (e) {
            console.error(`[Init Failed] Error loading ${window.location.pathname}:`, e);
        }
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', runInit);
    } else {
        runInit();
    }
}
