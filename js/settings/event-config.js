// @ts-check
/**
 * js/settings/event-config.js
 * Event Configuration page (Epic 4, Phase 4B.1) — lets an organiser override
 * a small set of organisation settings for just the active event.
 *
 * Deliberately not a new resolver: reads/writes the same settings and
 * event_settings tables js/config.js's loadStallCosts() already resolves,
 * through the same key/value shape. This module only adds the UI concept of
 * "is this key inherited or overridden", which the resolver itself has no
 * reason to know about.
 */
import { getSupabaseClient } from '../supabase.js';
import { showToast } from '../ui.js';
import { auditLog } from '../audit.js';
import { getPlatformContext } from '../config.js';
import { getCurrentEvent, fetchAvailableEvents } from '../event-service.js';
import { escapeHtml } from '../utils.js';

const sb = getSupabaseClient();

/**
 * Booking Prefix is deliberately excluded — it's a typed column on the
 * events table (see js/page-admin.js's event editor) with its own
 * resolution path (getActiveBookingPrefix() in js/config.js), not a
 * settings/event_settings key. Adding it here would create a second,
 * silently-ineffective place to set it.
 */
const SIMPLE_FIELDS = [
    { key: 'festival_display_name', label: 'Festival Display Name', type: 'text', helpText: 'Shown in the admin header and public pages for this event.' },
    { key: 'stall_cost_general', label: 'General Stall Price', type: 'currency', helpText: 'Suggested cost for a General stall at this event.' },
    { key: 'stall_cost_food', label: 'Food Stall Price', type: 'currency', helpText: 'Suggested cost for a Food & Drink stall at this event.' },
    { key: 'stall_cost_dev', label: 'Developer Stall Price', type: 'currency', helpText: 'Suggested cost for a Dev/non-bookable stall at this event.' },
];
const STALL_TYPES_KEY = 'allowed_stall_types';
const ALL_KEYS = [...SIMPLE_FIELDS.map(f => f.key), STALL_TYPES_KEY];

/** @typedef {{ orgValue: string, eventValue: string|undefined, overridden: boolean }} FieldState */

function parseStallTypes(raw) {
    return (raw || '').split(',').map(s => s.trim()).filter(Boolean);
}

/**
 * Loads the raw org + event rows for the fields this page manages — not
 * CONFIG, which only holds the already-merged effective value. The
 * inheritance UI needs to know which layer each value actually came from.
 * @returns {Promise<Record<string, FieldState>>}
 */
async function loadFieldState(orgId, eventId) {
    const [{ data: orgRows, error: orgError }, { data: eventRows, error: eventError }] = await Promise.all([
        sb.from('settings').select('key, value').eq('org_id', orgId).in('key', ALL_KEYS),
        sb.from('event_settings').select('key, value').eq('event_id', eventId).in('key', ALL_KEYS)
    ]);
    if (orgError) throw orgError;
    if (eventError) throw eventError;

    /** @type {Record<string, FieldState>} */
    const state = {};
    ALL_KEYS.forEach(key => { state[key] = { orgValue: '', eventValue: undefined, overridden: false }; });
    (orgRows || []).forEach(r => { if (state[r.key]) state[r.key].orgValue = r.value ?? ''; });
    (eventRows || []).forEach(r => {
        if (state[r.key]) {
            state[r.key].eventValue = r.value ?? '';
            state[r.key].overridden = true;
        }
    });
    return state;
}

