// @ts-check
/**
 * supabase.js
 * Wrapper for Supabase client initialization and authentication.
 */
import { CONFIG, loadStallCosts } from './config.js';
import { showToast } from './ui.js';
import { initNavigation } from './nav.js';

let _activeSbClient = null;

export function getSupabaseClient() {
    if (_activeSbClient) return _activeSbClient;

    if (typeof supabase === 'undefined') {
        // Fallback if loaded via CDN global
        if (window.supabase) {
            _activeSbClient = window.supabase.createClient(CONFIG.SUPABASE.URL, CONFIG.SUPABASE.KEY);
            return _activeSbClient;
        }
        console.error("Supabase SDK not loaded!");
        throw new Error("Supabase SDK not loaded");
    }

    // If imported as module (future proofing) or global
    const { createClient } = supabase;
    _activeSbClient = createClient(CONFIG.SUPABASE.URL, CONFIG.SUPABASE.KEY);
    return _activeSbClient;
}

/**
 * Checks if the user is authenticated and has the required role.
 * @param {string} requiredRole - 'admin' (default) or 'steward'
 */
/**
 * Injects the Sentry Loader Script, once a loader URL has loaded from the
 * settings table (sentry_browser_loader_url) - replacing the hardcoded
 * <script src> tag previously duplicated across 20 admin HTML files, so
 * rotating or disabling monitoring needs a settings.html edit, not a
 * redeploy.
 *
 * Takes the URL as a parameter rather than reading CONFIG directly, since it
 * has two different callers reading from two different places: requireAuth()
 * below (CONFIG.SENTRY_BROWSER_LOADER_URL, populated via the authenticated
 * admin settings read) for every requireAuth()-gated page, and
 * page-login.js/page-steward-login.js (ESF_PUBLIC_CONFIG.
 * SENTRY_BROWSER_LOADER_URL, populated via the anon-readable public settings
 * read - see supabase-public.js) for the two pages that have no session yet
 * and so can't use requireAuth() at all, despite needing Sentry the most
 * (that's exactly where auth failures happen).
 *
 * Still the Loader Script pattern, not the full SDK: it's a tiny stub that
 * only pulls the real bundle down on an actual first error, so this stays as
 * cheap as the hardcoded version was. The one real trade-off is timing - the
 * old static <head> tag started loading in parallel with HTML parsing,
 * before any JS ran; this now runs after settings resolve, so an error in
 * that narrow, well-tested settings-loading path itself wouldn't be
 * captured. Accepted in exchange for settings-table configurability.
 *
 * No-ops with nothing to guard against double-injection beyond the empty-
 * string check: every caller runs once per page load (a fresh document
 * every navigation, no SPA routing in this app), so there's no realistic
 * path that calls this twice.
 */
export function initSentryBrowser(loaderUrl) {
    if (!loaderUrl) return;
    const script = document.createElement('script');
    script.src = loaderUrl;
    script.crossOrigin = 'anonymous';
    document.head.appendChild(script);
}

export async function requireAuth(requiredRole = 'admin') {
    try {
        const sb = getSupabaseClient();
        const { data: { session } } = await sb.auth.getSession();

        if (!session) {
            throw new Error('Not authenticated');
        }

        // Fetch User Role
        const { data: roleData } = await sb
            .from('user_roles')
            .select('role')
            .eq('id', session.user.id)
            .single();

        const userRole = (roleData && roleData.role) ? roleData.role : null;

        // Authorization logic
        if (userRole === 'admin' || userRole === requiredRole) {
            await loadStallCosts(sb);
            initSentryBrowser(CONFIG.SENTRY_BROWSER_LOADER_URL);
            return session;
        }

        throw new Error('Unauthorized');

    } catch (e) {
        if (e.message === 'Not authenticated') {
            const loginPage = (requiredRole === 'steward') ? 'steward_login.html' : 'login.html';
            window.location.href = loginPage;
        } else if (e.message === 'Unauthorized') {
            const loginPage = (requiredRole === 'steward') ? 'steward_login.html' : 'login.html';
            window.location.href = loginPage + '?error=unauthorized';
        } else {
            console.warn("Database connection issue during authentication check:", e);
            if (typeof showToast === 'function') {
                showToast("Database connection issue. Retrying...", "error");
            }
        }
        throw e;
    }
}

/**
 * Signs the user out.
 */
export async function signOut() {
    const sb = getSupabaseClient();
    try {
        const { data: { session } } = await sb.auth.getSession();
        if (session) {
            const { auditLog } = await import('./audit.js');
            await auditLog('admin_logout', 'system', { email: session.user.email });
        }
    } catch (e) {
        console.warn("Failed to log checkout:", e);
    }
    await sb.auth.signOut();
    window.location.href = 'login.html';
}

/**
 * Shared helper to initialize admin and steward dashboard pages.
 * Handles DOM ready state, role authorization, and navigation setup.
 * @param {Function} [initCallback] - The page-specific initialization function.
 * @param {string} [requiredRole] - 'admin' or 'steward'
 */
export function initAdminPage(initCallback, requiredRole = 'admin') {
    const runInit = async () => {
        try {
            await requireAuth(requiredRole);
            if (requiredRole === 'admin') {
                initNavigation();
            }
            if (typeof initCallback === 'function') {
                await initCallback();
            }
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
