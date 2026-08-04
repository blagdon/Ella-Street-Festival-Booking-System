// @ts-check
import { getSupabaseClient } from '../supabase.js';
import { showToast } from '../ui.js';
import { auditLog } from '../audit.js';
import { CONFIG, clearSettingsCache } from '../config.js';
import { escapeHtml } from '../utils.js';

const sb = getSupabaseClient();

export async function initStallCosts() {
    const txtFood = /** @type {HTMLInputElement | null} */ (document.getElementById('cost-food'));
    const txtGeneral = /** @type {HTMLInputElement | null} */ (document.getElementById('cost-general'));
    const txtDev = /** @type {HTMLInputElement | null} */ (document.getElementById('cost-dev'));
    const btnSave = /** @type {HTMLButtonElement | null} */ (document.getElementById('btn-save-costs'));

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
            clearSettingsCache();
            await auditLog('update_stall_costs', 'system', { food: valFood, general: valGeneral, dev: valDev });
        } catch (err) {
            showToast(`Failed to save stall costs: ${err.message}`, 'error');
        } finally {
            btnSave.disabled = false;
            btnSave.textContent = "Save Costs";
        }
    });
}

export function initStallTypes() {
    const listEl = document.getElementById('stall-types-list');
    const inputEl = /** @type {HTMLInputElement | null} */ (document.getElementById('new-stall-type'));
    const btnAdd = /** @type {HTMLButtonElement | null} */ (document.getElementById('btn-add-stall-type'));

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
            : '<span class="text-xs text-gray-600 italic">No stall types configured.</span>';
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

            clearSettingsCache();
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
        const target = /** @type {Element} */ (e.target);
        const btn = target.closest('.remove-stall-type-btn');
        if (!(btn instanceof HTMLElement)) return;
        const type = btn.dataset.type;
        await saveTypes(CONFIG.UI.ALLOWED_TYPES.filter(t => t !== type));
        showToast(`Removed "${type}"`);
    });
}
