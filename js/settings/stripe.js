// @ts-check
import { getSupabaseClient } from '../supabase.js';
import { showToast } from '../ui.js';
import { auditLog } from '../audit.js';
import { buildStripeCredentialUpdates, STRIPE_CREDENTIAL_KEYS } from '../stripe-credentials.js';

const sb = getSupabaseClient();

/**
 * "Stripe Test Mode for Food/General" — a settings-table boolean
 * (`stripe_test_mode`, text 'true'/'false') read by the create-checkout-session
 * Edge Function. DEV-instance bookings always use Stripe Test Mode regardless
 * (unchanged); this toggle additionally forces Test Mode for FOOD/NONFOOD/MISC
 * bookings too, e.g. for a full rehearsal before going live with real payments.
 */
export async function initStripeSettings() {
    const btn = document.getElementById('toggle-stripe-test-mode');
    const dot = document.getElementById('toggle-stripe-test-mode-dot');
    const lbl = document.getElementById('lbl-stripe-test-mode-status');

    if (!btn) return;

    let testModeOn = false;

    try {
        const { data, error } = await sb.from('settings').select('key, value').eq('key', 'stripe_test_mode').maybeSingle();
        if (error) throw error;
        testModeOn = data ? (data.value === 'true') : false;
        updateUI(testModeOn);
    } catch (err) {
        showToast("Failed to load Stripe test mode setting: " + err.message, 'error');
    }

    btn.addEventListener('click', () => toggleSetting(!testModeOn));

    function updateUI(isOn) {
        if (isOn) {
            btn.className = "relative inline-flex h-6 w-11 items-center rounded-full bg-green-500 transition-colors focus:outline-none cursor-pointer";
            dot.className = "inline-block h-4 w-4 transform rounded-full bg-white transition-transform translate-x-6";
            lbl.className = "text-xs font-semibold text-green-700";
            lbl.textContent = "Test Mode ON for Food/General";
        } else {
            btn.className = "relative inline-flex h-6 w-11 items-center rounded-full bg-gray-300 transition-colors focus:outline-none cursor-pointer";
            dot.className = "inline-block h-4 w-4 transform rounded-full bg-white transition-transform translate-x-1";
            lbl.className = "text-xs font-semibold text-gray-600";
            lbl.textContent = "Live Mode for Food/General";
        }
        testModeOn = isOn;
    }

    async function toggleSetting(newValue) {
        const strVal = newValue ? 'true' : 'false';

        lbl.className = "text-xs text-gray-600 italic";
        lbl.textContent = "Saving...";

        try {
            const { data: { session } } = await sb.auth.getSession();
            const userEmail = session?.user?.email || 'admin';

            const { error } = await sb.from('settings').upsert({
                key: 'stripe_test_mode',
                value: strVal,
                updated_at: new Date().toISOString(),
                updated_by: userEmail
            });
            if (error) throw error;

            updateUI(newValue);
            showToast(`Stripe Test Mode for Food/General turned ${newValue ? 'ON' : 'OFF'}`);
            await auditLog('toggle_stripe_test_mode', 'stripe_test_mode', { test_mode: newValue });
        } catch (err) {
            showToast(`Failed to update setting: ${err.message}`, 'error');
            updateUI(testModeOn);
        }
    }

    // Credential fields (secret key + webhook signing secret, per mode).
    // Deliberately NOT hardcoded anywhere — these are the only source of
    // truth create-checkout-session/stripe-webhook read from, mirroring how
    // Zoho's credentials already work in this same table. Save is
    // permissive (no "all required" check) since an admin may legitimately
    // want to save just the Test-mode pair first and add Live later.
    //
    // WRITE-ONLY: these inputs are never populated with the stored credential.
    // The page learns only whether each key is set, never its value — see
    // refreshCredentialStatus() below and the comment in settings.html.
    const txtSecretTest = document.getElementById('stripe-secret-key-test');
    const txtSecretLive = document.getElementById('stripe-secret-key-live');
    const txtWebhookTest = document.getElementById('stripe-webhook-secret-test');
    const txtWebhookLive = document.getElementById('stripe-webhook-secret-live');
    const btnSaveStripe = /** @type {HTMLButtonElement | null} */ (document.getElementById('btn-save-stripe'));

    if (txtSecretTest && txtSecretLive && txtWebhookTest && txtWebhookLive && btnSaveStripe) {
        const fieldsByKey = {
            stripe_secret_key_test: txtSecretTest,
            stripe_secret_key_live: txtSecretLive,
            stripe_webhook_secret_test: txtWebhookTest,
            stripe_webhook_secret_live: txtWebhookLive
        };

        /**
         * Renders whether each credential is set, WITHOUT ever fetching its
         * value. Only the `key` column is selected, and the "is it set" test is
         * a server-side filter (.neq('value', '')), so the secrets themselves
         * never cross the wire and never enter the DOM. NULL values fail that
         * filter too, which is correct — an absent value is "not set".
         *
         * Do not be tempted to select `value` here to show a masked preview
         * ("sk_live_…abcd"): that puts the full secret back in the page, which
         * is exactly what this change removes.
         */
        async function refreshCredentialStatus() {
            const setStatus = (key, text, className) => {
                const el = document.getElementById(`${fieldsByKey[key].id}-status`);
                if (el) {
                    el.textContent = text;
                    el.className = `text-xs mt-1 ${className}`;
                }
            };

            try {
                const { data, error } = await sb.from('settings')
                    .select('key')
                    .in('key', STRIPE_CREDENTIAL_KEYS)
                    .neq('value', '');
                if (error) throw error;

                const configured = new Set((data || []).map(row => row.key));
                STRIPE_CREDENTIAL_KEYS.forEach(key => {
                    if (configured.has(key)) setStatus(key, '✓ Configured', 'text-green-700');
                    else setStatus(key, 'Not set', 'text-gray-600');
                });
            } catch (err) {
                // Non-fatal, and deliberately does NOT disable saving. Before
                // these fields were write-only, a failed load left them looking
                // blank when they were actually populated, so saving from that
                // state wiped them — hence the hard block this replaces. Now the
                // fields are ALWAYS blank on load and a blank one is never
                // written (buildStripeCredentialUpdates filters it out), so a
                // failed status check cannot cause a wipe. Blocking saves here
                // would only stop an admin configuring Stripe for no safety gain.
                STRIPE_CREDENTIAL_KEYS.forEach(key =>
                    setStatus(key, 'Could not check', 'text-amber-700'));
                showToast("Couldn't check which Stripe credentials are set: " + err.message, 'error');
            }
        }

        await refreshCredentialStatus();

        btnSaveStripe.addEventListener('click', async () => {
            btnSaveStripe.disabled = true;
            btnSaveStripe.textContent = "Saving...";

            try {
                const { data: { session } } = await sb.auth.getSession();
                const userEmail = session?.user?.email || 'admin';
                const now = new Date().toISOString();

                // A blank field means "leave this one alone", not "clear it" —
                // see stripe-credentials.js. With write-only fields this is the
                // normal case: every field starts blank on load, so a save only
                // ever writes the ones actually typed into.
                const updates = buildStripeCredentialUpdates(
                    Object.fromEntries(
                        STRIPE_CREDENTIAL_KEYS.map(key => [key, fieldsByKey[key].value])
                    ),
                    { updatedAt: now, updatedBy: userEmail }
                );

                if (updates.length === 0) {
                    showToast("Nothing to save — type a credential to replace it. Blank fields are left unchanged.", 'error');
                    return;
                }

                const { error } = await sb.from('settings').upsert(updates);
                if (error) throw error;

                // Don't leave the typed secrets sitting in the DOM afterwards —
                // the whole point of write-only fields is that the page holds a
                // credential for as short a time as possible.
                updates.forEach(row => { fieldsByKey[row.key].value = ''; });
                await refreshCredentialStatus();

                showToast(`Saved ${updates.length} Stripe credential${updates.length === 1 ? '' : 's'}`);
                await auditLog('update_stripe_settings', 'system', {
                    updated_keys: updates.map(row => row.key)
                });
            } catch (err) {
                showToast(`Failed to save Stripe credentials: ${err.message}`, 'error');
            } finally {
                btnSaveStripe.disabled = false;
                btnSaveStripe.textContent = "Save Stripe Settings";
            }
        });
    }
}
