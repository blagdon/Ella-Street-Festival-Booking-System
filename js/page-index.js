import { initAdminPage, getSupabaseClient } from './supabase.js';
import { getCurrentInstance } from './config.js';
import { showToast } from './ui.js';

let sb;

// True when this page load is the result of a Supabase password-reset email link.
// While this is set we block all dashboard access until the new password is saved.
let isPasswordRecovery = false;

function initIndex() {
    sb = getSupabaseClient();

    sb.auth.onAuthStateChange(async (event, session) => {
        if (event === 'PASSWORD_RECOVERY') {
            // The user arrived via a password-reset link. Lock down the dashboard
            // and force them to set a new password before they can do anything.
            isPasswordRecovery = true;
            lockDashboardForRecovery();
        }
    });

    // If we are NOT in password-recovery mode, render the normal dashboard.
    if (!isPasswordRecovery) {
        updateVisibility();

        // Event delegation for navigation cards
        document.body.addEventListener('click', (e) => {
            const navCard = e.target.closest('[data-action="navigate"]');
            if (navCard) {
                // Block navigation while password recovery is pending.
                if (isPasswordRecovery) return;
                const page = navCard.dataset.page;
                if (page) window.location.href = page + '.html';
            }
        });
    }

    // Password reset button
    const updatePassBtn = document.getElementById('updatePassBtn');
    if (updatePassBtn) {
        updatePassBtn.addEventListener('click', updateUserPassword);
    }
}

/**
 * Hides all dashboard content and shows the mandatory password-reset modal.
 * Called when the page detects a PASSWORD_RECOVERY Supabase event.
 */
function lockDashboardForRecovery() {
    // Hide the navigation bar so the user cannot navigate away.
    const navContainer = document.getElementById('nav-container');
    if (navContainer) navContainer.style.display = 'none';

    // Hide the module grid so there is nothing to interact with.
    const mainContent = document.querySelector('.max-w-7xl');
    if (mainContent) mainContent.style.display = 'none';

    // Show the password-reset modal (and make it non-dismissible — no close button).
    const modal = document.getElementById('passwordResetModal');
    if (modal) modal.classList.remove('opacity-0', 'pointer-events-none');
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

        showToast("Password updated successfully! Redirecting to login…", "success");

        // Sign out so the recovery session is fully cleared, then send the
        // admin to the login page to authenticate with their new password.
        setTimeout(async () => {
            await sb.auth.signOut();
            window.location.href = 'login.html';
        }, 1500);

    } catch (err) {
        showToast("Failed to update password.", "error");
        btn.disabled = false;
        btn.innerText = "Update Password";
    }
}
