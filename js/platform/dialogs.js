// @ts-check
/**
 * js/platform/dialogs.js
 * Modal dialogs and confirmation drawers for Platform Administration.
 */
import { escapeHtml } from '../utils.js';
import { registerModalClose, trapFocus } from '../ui.js';

/**
 * Creates and displays a platform modal dialog.
 * @param {{ id: string, title: string, bodyHtml: string, actionHtml?: string, onClose?: () => void }} params
 */
export function openDialog({ id, title, bodyHtml, actionHtml = '', onClose }) {
    let container = document.getElementById(id);
    if (!container) {
        container = document.createElement('div');
        container.id = id;
        container.className = 'fixed inset-0 z-50 overflow-y-auto bg-gray-900/50 backdrop-blur-sm flex items-center justify-center p-4';
        document.body.appendChild(container);
    }

    container.innerHTML = `
    <div id="${escapeHtml(id)}Content" class="bg-white rounded-2xl shadow-xl border border-gray-200 w-full max-w-lg overflow-hidden transform transition-all">
        <div class="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
            <h3 class="text-base font-bold text-gray-900">${escapeHtml(title)}</h3>
            <button type="button" class="btn-close-modal text-gray-400 hover:text-gray-600 p-1 rounded-lg transition" aria-label="Close dialog">
                <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg>
            </button>
        </div>
        <div class="p-6">
            ${bodyHtml}
        </div>
        ${actionHtml ? `<div class="px-6 py-3.5 bg-gray-50 border-t border-gray-100 flex justify-end gap-3">${actionHtml}</div>` : ''}
    </div>`;

    container.classList.remove('hidden');

    let unregisterEsc = null;
    let releaseFocus = null;

    const handleClose = () => {
        container.classList.add('hidden');
        if (unregisterEsc) unregisterEsc();
        if (releaseFocus) releaseFocus();
        if (typeof onClose === 'function') onClose();
    };

    unregisterEsc = registerModalClose(handleClose);
    releaseFocus = trapFocus(container);

    container.querySelectorAll('.btn-close-modal').forEach(btn => {
        btn.addEventListener('click', handleClose);
    });
}
