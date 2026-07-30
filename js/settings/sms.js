import { getSupabaseClient } from '../supabase.js';
import { showToast } from '../ui.js';
import { auditLog } from '../audit.js';

const sb = getSupabaseClient();

/**
 * SMS (The SMS Works) — sms_provider is fixed to 'thesmsworks' by this card
 * (there is no provider dropdown here; _shared/sms.ts still supports 'mock'
 * and 'twilio' as adapters, but this UI is scoped to the one integration
 * that was actually asked for). sms_test_mode is the separate, more visible
 * master switch — see the 20260728090000 migration and sendViaSms() in
 * _shared/sms.ts for why it overrides the provider rather than the admin
 * needing to remember to flip sms_provider back to 'mock'.
 */
export async function initSmsSettings() {
    const btnTestMode = document.getElementById('toggle-sms-test-mode');
    const dotTestMode = document.getElementById('toggle-sms-test-mode-dot');
    const lblTestMode = document.getElementById('lbl-sms-test-mode-status');
    const txtSenderId = document.getElementById('sms-sender-id');
    const txtApiKey = document.getElementById('sms-api-key');
    const lblApiKeyStatus = document.getElementById('sms-api-key-status');
    const btnSave = document.getElementById('btn-save-sms');

    if (!btnTestMode || !txtSenderId || !txtApiKey || !btnSave) return;

    let testModeOn = true; // matches the migration's safe-by-default seed

    function updateToggleUI(isOn) {
        if (isOn) {
            btnTestMode.className = "relative inline-flex h-6 w-11 items-center rounded-full bg-amber-500 transition-colors focus:outline-none cursor-pointer";
            dotTestMode.className = "inline-block h-4 w-4 transform rounded-full bg-white transition-transform translate-x-6";
            lblTestMode.className = "text-xs font-semibold text-amber-700";
            lblTestMode.textContent = "Test Mode ON — no real texts are sent";
        } else {
            btnTestMode.className = "relative inline-flex h-6 w-11 items-center rounded-full bg-green-500 transition-colors focus:outline-none cursor-pointer";
            dotTestMode.className = "inline-block h-4 w-4 transform rounded-full bg-white transition-transform translate-x-1";
            lblTestMode.className = "text-xs font-semibold text-green-700";
            lblTestMode.textContent = "Live — real texts are sent and billed";
        }
        testModeOn = isOn;
    }

    async function toggleTestMode(newValue) {
        lblTestMode.className = "text-xs text-gray-400 italic";
        lblTestMode.textContent = "Saving...";

        try {
            const { data: { session } } = await sb.auth.getSession();
            const userEmail = session?.user?.email || 'admin';

            const { error } = await sb.from('settings').upsert({
                key: 'sms_test_mode',
                value: newValue ? 'true' : 'false',
                updated_at: new Date().toISOString(),
                updated_by: userEmail
            });
            if (error) throw error;

            updateToggleUI(newValue);
            showToast(`SMS Test Mode turned ${newValue ? 'ON' : 'OFF'}`, newValue ? 'success' : 'error');
            await auditLog('toggle_sms_test_mode', 'sms_test_mode', { test_mode: newValue });
        } catch (err) {
            showToast(`Failed to update SMS test mode: ${err.message}`, 'error');
            updateToggleUI(testModeOn);
        }
    }

    // Load current state: test mode (defaults ON if never set, matching the
    // migration's safe default) and sender id (not secret, loaded normally).
    try {
        const { data, error } = await sb.from('settings')
            .select('key, value')
            .in('key', ['sms_test_mode', 'sms_sender_id']);
        if (error) throw error;

        const row = (key) => (data || []).find(r => r.key === key)?.value;
        updateToggleUI(row('sms_test_mode') !== 'false'); // absent or 'true' -> ON
        txtSenderId.value = row('sms_sender_id') || '';
    } catch (err) {
        showToast("Failed to load SMS settings: " + err.message, 'error');
    }

    btnTestMode.addEventListener('click', () => toggleTestMode(!testModeOn));

    /**
     * Renders whether the API key is set, WITHOUT ever fetching its value —
     * same reasoning as Stripe's refreshCredentialStatus(). Only `key` is
     * selected; whether it's "set" is a server-side .neq('value', '') filter,
     * so the secret itself never crosses the wire into this page.
     */
    async function refreshApiKeyStatus() {
        try {
            const { data, error } = await sb.from('settings')
                .select('key')
                .eq('key', 'sms_api_key')
                .neq('value', '');
            if (error) throw error;

            if (data && data.length > 0) {
                lblApiKeyStatus.textContent = '✓ Configured';
                lblApiKeyStatus.className = 'text-xs mt-1 text-green-700';
            } else {
                lblApiKeyStatus.textContent = 'Not set';
                lblApiKeyStatus.className = 'text-xs mt-1 text-gray-600';
            }
        } catch (err) {
            // Non-fatal and deliberately does not block saving — see Stripe's
            // identical rationale: the field is always blank regardless of
            // this check's outcome, so a failed check cannot cause a wipe.
            lblApiKeyStatus.textContent = 'Could not check';
            lblApiKeyStatus.className = 'text-xs mt-1 text-amber-700';
        }
    }

    await refreshApiKeyStatus();

    btnSave.addEventListener('click', async () => {
        const valSenderId = txtSenderId.value.trim();
        const valApiKey = txtApiKey.value.trim();

        if (!valSenderId) {
            showToast("Sender ID is required.", "error");
            return;
        }
        if (!/^[A-Za-z0-9]{1,11}$/.test(valSenderId)) {
            showToast("Sender ID must be 1-11 letters/digits, no spaces or symbols.", "error");
            return;
        }

        btnSave.disabled = true;
        btnSave.textContent = "Saving...";

        try {
            const { data: { session } } = await sb.auth.getSession();
            const userEmail = session?.user?.email || 'admin';
            const now = new Date().toISOString();

            // sms_provider is fixed to 'thesmsworks' by this card — there is
            // no provider dropdown in this UI, since The SMS Works is the one
            // integration actually being configured here.
            const updates = [
                { key: 'sms_provider', value: 'thesmsworks', updated_at: now, updated_by: userEmail },
                { key: 'sms_sender_id', value: valSenderId, updated_at: now, updated_by: userEmail },
            ];
            // Blank means "leave it alone" — same write-only rule as Stripe,
            // and for the same reason: this field is never populated with
            // the stored value, so blank-on-load is the normal state, not
            // evidence the key is unset.
            if (valApiKey) {
                updates.push({ key: 'sms_api_key', value: valApiKey, updated_at: now, updated_by: userEmail });
            }

            const { error } = await sb.from('settings').upsert(updates);
            if (error) throw error;

            // Don't leave a typed secret sitting in the DOM afterwards.
            txtApiKey.value = '';
            await refreshApiKeyStatus();

            showToast("SMS settings saved successfully");
            await auditLog('update_sms_settings', 'system', {
                sender_id: valSenderId,
                api_key_updated: !!valApiKey
            });
        } catch (err) {
            showToast(`Failed to save SMS settings: ${err.message}`, 'error');
        } finally {
            btnSave.disabled = false;
            btnSave.textContent = "Save SMS Settings";
        }
    });
}
