import { getSupabaseClient } from '../supabase.js';
import { showToast } from '../ui.js';
import { auditLog } from '../audit.js';
import { CONFIG } from '../config.js';
import { ESF_PUBLIC_CONFIG } from '../../supabase-public.js';

const sb = getSupabaseClient();

export async function initToggles() {
    const btnGeneral = document.getElementById('toggle-general');
    const dotGeneral = document.getElementById('toggle-general-dot');
    const lblGeneral = document.getElementById('lbl-general-status');

    const btnFood = document.getElementById('toggle-food');
    const dotFood = document.getElementById('toggle-food-dot');
    const lblFood = document.getElementById('lbl-food-status');

    if (!btnGeneral || !btnFood) return;

    let generalOpen = true;
    let foodOpen = true;

    // Load current values
    try {
        const { data, error } = await sb.from('settings').select('*');
        if (error) throw error;

        data.forEach(item => {
            if (item.key === 'general_bookings_open') {
                generalOpen = (item.value === 'true');
            } else if (item.key === 'food_bookings_open') {
                foodOpen = (item.value === 'true');
            }
        });

        updateUI('general', generalOpen);
        updateUI('food', foodOpen);
    } catch (err) {
        showToast("Failed to load form status: " + err.message, 'error');
    }

    // Wire up events
    btnGeneral.addEventListener('click', () => toggleSetting('general_bookings_open', !generalOpen, 'general'));
    btnFood.addEventListener('click', () => toggleSetting('food_bookings_open', !foodOpen, 'food'));

    function updateUI(formKey, isOpen) {
        const btn = formKey === 'general' ? btnGeneral : btnFood;
        const dot = formKey === 'general' ? dotGeneral : dotFood;
        const lbl = formKey === 'general' ? lblGeneral : lblFood;

        if (isOpen) {
            btn.className = "relative inline-flex h-6 w-11 items-center rounded-full bg-green-500 transition-colors focus:outline-none cursor-pointer";
            dot.className = "inline-block h-4 w-4 transform rounded-full bg-white transition-transform translate-x-6";
            lbl.className = "text-xs font-semibold text-green-700";
            lbl.textContent = "Open & Accepting Forms";
            if (formKey === 'general') generalOpen = true;
            else foodOpen = true;
        } else {
            btn.className = "relative inline-flex h-6 w-11 items-center rounded-full bg-red-400 transition-colors focus:outline-none cursor-pointer";
            dot.className = "inline-block h-4 w-4 transform rounded-full bg-white transition-transform translate-x-1";
            lbl.className = "text-xs font-semibold text-red-700";
            lbl.textContent = "Closed (Visitors Blocked)";
            if (formKey === 'general') generalOpen = false;
            else foodOpen = false;
        }
    }

    async function toggleSetting(key, newValue, formKey) {
        const strVal = newValue ? 'true' : 'false';
        const label = formKey === 'general' ? 'General Form' : 'Food Form';

        // Pessimistic UI: show saving status
        const lbl = formKey === 'general' ? lblGeneral : lblFood;
        lbl.className = "text-xs text-gray-600 italic";
        lbl.textContent = "Saving...";

        try {
            const { data: { session } } = await sb.auth.getSession();
            const userEmail = session?.user?.email || 'admin';

            const { error } = await sb.from('settings').upsert({
                key: key,
                value: strVal,
                updated_at: new Date().toISOString(),
                updated_by: userEmail
            });

            if (error) throw error;

            updateUI(formKey, newValue);
            showToast(`${label} marked as ${newValue ? 'OPEN' : 'CLOSED'}`);
            await auditLog('toggle_booking_form', key, { form: label, open: newValue });
        } catch (err) {
            showToast(`Failed to update setting: ${err.message}`, 'error');
            // Revert UI to previous state
            updateUI(formKey, formKey === 'general' ? generalOpen : foodOpen);
        }
    }
}

