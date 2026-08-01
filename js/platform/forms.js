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
