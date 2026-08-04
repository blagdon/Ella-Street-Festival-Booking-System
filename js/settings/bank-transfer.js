// @ts-check
import { getSupabaseClient } from '../supabase.js';
import { showToast } from '../ui.js';
import { auditLog } from '../audit.js';
import { getCurrentOrgId } from '../config.js';

const sb = getSupabaseClient();

/**
 * Bank Transfer Payment Details — shown to stallholders in the
 * payment_requested email as the bank-transfer option alongside the Stripe
 * link. Same "settings table, never hardcoded" mechanism as every other
 * credential/detail here; not secret (unlike the Stripe keys), so plain
 * text inputs rather than password fields.
 */
export async function initBankTransferSettings() {
    const txtAccountName = /** @type {HTMLInputElement | null} */ (document.getElementById('bank-transfer-account-name'));
    const txtSortCode = /** @type {HTMLInputElement | null} */ (document.getElementById('bank-transfer-sort-code'));
    const txtAccountNumber = /** @type {HTMLInputElement | null} */ (document.getElementById('bank-transfer-account-number'));
    const btnSave = /** @type {HTMLButtonElement | null} */ (document.getElementById('btn-save-bank-transfer-details'));

    if (!txtAccountName || !txtSortCode || !txtAccountNumber || !btnSave) return;

    try {
        const { data, error } = await sb.from('settings').select('key, value')
            .eq('org_id', getCurrentOrgId())
            .in('key', [
                'bank_account_name', 'bank_sort_code', 'bank_account_number'
            ]);
        if (error) throw error;

        (data || []).forEach(item => {
            if (item.key === 'bank_account_name') txtAccountName.value = item.value || '';
            else if (item.key === 'bank_sort_code') txtSortCode.value = item.value || '';
            else if (item.key === 'bank_account_number') txtAccountNumber.value = item.value || '';
        });
    } catch (err) {
        showToast("Failed to load bank transfer details: " + err.message, 'error');
    }

    btnSave.addEventListener('click', async () => {
        btnSave.disabled = true;
        btnSave.textContent = "Saving...";

        try {
            const { data: { session } } = await sb.auth.getSession();
            const userEmail = session?.user?.email || 'admin';
            const now = new Date().toISOString();

            const orgId = getCurrentOrgId();
            const updates = [
                { org_id: orgId, key: 'bank_account_name', value: txtAccountName.value.trim(), updated_at: now, updated_by: userEmail },
                { org_id: orgId, key: 'bank_sort_code', value: txtSortCode.value.trim(), updated_at: now, updated_by: userEmail },
                { org_id: orgId, key: 'bank_account_number', value: txtAccountNumber.value.trim(), updated_at: now, updated_by: userEmail }
            ];

            const { error } = await sb.from('settings').upsert(updates);
            if (error) throw error;

            showToast("Bank transfer details saved successfully");
            await auditLog('update_bank_transfer_details', 'system', {
                has_account_name: !!txtAccountName.value.trim(),
                has_sort_code: !!txtSortCode.value.trim(),
                has_account_number: !!txtAccountNumber.value.trim()
            });
        } catch (err) {
            showToast(`Failed to save bank transfer details: ${err.message}`, 'error');
        } finally {
            btnSave.disabled = false;
            btnSave.textContent = "Save Bank Transfer Details";
        }
    });
}
