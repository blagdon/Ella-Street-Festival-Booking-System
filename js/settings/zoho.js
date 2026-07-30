import { getSupabaseClient } from '../supabase.js';
import { showToast } from '../ui.js';
import { auditLog } from '../audit.js';
import { parseEdgeFunctionError } from '../utils.js';

const sb = getSupabaseClient();

export async function initZohoSettings() {
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
