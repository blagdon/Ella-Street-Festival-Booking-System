// @ts-check
/**
 * supabase.js
 * Wrapper for Supabase client initialization and authentication.
 */
import { CONFIG, loadStallCosts, setCurrentOrgId } from './config.js';
import { showToast } from './ui.js';
import { initNavigation } from './nav.js';
import { ESF_PUBLIC_CONFIG } from '../supabase-public.js';

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

/**
 * Resolves a steward's own organisation id and caches it via
 * setCurrentOrgId() — reusing exactly what js/nav.js's admin org-switcher
 * already calls (rpc_list_switchable_organisations() joins
 * organisation_members by auth.uid(), no role filter, so a steward's own
 * membership row resolves here the same way an admin's does there).
 * Stewards have no switcher UI of their own, so nothing else ever populates
 * ESF_ORG_ID for them — without this, loadStallCosts() below would silently
 * resolve org_default's settings for every steward regardless of their real
 * organisation (V1.1 Sprint 2 steward-prefix-fix write-up).
 *
 * Deliberately fails closed rather than guessing: a steward account with
 * zero or more than one organisation_members row is a configuration problem
 * an admin needs to fix, not something to silently paper over by picking an
 * organisation or falling back to org_default — RLS would still stop actual
 * cross-tenant data access either way, but a wrong/ambiguous organisation
 * would still drive the wrong booking-prefix filter and settings, which is
 * misleading operational behaviour even though it isn't a security hole.
 *
 * Also resolves the organisation's real booking_prefix here, through the
 * same anon-readable `settings` key every public booking page already
 * relies on ('booking_prefix' is in the anon SELECT policy's allow-list).
 * Necessary because the `settings` table's authenticated-read RLS policy is
 * deliberately admin-only ("Admins can read settings"); a steward session
 * cannot read it directly, so loadStallCosts() below would silently find
 * zero rows and CONFIG.INSTANCE_MAP would fall back to the hardcoded
 * "ESF26" default for every steward regardless of organisation. Widening
 * that policy to include stewards was considered and rejected — it would
 * expose the full settings table's every key, not just booking_prefix.
 *
 * Deliberately does NOT call the shared getPublicSupabaseClient() singleton
 * (supabase-public.js): Supabase-js persists a session in localStorage keyed
 * only by project URL, so a second client instance for the same project
 * silently inherits whatever session already exists there — confirmed live,
 * the "public" client's request evaluated as the steward's own authenticated
 * role, not anon, hitting the exact policy this exists to avoid. A
 * throwaway client with persistSession/autoRefreshToken disabled never reads
 * or writes that shared session, so it behaves as genuinely anonymous
 * regardless of which already-authenticated page calls it from — same anon
 * URL/key ESF_PUBLIC_CONFIG already exports, just not the cached instance.
 * @param {ReturnType<typeof getSupabaseClient>} sb
 */
async function resolveStewardOrgId(sb) {
    const { data, error } = await sb.rpc('rpc_list_switchable_organisations');
    if (error) throw new Error('OrganisationResolutionFailed');

    const orgs = data?.organisations || [];
    if (orgs.length === 0) throw new Error('NoOrganisation');
    if (orgs.length > 1) throw new Error('MultipleOrganisations');

    const orgId = orgs[0].id;
    setCurrentOrgId(orgId);

    try {
        const { createClient } = supabase;
        const anonReadClient = createClient(ESF_PUBLIC_CONFIG.SUPABASE_URL, ESF_PUBLIC_CONFIG.SUPABASE_KEY, {
            auth: { persistSession: false, autoRefreshToken: false }
        });
        const { data: prefixRow } = await anonReadClient
            .from('settings')
            .select('value')
            .eq('org_id', orgId)
            .eq('key', 'booking_prefix')
            .maybeSingle();
        if (prefixRow?.value) {
            ESF_PUBLIC_CONFIG.BOOKING_PREFIX = prefixRow.value;
        }
    } catch (e) {
        console.warn('[requireAuth] Could not resolve steward booking prefix:', e.message);
    }
}

export async function requireAuth(requiredRole = 'admin') {
    try {
        const sb = getSupabaseClient();
        const { data: { session } } = await sb.auth.getSession();

        if (!session) {
            throw new Error('Not authenticated');
        }

        // Fetch User Role (checks user_roles first, falls back to organisation_members)
        let userRole = null;
        const { data: roleData } = await sb
            .from('user_roles')
            .select('role')
            .eq('id', session.user.id)
            .maybeSingle();

        if (roleData && roleData.role) {
            userRole = roleData.role;
        } else {
            const { data: memberData } = await sb
                .from('organisation_members')
                .select('role')
                .eq('user_id', session.user.id)
                .maybeSingle();
            if (memberData && memberData.role) {
                userRole = memberData.role;
            }
        }

        // Authorization logic
        if (userRole === 'admin' || userRole === requiredRole) {
            // Steward-only path — an admin visiting steward.html keeps
            // whatever organisation they already have selected via the
            // normal admin org-switcher, unaffected by this branch.
            if (requiredRole === 'steward' && userRole !== 'admin') {
                await resolveStewardOrgId(sb);
            }
            await loadStallCosts(sb);
            initSentryBrowser(CONFIG.SENTRY_BROWSER_LOADER_URL);
            return session;
        }

        throw new Error('Unauthorized');

    } catch (e) {
        const loginPage = (requiredRole === 'steward') ? 'steward_login.html' : 'login.html';
        if (e.message === 'Not authenticated') {
            window.location.href = loginPage;
        } else if (e.message === 'Unauthorized') {
            window.location.href = loginPage + '?error=unauthorized';
        } else if (e.message === 'NoOrganisation') {
            window.location.href = loginPage + '?error=no_organisation';
        } else if (e.message === 'MultipleOrganisations') {
            window.location.href = loginPage + '?error=multiple_organisations';
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
                await initNavigation();
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
