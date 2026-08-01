// @ts-check
/**
 * js/platform/tables.js
 * Data table components for Platform Administration.
 */
import { escapeHtml } from '../utils.js';

/**
 * Renders a data table component.
 * @param {{ columns: { key: string, label: string }[], rows: Record<string, any>[], emptyMessage?: string, renderCell?: (row: Record<string, any>, colKey: string) => string }} params
 * @returns {string} HTML string
 */
export function renderDataTable({ columns, rows, emptyMessage = 'No items found.', renderCell }) {
    if (!rows || rows.length === 0) {
        return `
        <div class="text-center py-12 px-4 bg-gray-50 rounded-xl border border-dashed border-gray-200">
            <p class="text-sm text-gray-500">${escapeHtml(emptyMessage)}</p>
        </div>`;
    }

    const headersHtml = columns
        .map(col => `<th class="px-6 py-3 text-left text-xs font-bold text-gray-500 uppercase tracking-wider">${escapeHtml(col.label)}</th>`)
        .join('');

    const rowsHtml = rows
        .map(row => {
            const cellsHtml = columns
                .map(col => {
                    const val = renderCell ? renderCell(row, col.key) : escapeHtml(String(row[col.key] ?? ''));
                    return `<td class="px-6 py-4 whitespace-nowrap text-sm text-gray-900">${val}</td>`;
                })
                .join('');
            return `<tr class="hover:bg-gray-50 transition border-b border-gray-100 last:border-0">${cellsHtml}</tr>`;
        })
        .join('');

    return `
    <div class="overflow-x-auto rounded-xl border border-gray-200 shadow-sm">
        <table class="min-w-full divide-y divide-gray-200 bg-white">
            <thead class="bg-gray-50">
                <tr>${headersHtml}</tr>
            </thead>
            <tbody class="divide-y divide-gray-100">
                ${rowsHtml}
            </tbody>
        </table>
    </div>`;
}

/**
 * Renders a status badge pill.
 * @param {string} status
 * @param {string} [variant] - 'active'|'inactive'|'pending'|'info'
 * @returns {string} HTML string
 */
export function renderStatusBadge(status, variant) {
    const v = variant || (status.toLowerCase().includes('active') ? 'active' : 'inactive');
    const styles = {
        active: 'bg-emerald-50 text-emerald-700 border-emerald-200',
        inactive: 'bg-gray-100 text-gray-600 border-gray-300',
        pending: 'bg-amber-50 text-amber-700 border-amber-200',
        info: 'bg-blue-50 text-blue-700 border-blue-200'
    };

    const style = styles[v] || styles.inactive;

    return `<span class="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold border ${style}">${escapeHtml(status)}</span>`;
}
