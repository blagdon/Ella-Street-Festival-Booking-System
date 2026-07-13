import { initAdminPage, getSupabaseClient } from './supabase.js';
import { showToast } from './ui.js';
import { auditLog } from './api.js';
import { CONFIG } from './config.js';
import { ESF_PUBLIC_CONFIG } from '../supabase-public.js';
import { parseEdgeFunctionError, escapeHtml } from './utils.js';

const sb = getSupabaseClient();

function initSettings() {
    initToggles();
    initStallCosts();
    initStallTypes();
    initSystemConstants();
    initZohoSettings();
    initSerpApiSettings();
}

initAdminPage(initSettings);

async function initToggles() {
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
            lbl.className = "text-xs font-semibold text-green-600";
            lbl.textContent = "Open & Accepting Forms";
            if (formKey === 'general') generalOpen = true;
            else foodOpen = true;
        } else {
            btn.className = "relative inline-flex h-6 w-11 items-center rounded-full bg-red-400 transition-colors focus:outline-none cursor-pointer";
            dot.className = "inline-block h-4 w-4 transform rounded-full bg-white transition-transform translate-x-1";
            lbl.className = "text-xs font-semibold text-red-600";
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
        lbl.className = "text-xs text-gray-400 italic";
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

async function initStallCosts() {
    const txtFood = document.getElementById('cost-food');
    const txtGeneral = document.getElementById('cost-general');
    const txtDev = document.getElementById('cost-dev');
    const btnSave = document.getElementById('btn-save-costs');

    if (!txtFood || !txtGeneral || !txtDev || !btnSave) return;

    // Load active settings from CONFIG (already loaded from DB in requireAuth).
    // Falls back to 0 if a value hasn't loaded (e.g. settings fetch failed).
    txtFood.value = (CONFIG.UI.STALL_COST.FOOD ?? 0).toFixed(2);
    txtGeneral.value = (CONFIG.UI.STALL_COST.GENERAL ?? 0).toFixed(2);
    txtDev.value = (CONFIG.UI.STALL_COST.DEV ?? 0).toFixed(2);

    btnSave.addEventListener('click', async () => {
        const valFood = parseFloat(txtFood.value);
        const valGeneral = parseFloat(txtGeneral.value);
        const valDev = parseFloat(txtDev.value);

        if (isNaN(valFood) || valFood < 0 || isNaN(valGeneral) || valGeneral < 0 || isNaN(valDev) || valDev < 0) {
            showToast("Costs must be valid positive numbers", "error");
            return;
        }

        btnSave.disabled = true;
        btnSave.textContent = "Saving...";

        try {
            const { data: { session } } = await sb.auth.getSession();
            const userEmail = session?.user?.email || 'admin';
            const now = new Date().toISOString();

            const updates = [
                { key: 'stall_cost_food', value: valFood.toFixed(2), updated_at: now, updated_by: userEmail },
                { key: 'stall_cost_general', value: valGeneral.toFixed(2), updated_at: now, updated_by: userEmail },
                { key: 'stall_cost_dev', value: valDev.toFixed(2), updated_at: now, updated_by: userEmail }
            ];

            const { error } = await sb.from('settings').upsert(updates);
            if (error) throw error;

            // Update in-memory configuration
            CONFIG.UI.STALL_COST.FOOD = valFood;
            CONFIG.UI.STALL_COST.GENERAL = valGeneral;
            CONFIG.UI.STALL_COST.DEV = valDev;

            showToast("Stall costs saved successfully");
            if (typeof sessionStorage !== 'undefined') {
                sessionStorage.removeItem('ESF_SETTINGS_CACHE');
            }
            await auditLog('update_stall_costs', 'system', { food: valFood, general: valGeneral, dev: valDev });
        } catch (err) {
            showToast(`Failed to save stall costs: ${err.message}`, 'error');
        } finally {
            btnSave.disabled = false;
            btnSave.textContent = "Save Costs";
        }
    });
}

function initStallTypes() {
    const listEl = document.getElementById('stall-types-list');
    const inputEl = document.getElementById('new-stall-type');
    const btnAdd = document.getElementById('btn-add-stall-type');

    if (!listEl || !inputEl || !btnAdd) return;

    function render() {
        const types = CONFIG.UI.ALLOWED_TYPES || [];
        listEl.innerHTML = types.length
            ? types.map(type => `
                <span class="inline-flex items-center gap-1 bg-blue-100 text-blue-800 text-xs font-bold px-2 py-1 rounded">
                    ${escapeHtml(type)}
                    <button data-type="${escapeHtml(type)}" class="remove-stall-type-btn text-blue-500 hover:text-blue-700 font-bold ml-0.5 text-sm leading-none focus:outline-none" title="Remove Type">×</button>
                </span>
            `).join('')
            : '<span class="text-xs text-gray-400 italic">No stall types configured.</span>';
    }

    async function saveTypes(newList) {
        const previous = [...CONFIG.UI.ALLOWED_TYPES];
        CONFIG.UI.ALLOWED_TYPES = newList; // optimistic update
        render();

        try {
            const { data: { session } } = await sb.auth.getSession();
            const userEmail = session?.user?.email || 'admin';

            const { error } = await sb.from('settings').upsert({
                key: 'allowed_stall_types',
                value: newList.join(','),
                updated_at: new Date().toISOString(),
                updated_by: userEmail
            });
            if (error) throw error;

            if (typeof sessionStorage !== 'undefined') {
                sessionStorage.removeItem('ESF_SETTINGS_CACHE');
            }
            await auditLog('update_stall_types', 'system', { types: newList });
        } catch (err) {
            CONFIG.UI.ALLOWED_TYPES = previous; // roll back on failure
            render();
            showToast(`Failed to save stall types: ${err.message}`, 'error');
        }
    }

    render();

    btnAdd.addEventListener('click', async () => {
        const val = inputEl.value.trim();
        if (!val) {
            showToast("Enter a stall type name", "error");
            return;
        }
        if (CONFIG.UI.ALLOWED_TYPES.some(t => t.toLowerCase() === val.toLowerCase())) {
            showToast(`"${val}" already exists`, "error");
            return;
        }

        inputEl.value = '';
        await saveTypes([...CONFIG.UI.ALLOWED_TYPES, val]);
        showToast(`Added "${val}"`);
    });

    inputEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            btnAdd.click();
        }
    });

    listEl.addEventListener('click', async (e) => {
        const btn = e.target.closest('.remove-stall-type-btn');
        if (!btn) return;
        const type = btn.dataset.type;
        await saveTypes(CONFIG.UI.ALLOWED_TYPES.filter(t => t !== type));
        showToast(`Removed "${type}"`);
    });
}

