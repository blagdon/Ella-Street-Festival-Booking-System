// @ts-check
/**
 * js/platform/notifications.js
 * Toast notifications and alert banners for Platform Administration.
 */
import { escapeHtml } from '../utils.js';
import { showToast as coreShowToast } from '../ui.js';

/**
 * Displays a toast message.
 * @param {string} message
 * @param {'success'|'error'|'info'} [type='info']
 */
export function notify(message, type = 'info') {
    coreShowToast(message, type);
}

/**
 * Renders an inline alert banner component.
 * @param {{ title?: string, message: string, type?: 'info'|'warning'|'error'|'success' }} params
 * @returns {string} HTML string
 */
export function renderAlert({ title, message, type = 'info' }) {
    const styles = {
        info: 'bg-blue-50 text-blue-800 border-blue-200',
        warning: 'bg-amber-50 text-amber-800 border-amber-200',
        error: 'bg-red-50 text-red-800 border-red-200',
        success: 'bg-emerald-50 text-emerald-800 border-emerald-200'
    };

    const style = styles[type] || styles.info;

    return `
    <div class="p-4 rounded-xl border ${style} flex items-start gap-3 my-4">
        <div class="flex-1">
            ${title ? `<h4 class="font-bold text-sm mb-1">${escapeHtml(title)}</h4>` : ''}
            <p class="text-sm leading-relaxed">${escapeHtml(message)}</p>
        </div>
    </div>`;
}
