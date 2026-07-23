import { getPublicSupabaseClient, initPublicPage } from '../supabase-public.js';
import { parseEdgeFunctionError } from './utils.js';

// Hardcoded rather than ESF_PUBLIC_CONFIG.PORTAL_URL - that value is
// currently a dead link (ellastreet.co.uk/fest26/portal 404s), and this is
// a fixed page on the festival's own site, not something that changes per
// environment.
const CONTACT_URL = 'https://www.ellastreet.co.uk/contact';

initPublicPage(async () => {
    const sb = getPublicSupabaseClient(); // From supabase-public.js

    const contactLink = document.getElementById('contact-link');
    if (contactLink) {
        contactLink.href = CONTACT_URL;
        contactLink.target = '_blank';
        contactLink.rel = 'noopener noreferrer';
    }

    // Bind Turnstile Key from database dynamically
    const siteKey = window.ESF_PUBLIC_CONFIG?.TURNSTILE_SITE_KEY;
    if (siteKey) {
        document.querySelectorAll('.cf-turnstile').forEach(el => {
            el.setAttribute('data-sitekey', siteKey);
        });
    }

    // Dynamically load Turnstile script
    const script = document.createElement('script');
    script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js";
    script.async = true;
    script.defer = true;
    document.head.appendChild(script);
    // --- 1. READ TOKEN FROM URL ---
    const params = new URLSearchParams(window.location.search);
    const cancelToken = params.get('token');

    if (!cancelToken) {
        document.getElementById('invalidTokenMsg').classList.remove('hidden');
    } else {
        document.getElementById('cancelForm').classList.remove('hidden');
    }

    // --- 2. HANDLE CANCELLATION ---
    const cancelForm = document.getElementById('cancelForm');
    if (cancelForm) {
        cancelForm.addEventListener('submit', async function (e) {
            e.preventDefault();

            const btn = document.getElementById('submitBtn');
            const msg = document.getElementById('statusMessage');
            const reason = document.getElementById('inputReason').value.trim();

            // Verify CAPTCHA
            const captchaToken = document.querySelector('[name="cf-turnstile-response"]');
            if (!captchaToken || !captchaToken.value) {
                msg.className = "mt-6 p-4 rounded-lg bg-yellow-50 border border-yellow-200 text-center text-sm font-bold text-yellow-800";
                msg.innerText = "Please complete the CAPTCHA verification.";
                msg.classList.remove('hidden');
                return;
            }

            // UI Loading
            btn.disabled = true;
            btn.innerHTML = `<svg class="animate-spin -ml-1 mr-3 h-5 w-5 text-white inline-block" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg> Verifying...`;
            msg.classList.add('hidden');

            try {
                const { data, error } = await sb.functions.invoke('cancel-booking', {
                    body: {
                        token: captchaToken.value,
                        cancelToken: cancelToken,
                        reason: reason || null
                    }
                });

                if (error) {
                    throw new Error(await parseEdgeFunctionError(error, "Server error"));
                }
                if (data && data.error) {
                    throw new Error(data.error);
                }

                // Success
                document.getElementById('cancelForm').classList.add('hidden');
                msg.className = "mt-6 p-6 rounded-lg bg-red-50 border border-red-200 text-center";
                msg.innerHTML = `
          <div class="flex flex-col items-center">
            <div class="h-12 w-12 bg-red-100 rounded-full flex items-center justify-center mb-3">
              <svg class="w-6 h-6 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path>
              </svg>
            </div>
            <h3 class="text-lg font-bold text-red-800">Booking Cancelled</h3>
            <p class="text-red-600 mt-1">Your booking has been removed from the active list.</p>
            <p class="text-sm text-gray-500 mt-2">A confirmation email has been sent.</p>
          </div>
        `;
                msg.classList.remove('hidden');

            } catch (err) {
                // err.message here is always either a message the server deliberately
                // crafted for the end user (via parseEdgeFunctionError or data.error
                // above) or a generic browser/network error - this flow never makes a
                // raw Postgres/Supabase call directly, so there's no risk of leaking
                // internal error detail the way safeError() guards against elsewhere.
                // safeError() was previously double-processing the server's own safe
                // message here, and its "token" substring match was misfiring on the
                // legitimate phrase "Invalid or expired cancel token." - showing a
                // confusing "Authentication error" instead of the real reason.
                msg.className = "mt-6 p-4 rounded-lg bg-yellow-50 border border-yellow-200 text-center text-sm font-bold text-yellow-800";
                msg.innerText = (err && err.message) ? err.message : "Something went wrong. Please try again or contact us.";
                msg.classList.remove('hidden');
                btn.disabled = false;
                btn.innerText = "Confirm Cancellation";
                if (typeof turnstile !== 'undefined') turnstile.reset();
            }
        });
    }
});