export async function initSystemConstants() {
    const txtFestivalName = document.getElementById('festival-display-name');
    const txtTurnstile = document.getElementById('turnstile-key');
    const txtBaseUrl = document.getElementById('base-url');
    const txtCancelUrl = document.getElementById('cancel-url');
    const txtPortalUrl = document.getElementById('portal-url');
    const txtCouncilEmail = document.getElementById('council-email');
    const txtBucket = document.getElementById('bucket-name');
    const txtPrefix = document.getElementById('booking-prefix');
    const btnSave = document.getElementById('btn-save-constants');

    if (!txtFestivalName || !txtTurnstile || !txtBaseUrl || !txtCancelUrl || !txtPortalUrl || !txtCouncilEmail || !txtBucket || !txtPrefix || !btnSave) return;

    // Load active settings from public config and CONFIG
    txtFestivalName.value = CONFIG.FESTIVAL_DISPLAY_NAME || '';
    txtTurnstile.value = ESF_PUBLIC_CONFIG?.TURNSTILE_SITE_KEY || '';
    txtBaseUrl.value = ESF_PUBLIC_CONFIG?.BASE_URL || '';
    txtCancelUrl.value = ESF_PUBLIC_CONFIG?.CANCEL_URL || '';
    txtPortalUrl.value = ESF_PUBLIC_CONFIG?.PORTAL_URL || '';
    txtBucket.value = ESF_PUBLIC_CONFIG?.BUCKET_NAME || '';
    txtPrefix.value = ESF_PUBLIC_CONFIG?.BOOKING_PREFIX || '';
    txtCouncilEmail.value = CONFIG.HCC_COUNCIL_EMAIL || '';

    btnSave.addEventListener('click', async () => {
        const valFestivalName = txtFestivalName.value.trim();
        const valTurnstile = txtTurnstile.value.trim();
        const valBaseUrl = txtBaseUrl.value.trim();
        const valCancelUrl = txtCancelUrl.value.trim();
        const valPortalUrl = txtPortalUrl.value.trim();
        const valCouncilEmail = txtCouncilEmail.value.trim();
        const valBucket = txtBucket.value.trim();
        const valPrefix = txtPrefix.value.trim().toUpperCase();

        if (!valFestivalName || !valTurnstile || !valBaseUrl || !valCancelUrl || !valPortalUrl || !valCouncilEmail || !valBucket || !valPrefix) {
            showToast("All fields are required", "error");
            return;
        }

        if (!/^[A-Z0-9]+$/.test(valPrefix)) {
            showToast("Booking ID prefix must be alphanumeric (e.g. ESF26)", "error");
            return;
        }

        btnSave.disabled = true;
        btnSave.textContent = "Saving...";

        try {
            const { data: { session } } = await sb.auth.getSession();
            const userEmail = session?.user?.email || 'admin';
            const now = new Date().toISOString();

            const updates = [
                { key: 'festival_display_name', value: valFestivalName, updated_at: now, updated_by: userEmail },
                { key: 'turnstile_site_key', value: valTurnstile, updated_at: now, updated_by: userEmail },
                { key: 'base_url', value: valBaseUrl, updated_at: now, updated_by: userEmail },
                { key: 'cancel_url', value: valCancelUrl, updated_at: now, updated_by: userEmail },
                { key: 'portal_url', value: valPortalUrl, updated_at: now, updated_by: userEmail },
                { key: 'hcc_council_email', value: valCouncilEmail, updated_at: now, updated_by: userEmail },
                { key: 'bucket_name', value: valBucket, updated_at: now, updated_by: userEmail },
                { key: 'booking_prefix', value: valPrefix, updated_at: now, updated_by: userEmail }
            ];

            const { error } = await sb.from('settings').upsert(updates);
            if (error) throw error;

            // Update in-memory configuration
            if (ESF_PUBLIC_CONFIG) {
                ESF_PUBLIC_CONFIG.TURNSTILE_SITE_KEY = valTurnstile;
                ESF_PUBLIC_CONFIG.BASE_URL = valBaseUrl;
                ESF_PUBLIC_CONFIG.CANCEL_URL = valCancelUrl;
                ESF_PUBLIC_CONFIG.PORTAL_URL = valPortalUrl;
                ESF_PUBLIC_CONFIG.BUCKET_NAME = valBucket;
                ESF_PUBLIC_CONFIG.BOOKING_PREFIX = valPrefix;
            }
            CONFIG.HCC_COUNCIL_EMAIL = valCouncilEmail;
            CONFIG.FESTIVAL_DISPLAY_NAME = valFestivalName;

            showToast("System constants saved successfully");
            if (typeof sessionStorage !== 'undefined') {
                sessionStorage.removeItem('ESF_SETTINGS_CACHE');
            }
            await auditLog('update_system_constants', 'system', {
                festival_display_name: valFestivalName,
                turnstile_key: valTurnstile,
                base_url: valBaseUrl,
                council_email: valCouncilEmail,
                booking_prefix: valPrefix
            });
        } catch (err) {
            showToast(`Failed to save system constants: ${err.message}`, 'error');
        } finally {
            btnSave.disabled = false;
            btnSave.textContent = "Save System Constants";
        }
    });
}

