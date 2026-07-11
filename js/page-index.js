import { initAdminPage, getSupabaseClient } from './supabase.js';
import { getCurrentInstance } from './config.js';
import { showToast } from './ui.js';

let sb;

function initIndex() {
    updateVisibility();

    sb = getSupabaseClient();

    sb.auth.onAuthStateChange(async (event, session) => {
        if (event === 'PASSWORD_RECOVERY') {
            document.getElementById('passwordResetModal').classList.remove('opacity-0', 'pointer-events-none');
        }
    });

    // Event delegation for navigation cards
    document.body.addEventListener('click', (e) => {
        const navCard = e.target.closest('[data-action="navigate"]');
        if (navCard) {
            const page = navCard.dataset.page;
            if (page) window.location.href = page + '.html';
        }
    });

    // Password reset button
    const updatePassBtn = document.getElementById('updatePassBtn');
    if (updatePassBtn) {
        updatePassBtn.addEventListener('click', updateUserPassword);
    }
}

initAdminPage(initIndex);

function updateVisibility() {
    const val = getCurrentInstance();
    const hccCard = document.getElementById('hcc-card');

    if (hccCard) {
        if (val === 'FOOD' || val === 'DEV') {
            hccCard.classList.remove('hidden');
        } else {
            hccCard.classList.add('hidden');
        }
    }
}

async function updateUserPassword() {
    const newPass = document.getElementById('newPassword').value;
    const btn = document.getElementById('updatePassBtn');

    if (newPass.length < 8) {
        showToast("Password must be at least 8 characters", "error");
        return;
    }

    btn.disabled = true;
    btn.innerText = "Updating...";

    try {
        const { error } = await sb.auth.updateUser({ password: newPass });
        if (error) throw error;

        showToast("Success! Password updated.", "success");

        setTimeout(() => {
            document.getElementById('passwordResetModal').classList.add('opacity-0', 'pointer-events-none');
            window.history.replaceState(null, null, window.location.pathname);
        }, 1500);

    } catch (err) {
        showToast("Failed to update password.", "error");
        btn.disabled = false;
        btn.innerText = "Update Password";
    }
}
