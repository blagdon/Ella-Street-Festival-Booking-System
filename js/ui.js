/**
 * UI Utilities
 * Shared components for user feedback and interaction.
 */

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

/**
 * Renders the active instance badge styling and label.
 * @param {string} badgeId - The DOM element ID of the badge.
 */
export function renderInstanceBadge(badgeId) {
    const instance = localStorage.getItem('ESF_INSTANCE') || 'DEV';
    const badge = document.getElementById(badgeId);
    if (badge) {
        if (instance === 'FOOD') {
            badge.className = "bg-red-100 text-red-800 text-xs font-bold px-2 py-1 rounded uppercase tracking-wide";
            badge.innerText = "Food Stalls";
        } else if (instance === 'GENERAL') {
            badge.className = "bg-blue-100 text-blue-800 text-xs font-bold px-2 py-1 rounded uppercase tracking-wide";
            badge.innerText = "Non-Food";
        } else if (instance === 'MISC') {
            badge.className = "bg-purple-100 text-purple-800 text-xs font-bold px-2 py-1 rounded uppercase tracking-wide";
            badge.innerText = "Misc / Facilities";
        } else {
            badge.className = "bg-green-100 text-green-800 text-xs font-bold px-2 py-1 rounded uppercase tracking-wide";
            badge.innerText = "Dev Environment";
        }
    }
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


