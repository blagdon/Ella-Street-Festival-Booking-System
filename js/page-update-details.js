import { requireAuth } from './supabase.js';
import { initNavigation } from './nav.js';
import { initDetails, selectBooking, filterList, saveChanges, backToList } from './details.js';

document.addEventListener('DOMContentLoaded', async () => {
    try {
        await requireAuth('admin');
        initNavigation();
        initDetails();

        // Attach event listeners
        const searchInput = document.getElementById('searchInput');
        if (searchInput) searchInput.addEventListener('keyup', filterList);

        const btnBackToList = document.getElementById('btn-back-to-list');
        if (btnBackToList) btnBackToList.addEventListener('click', backToList);

        const saveBtn = document.getElementById('saveBtn');
        if (saveBtn) saveBtn.addEventListener('click', saveChanges);

    } catch (e) {
        console.error("Auth init failed in update_details", e);
    }
});
