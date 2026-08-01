// @ts-check
/**
 * js/platform/cards.js
 * Card containers and metric stat displays for Platform Administration.
 */
import { escapeHtml } from '../utils.js';

/**
 * Renders a metric stat card component.
 * @param {{ label: string, value: string|number, change?: string, icon?: string, badgeClass?: string }} params
 * @returns {string} HTML string
 */
export function renderStatCard({ label, value, change, icon = '📊', badgeClass = 'bg-blue-50 text-blue-700' }) {
    return `
    <div class="bg-white p-5 rounded-xl border border-gray-200 shadow-sm flex flex-col justify-between">
        <div class="flex items-center justify-between mb-3">
            <span class="text-xs font-semibold uppercase tracking-wider text-gray-500">${escapeHtml(label)}</span>
            <span class="p-2 rounded-lg text-base ${badgeClass}">${icon}</span>
        </div>
        <div class="flex items-baseline justify-between">
            <span class="text-2xl font-extrabold text-gray-900">${escapeHtml(String(value))}</span>
            ${change ? `<span class="text-xs font-medium text-emerald-600">${escapeHtml(change)}</span>` : ''}
        </div>
    </div>`;
}

/**
 * Renders a card container with header title and actions.
 * @param {{ title: string, subtitle?: string, contentHtml: string, actionHtml?: string }} params
 * @returns {string} HTML string
 */
export function renderCard({ title, subtitle, contentHtml, actionHtml = '' }) {
    return `
    <div class="bg-white rounded-xl border border-gray-200 shadow-sm mb-6 overflow-hidden">
        <div class="px-6 py-4 border-b border-gray-100 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div>
                <h3 class="text-base font-bold text-gray-900">${escapeHtml(title)}</h3>
                ${subtitle ? `<p class="text-xs text-gray-500 mt-0.5">${escapeHtml(subtitle)}</p>` : ''}
            </div>
            ${actionHtml ? `<div>${actionHtml}</div>` : ''}
        </div>
        <div class="p-6">
            ${contentHtml}
        </div>
    </div>`;
}
