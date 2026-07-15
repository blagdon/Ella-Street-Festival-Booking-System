import { initAdminPage } from './supabase.js';
import { initKanban, filterCards, loadBoard, setSort, emailAllConfirmed, closeModal, openEmailModal, saveNote, changeStatus, promptStatusChange, finalizeConfirm, sendSystemEmail, confirmRejection, sendBulkEmail, cancelDrag, requestPaymentAction, resendPaymentRequestAction, recoverStuckPaidBookingAction } from './kanban.js';

function init() {
    initKanban();

    // 1. Static Elements by ID
    const kanbanSearch = document.getElementById('searchInput');
    if (kanbanSearch) kanbanSearch.addEventListener('keyup', filterCards);

    const sortSelect = document.getElementById('sortSelect');
    if (sortSelect) sortSelect.addEventListener('change', (e) => {
        const [field, direction] = e.target.value.split('-');
        setSort(field, direction);
    });

    const btnRefreshBoard = document.getElementById('btn-refresh-board');
    if (btnRefreshBoard) btnRefreshBoard.addEventListener('click', loadBoard);

    const btnEmailConfirmed = document.getElementById('btn-email-confirmed');
    if (btnEmailConfirmed) btnEmailConfirmed.addEventListener('click', emailAllConfirmed);

    const btnOpenEmail = document.getElementById('btn-open-email');
    if (btnOpenEmail) btnOpenEmail.addEventListener('click', openEmailModal);

    const btnSaveNote = document.getElementById('btn-save-note');
    if (btnSaveNote) btnSaveNote.addEventListener('click', saveNote);

    const btnFinalizeTrue = document.getElementById('btn-finalize-true');
    if (btnFinalizeTrue) btnFinalizeTrue.addEventListener('click', () => finalizeConfirm(true));

    const btnFinalizeFalse = document.getElementById('btn-finalize-false');
    if (btnFinalizeFalse) btnFinalizeFalse.addEventListener('click', () => finalizeConfirm(false));

    const btnConfirmRejection = document.getElementById('btn-confirm-rejection');
    if (btnConfirmRejection) btnConfirmRejection.addEventListener('click', confirmRejection);

    const btnRequestPayment = document.getElementById('btn-request-payment');
    if (btnRequestPayment) btnRequestPayment.addEventListener('click', () => requestPaymentAction());

    const btnResendPaymentRequest = document.getElementById('btn-resend-payment-request');
    if (btnResendPaymentRequest) btnResendPaymentRequest.addEventListener('click', () => resendPaymentRequestAction());

    const btnRecoverPaid = document.getElementById('btn-recover-paid');
    if (btnRecoverPaid) btnRecoverPaid.addEventListener('click', () => recoverStuckPaidBookingAction());

    const btnSendSystemEmail = document.getElementById('btn-send-system-email');
    if (btnSendSystemEmail) btnSendSystemEmail.addEventListener('click', function () { sendSystemEmail(this); });

    const btnSendBulkEmail = document.getElementById('btn-send-bulk-email');
    if (btnSendBulkEmail) btnSendBulkEmail.addEventListener('click', function () { sendBulkEmail(this); });

    // 2. Event Delegation for Data Attributes
    document.body.addEventListener('click', (e) => {
        // Close Modal Actions
        const closeBtn = e.target.closest('[data-action="close-modal"]');
        if (closeBtn) {
            closeModal(closeBtn.dataset.modal);
            // Specifically for kanban, call cancelDrag on close
            cancelDrag();
            return;
        }

        // Change Status Actions
        const changeStatusBtn = e.target.closest('[data-action="change-status"]');
        if (changeStatusBtn) {
            changeStatus(changeStatusBtn.dataset.status);
            return;
        }

        // Prompt Status Change Actions
        const promptChangeBtn = e.target.closest('[data-action="prompt-status-change"]');
        if (promptChangeBtn) {
            promptStatusChange(promptChangeBtn.dataset.status);
            return;
        }
    });

    // 3. Initialize Auto-scroll logic formerly inline
    initAutoScroll();
}

initAdminPage(init);

function initAutoScroll() {
    const EDGE_SIZE = 80; // px from edge to trigger scroll
    const MAX_SPEED = 12; // px per frame
    let scrollContainer = null;
    let animFrame = null;
    let isDragging = false;
    let pointerX = 0;

    function getScrollContainer() {
        if (!scrollContainer) {
            scrollContainer = document.querySelector('.flex-1.overflow-x-auto');
        }
        return scrollContainer;
    }

    function autoScroll() {
        const container = getScrollContainer();
        if (!container || !isDragging) { animFrame = null; return; }

        const rect = container.getBoundingClientRect();
        const distFromRight = rect.right - pointerX;
        const distFromLeft = pointerX - rect.left;

        if (distFromRight < EDGE_SIZE && distFromRight > 0) {
            const speed = Math.round(MAX_SPEED * (1 - distFromRight / EDGE_SIZE));
            container.scrollLeft += Math.max(1, speed);
        } else if (distFromLeft < EDGE_SIZE && distFromLeft > 0) {
            const speed = Math.round(MAX_SPEED * (1 - distFromLeft / EDGE_SIZE));
            container.scrollLeft -= Math.max(1, speed);
        }

        animFrame = requestAnimationFrame(autoScroll);
    }

    function onPointerMove(e) {
        if (!isDragging) return;
        pointerX = e.clientX || (e.touches && e.touches[0] ? e.touches[0].clientX : 0);
    }

    function startScrolling() {
        isDragging = true;
        if (!animFrame) animFrame = requestAnimationFrame(autoScroll);
    }

    function stopScrolling() {
        isDragging = false;
        if (animFrame) { cancelAnimationFrame(animFrame); animFrame = null; }
    }

    // Listen for dragula's mirror element appearing (drag start)
    const observer = new MutationObserver(function (mutations) {
        for (const m of mutations) {
            for (const node of m.addedNodes) {
                if (node.classList && node.classList.contains('gu-mirror')) {
                    startScrolling();
                    return;
                }
            }
            for (const node of m.removedNodes) {
                if (node.classList && node.classList.contains('gu-mirror')) {
                    stopScrolling();
                    return;
                }
            }
        }
    });

    observer.observe(document.body, { childList: true });

    document.addEventListener('mousemove', onPointerMove);
    document.addEventListener('touchmove', onPointerMove, { passive: true });
}
