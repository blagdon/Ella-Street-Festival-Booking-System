/**
 * UI Utilities
 * Shared components for user feedback and interaction.
 */

/**
 * One-line notice for a list fetch that hit its cap (see api.js's
 * fetchCapped / LIST_CAP / STATS_CAP) — shared so the six call sites that
 * check `.truncated` all word it the same way, rather than drifting. Uses
 * showToast, which sets the message via `.innerText`, not innerHTML, so this
 * is inherently XSS-safe with no separate escaping step needed even though
 * `label` here is always a static string, never user data.
 * @param {Array} data - the result of a fetchCapped()-backed call
 * @param {number} cap - the cap that was applied (LIST_CAP or STATS_CAP)
 * @param {string} label - what the capped items are, e.g. "bookings"
 */
export function notifyIfTruncated(data, cap, label) {
    if (data && data.truncated) {
        showToast(`Showing the first ${cap} ${label} — there are more than this. This view will need real pagination if that becomes routine.`, 'info');
    }
}

/**
 * Shows a toast notification at the bottom right of the screen.
 * Requires a #toast element in the DOM (injected if missing).
 * @param {string} message - The message to display
 * @param {string} type - 'success', 'error', 'info' (determines icon/color)
 */
export function showToast(message, type = 'success') {
    let toast = document.getElementById('toast');

    // Inject toast container if not present
    if (!toast) {
        toast = document.createElement('div');
        toast.id = 'toast';
        toast.className = 'fixed bottom-5 right-5 bg-gray-800 text-white px-6 py-4 rounded-lg shadow-xl transform translate-y-20 opacity-0 transition-all duration-300 z-50 flex items-center gap-3';
        toast.innerHTML = `
            <div id="toastIcon"></div>
            <div>
                <h4 id="toastTitle" class="font-bold text-sm">Notification</h4>
                <p id="toastMsg" class="text-xs text-gray-300"></p>
            </div>
        `;
        document.body.appendChild(toast);
    }

    const toastMsg = document.getElementById('toastMsg');
    const toastTitle = document.getElementById('toastTitle');
    const toastIcon = document.getElementById('toastIcon');

    toastMsg.innerText = message;

    // Configure based on type
    if (type === 'success') {
        toastTitle.innerText = 'Success';
        toastIcon.innerHTML = `<svg class="w-6 h-6 text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"></path></svg>`;
    } else if (type === 'error') {
        toastTitle.innerText = 'Error';
        toastIcon.innerHTML = `<svg class="w-6 h-6 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg>`;
    } else {
        toastTitle.innerText = 'Info';
        toastIcon.innerHTML = `<svg class="w-6 h-6 text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>`;
    }

    // Show
    toast.classList.remove('translate-y-20', 'opacity-0');

    // Hide after 3 seconds
    setTimeout(() => {
        toast.classList.add('translate-y-20', 'opacity-0');
    }, 3000);
}

let activeConfirmCallback = null;

/**
 * Shows a styled confirmation modal, dynamically injecting it if missing.
 * @param {string} title - Modal title
 * @param {string} message - Modal body text
 * @param {Function} onConfirm - Callback executed when user clicks "Confirm"
 */
export function showConfirm(title, message, onConfirm) {
    let modal = document.getElementById('confirmModal');

    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'confirmModal';
        modal.className = 'fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 opacity-0 pointer-events-none transition-opacity duration-200';
        modal.innerHTML = `
            <div class="bg-white rounded-lg shadow-2xl max-w-md w-full mx-4 transform transition-all">
                <div class="p-6">
                    <h3 class="text-lg font-bold text-gray-900 mb-2" id="confirmTitle">Confirm Action</h3>
                    <p class="text-sm text-gray-600 mb-6" id="confirmMessage">Are you sure you want to proceed?</p>
                    <div class="flex gap-3 justify-end">
                        <button id="btn-cancel-confirm"
                            class="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200 transition-colors">
                            Cancel
                        </button>
                        <button id="confirmButton"
                            class="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition-colors">
                            Confirm
                        </button>
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(modal);

        // Attach listeners to the newly created buttons
        document.getElementById('btn-cancel-confirm').addEventListener('click', closeConfirmModal);
        document.getElementById('confirmButton').addEventListener('click', executeConfirmAction);
    }

    const titleEl = document.getElementById('confirmTitle');
    const msgEl = document.getElementById('confirmMessage');

    if (titleEl) titleEl.innerText = title;
    if (msgEl) msgEl.innerText = message;

    activeConfirmCallback = onConfirm;

    // Show modal
    modal.classList.remove('opacity-0', 'pointer-events-none');
}

export function closeConfirmModal() {
    const modal = document.getElementById('confirmModal');
    if (modal) {
        modal.classList.add('opacity-0', 'pointer-events-none');
    }
    activeConfirmCallback = null;
}

function executeConfirmAction() {
    if (typeof activeConfirmCallback === 'function') {
        activeConfirmCallback();
    }
    closeConfirmModal();
}