function renderSimpleField(field, fieldState) {
    const isOverridden = fieldState.overridden;
    const displayValue = isOverridden ? fieldState.eventValue : fieldState.orgValue;
    const inputType = field.type === 'currency' ? 'number' : 'text';
    const step = field.type === 'currency' ? 'step="0.01" min="0"' : '';
    const prefix = field.type === 'currency' ? '£' : '';

    return `
    <div class="p-4 rounded-lg border border-gray-200 bg-gray-50" data-field="${escapeHtml(field.key)}">
        <div class="flex items-start justify-between gap-3 mb-2">
            <div>
                <label for="field-${escapeHtml(field.key)}" class="text-sm font-bold text-gray-800">${escapeHtml(field.label)}</label>
                <p class="text-xs text-gray-500">${escapeHtml(field.helpText)}</p>
            </div>
            <span class="shrink-0 inline-flex items-center px-2 py-1 rounded-full text-xs font-bold ${isOverridden ? 'bg-blue-100 text-blue-700' : 'bg-gray-200 text-gray-600'}" data-role="badge">
                ${isOverridden ? 'Overridden for this Event' : 'Inherited from Organisation'}
            </span>
        </div>

        <div class="flex items-center justify-between py-2 mb-2 text-xs">
            <span class="font-semibold text-gray-600">Override for this event</span>
            <button type="button" data-role="toggle"
                class="relative inline-flex h-6 w-11 items-center rounded-full ${isOverridden ? 'bg-blue-600' : 'bg-gray-300'} transition-colors focus:outline-none cursor-pointer"
                aria-pressed="${isOverridden}" aria-label="Override ${escapeHtml(field.label)} for this event">
                <span class="inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${isOverridden ? 'translate-x-6' : 'translate-x-1'}"></span>
            </button>
        </div>

        <div class="flex items-center gap-2">
            ${prefix ? `<span class="text-sm text-gray-500">${prefix}</span>` : ''}
            <input type="${inputType}" ${step} id="field-${escapeHtml(field.key)}" data-role="input"
                value="${escapeHtml(displayValue ?? '')}" ${isOverridden ? '' : 'disabled'}
                class="flex-1 p-2 border border-gray-300 rounded focus:ring-1 focus:ring-blue-500 focus:outline-none text-sm disabled:bg-gray-100 disabled:text-gray-500">
        </div>
        <p class="text-xs text-gray-500 mt-1" data-role="org-default">
            Organisation default: ${prefix}${escapeHtml(fieldState.orgValue || '—')}
        </p>
        <button type="button" data-role="reset"
            class="text-xs font-bold text-gray-500 hover:text-red-600 mt-2 cursor-pointer ${isOverridden ? '' : 'hidden'}">
            Reset to Organisation Default
        </button>
    </div>`;
}

function renderStallTypesField(fieldState) {
    const isOverridden = fieldState.overridden;
    const activeList = isOverridden ? parseStallTypes(fieldState.eventValue) : parseStallTypes(fieldState.orgValue);

    return `
    <div class="p-4 rounded-lg border border-gray-200 bg-gray-50" data-field="${STALL_TYPES_KEY}">
        <div class="flex items-start justify-between gap-3 mb-2">
            <div>
                <span class="text-sm font-bold text-gray-800">Allowed Stall Types</span>
                <p class="text-xs text-gray-500">The stall/category types traders can pick for this event.</p>
            </div>
            <span class="shrink-0 inline-flex items-center px-2 py-1 rounded-full text-xs font-bold ${isOverridden ? 'bg-blue-100 text-blue-700' : 'bg-gray-200 text-gray-600'}" data-role="badge">
                ${isOverridden ? 'Overridden for this Event' : 'Inherited from Organisation'}
            </span>
        </div>

        <div class="flex items-center justify-between py-2 mb-2 text-xs">
            <span class="font-semibold text-gray-600">Override for this event</span>
            <button type="button" data-role="toggle"
                class="relative inline-flex h-6 w-11 items-center rounded-full ${isOverridden ? 'bg-blue-600' : 'bg-gray-300'} transition-colors focus:outline-none cursor-pointer"
                aria-pressed="${isOverridden}" aria-label="Override Allowed Stall Types for this event">
                <span class="inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${isOverridden ? 'translate-x-6' : 'translate-x-1'}"></span>
            </button>
        </div>

        <div data-role="chip-list" class="flex flex-wrap gap-2 mb-3">
            ${activeList.length
            ? activeList.map(t => `
                <span class="inline-flex items-center gap-1 bg-blue-100 text-blue-800 text-xs font-bold px-2 py-1 rounded">
                    ${escapeHtml(t)}
                    <button type="button" data-role="remove-type" data-type="${escapeHtml(t)}" class="text-blue-500 hover:text-blue-700 font-bold ml-0.5 text-sm leading-none focus:outline-none ${isOverridden ? '' : 'hidden'}" title="Remove Type">×</button>
                </span>`).join('')
            : '<span class="text-xs text-gray-600 italic">No stall types configured.</span>'}
        </div>
        <div class="flex gap-2 ${isOverridden ? '' : 'hidden'}" data-role="add-row">
            <input type="text" data-role="new-type" placeholder="e.g. Craft Stall" class="flex-1 p-2 border border-gray-300 rounded focus:ring-1 focus:ring-blue-500 focus:outline-none text-sm">
            <button type="button" data-role="add-type" class="bg-blue-600 hover:bg-blue-700 text-white font-bold px-4 py-2 rounded transition text-xs tracking-wider uppercase cursor-pointer shadow-sm shrink-0">Add</button>
        </div>
        <p class="text-xs text-gray-500 mt-2" data-role="org-default">
            Organisation default: ${escapeHtml(parseStallTypes(fieldState.orgValue).join(', ') || '—')}
        </p>
        <button type="button" data-role="reset"
            class="text-xs font-bold text-gray-500 hover:text-red-600 mt-2 cursor-pointer ${isOverridden ? '' : 'hidden'}">
            Reset to Organisation Default
        </button>
    </div>`;
}

