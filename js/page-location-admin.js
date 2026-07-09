import { initNavigation } from './nav.js';
import { initLocations, setFilter, loadData, sendBulkEmails, closeLocationSheet, assignMobileLocation, sendEmail, closeConfirmModal, confirmAction, openLocationSheet, assignLocation } from './locations.js';
import { requireAuth } from './supabase.js';

document.addEventListener('DOMContentLoaded', async () => {
    try {
        await requireAuth('admin');
        initNavigation();
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

        const btnCancelConfirm = document.getElementById('btn-cancel-confirm');
        if (btnCancelConfirm) btnCancelConfirm.addEventListener('click', closeConfirmModal);

        const btnConfirmButton = document.getElementById('confirmButton');
        if (btnConfirmButton) btnConfirmButton.addEventListener('click', confirmAction);


        // Attach delegated event listeners for dynamic content
        document.body.addEventListener('change', (e) => {
            if (e.target.matches('select[data-action="assign-location"]')) {
                assignLocation(e.target.dataset.id, e.target.value);
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
        });

    } catch (e) {
        console.error("Initialization failed:", e);
    }
});
