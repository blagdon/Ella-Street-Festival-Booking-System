import { initAdminPage } from './supabase.js';
import { initDetails, selectBooking, filterList, saveChanges, backToList } from './details.js';

function init() {
    initDetails();

    // Attach event listeners
    const searchInput = document.getElementById('searchInput');
    if (searchInput) searchInput.addEventListener('keyup', filterList);

    const btnBackToList = document.getElementById('btn-back-to-list');
    if (btnBackToList) btnBackToList.addEventListener('click', backToList);

    const saveBtn = document.getElementById('saveBtn');
    if (saveBtn) saveBtn.addEventListener('click', saveChanges);
}

initAdminPage(init);