export async function initEventConfig() {
    const root = document.getElementById('event-config-root');
    const eventNameEl = document.getElementById('event-config-event-name');
    const btnSave = /** @type {HTMLButtonElement | null} */ (document.getElementById('btn-save-event-config'));
    if (!root || !btnSave) return;

    const ctx = getPlatformContext();
    await fetchAvailableEvents();
    const activeEvent = getCurrentEvent();
    if (eventNameEl) eventNameEl.textContent = activeEvent.name || ctx.eventId;

    let fieldState = await loadFieldState(ctx.orgId, ctx.eventId);

    function render() {
        root.innerHTML = SIMPLE_FIELDS.map(f => renderSimpleField(f, fieldState[f.key])).join('') // innerhtml-safe: both render helpers already pass every interpolated value through escapeHtml()
            + renderStallTypesField(fieldState[STALL_TYPES_KEY]);
    }

    render();

    // Event delegation: toggles, resets, and the stall-types chip editor all
    // live inside #event-config-root, re-rendered wholesale on every change.
    root.addEventListener('click', async (e) => {
        const target = /** @type {Element} */ (e.target);

        const toggleBtn = target.closest('[data-role="toggle"]');
        if (toggleBtn instanceof HTMLElement) {
            const card = toggleBtn.closest('[data-field]');
            const key = card?.getAttribute('data-field');
            if (!key) return;
            const state = fieldState[key];
            if (state.overridden) {
                // Turning override off is a reset, same as the explicit
                // Reset button — it must delete, not just hide, the row.
                await resetField(key);
            } else {
                // Seed the editable value with the org default as a
                // starting point — this is NOT what Reset does on the way
                // back out, so it doesn't violate "reset removes rather
                // than copies".
                state.overridden = true;
                state.eventValue = state.eventValue ?? state.orgValue;
                render();
            }
            return;
        }

        const resetBtn = target.closest('[data-role="reset"]');
        if (resetBtn instanceof HTMLElement) {
            const card = resetBtn.closest('[data-field]');
            const key = card?.getAttribute('data-field');
            if (key) await resetField(key);
            return;
        }

        const addTypeBtn = target.closest('[data-role="add-type"]');
        if (addTypeBtn instanceof HTMLElement) {
            const card = addTypeBtn.closest('[data-field]');
            const input = /** @type {HTMLInputElement | null} */ (card?.querySelector('[data-role="new-type"]'));
            if (!input) return;
            const val = input.value.trim();
            if (!val) { showToast('Enter a stall type name', 'error'); return; }
            const current = parseStallTypes(fieldState[STALL_TYPES_KEY].eventValue);
            if (current.some(t => t.toLowerCase() === val.toLowerCase())) {
                showToast(`"${val}" already exists`, 'error');
                return;
            }
            fieldState[STALL_TYPES_KEY].eventValue = [...current, val].join(',');
            render();
            return;
        }

        const removeTypeBtn = target.closest('[data-role="remove-type"]');
        if (removeTypeBtn instanceof HTMLElement) {
            const type = removeTypeBtn.getAttribute('data-type');
            const current = parseStallTypes(fieldState[STALL_TYPES_KEY].eventValue);
            fieldState[STALL_TYPES_KEY].eventValue = current.filter(t => t !== type).join(',');
            render();
            return;
        }
    });

    root.addEventListener('keydown', (e) => {
        const target = /** @type {Element} */ (e.target);
        if (e.key === 'Enter' && target.matches('[data-role="new-type"]')) {
            e.preventDefault();
            const card = target.closest('[data-field]');
            const addBtn = /** @type {HTMLButtonElement | null} */ (card?.querySelector('[data-role="add-type"]'));
            addBtn?.click();
        }
    });

    async function resetField(key) {
        try {
            const { error } = await sb.from('event_settings').delete().eq('event_id', ctx.eventId).eq('key', key);
            if (error) throw error;
            fieldState[key] = { ...fieldState[key], eventValue: undefined, overridden: false };
            render();
            if (typeof sessionStorage !== 'undefined') sessionStorage.removeItem(`ESF_SETTINGS_CACHE_${ctx.orgId}_${ctx.eventId}`);
            await auditLog('reset_event_setting', ctx.eventId, { key });
            showToast(`Reset "${key}" to the organisation default`);
        } catch (err) {
            showToast(`Failed to reset: ${err.message}`, 'error');
        }
    }

    btnSave.addEventListener('click', async () => {
        // Validate every currently-overridden field before writing anything —
        // a friendly message and no partial save, not a silent drop.
        const upserts = [];
        for (const field of SIMPLE_FIELDS) {
            const state = fieldState[field.key];
            if (!state.overridden) continue;
            const inputEl = /** @type {HTMLInputElement | null} */ (root.querySelector(`[data-field="${field.key}"] [data-role="input"]`));
            const raw = inputEl?.value ?? '';

            if (field.type === 'currency') {
                const n = parseFloat(raw);
                if (isNaN(n) || n < 0) {
                    showToast(`${field.label} must be a valid, non-negative price.`, 'error');
                    return;
                }
                state.eventValue = n.toFixed(2);
            } else {
                const trimmed = raw.trim();
                if (!trimmed) {
                    showToast(`${field.label} can't be empty.`, 'error');
                    return;
                }
                state.eventValue = trimmed;
            }
            upserts.push({ key: field.key, value: state.eventValue });
        }

        const stallTypesState = fieldState[STALL_TYPES_KEY];
        if (stallTypesState.overridden) {
            const types = parseStallTypes(stallTypesState.eventValue);
            if (types.length === 0) {
                showToast('Allowed Stall Types needs at least one type, or turn its override off.', 'error');
                return;
            }
            upserts.push({ key: STALL_TYPES_KEY, value: types.join(',') });
        }

        if (upserts.length === 0) {
            showToast('No overrides to save — every value is inherited from the organisation.', 'info');
            return;
        }

        btnSave.disabled = true;
        btnSave.textContent = 'Saving...';
        try {
            const { data: { session } } = await sb.auth.getSession();
            const userEmail = session?.user?.email || 'admin';
            const now = new Date().toISOString();

            const rows = upserts.map(u => ({ event_id: ctx.eventId, key: u.key, value: u.value, updated_at: now, updated_by: userEmail }));
            const { error } = await sb.from('event_settings').upsert(rows);
            if (error) throw error;

            if (typeof sessionStorage !== 'undefined') sessionStorage.removeItem(`ESF_SETTINGS_CACHE_${ctx.orgId}_${ctx.eventId}`);
            await auditLog('update_event_settings', ctx.eventId, { keys: upserts.map(u => u.key) });
            showToast('Event configuration saved');
            fieldState = await loadFieldState(ctx.orgId, ctx.eventId);
            render();
        } catch (err) {
            showToast(`Failed to save event configuration: ${err.message}`, 'error');
        } finally {
            btnSave.disabled = false;
            btnSave.textContent = 'Save Event Configuration';
        }
    });
}
