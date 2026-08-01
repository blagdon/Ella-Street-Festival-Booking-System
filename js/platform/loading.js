// @ts-check
/**
 * js/platform/loading.js
 * Loading skeletons and spinner indicators for the Platform Administration Workspace.
 */
import { escapeHtml } from '../utils.js';

/**
 * Renders a skeleton loader placeholder for cards or tables.
 * @param {string} [type='card'] - 'card' | 'table' | 'text'
 * @returns {string} HTML string
 */
export function renderSkeleton(type = 'card') {
    if (type === 'table') {
        return `
        <div class="animate-pulse space-y-3 p-4 bg-white rounded-xl border border-gray-200">
            <div class="h-4 bg-gray-200 rounded w-1/4"></div>
            <div class="h-8 bg-gray-100 rounded w-full"></div>
            <div class="h-8 bg-gray-100 rounded w-full"></div>
            <div class="h-8 bg-gray-100 rounded w-full"></div>
        </div>`;
    }
    if (type === 'text') {
        return `<div class="animate-pulse h-4 bg-gray-200 rounded w-3/4"></div>`;
    }
    return `
    <div class="animate-pulse p-6 bg-white rounded-xl border border-gray-200 space-y-4">
        <div class="h-4 bg-gray-200 rounded w-1/3"></div>
        <div class="h-8 bg-gray-100 rounded w-1/2"></div>
        <div class="h-4 bg-gray-100 rounded w-2/3"></div>
    </div>`;
}

/**
 * Renders an inline spinner.
 * @param {string} [label='Loading...']
 * @returns {string} HTML string
 */
export function renderSpinner(label = 'Loading...') {
    return `
    <div class="flex items-center justify-center p-8 text-gray-500 gap-3">
        <svg class="animate-spin h-5 w-5 text-blue-600" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
        </svg>
        <span class="text-sm font-medium">${escapeHtml(label)}</span>
    </div>`;
}
