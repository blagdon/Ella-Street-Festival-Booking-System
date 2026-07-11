import { initAdminPage } from './supabase.js';
import { initSummary } from './summary.js';

function init() {
    initSummary();

    // 1. Static Elements by ID
    const statusFilter = document.getElementById('statusFilter');
    if (statusFilter) statusFilter.addEventListener('change', window.filterTable);

    const searchInput = document.getElementById('searchInput');
    if (searchInput) searchInput.addEventListener('keyup', window.filterTable);

    const btnExportCsv = document.getElementById('btn-export-csv');
    if (btnExportCsv) btnExportCsv.addEventListener('click', window.exportCSV);

    const btnEmailAll = document.getElementById('btn-email-all');
    if (btnEmailAll) btnEmailAll.addEventListener('click', window.emailAllConfirmed);

    const btnOpenEmail = document.getElementById('btn-open-email');
    if (btnOpenEmail) btnOpenEmail.addEventListener('click', window.openEmailModal);

    const btnSaveNote = document.getElementById('btn-save-note');
    if (btnSaveNote) btnSaveNote.addEventListener('click', window.saveNote);

    const btnFinalizeTrue = document.getElementById('btn-finalize-true');
    if (btnFinalizeTrue) btnFinalizeTrue.addEventListener('click', () => window.finalizeConfirm(true));

    const btnFinalizeFalse = document.getElementById('btn-finalize-false');
    if (btnFinalizeFalse) btnFinalizeFalse.addEventListener('click', () => window.finalizeConfirm(false));

    const btnConfirmRejection = document.getElementById('btn-confirm-rejection');
    if (btnConfirmRejection) btnConfirmRejection.addEventListener('click', window.confirmRejection);

    const btnSendSystemEmail = document.getElementById('btn-send-system-email');
    if (btnSendSystemEmail) btnSendSystemEmail.addEventListener('click', function () { window.sendSystemEmail(this); });

    const btnSendBulkEmail = document.getElementById('btn-send-bulk-email');
    if (btnSendBulkEmail) btnSendBulkEmail.addEventListener('click', function () { window.sendBulkEmail(this); });

    // 2. Event Delegation for Data Attributes
    document.body.addEventListener('click', (e) => {
        // Sort Actions
        const sortBtn = e.target.closest('[data-action="sort"]');
        if (sortBtn) {
            window.sortTable(sortBtn.dataset.field);
            return;
        }

        // Close Modal Actions
        const closeBtn = e.target.closest('[data-action="close-modal"]');
        if (closeBtn) {
            window.closeModal(closeBtn.dataset.modal);
            return;
        }

        // Change Status Actions
        const changeStatusBtn = e.target.closest('[data-action="change-status"]');
        if (changeStatusBtn) {
            window.changeStatus(changeStatusBtn.dataset.status);
            return;
        }
    });
}

initAdminPage(init);
