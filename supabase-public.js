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

// ---------------------------------------------------------------------------
// LOCAL TEST-PROJECT OVERRIDE (localhost only — production can never reach it)
//
// Why this exists: this file points at production, so loading any admin page
// locally talks to the LIVE database — which is why clicking a button while
// developing could email real traders, and why several features shipped with
// "an admin needs to confirm this works." This lets a local session point at
// the disposable test project instead, so browser flows can actually be
// exercised end-to-end.
//
// Three deliberate safety properties, given this file caused a full outage on
// 2026-07-18 when it was repointed at the test DB and committed:
//  1. It is gated on a strict allowlist of localhost origins (exact match, not
//     a substring test — "localhost.evil.com" must not pass). A deployed
//     origin cannot execute the override branch at all, so the production
//     behaviour of this file is unchanged byte for byte.
//  2. The override lives in localStorage, NOT in any file. There is nothing to
//     accidentally commit, and nothing to 404 in production.
//  3. When active it is loud: a console warning plus an on-page banner naming
//     the project, because silently talking to the wrong database is the
//     failure mode that actually costs hours.
//
// Usage from the browser console on a local page:
//   esfUseTestProject('https://<ref>.supabase.co', '<anon key>')  // then reload
//   esfUseProduction()                                            // then reload
// ---------------------------------------------------------------------------
const ESF_LOCAL_HOSTS = ['localhost', '127.0.0.1', '::1', '[::1]'];
const ESF_OVERRIDE_KEY = 'ESF_LOCAL_SUPABASE_OVERRIDE';

function esfIsLocalHost() {
    return typeof window !== 'undefined'
        && ESF_LOCAL_HOSTS.includes(window.location.hostname);
}

function esfReadLocalOverride() {
    if (!esfIsLocalHost() || typeof localStorage === 'undefined') return null;

    let raw;
    try {
        raw = localStorage.getItem(ESF_OVERRIDE_KEY);
    } catch (e) {
        return null; // storage blocked (private mode etc.) — just use production
    }
    if (!raw) return null;

    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch (e) {
        console.warn('[ESF] Ignoring malformed local Supabase override:', e.message);
        return null;
    }

    // Validate rather than trust: a half-applied override (valid URL, missing
    // key) would fail in a confusing place far from here.
    const url = parsed && parsed.SUPABASE_URL;
    const key = parsed && parsed.SUPABASE_KEY;
    if (typeof url !== 'string' || !/^https:\/\/[a-z0-9]+\.supabase\.co$/.test(url)) {
        console.warn('[ESF] Ignoring local Supabase override: SUPABASE_URL is not a valid Supabase project URL.');
        return null;
    }
    if (typeof key !== 'string' || key.length < 20) {
        console.warn('[ESF] Ignoring local Supabase override: SUPABASE_KEY is missing or implausibly short.');
        return null;
    }
    return parsed;
}

export const ESF_PUBLIC_CONFIG = {
    SUPABASE_URL: "https://rsnxhuhibglieofikkpo.supabase.co",
    SUPABASE_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJzbnhodWhpYmdsaWVvZmlra3BvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njk2Nzg5MjcsImV4cCI6MjA4NTI1NDkyN30.QNrMVCc9FFdIAR4wRv6g4V4p2JA8pbCoaf8zLRuu0fw",
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

// Apply the local override (no-op on any deployed origin) before anything
// reads the config. Mutates in place so the existing exported-const binding
// and window.ESF_PUBLIC_CONFIG alias both see it.
const _esfOverride = esfReadLocalOverride();
if (_esfOverride) {
    Object.assign(ESF_PUBLIC_CONFIG, _esfOverride);
    ESF_PUBLIC_CONFIG.__LOCAL_OVERRIDE_ACTIVE = true;

    const ref = ESF_PUBLIC_CONFIG.SUPABASE_URL.replace(/^https:\/\//, '').split('.')[0];
    console.warn(
        `%c[ESF] LOCAL OVERRIDE ACTIVE — talking to Supabase project "${ref}", not production.`,
        'background:#b45309;color:#fff;font-weight:bold;padding:2px 6px;border-radius:3px'
    );

    // On-page banner: a console warning is too easy to miss, and believing
    // you're on the test database when you're not is the expensive mistake.
    const showBanner = () => {
        if (document.getElementById('esf-local-override-banner')) return;
        const el = document.createElement('div');
        el.id = 'esf-local-override-banner';
        el.textContent = `LOCAL OVERRIDE — Supabase project: ${ref} (not production)`;
        el.style.cssText = [
            'position:fixed', 'bottom:0', 'left:0', 'right:0', 'z-index:2147483647',
            'background:#b45309', 'color:#fff', 'font:bold 12px system-ui,sans-serif',
            'text-align:center', 'padding:4px 8px', 'letter-spacing:.02em',
            'pointer-events:none'
        ].join(';');
        document.body.appendChild(el);
    };
    if (typeof document !== 'undefined') {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', showBanner);
        } else {
            showBanner();
        }
    }
}

if (typeof window !== 'undefined') {
    window.ESF_PUBLIC_CONFIG = ESF_PUBLIC_CONFIG;
}

// Console helpers, defined only on localhost. Both clear the settings cache:
// ESF_SETTINGS_CACHE holds values fetched from whichever project was active
// before, and applying another project's settings over the new one is a
// genuinely confusing failure (wrong bucket, wrong Turnstile key).
if (esfIsLocalHost()) {
    window.esfUseTestProject = function (url, key, extra) {
        localStorage.setItem(ESF_OVERRIDE_KEY, JSON.stringify(
            Object.assign({ SUPABASE_URL: url, SUPABASE_KEY: key }, extra || {})
        ));
        try { sessionStorage.removeItem('ESF_SETTINGS_CACHE'); } catch (e) {}
        console.warn('[ESF] Local override set. Reload the page to apply.');
    };
    window.esfUseProduction = function () {
        localStorage.removeItem(ESF_OVERRIDE_KEY);
        try { sessionStorage.removeItem('ESF_SETTINGS_CACHE'); } catch (e) {}
        console.warn('[ESF] Local override cleared. Reload the page to return to production.');
    };
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
