// @ts-check
/**
 * js/platform/forms.js
 * Form control components for Platform Administration.
 */
import { escapeHtml } from '../utils.js';

/**
 * Renders a standardized form field with label and optional help text.
 * @param {{ id: string, label: string, type?: string, value?: string, placeholder?: string, required?: boolean, helpText?: string, readonly?: boolean }} params
 * @returns {string} HTML string
 */
export function renderInputField({ id, label, type = 'text', value = '', placeholder = '', required = false, helpText = '', readonly = false }) {
    return `
    <div class="mb-4">
        <label for="${escapeHtml(id)}" class="block text-xs font-bold text-gray-700 uppercase tracking-wider mb-1.5">
            ${escapeHtml(label)} ${required ? '<span class="text-red-500">*</span>' : ''}
        </label>
        <input 
            type="${escapeHtml(type)}" 
            id="${escapeHtml(id)}" 
            name="${escapeHtml(id)}"
            value="${escapeHtml(value)}" 
            placeholder="${escapeHtml(placeholder)}"
            ${required ? 'required' : ''}
            ${readonly ? 'readonly class="w-full px-3.5 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm text-gray-500 cursor-not-allowed"' : 'class="w-full px-3.5 py-2 bg-white border border-gray-300 rounded-lg text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition"'}
        />
        ${helpText ? `<p class="text-xs text-gray-500 mt-1">${escapeHtml(helpText)}</p>` : ''}
    </div>`;
}

// Two eye-icon states swapped by toggleSecretFieldVisibility() below — kept
// as plain strings rather than a sprite/library, matching how every other
// inline SVG in this codebase (e.g. Food_Stall_booking.html's success
// checkmark) is embedded directly rather than referenced.
const EYE_ICON = '<svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
const EYE_OFF_ICON = '<svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.94 10.94 0 0112 20c-7 0-11-8-11-8a20.4 20.4 0 015.06-5.94M9.9 4.24A10.94 10.94 0 0112 4c7 0 11 8 11 8a20.3 20.3 0 01-2.16 3.19m-6.18-1.02a3 3 0 11-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';

/**
 * Renders a masked secret field (Stripe keys, webhook signing secrets, etc.)
 * — a password-type input plus a show/hide toggle button, so a saved secret
 * isn't rendered in cleartext on screen by default. Field semantics
 * (id/name/value/placeholder) are otherwise identical to renderInputField,
 * so existing read/save code (currentSettings.<key>, document.getElementById
 * (id).value) needs no changes — only the input's `type` and this toggle
 * button are new. Call bindSecretFieldToggles() once after inserting this
 * HTML into the DOM to wire the button up.
 * @param {{ id: string, label: string, value?: string, placeholder?: string, helpText?: string }} params
 * @returns {string} HTML string
 */
export function renderSecretField({ id, label, value = '', placeholder = '', helpText = '' }) {
    return `
    <div class="mb-4">
        <label for="${escapeHtml(id)}" class="block text-xs font-bold text-gray-700 uppercase tracking-wider mb-1.5">
            ${escapeHtml(label)}
        </label>
        <div class="relative">
            <input
                type="password"
                id="${escapeHtml(id)}"
                name="${escapeHtml(id)}"
                value="${escapeHtml(value)}"
                placeholder="${escapeHtml(placeholder)}"
                autocomplete="off"
                class="w-full px-3.5 py-2 pr-11 bg-white border border-gray-300 rounded-lg text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition"
            />
            <button
                type="button"
                data-toggle-secret="${escapeHtml(id)}"
                class="absolute inset-y-0 right-0 flex items-center px-3 text-gray-400 hover:text-gray-600"
                aria-label="Show ${escapeHtml(label)}"
                aria-pressed="false"
            >${EYE_ICON}</button>
        </div>
        ${helpText ? `<p class="text-xs text-gray-500 mt-1">${escapeHtml(helpText)}</p>` : ''}
    </div>`;
}

/**
 * Wires up every renderSecretField() show/hide button currently in the DOM.
 * Idempotent to call after each re-render — addEventListener on a freshly
 * innerHTML'd button can never double-bind a stale one.
 * @param {ParentNode} [root]
 */
export function bindSecretFieldToggles(root = document) {
    root.querySelectorAll('[data-toggle-secret]').forEach((btn) => {
        btn.addEventListener('click', () => {
            const id = btn.getAttribute('data-toggle-secret');
            const input = /** @type {HTMLInputElement|null} */ (id ? document.getElementById(id) : null);
            if (!input) return;
            const nowVisible = input.type === 'password';
            input.type = nowVisible ? 'text' : 'password';
            btn.innerHTML = nowVisible ? EYE_OFF_ICON : EYE_ICON;
            btn.setAttribute('aria-pressed', String(nowVisible));
            btn.setAttribute('aria-label', `${nowVisible ? 'Hide' : 'Show'} ${input.getAttribute('name') || 'secret'}`);
        });
    });
}

/**
 * Renders a toggle checkbox switch.
 * @param {{ id: string, label: string, checked?: boolean, helpText?: string }} params
 * @returns {string} HTML string
 */
export function renderToggleField({ id, label, checked = false, helpText = '' }) {
    return `
    <div class="flex items-start justify-between py-3 border-b border-gray-100 last:border-0">
        <div>
            <label for="${escapeHtml(id)}" class="text-sm font-bold text-gray-900 cursor-pointer">${escapeHtml(label)}</label>
            ${helpText ? `<p class="text-xs text-gray-500 mt-0.5">${escapeHtml(helpText)}</p>` : ''}
        </div>
        <div class="flex items-center">
            <input 
                type="checkbox" 
                id="${escapeHtml(id)}" 
                name="${escapeHtml(id)}"
                ${checked ? 'checked' : ''}
                class="w-5 h-5 text-blue-600 border-gray-300 rounded focus:ring-blue-500 cursor-pointer"
            />
        </div>
    </div>`;
}

/**
 * Renders a standard save bar container.
 * @param {{ submitId?: string, submitLabel?: string }} params
 * @returns {string} HTML string
 */
export function renderFormSaveBar({ submitId = 'btnSaveForm', submitLabel = 'Save Changes' } = {}) {
    return `
    <div class="mt-6 pt-4 border-t border-gray-200 flex justify-end">
        <button 
            type="submit" 
            id="${escapeHtml(submitId)}"
            class="px-5 py-2.5 bg-blue-600 hover:bg-blue-700 text-white font-semibold text-sm rounded-lg shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500 transition disabled:opacity-50"
        >
            ${escapeHtml(submitLabel)}
        </button>
    </div>`;
}
