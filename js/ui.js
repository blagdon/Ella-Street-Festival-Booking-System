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


