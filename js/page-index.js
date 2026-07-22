import { initAdminPage, getSupabaseClient } from './supabase.js';
import { getCurrentInstance } from './config.js';
import { showToast } from './ui.js';
import { safeError } from './utils.js';

let sb;

// ---------------------------------------------------------------------------
// Password-recovery detection — MUST happen synchronously at module load,
// before initAdminPage / requireAuth runs.
//
// When an admin clicks a Supabase password-reset link they are redirected to
// index.html with a URL fragment like:
//   #access_token=...&refresh_token=...&type=recovery
//
// The Supabase client auto-exchanges that token and creates a valid session,
// so requireAuth() would pass even though the intent is only to set a new
// password.  The PASSWORD_RECOVERY auth-state-change event fires
// *asynchronously* (after the microtask queue), so any synchronous check
// for it runs too late — the dashboard has already rendered.
//
// Solution: read `type` from the hash fragment right now, synchronously,
// and skip the normal auth + dashboard flow entirely if it is "recovery".
// ---------------------------------------------------------------------------
const _hashParams = new URLSearchParams(window.location.hash.slice(1));
const IS_PASSWORD_RECOVERY = _hashParams.get('type') === 'recovery';

if (IS_PASSWORD_RECOVERY) {
    // --- RECOVERY PATH ---
    // Show only the password-reset modal; nothing else is rendered.
    document.addEventListener('DOMContentLoaded', () => {
        // Create the client — and let it exchange the recovery hash for a
        // session — BEFORE the hash is stripped below. getSupabaseClient()
        // constructs the underlying GoTrueClient, which reads the
        // access_token/type=recovery params out of window.location at
        // construction time to establish the session; call this any later
        // and there's nothing left in the URL to exchange, so
        // auth.updateUser() below fails with "Auth session missing!".
        sb = getSupabaseClient();

        // Strip the sensitive token from the browser's address bar now that
        // the client has consumed it.
        window.history.replaceState(null, '', window.location.pathname);

        // Hide dashboard chrome so there is nothing to interact with.
        const navContainer = document.getElementById('nav-container');
        if (navContainer) navContainer.style.display = 'none';

        const mainContent = document.querySelector('.max-w-7xl');
        if (mainContent) mainContent.style.display = 'none';

        // Show the mandatory password-change modal.
        const modal = document.getElementById('passwordResetModal');
        if (modal) modal.classList.remove('opacity-0', 'pointer-events-none');

        // Wire up the button.
        const updatePassBtn = document.getElementById('updatePassBtn');
        if (updatePassBtn) {
            updatePassBtn.addEventListener('click', updateUserPassword);
        }
    });

} else {
    // --- NORMAL PATH ---
    initAdminPage(initIndex);
}

// ---------------------------------------------------------------------------
// Normal dashboard initialisation (only reached when IS_PASSWORD_RECOVERY is false)
// ---------------------------------------------------------------------------
function initIndex() {
    sb = getSupabaseClient();

    updateVisibility();

    // Event delegation for navigation cards.
    document.body.addEventListener('click', (e) => {
        const navCard = e.target.closest('[data-action="navigate"]');
        if (navCard) {
            const page = navCard.dataset.page;
            if (!page) return;
            // visitor_map.html is also reachable directly by a real member of
            // the public with no session at all, so it must default to the
            // real LIVE data - it must NOT read the admin's ESF_INSTANCE
            // localStorage the way every other admin page does, since a
            // genuine visitor never has that key set but an admin previewing
            // from this card, on this same browser, always does. Passing the
            // instance as an explicit one-time query param means this card's
            // "preview what I'm currently working on" intent is honoured for
            // exactly this navigation, without the map silently inheriting
            // unrelated leftover browser state on every future visit.
            if (page === 'visitor_map') {
                window.location.href = `${page}.html?preview=${encodeURIComponent(getCurrentInstance())}`;
            } else {
                window.location.href = page + '.html';
            }
        }
    });
}

function updateVisibility() {
    const val = getCurrentInstance();
    const hccCard = document.getElementById('hcc-card');

    if (hccCard) {
        if (val === 'FOOD' || val === 'DEV') {
            hccCard.classList.remove('hidden');
        } else {
            hccCard.classList.add('hidden');
        }
    }
}

// ---------------------------------------------------------------------------
// Password update — shared by both paths (recovery modal lives in index.html)
// ---------------------------------------------------------------------------
async function updateUserPassword() {
    const newPass = document.getElementById('newPassword').value;
    const btn = document.getElementById('updatePassBtn');

    if (newPass.length < 8) {
        showToast('Password must be at least 8 characters', 'error');
        return;
    }

    btn.disabled = true;
    btn.innerText = 'Updating...';

    try {
        const { error } = await sb.auth.updateUser({ password: newPass });
        if (error) throw error;

        showToast('Password updated successfully! Redirecting to login…', 'success');

        // Sign out so the recovery session is fully cleared, then force the
        // admin to authenticate fresh with their new password.
        setTimeout(async () => {
            await sb.auth.signOut();
            window.location.href = 'login.html';
        }, 1500);

    } catch (err) {
        console.error('Password update failed:', err);
        showToast('Failed to update password: ' + safeError(err), 'error');
        btn.disabled = false;
        btn.innerText = 'Update Password';
    }
}
