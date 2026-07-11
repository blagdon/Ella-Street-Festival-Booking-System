import { initAdminPage } from './supabase.js';
import { initLocations, setFilter, loadData, sendBulkEmails, closeLocationSheet, assignMobileLocation, sendEmail, openLocationSheet, assignLocation } from './locations.js';

async function init() {
    await initLocations();

    // Attach static event listeners
    const btnFilterAll = document.getElementById('btn-filter-all');
    if (btnFilterAll) btnFilterAll.addEventListener('click', () => setFilter('all'));

    const btnFilterUnassigned = document.getElementById('btn-filter-unassigned');
    if (btnFilterUnassigned) btnFilterUnassigned.addEventListener('click', () => setFilter('unassigned'));

    const btnFilterAssigned = document.getElementById('btn-filter-assigned');
    if (btnFilterAssigned) btnFilterAssigned.addEventListener('click', () => setFilter('assigned'));

    const btnRefreshData = document.getElementById('btn-refresh-data');
    if (btnRefreshData) btnRefreshData.addEventListener('click', loadData);

    const btnSendBulkEmails = document.getElementById('btn-send-bulk-emails');
    if (btnSendBulkEmails) btnSendBulkEmails.addEventListener('click', sendBulkEmails);

    const locationSheetBackdrop = document.getElementById('locationSheetBackdrop');
    if (locationSheetBackdrop) locationSheetBackdrop.addEventListener('click', closeLocationSheet);

    const btnCloseLocationSheet = document.getElementById('btn-close-location-sheet');
    if (btnCloseLocationSheet) btnCloseLocationSheet.addEventListener('click', closeLocationSheet);

    const btnClearAssignment = document.getElementById('btn-clear-assignment');
    if (btnClearAssignment) btnClearAssignment.addEventListener('click', () => assignMobileLocation(null));


    // Attach delegated event listeners for dynamic content
    document.body.addEventListener('change', (e) => {
        if (e.target.matches('select[data-action="add-allocated-location"]')) {
            const select = e.target;
            const bookingId = select.dataset.bookingId;
            const newLoc = select.value;
            
            if (newLoc && newLoc !== '__cancel__') {
                const cell = select.closest('td');
                const buttons = cell.querySelectorAll('button[data-location-id]');
                const currentLocs = Array.from(buttons).map(btn => btn.dataset.locationId);
                if (!currentLocs.includes(newLoc)) {
                    currentLocs.push(newLoc);
                }
                assignLocation(bookingId, currentLocs.join(', '));
            } else {
                // Reset UI
                const container = select.closest('div');
                const addBtn = container.querySelector('button[data-action="show-add-select"]');
                if (addBtn) addBtn.classList.remove('hidden');
                select.classList.add('hidden');
            }
        }
    });

    document.body.addEventListener('click', (e) => {
        const sendEmailBtn = e.target.closest('button[data-action="send-email"]');
        if (sendEmailBtn) {
            sendEmail(sendEmailBtn.dataset.id);
            e.stopPropagation();
            return;
        }

        const openSheetBtn = e.target.closest('button[data-action="open-location-sheet"]');
        if (openSheetBtn) {
            openLocationSheet(openSheetBtn.dataset.id);
            e.stopPropagation();
            return;
        }

        const showAddBtn = e.target.closest('button[data-action="show-add-select"]');
        if (showAddBtn) {
            const container = showAddBtn.closest('div');
            const select = container.querySelector('select[data-action="add-allocated-location"]');
            if (select) {
                showAddBtn.classList.add('hidden');
                select.classList.remove('hidden');
                select.focus();
            }
            e.stopPropagation();
            return;
        }

        const removeBtn = e.target.closest('button[data-action="remove-allocated-location"]');
        if (removeBtn) {
            const bookingId = removeBtn.dataset.bookingId;
            const locToRemove = removeBtn.dataset.locationId;
            const cell = removeBtn.closest('td');
            const buttons = cell.querySelectorAll('button[data-location-id]');
            const currentLocs = Array.from(buttons)
                .map(btn => btn.dataset.locationId)
                .filter(loc => loc !== locToRemove);
            
            assignLocation(bookingId, currentLocs.join(', '));
            e.stopPropagation();
            return;
        }
    });
}

initAdminPage(init);
