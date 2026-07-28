import { getPublicSupabaseClient, initPublicPage } from '../supabase-public.js';
import { parseEdgeFunctionError } from './utils.js';

// Hardcoded rather than ESF_PUBLIC_CONFIG.PORTAL_URL — see page-cancel.js
// for why (that value is currently a dead link).
const CONTACT_URL = 'https://www.ellastreet.co.uk/contact';

// No settings this page needs (no Turnstile, no base_url — the redirect
// target is resolved entirely server-side), so it opts out of the DB
// settings load initPublicPage() otherwise awaits by default.
initPublicPage(async () => {
    const sb = getPublicSupabaseClient();

    const contactLink = document.getElementById('contact-link');
    if (contactLink) {
        contactLink.href = CONTACT_URL;
        contactLink.target = '_blank';
        contactLink.rel = 'noopener noreferrer';
    }

    const showError = (message) => {
        document.getElementById('loadingMsg').classList.add('hidden');
        const errorText = document.getElementById('errorText');
        if (errorText && message) errorText.textContent = message;
        document.getElementById('errorMsg').classList.remove('hidden');
    };

    const params = new URLSearchParams(window.location.search);
    const token = params.get('token');
    if (!token) {
        showError('This link is missing a valid payment token.');
        return;
    }

    try {
        const { data, error } = await sb.functions.invoke('get-payment-link', { body: { token } });
        if (error) throw new Error(await parseEdgeFunctionError(error, 'Server error'));
        if (data && data.error) throw new Error(data.error);
        if (!data || !data.checkout_url) throw new Error('No payment link was returned.');

        const manualLink = document.getElementById('manualLink');
        if (manualLink) manualLink.href = data.checkout_url;

        window.location.replace(data.checkout_url);
    } catch (err) {
        // Mirrors page-cancel.js's reasoning: err.message here is always
        // either a message the server deliberately crafted for the end
        // user, or a generic browser/network error — never a raw internal
        // one, so it's safe to show verbatim.
        showError((err && err.message) ? err.message : 'Something went wrong. Please try again or contact us.');
    }
}, { loadSettings: false });