/**
 * Error Monitoring (Sentry) — sentry_dsn (Edge Functions, read by
 * _shared/sentry.ts) and sentry_browser_loader_url (admin dashboard,
 * injected by supabase.js's requireAuth()). Unlike Stripe/SMS Works, neither
 * field is write-only: Sentry DSNs and loader URLs are designed to be
 * embedded in client-visible code, so there's nothing to hide by not
 * re-displaying the stored value.
 */
export async function initSentrySettings() {
    const txtDsn = document.getElementById('sentry-dsn');
    const txtLoaderUrl = document.getElementById('sentry-browser-loader-url');
    const btnSave = document.getElementById('btn-save-sentry');

    if (!txtDsn || !txtLoaderUrl || !btnSave) return;

    try {
        const { data, error } = await sb.from('settings')
            .select('key, value')
            .in('key', ['sentry_dsn', 'sentry_browser_loader_url']);
        if (error) throw error;

        const row = (key) => (data || []).find(r => r.key === key)?.value;
        txtDsn.value = row('sentry_dsn') || '';
        txtLoaderUrl.value = row('sentry_browser_loader_url') || '';
    } catch (err) {
        showToast("Failed to load Error Monitoring settings: " + err.message, 'error');
    }

    btnSave.addEventListener('click', async () => {
        const valDsn = txtDsn.value.trim();
        const valLoaderUrl = txtLoaderUrl.value.trim();

        btnSave.disabled = true;
        btnSave.textContent = "Saving...";

        try {
            const { data: { session } } = await sb.auth.getSession();
            const userEmail = session?.user?.email || 'admin';
            const now = new Date().toISOString();

            const { error } = await sb.from('settings').upsert([
                { key: 'sentry_dsn', value: valDsn, updated_at: now, updated_by: userEmail },
                { key: 'sentry_browser_loader_url', value: valLoaderUrl, updated_at: now, updated_by: userEmail },
            ]);
            if (error) throw error;

            // The browser loader script is injected once per page load
            // (supabase.js's requireAuth(), which already ran before this
            // page's own init callback) - a change here takes effect on the
            // next admin page load, not retroactively on this one.
            showToast("Error Monitoring settings saved. Reload any open admin tabs to pick up a browser loader URL change.");
            if (typeof sessionStorage !== 'undefined') {
                sessionStorage.removeItem('ESF_SETTINGS_CACHE');
            }
            await auditLog('update_sentry_settings', 'system', {
                dsn_set: !!valDsn,
                browser_loader_url_set: !!valLoaderUrl
            });
        } catch (err) {
            showToast(`Failed to save Error Monitoring settings: ${err.message}`, 'error');
        } finally {
            btnSave.disabled = false;
            btnSave.textContent = "Save Error Monitoring Settings";
        }
    });
}

export async function initSerpApiSettings() {
    const txtSerpApiKey = document.getElementById('serpapi-api-key');
    const btnSaveSerpApi = document.getElementById('btn-save-serpapi');

    if (!txtSerpApiKey || !btnSaveSerpApi) return;

    // Load current value
    try {
        const { data, error } = await sb
            .from('settings')
            .select('key, value')
            .eq('key', 'serpapi_api_key')
            .single();

        if (error && error.code !== 'PGRST116') throw error; // Ignore not found error

        if (data) {
            txtSerpApiKey.value = data.value || '';
        }
    } catch (err) {
        showToast("Failed to load SerpApi settings: " + err.message, "error");
    }

    // Save handler
    btnSaveSerpApi.addEventListener('click', async () => {
        const valSerpApiKey = txtSerpApiKey.value.trim();

        if (!valSerpApiKey) {
            showToast("SerpApi API Key is required.", "error");
            return;
        }

        btnSaveSerpApi.disabled = true;
        btnSaveSerpApi.textContent = "Saving...";

        try {
            const { data: { session } } = await sb.auth.getSession();
            const userEmail = session?.user?.email || 'admin';
            const now = new Date().toISOString();

            const { error } = await sb.from('settings').upsert({
                key: 'serpapi_api_key',
                value: valSerpApiKey,
                updated_at: now,
                updated_by: userEmail
            });
            if (error) throw error;

            showToast("SerpApi API key saved successfully!");
            await auditLog('update_serpapi_settings', 'system', {
                has_key: true
            });
        } catch (err) {
            showToast(`Failed to save SerpApi settings: ${err.message}`, 'error');
        } finally {
            btnSaveSerpApi.disabled = false;
            btnSaveSerpApi.textContent = "Save SerpApi Settings";
        }
    });
}
