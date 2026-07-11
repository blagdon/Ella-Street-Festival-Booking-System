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
 * Checks if the user is authenticated. If not, redirects to login.html.
 */
/**
 * Checks if the user is authenticated and has the required role.
 * @param {string} requiredRole - 'admin' (default) or 'steward'
 */
export async function requireAuth(requiredRole = 'admin') {
    try {
        const sb = getSupabaseClient();
        const { data: { session } } = await sb.auth.getSession();

        if (!session) {
            window.location.href = (requiredRole === 'steward') ? 'steward_login.html' : 'login.html';
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
            return session;
        }

        const loginPage = (requiredRole === 'steward') ? 'steward_login.html' : 'login.html';
        window.location.href = loginPage + '?error=unauthorized';
        throw new Error('Unauthorized');

    } catch (e) {
        if (e.message === 'Not authenticated' || e.message === 'Unauthorized') {
            const loginPage = (requiredRole === 'steward') ? 'steward_login.html' : 'login.html';
            window.location.href = loginPage;
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
            const { auditLog } = await import('./api.js');
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
 * @param {Function} initCallback - The page-specific initialization function.
 * @param {string} requiredRole - 'admin' or 'steward'
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
