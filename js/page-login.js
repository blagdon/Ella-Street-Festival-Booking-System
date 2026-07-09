import { getSupabaseClient } from './supabase.js';
import { safeError } from './utils.js';
import { auditLog } from './api.js';

// --- UTILITIES ---
let loginAttempts = 0;
let lockoutUntil = 0;

function toggleView(view) {
    const loginCard = document.getElementById('loginCard');
    const resetCard = document.getElementById('resetCard');
    const loginError = document.getElementById('loginError');
    const resetMsg = document.getElementById('resetMessage');

    // Clear messages
    loginError.classList.add('hidden');
    resetMsg.classList.add('hidden');

    if (view === 'reset') {
        loginCard.classList.add('hidden');
        resetCard.classList.remove('hidden');
        document.getElementById('resetEmail').value = document.getElementById('loginEmail').value; // Auto-fill email
        document.getElementById('resetEmail').focus();
    } else {
        resetCard.classList.add('hidden');
        loginCard.classList.remove('hidden');
        document.getElementById('loginEmail').focus();
    }
}

// --- INITIALIZATION ---
document.addEventListener('DOMContentLoaded', async () => {
    // Attach event listeners
    document.getElementById('link-forgot-password')?.addEventListener('click', () => toggleView('reset'));
    document.getElementById('link-back-login')?.addEventListener('click', () => toggleView('login'));

    // Check for unauthorized access error from RBAC redirect
    const params = new URLSearchParams(window.location.search);
    const isUnauthorized = params.get('error') === 'unauthorized';

    if (isUnauthorized) {
        const errEl = document.getElementById('loginError');
        errEl.innerText = 'You do not have administrative privileges.';
        errEl.classList.remove('hidden');
    }

    try {
        const sb = getSupabaseClient();
        const { data: { session } } = await sb.auth.getSession();

        // Only auto-redirect if NOT coming from an unauthorized rejection
        if (session && !isUnauthorized) {
            window.location.href = 'index.html';
            return;
        }
    } catch (e) { /* not logged in, show form */ }

    document.getElementById('loadingState').classList.add('hidden');
    document.getElementById('loginCard').classList.remove('hidden');
    document.getElementById('loginEmail').focus();
});

// --- LOGIN HANDLER ---
document.getElementById('loginForm')?.addEventListener('submit', async function (e) {
    e.preventDefault();
    const btn = document.getElementById('loginBtn');
    const errEl = document.getElementById('loginError');

    // Check lockout
    const now = Date.now();
    if (now < lockoutUntil) {
        const secsLeft = Math.ceil((lockoutUntil - now) / 1000);
        errEl.innerText = `Too many attempts. Try again in ${secsLeft}s.`;
        errEl.classList.remove('hidden');
        return;
    }

    btn.disabled = true;
    btn.innerText = 'Signing in...';
    errEl.classList.add('hidden');

    try {
        const sb = getSupabaseClient();
        const { error } = await sb.auth.signInWithPassword({
            email: document.getElementById('loginEmail').value.trim(),
            password: document.getElementById('loginPassword').value
        });

        if (error) throw error;

        // Log the successful sign-in
        await auditLog('admin_login', 'system', { email: document.getElementById('loginEmail').value.trim() });

        loginAttempts = 0; // Reset on success
        window.location.href = 'index.html';

    } catch (err) {
        loginAttempts++;
        if (loginAttempts >= 5) {
            lockoutUntil = Date.now() + 30000; // 30 second lockout
            errEl.innerText = 'Too many failed attempts. Please wait 30 seconds.';
        } else {
            errEl.innerText = (typeof safeError === 'function') ? safeError(err) : 'Invalid email or password.';
        }
        errEl.classList.remove('hidden');
        btn.disabled = false;
        btn.innerText = 'Sign In';
    }
});

// --- RESET PASSWORD HANDLER ---
document.getElementById('resetForm')?.addEventListener('submit', async function (e) {
    e.preventDefault();
    const btn = document.getElementById('resetBtn');
    const msgEl = document.getElementById('resetMessage');
    const email = document.getElementById('resetEmail').value.trim();

    btn.disabled = true;
    btn.innerText = 'Sending...';
    msgEl.classList.add('hidden');

    try {
        const sb = getSupabaseClient();

        // Send the password reset email
        // Redirects user to index.html after they click the email link
        // Use dynamic origin instead of hardcoded production domain
        const { error } = await sb.auth.resetPasswordForEmail(email, {
            redirectTo: window.location.origin + "/index.html"
        });

        if (error) throw error;

        msgEl.className = "mt-4 p-3 bg-green-50 border border-green-200 text-green-700 rounded-lg text-sm text-center";
        msgEl.innerHTML = "<b>Check your email!</b><br>We've sent a password reset link to " + email;
        msgEl.classList.remove('hidden');

    } catch (err) {
        msgEl.className = "mt-4 p-3 bg-red-50 border border-red-200 text-red-700 rounded-lg text-sm text-center";
        msgEl.innerText = (typeof safeError === 'function') ? safeError(err) : "Failed to send reset email. Please check your email address and try again.";
        msgEl.classList.remove('hidden');
    } finally {
        btn.disabled = false;
        btn.innerText = 'Send Reset Link';
    }
});
