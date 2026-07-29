import { getPublicSupabaseClient, initPublicPage } from '../supabase-public.js';
import { parseEdgeFunctionError } from './utils.js';

// Hardcoded rather than ESF_PUBLIC_CONFIG.PORTAL_URL — see page-cancel.js
// for why (that value is currently a dead link).
const CONTACT_URL = 'https://www.ellastreet.co.uk/contact';

// No settings this page needs beyond the Turnstile site key (below) - the
// redirect target is resolved entirely server-side, so it opts out of the
// DB settings load initPublicPage() otherwise awaits by default.
initPublicPage(async () => {
    const sb = getPublicSupabaseClient();

    document.querySelectorAll('#contact-link, #contact-link-error').forEach(el => {
        el.href = CONTACT_URL;
        el.target = '_blank';
        el.rel = 'noopener noreferrer';
    });

    // Bind Turnstile Key dynamically, then load the widget script - same
    // pattern as page-cancel.js/page-food-booking.js.
    const siteKey = window.ESF_PUBLIC_CONFIG?.TURNSTILE_SITE_KEY;
    if (siteKey) {
        document.querySelectorAll('.cf-turnstile').forEach(el => {
            el.setAttribute('data-sitekey', siteKey);
        });
    }
    const script = document.createElement('script');
    script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js";
    script.async = true;
    script.defer = true;
    document.head.appendChild(script);

    const statusMsg = document.getElementById('statusMessage');
    const showStatus = (message) => {
        statusMsg.textContent = message;
        statusMsg.classList.remove('hidden');
    };

    // URL query param stays "token" - every already-sent SMS/email link uses
    // pay.html?token=<payment_link_code>, and that can't be changed
    // retroactively. Internally distinct from the Turnstile response, which
    // the server now also expects in the same request (get-payment-link can
    // create real Stripe sessions, so it needs the same CAPTCHA gate
    // submit-booking/cancel-booking already have).
    const params = new URLSearchParams(window.location.search);
    const paymentLinkCode = params.get('token');

    if (!paymentLinkCode) {
        document.getElementById('invalidTokenMsg').classList.remove('hidden');
        return;
    }
    document.getElementById('payForm').classList.remove('hidden');

    const continueBtn = document.getElementById('continueBtn');
    const continueBtnText = document.getElementById('continueBtnText');

    continueBtn.addEventListener('click', async () => {
        const captchaToken = document.querySelector('[name="cf-turnstile-response"]');
        if (!captchaToken || !captchaToken.value) {
            showStatus('Please complete the CAPTCHA verification.');
            return;
        }

        statusMsg.classList.add('hidden');
        continueBtn.disabled = true;
        continueBtnText.textContent = 'Preparing your payment…';

        try {
            const { data, error } = await sb.functions.invoke('get-payment-link', {
                body: { token: captchaToken.value, paymentToken: paymentLinkCode }
            });
            if (error) throw new Error(await parseEdgeFunctionError(error, 'Server error'));
            if (data && data.error) throw new Error(data.error);
            if (!data || !data.checkout_url) throw new Error('No payment link was returned.');

            continueBtnText.textContent = 'Redirecting…';
            window.location.replace(data.checkout_url);
        } catch (err) {
            // Mirrors page-cancel.js's reasoning: err.message here is always
            // either a message the server deliberately crafted for the end
            // user, or a generic browser/network error — never a raw internal
            // one, so it's safe to show verbatim. The form stays visible/
            // usable so a recoverable failure (a momentary "still preparing"
            // race, an expired CAPTCHA) can just be retried.
            showStatus((err && err.message) ? err.message : 'Something went wrong. Please try again or contact us.');
            continueBtn.disabled = false;
            continueBtnText.textContent = 'Continue to Payment';
            if (typeof turnstile !== 'undefined') turnstile.reset();
        }
    });
}, { loadSettings: false });