async function initSystemConstants() {
    const txtTurnstile = document.getElementById('turnstile-key');
    const txtBank = document.getElementById('bank-details');
    const txtBaseUrl = document.getElementById('base-url');
    const txtCancelUrl = document.getElementById('cancel-url');
    const txtPortalUrl = document.getElementById('portal-url');
    const txtCouncilEmail = document.getElementById('council-email');
    const txtBucket = document.getElementById('bucket-name');
    const txtPrefix = document.getElementById('booking-prefix');
    const txtLimit = document.getElementById('rate-limit');
    const txtWindow = document.getElementById('rate-window');
    const btnSave = document.getElementById('btn-save-constants');

    if (!txtTurnstile || !txtBank || !txtBaseUrl || !txtCancelUrl || !txtPortalUrl || !txtCouncilEmail || !txtBucket || !txtPrefix || !txtLimit || !txtWindow || !btnSave) return;

    // Load active settings from public config and CONFIG
    txtTurnstile.value = ESF_PUBLIC_CONFIG?.TURNSTILE_SITE_KEY || '';
    txtBank.value = ESF_PUBLIC_CONFIG?.BANK_DETAILS || '';
    txtBaseUrl.value = ESF_PUBLIC_CONFIG?.BASE_URL || '';
    txtCancelUrl.value = ESF_PUBLIC_CONFIG?.CANCEL_URL || '';
    txtPortalUrl.value = ESF_PUBLIC_CONFIG?.PORTAL_URL || '';
    txtBucket.value = ESF_PUBLIC_CONFIG?.BUCKET_NAME || '';
    txtPrefix.value = ESF_PUBLIC_CONFIG?.BOOKING_PREFIX || '';
    txtCouncilEmail.value = CONFIG.HCC_COUNCIL_EMAIL || '';
    txtLimit.value = CONFIG.EMAIL_RATE_LIMIT || '';
    txtWindow.value = CONFIG.EMAIL_RATE_WINDOW_MS || '';

    btnSave.addEventListener('click', async () => {
        const valTurnstile = txtTurnstile.value.trim();
        const valBank = txtBank.value.trim();
        const valBaseUrl = txtBaseUrl.value.trim();
        const valCancelUrl = txtCancelUrl.value.trim();
        const valPortalUrl = txtPortalUrl.value.trim();
        const valCouncilEmail = txtCouncilEmail.value.trim();
        const valBucket = txtBucket.value.trim();
        const valPrefix = txtPrefix.value.trim().toUpperCase();
        const valLimit = parseInt(txtLimit.value, 10);
        const valWindow = parseInt(txtWindow.value, 10);

        if (!valTurnstile || !valBank || !valBaseUrl || !valCancelUrl || !valPortalUrl || !valCouncilEmail || !valBucket || !valPrefix || isNaN(valLimit) || valLimit < 1 || isNaN(valWindow) || valWindow < 1000) {
            showToast("All fields are required and rate limits must be valid positive numbers", "error");
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
                { key: 'turnstile_site_key', value: valTurnstile, updated_at: now, updated_by: userEmail },
                { key: 'bank_details', value: valBank, updated_at: now, updated_by: userEmail },
                { key: 'base_url', value: valBaseUrl, updated_at: now, updated_by: userEmail },
                { key: 'cancel_url', value: valCancelUrl, updated_at: now, updated_by: userEmail },
                { key: 'portal_url', value: valPortalUrl, updated_at: now, updated_by: userEmail },
                { key: 'hcc_council_email', value: valCouncilEmail, updated_at: now, updated_by: userEmail },
                { key: 'bucket_name', value: valBucket, updated_at: now, updated_by: userEmail },
                { key: 'booking_prefix', value: valPrefix, updated_at: now, updated_by: userEmail },
                { key: 'email_rate_limit', value: valLimit.toString(), updated_at: now, updated_by: userEmail },
                { key: 'email_rate_window_ms', value: valWindow.toString(), updated_at: now, updated_by: userEmail }
            ];

            const { error } = await sb.from('settings').upsert(updates);
            if (error) throw error;

            // Update in-memory configuration
            if (ESF_PUBLIC_CONFIG) {
                ESF_PUBLIC_CONFIG.TURNSTILE_SITE_KEY = valTurnstile;
                ESF_PUBLIC_CONFIG.BANK_DETAILS = valBank;
                ESF_PUBLIC_CONFIG.BASE_URL = valBaseUrl;
                ESF_PUBLIC_CONFIG.CANCEL_URL = valCancelUrl;
                ESF_PUBLIC_CONFIG.PORTAL_URL = valPortalUrl;
                ESF_PUBLIC_CONFIG.BUCKET_NAME = valBucket;
                ESF_PUBLIC_CONFIG.BOOKING_PREFIX = valPrefix;
            }
            CONFIG.HCC_COUNCIL_EMAIL = valCouncilEmail;
            CONFIG.EMAIL_RATE_LIMIT = valLimit;
            CONFIG.EMAIL_RATE_WINDOW_MS = valWindow;

            showToast("System constants saved successfully");
            if (typeof sessionStorage !== 'undefined') {
                sessionStorage.removeItem('ESF_SETTINGS_CACHE');
            }
            await auditLog('update_system_constants', 'system', {
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

async function initZohoSettings() {
    const txtClientId = document.getElementById('zoho-client-id');
    const txtClientSecret = document.getElementById('zoho-client-secret');
    const txtRefreshToken = document.getElementById('zoho-refresh-token');
    const txtAccountId = document.getElementById('zoho-account-id');
    const txtFromAddress = document.getElementById('zoho-from-address');
    const txtDisplayName = document.getElementById('zoho-display-name');
    const selApiDomain = document.getElementById('zoho-api-domain');
    const selAccountsDomain = document.getElementById('zoho-accounts-domain');
    const btnSaveZoho = document.getElementById('btn-save-zoho');

    if (!txtClientId || !txtClientSecret || !txtRefreshToken || !txtAccountId || !txtFromAddress || !txtDisplayName || !selApiDomain || !selAccountsDomain || !btnSaveZoho) return;

    // Load active settings from Supabase
    try {
        const { data, error } = await sb
            .from('settings')
            .select('key, value')
            .in('key', [
                'zoho_client_id',
                'zoho_client_secret',
                'zoho_refresh_token',
                'zoho_account_id',
                'zoho_from_address',
                'zoho_display_name',
                'zoho_api_domain',
                'zoho_accounts_domain'
            ]);

        if (error) throw error;

        if (data) {
            data.forEach(item => {
                if (item.key === 'zoho_client_id') txtClientId.value = item.value || '';
                else if (item.key === 'zoho_client_secret') txtClientSecret.value = item.value || '';
                else if (item.key === 'zoho_refresh_token') txtRefreshToken.value = item.value || '';
                else if (item.key === 'zoho_account_id') txtAccountId.value = item.value || '';
                else if (item.key === 'zoho_from_address') txtFromAddress.value = item.value || '';
                else if (item.key === 'zoho_display_name') txtDisplayName.value = item.value || '';
                else if (item.key === 'zoho_api_domain') selApiDomain.value = item.value || 'https://mail.zoho.eu';
                else if (item.key === 'zoho_accounts_domain') selAccountsDomain.value = item.value || 'https://accounts.zoho.eu';
            });
        }
    } catch (err) {
        showToast("Failed to load Zoho settings: " + err.message, "error");
    }

    // Save handler
    btnSaveZoho.addEventListener('click', async () => {
        const valClientId = txtClientId.value.trim();
        const valClientSecret = txtClientSecret.value.trim();
        const valRefreshToken = txtRefreshToken.value.trim();
        const valAccountId = txtAccountId.value.trim();
        const valFromAddress = txtFromAddress.value.trim();
        const valDisplayName = txtDisplayName.value.trim();
        const valApiDomain = selApiDomain.value;
        const valAccountsDomain = selAccountsDomain.value;

        if (!valClientId || !valClientSecret || !valRefreshToken || !valAccountId || !valFromAddress || !valDisplayName) {
            showToast("All Zoho fields are required.", "error");
            return;
        }

        btnSaveZoho.disabled = true;
        btnSaveZoho.textContent = "Saving...";

        try {
            const { data: { session } } = await sb.auth.getSession();
            const userEmail = session?.user?.email || 'admin';
            const now = new Date().toISOString();

            const updates = [
                { key: 'zoho_client_id', value: valClientId, updated_at: now, updated_by: userEmail },
                { key: 'zoho_client_secret', value: valClientSecret, updated_at: now, updated_by: userEmail },
                { key: 'zoho_refresh_token', value: valRefreshToken, updated_at: now, updated_by: userEmail },
                { key: 'zoho_account_id', value: valAccountId, updated_at: now, updated_by: userEmail },
                { key: 'zoho_from_address', value: valFromAddress, updated_at: now, updated_by: userEmail },
                { key: 'zoho_display_name', value: valDisplayName, updated_at: now, updated_by: userEmail },
                { key: 'zoho_api_domain', value: valApiDomain, updated_at: now, updated_by: userEmail },
                { key: 'zoho_accounts_domain', value: valAccountsDomain, updated_at: now, updated_by: userEmail }
            ];

            const { error } = await sb.from('settings').upsert(updates);
            if (error) throw error;

            showToast("Zoho Mail API settings saved successfully!");
            if (typeof sessionStorage !== 'undefined') {
                sessionStorage.removeItem('ESF_SETTINGS_CACHE');
            }
            await auditLog('update_zoho_settings', 'system', {
                from_address: valFromAddress,
                api_domain: valApiDomain
            });
        } catch (err) {
            showToast(`Failed to save Zoho settings: ${err.message}`, 'error');
        } finally {
            btnSaveZoho.disabled = false;
            btnSaveZoho.textContent = "Save Zoho Settings";
        }
    });

    // Auto-Fetch Account ID handler
    const btnFetchAccountId = document.getElementById('btn-fetch-account-id');
    if (btnFetchAccountId) {
        btnFetchAccountId.addEventListener('click', async () => {
            const valClientId = txtClientId.value.trim();
            const valClientSecret = txtClientSecret.value.trim();
            const valRefreshToken = txtRefreshToken.value.trim();
            const valApiDomain = selApiDomain.value;
            const valAccountsDomain = selAccountsDomain.value;
            const valFromAddress = txtFromAddress.value.trim();

            if (!valClientId || !valClientSecret || !valRefreshToken) {
                showToast("Please enter Client ID, Client Secret, and Refresh Token first to fetch the Account ID.", "error");
                return;
            }

            btnFetchAccountId.disabled = true;
            btnFetchAccountId.textContent = "Fetching...";

            try {
                const { data, error } = await sb.functions.invoke('send-email', {
                    body: {
                        action: 'get_accounts',
                        clientId: valClientId,
                        clientSecret: valClientSecret,
                        refreshToken: valRefreshToken,
                        accountsDomain: valAccountsDomain,
                        apiDomain: valApiDomain
                    }
                });

                if (error) {
                    const errMsg = await parseEdgeFunctionError(error, "Failed to fetch accounts");
                    throw new Error(errMsg);
                }

                if (data && data.error) {
                    throw new Error(data.error);
                }

                if (data && data.data && data.data.data && data.data.data.length > 0) {
                    const accountsList = data.data.data;
                    // Find account matching our fromAddress, or default to the first one
                    let matchedAccount = accountsList.find(acc => acc.accountName.toLowerCase() === valFromAddress.toLowerCase());
                    if (!matchedAccount) {
                        matchedAccount = accountsList[0];
                    }
                    txtAccountId.value = matchedAccount.accountId;
                    showToast(`Successfully fetched Account ID: ${matchedAccount.accountId} (associated with ${matchedAccount.accountName})`, "success");
                } else {
                    throw new Error("No accounts found in your Zoho profile.");
                }
            } catch (err) {
                showToast(`Failed to fetch Account ID: ${err.message}`, 'error');
            } finally {
                btnFetchAccountId.disabled = false;
                btnFetchAccountId.textContent = "(Auto-Fetch)";
            }
        });
    }
}

async function initSerpApiSettings() {
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
