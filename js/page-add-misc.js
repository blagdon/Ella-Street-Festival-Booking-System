import { initAdminPage } from './supabase.js';
import { insertMiscBooking } from './api.js';
import { showToast } from './ui.js';
import { CONFIG } from './config.js';

initAdminPage(initAddMisc);

function initAddMisc() {
    // Populate stall types
    const typeSelect = document.getElementById('entryType');
    if (CONFIG && CONFIG.UI && CONFIG.UI.ALLOWED_TYPES) {
        CONFIG.UI.ALLOWED_TYPES.forEach(type => {
            const opt = document.createElement('option');
            opt.value = type;
            opt.innerText = type;
            typeSelect.appendChild(opt);
        });
    }

    const form = document.getElementById('miscForm');
    if (form) {
        form.addEventListener('submit', async (e) => {
            e.preventDefault();
            await submitMiscEntry();
        });
    }
}

async function submitMiscEntry() {
    const btn = document.getElementById('submitBtn');
    const originalText = btn.innerText;

    // Collect Payload
    const payload = {
        business: document.getElementById('entryBusiness').value.trim(),
        owner: document.getElementById('entryOwner').value.trim(),
        type: document.getElementById('entryType').value,
        category: document.getElementById('entryCategory').value.trim(),
        email: document.getElementById('entryEmail').value.trim(),
        phone: document.getElementById('entryPhone').value.trim(),
        house: document.getElementById('entryAddress').value.trim(),
        website: document.getElementById('entryWebsite').value.trim(),
        description: document.getElementById('entryDescription').value.trim()
    };

    if (!payload.business || !payload.owner) {
        showToast("Business Name and Owner Name are required.", "error");
        return;
    }

    btn.disabled = true;
    btn.innerText = "Saving...";

    try {
        const result = await insertMiscBooking(payload);
        showToast(`Success! Created entry: ${result.id}`, "success");

        // Clear the form
        document.getElementById('miscForm').reset();
    } catch (err) {
        showToast(err.message || "Failed to create entry.", "error");
    } finally {
        btn.disabled = false;
        btn.innerText = originalText;
    }
}
