// @ts-check
import { getSupabaseClient, initSentryBrowser } from './supabase.js';
import { safeError } from './utils.js';
import { initPublicPage, fetchSentryBrowserLoaderUrl } from '../supabase-public.js';

// Fix #6: Login rate limiting
let loginAttempts = 0;
let lockoutUntil = 0;

// CI proved (trace evidence, admin-accessibility-tests run 31469497463) that
// attaching this listener at the end of the async init chain below is a
// race: on a slow enough runner, a click can land on #loginBtn before the
// Sentry-loader fetch + getSession() check resolve, and with no listener
// attached yet the browser falls through to native <form> submission (no
// method/action -> GET to the current URL), reloading the page and silently
// dropping the login attempt. Attaching synchronously - before any async
// work, as soon as the module runs - means e.preventDefault() always wins
// that race, regardless of timing. #loginBtn is also disabled until init
// completes (see the finally block below), so a real user can't trigger a
// login before the handler is actually ready to do anything with it; the
// initReady guard in handleLogin() is the same check enforced in JS, as a
// second, independent line of defence.
let initReady = false;

const loginForm = document.getElementById('loginForm');
if (loginForm) {
    loginForm.addEventListener('submit', handleLogin);
}

// loadSettings: false — this page reads no OTHER public settings; keep it
// free of the DB round-trip. sentry_browser_loader_url gets its own scoped
// fetch below instead of coming along for free.
initPublicPage(async () => {
    const btn = /** @type {HTMLButtonElement | null} */ (document.getElementById('loginBtn'));
    try {
        initSentryBrowser(await fetchSentryBrowserLoaderUrl(getSupabaseClient()));

        // Check for an error from RBAC/organisation-resolution redirects
        // (js/supabase.js's requireAuth()) - reusing the same errorMsg element
        // and query-param convention for all three reasons, not a new UI.
        const params = new URLSearchParams(window.location.search);
        const errorReason = params.get('error');

        if (errorReason) {
            const errorMsg = document.getElementById('errorMsg');
            if (errorMsg) {
                if (errorReason === 'no_organisation') {
                    errorMsg.innerText = 'Your account isn\'t linked to an organisation. Contact your administrator.';
                } else if (errorReason === 'multiple_organisations') {
                    errorMsg.innerText = 'Your account belongs to more than one organisation. Contact your administrator to resolve this before signing in as a steward.';
                } else {
                    errorMsg.innerText = 'You do not have steward privileges.';
                }
                errorMsg.classList.remove('hidden');
            }
        }

        // Auto-redirect check
        try {
            const sb = getSupabaseClient();
            const { data: { session } } = await sb.auth.getSession();
            if (session && !errorReason) {
                window.location.href = 'steward.html';
                return;
            }
        } catch (e) {
            console.error("Auto-redirect check failed:", e);
        }
    } finally {
        // Always run, even if the Sentry loader fetch or getSession() threw -
        // a non-essential init failure must not leave the form permanently
        // disabled with no way for a real user to sign in.
        initReady = true;
        if (btn) {
            btn.disabled = false;
            btn.innerText = 'Sign In';
        }
    }
}, { loadSettings: false });

async function handleLogin(e) {
    e.preventDefault();
    if (!initReady) return;

    const email = (/** @type {HTMLInputElement} */ (document.getElementById('email'))).value.trim();
    const password = (/** @type {HTMLInputElement} */ (document.getElementById('password'))).value; // Fix #7: No .trim() on password
    const btn = /** @type {HTMLButtonElement} */ (document.getElementById('loginBtn'));
    const errorMsg = /** @type {HTMLElement} */ (document.getElementById('errorMsg'));

    // Fix #6: Check lockout
    const now = Date.now();
    if (now < lockoutUntil) {
        const secsLeft = Math.ceil((lockoutUntil - now) / 1000);
        errorMsg.innerText = `Too many attempts. Try again in ${secsLeft}s.`;
        errorMsg.classList.remove('hidden');
        return;
    }

    // Reset UI
    errorMsg.classList.add('hidden');
    btn.disabled = true;
    btn.innerHTML = `<span class="animate-pulse">Authenticating...</span>`;

    try {
        const sb = getSupabaseClient();

        const { error } = await sb.auth.signInWithPassword({
            email: email,
            password: password
        });

        if (error) throw error;

        // Success: reset attempts and redirect
        loginAttempts = 0;
        window.location.href = 'steward.html';

    } catch (err) {
        // Fix #6: Increment attempts and apply backoff
        loginAttempts++;
        if (loginAttempts >= 5) {
            lockoutUntil = Date.now() + 30000; // 30 second lockout
            errorMsg.innerText = 'Too many failed attempts. Please wait 30 seconds.';
        } else {
            // Fix #5: Use safeError instead of raw err.message
            errorMsg.innerText = (typeof safeError === 'function') ? safeError(err) : 'Login failed';
        }
        errorMsg.classList.remove('hidden');
        btn.disabled = false;
        btn.innerText = "Sign In";

        // Shake animation for bad password
        const card = document.querySelector('.bg-white');
        if (card) {
            card.classList.add('animate-bounce');
            setTimeout(() => card.classList.remove('animate-bounce'), 500);
        }
    }
}
