import { getSupabaseClient } from './supabase.js';
import { safeError } from './utils.js';
import { initPublicPage } from '../supabase-public.js';

// Fix #6: Login rate limiting
let loginAttempts = 0;
let lockoutUntil = 0;

// loadSettings: false — this page reads no public settings; keep it free of
// the DB round-trip.
initPublicPage(async () => {
    // Check for unauthorized access error from RBAC redirect
    const params = new URLSearchParams(window.location.search);
    const isUnauthorized = params.get('error') === 'unauthorized';

    if (isUnauthorized) {
        const errorMsg = document.getElementById('errorMsg');
        if (errorMsg) {
            errorMsg.innerText = 'You do not have steward privileges.';
            errorMsg.classList.remove('hidden');
        }
    }

    // Auto-redirect check
    try {
        const sb = (typeof window.sbClient !== 'undefined') ? window.sbClient : getSupabaseClient();
        const { data: { session } } = await sb.auth.getSession();
        if (session && !isUnauthorized) {
            window.location.href = 'steward.html';
        }
    } catch (e) {
        console.error("Auto-redirect check failed:", e);
    }

    const loginForm = document.getElementById('loginForm');
    if (loginForm) {
        loginForm.addEventListener('submit', handleLogin);
    }
}, { loadSettings: false });

async function handleLogin(e) {
    e.preventDefault();

    const email = document.getElementById('email').value.trim();
    const password = document.getElementById('password').value; // Fix #7: No .trim() on password
    const btn = document.getElementById('loginBtn');
    const errorMsg = document.getElementById('errorMsg');

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
        // Use the sbClient from config.js (or create new if missing)
        const sb = (typeof window.sbClient !== 'undefined') ? window.sbClient : getSupabaseClient();

        const { data, error } = await sb.auth.signInWithPassword({
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
