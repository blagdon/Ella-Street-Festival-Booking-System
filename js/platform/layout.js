// @ts-check
/**
 * js/platform/layout.js
 * Unified Page Layouts & Workspace Header for Platform Administration.
 */
import { escapeHtml } from '../utils.js';

/**
 * Renders the top header for an administrative section view.
 * @param {{ title: string, description?: string, actionHtml?: string, breadcrumb?: string }} params
 * @returns {string} HTML string
 */
export function renderPageHeader({ title, description, actionHtml = '', breadcrumb = 'Platform Administration' }) {
    return `
    <div class="mb-6 pb-5 border-b border-gray-200 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
            <div class="flex items-center text-xs text-gray-500 gap-1.5 mb-1">
                <span>${escapeHtml(breadcrumb)}</span>
                <span>/</span>
                <span class="font-semibold text-gray-700">${escapeHtml(title)}</span>
            </div>
            <h1 class="text-2xl font-extrabold text-gray-900 tracking-tight">${escapeHtml(title)}</h1>
            ${description ? `<p class="text-sm text-gray-600 mt-1">${escapeHtml(description)}</p>` : ''}
        </div>
        ${actionHtml ? `<div class="shrink-0 flex items-center gap-3">${actionHtml}</div>` : ''}
    </div>`;
}
