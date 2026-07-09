import { requireAuth, getSupabaseClient } from './supabase.js';
import { initNavigation } from './nav.js';
import { showToast } from './ui.js';
import { auditLog } from './api.js';
import { CONFIG } from './config.js';

const sb = getSupabaseClient();

document.addEventListener('DOMContentLoaded', async () => {
    try {
        await requireAuth('admin');
        initNavigation();
        initToggles();
        initStallCosts();
    } catch (e) {
        // Redirection handled in requireAuth
    }
});

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

    // Load active settings from CONFIG (already loaded from DB in requireAuth)
    txtFood.value = CONFIG.UI.STALL_COST.FOOD.toFixed(2);
    txtGeneral.value = CONFIG.UI.STALL_COST.GENERAL.toFixed(2);
    txtDev.value = CONFIG.UI.STALL_COST.DEV.toFixed(2);

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
            await auditLog('update_stall_costs', 'system', { food: valFood, general: valGeneral, dev: valDev });
        } catch (err) {
            showToast(`Failed to save stall costs: ${err.message}`, 'error');
        } finally {
            btnSave.disabled = false;
            btnSave.textContent = "Save Costs";
        }
    });
}
