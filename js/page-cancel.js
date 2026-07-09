import { getPublicSupabaseClient } from '../supabase-public.js';

const sb = getPublicSupabaseClient(); // From supabase-public.js

document.addEventListener('DOMContentLoaded', () => {
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
                const { data, error } = await sb.rpc('cancel_booking_secure', {
                    p_token: cancelToken,
                    p_reason: reason || null
                });

                if (error || (data && data.success === false)) {
                    const errMsg = (data && data.error) ? data.error : "Could not cancel. The link may have already been used or has expired.";
                    throw new Error(errMsg);
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
                msg.className = "mt-6 p-4 rounded-lg bg-yellow-50 border border-yellow-200 text-center text-sm font-bold text-yellow-800";
                // Fix #3: Use safeError or fallback to prevent leaking info
                msg.innerText = (err && err.message) ? "Cancellation failed: " + err.message : "Something went wrong. Please try again or contact us.";

                // Actually, if safeError is available globally (e.g. from a shared script), use it.
                // But for public pages, we should be very careful.
                if (typeof safeError === 'function') {
                    msg.innerText = safeError(err);
                } else if (err.message && err.message.includes("not found")) {
                    msg.innerText = "Booking not found or already cancelled.";
                } else {
                    msg.innerText = "Something went wrong. Please try again or contact us.";
                }

                msg.classList.remove('hidden');
                btn.disabled = false;
                btn.innerText = "Confirm Cancellation";
                if (typeof turnstile !== 'undefined') turnstile.reset();
            }
        });
    }
});
