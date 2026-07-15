import { fetchKanbanData, updateBookingStatus, addNote, sendEmail, queueBulkEmail, requestPayment, resendPaymentRequest } from './api.js';
import { CONFIG, getStallCost } from './config.js';
import { safeError, escapeHtml, sortBookings } from './utils.js';
import { sharedUpdateStatus, populateDetailPane } from './shared.js';
import { showToast, renderInstanceBadge, showConfirm } from './ui.js';

// Single source of truth for which columns exist, per instance — HCC Checks
// is Food-instance-only; the new payment-flow statuses apply everywhere.
function getBoardStatuses() {
    const instance = localStorage.getItem('ESF_INSTANCE') || 'DEV';
    return instance === 'GENERAL'
        ? ['Pending', 'Payment Requested', 'Confirmed', 'Rejected', 'Cancelled']
        : ['Pending', 'HCC Checks', 'Payment Requested', 'Confirmed', 'Rejected', 'Cancelled'];
}

function cardBorderClass(status) {
    switch (status) {
        case 'Confirmed': return 'border-green-500';
        case 'Rejected': return 'border-red-500';
        case 'HCC Checks': return 'border-orange-500';
        case 'Payment Requested': return 'border-indigo-500';
        default: return 'border-yellow-400';
    }
}

let drake;
let allBookings = [];
let draggedItem = null;
let sourceStatus = null;
let currentId = null;
let currentSortField = 'id';
let currentSortDir = 'asc';

// Initializer
export function initKanban() {
    loadBoard();
    initDragula();
    initInstanceBadge();
}

// Instance Badge
function initInstanceBadge() {
    const instance = localStorage.getItem('ESF_INSTANCE') || 'DEV';
    const hccColumn = document.getElementById('hcc-checks-column');
    const hccButton = document.getElementById('hcc-checks-button');

    if (instance === 'GENERAL') {
        if (hccColumn) hccColumn.style.display = 'none';
        if (hccButton) hccButton.style.display = 'none';
    } else {
        if (hccColumn) hccColumn.style.display = 'flex';
        if (hccButton) hccButton.style.display = 'block';
    }

    renderInstanceBadge('pageInstanceBadge');
}



function renderBoard(data) {
    const statuses = getBoardStatuses();

    statuses.forEach(status => {
        const col = document.getElementById(`col-${status}`);
        if (col) col.innerHTML = '';
        const count = document.getElementById(`count-${status}`);
        if (count) count.innerText = '0';
    });

    data.forEach(item => {
        const status = item.status || 'Pending';
        const col = document.getElementById(`col-${status}`);
        if (col) col.appendChild(createCard(item));
    });

    updateCounts();
}

function createCard(item) {
    const div = document.createElement('div');
    div.className = 'card bg-white p-3 rounded-lg shadow-sm mb-3 border-l-4 hover:shadow-md relative group';
    div.id = item.id;
    // Store raw data if needed, or lookup from allBookings
    // div.dataset.raw = JSON.stringify(item); 

    div.onclick = (e) => {
        if (e.target.closest('button')) return;
        openDetails(item.id);
    };

    div.classList.add(cardBorderClass(item.status));

    const powerIcon = (item.power_required && item.power_required !== 'No power') ? '<span class="text-yellow-600 ml-1" title="Power Required">\u26A1</span>' : '';

    div.innerHTML = `
    <div class="flex justify-between items-start mb-1">
        <span class="text-[10px] font-mono text-gray-400 uppercase tracking-widest">${escapeHtml(item.id)}</span>
        <div class="opacity-0 group-hover:opacity-100 transition-opacity flex gap-1">
            <button class="btn-card-email text-gray-400 hover:text-blue-500 p-1" title="Email"><svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"></path></svg></button>
        </div>
    </div>
    <h4 class="font-bold text-gray-800 text-sm leading-tight mb-1">${escapeHtml(item.business_name || item.business)} ${powerIcon}</h4>
    <div class="text-xs text-gray-500 truncate">${escapeHtml(item.category || 'Uncategorized')}</div>
    ${item.stall_type ? `<div class="mt-2 text-[10px] bg-gray-100 inline-block px-2 py-0.5 rounded text-gray-600 font-bold uppercase">${escapeHtml(item.stall_type)}</div>` : ''}
    `;

    const btnEmail = div.querySelector('.btn-card-email');
    if (btnEmail) {
        btnEmail.addEventListener('click', (e) => {
            e.stopPropagation();
            openEmailModal(item.id);
        });
    }

    return div;
}

// Drag & Drop
function initDragula() {
    if (typeof dragula === 'undefined') return;

    const instance = localStorage.getItem('ESF_INSTANCE') || 'DEV';

    // 'Payment Requested' is deliberately NOT a drag target — it only ever
    // changes via "Request Payment"/the Stripe webhook, never a plain drag
    // (which would fake a transition with no real Checkout Session or
    // payment behind it). Cards can still leave that column via the
    // detail-pane buttons (Reject/HCC Checks/etc), just not by dragging.
    const containers = [
        document.getElementById('col-Pending'),
        instance !== 'GENERAL' ? document.getElementById('col-HCC Checks') : null,
        document.getElementById('col-Confirmed'),
        document.getElementById('col-Rejected'),
        document.getElementById('col-Cancelled')
    ];

    const validContainers = containers.filter(c => c !== null);

    drake = dragula(validContainers)
        .on('drag', function (el, source) {
            draggedItem = el;
            sourceStatus = source.dataset.status;
        })
        .on('drop', function (el, target, source, sibling) {
            if (!target || target === source) return;

            const newStatus = target.dataset.status;
            const bookingId = el.id;

            // INTERCEPT: Rejection
            if (newStatus === 'Rejected') {
                document.getElementById('rejectBookingId').value = bookingId;
                document.getElementById('rejectReason').value = "";
                document.getElementById('rejectReasonModal').classList.remove('opacity-0', 'pointer-events-none');
                return;
            }

            // INTERCEPT: Confirmation (Chargeable check) — dropping onto
            // 'Confirmed' opens the same modal as clicking the Confirm
            // button; the admin's Free/Chargeable choice (and £0 override)
            // decides whether it lands on Confirmed directly or immediately
            // fires a Stripe payment request (landing on Payment Requested).
            if (newStatus === 'Confirmed') {
                showConfirmModalLocal(bookingId);
                return;
            }

            updateStatus(bookingId, newStatus);
        });
}

function updateStatus(id, status, reason = null, isChargeable = null, overrideCost = null) {
    sharedUpdateStatus(id, status, allBookings, {
        reason: reason,
        isChargeable: isChargeable,
        overrideCost: overrideCost,
        onSuccess: (newStatus) => {
            draggedItem = null;
            sourceStatus = null;
            updateCounts();
            // Also need to find the card and move it if it wasn't dragged? 
            // If dragging, dragula handles the move. If programmatic (from modal), we might need to move it manually or reload.
            // But since loadBoard resets everything, we might just reload or careful manipulation.
            // The existing shared logic calls onSuccess. 
            // In dragula drop, the element is already in the new container.

            // If calling from Detail modal, we should reload or move card.
            if (!drake || !drake.dragging) {
                // Simple approach: reload board or move element manually
                // Moving manually is better for UX but requires logic.
                // For now, let's keep it simple: if not dragged, reload or move.
                const card = document.getElementById(id);
                if (card) {
                    const targetCol = document.getElementById(`col-${newStatus}`);
                    if (targetCol && card.parentNode !== targetCol) targetCol.appendChild(card);
                    // Update style
                    card.className = card.className.replace(/border-\w+-500/, '').replace('border-yellow-400', '');
                    card.classList.add(cardBorderClass(newStatus));
                }
            }
        },
        onError: () => {
            cancelDrag();
            // loadBoard(); // Optional
        }
    });
}

export function cancelDrag() {
    if (drake) drake.cancel(true);
    if (draggedItem && sourceStatus) {
        const sourceCol = document.getElementById('col-' + sourceStatus);
        if (sourceCol && draggedItem.parentNode !== sourceCol) {
            sourceCol.appendChild(draggedItem);
        }
    }
    draggedItem = null;
    sourceStatus = null;
}

function updateCounts() {
    const statuses = getBoardStatuses();

    let total = 0;
    statuses.forEach(status => {
        const col = document.getElementById(`col-${status}`);
        if (col) {
            let visible = 0;
            Array.from(col.children).forEach(c => { if (c.style.display !== 'none') visible++; });
            document.getElementById(`count-${status}`).innerText = visible;
            total += visible;
        }
    });
    const totalEl = document.getElementById('totalCount');
    if (totalEl) totalEl.innerText = total + ' bookings';
}

// Re-sorts and re-renders the board, then re-applies the current search text
// filter (renderBoard rebuilds every card, so any previously-hidden card
// would otherwise reappear).
export function setSort(field, direction) {
    currentSortField = field;
    currentSortDir = direction;
    renderBoard(sortBookings(allBookings, currentSortField, currentSortDir));
    filterCards();
}

// Global Exports for inline HTML handlers
export function filterCards() {
    const term = document.getElementById('searchInput').value.toLowerCase();
    getBoardStatuses().forEach(status => {
        const col = document.getElementById(`col-${status}`);
        if (!col) return;
        Array.from(col.children).forEach(card => {
            const h4 = card.querySelector('h4');
            const text = (h4 ? h4.textContent : '').toLowerCase() + (card.id || '').toLowerCase();
            card.style.display = text.includes(term) ? '' : 'none';
        });
    });
    updateCounts();
};

export async function loadBoard() {
    const searchInput = document.getElementById('searchInput');
    if (searchInput) searchInput.value = '';

    const containers = document.querySelectorAll('.column-scroll-area');
    containers.forEach(c => c.innerHTML = '<div class="text-center p-4 text-gray-400 text-sm animate-pulse">Loading...</div>');

    try {
        const currentInstance = localStorage.getItem('ESF_INSTANCE') || 'DEV';
        const data = await fetchKanbanData(currentInstance);
        allBookings = data;
        renderBoard(sortBookings(allBookings, currentSortField, currentSortDir));
    } catch (err) {
        console.error(err);
        const safeMsg = (typeof safeError === 'function') ? safeError(err) : "Failed to load board. Please refresh or try again later.";
        containers.forEach(c => c.innerHTML = `<div class="text-center p-2 text-red-500 text-xs">Error: ${escapeHtml(safeMsg)}</div>`);
    }
}

// Modals
export function closeModal(id) {
    if (id === 'detailModal') {
        document.getElementById('detailPanel').classList.add('translate-x-full');
        setTimeout(() => {
            document.getElementById('detailModal').classList.add('opacity-0', 'pointer-events-none');
            document.body.classList.remove('modal-active');
        }, 200);
    } else {
        document.getElementById(id).classList.add('opacity-0', 'pointer-events-none');
    }
}

// Detail Pane Logic
function openDetails(id) {
    const item = allBookings.find(b => b.id === id);
    if (!item) return;

    currentId = id;
    populateDetailPane(item);

    const m = document.getElementById('detailModal');
    const p = document.getElementById('detailPanel');
    document.body.classList.add('modal-active');
    m.classList.remove('opacity-0', 'pointer-events-none');
    p.classList.remove('translate-x-full');
}

export async function saveNote() {
    const note = document.getElementById('d-notes').value;
    try {
        await addNote(currentId, note);
        showToast("Note saved");
        const idx = allBookings.findIndex(b => b.id === currentId);
        if (idx > -1) allBookings[idx].admin_notes = note;
    } catch (e) { showToast("Error saving note: " + e.message, 'error'); }
}

export async function promptStatusChange(newStatus) {
    if (newStatus === 'Confirmed') {
        closeModal('detailModal');
        showConfirmModalLocal(currentId);
        return;
    }

    showConfirm(
        "Confirm Status Change",
        `Are you sure you want to mark this as ${newStatus}?`,
        async () => {
            try {
                if (newStatus === 'Rejected') {
                    closeModal('detailModal');
                    document.getElementById('rejectBookingId').value = currentId;
                    document.getElementById('rejectReason').value = "";
                    document.getElementById('rejectReasonModal').classList.remove('opacity-0', 'pointer-events-none');
                } else {
                    await updateStatus(currentId, newStatus);
                    openDetails(currentId);
                }
            } catch (e) { showToast("Error changing status: " + e.message, 'error'); }
        }
    );
}

export function changeStatus(newStatus) {
    promptStatusChange(newStatus);
}

// Quill Editor instance
let bulkEmailQuill = null;

function initQuill() {
    if (bulkEmailQuill) return;
    const container = document.getElementById('bulkEmailEditor');
    if (!container) return;

    bulkEmailQuill = new Quill('#bulkEmailEditor', {
        theme: 'snow',
        modules: {
            toolbar: '#bulkEmailToolbar'
        }
    });
}

// Bulk Email - Open compose modal for all confirmed bookings
export function emailAllConfirmed() {
    const confirmed = allBookings.filter(b => b.status === 'Confirmed');

    if (confirmed.length === 0) {
        showToast('No confirmed bookings found.', 'info');
        return;
    }

    initQuill();

    // Show count badge in modal
    const countEl = document.getElementById('bulkEmailCount');
    if (countEl) countEl.innerText = `${confirmed.length} confirmed booking${confirmed.length !== 1 ? 's' : ''} will receive this email`;

    // Clear previous content
    const subjectEl = document.getElementById('bulkEmailSubject');
    if (subjectEl) subjectEl.value = '';
    if (bulkEmailQuill) bulkEmailQuill.setContents([]);

    document.getElementById('bulkEmailModal').classList.remove('opacity-0', 'pointer-events-none');
};

// Bulk Email - Send admin-written HTML email to all confirmed bookings
export async function sendBulkEmail(btn) {
    const confirmed = allBookings.filter(b => b.status === 'Confirmed');
    const subject = document.getElementById('bulkEmailSubject').value.trim();
    const body = bulkEmailQuill ? bulkEmailQuill.root.innerHTML.trim() : '';

    // Quill root.innerHTML usually contains '<p><br></p>' when empty
    const isBodyEmpty = !body || body === '<p><br></p>';

    if (!subject || isBodyEmpty) {
        showToast('Please fill in the subject and message.', 'error');
        return;
    }

    const originalContent = btn.innerHTML;
    btn.innerHTML = `<svg class="animate-spin -ml-1 mr-2 h-4 w-4 text-white inline-block align-text-bottom" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg> Sending...`;
    btn.disabled = true;

    try {
        const { queued } = await queueBulkEmail(confirmed.map(b => b.id), subject, body);
        closeModal('bulkEmailModal');
        showToast(`${queued} email${queued !== 1 ? 's' : ''} queued and sending.`);
    } catch (e) {
        showToast('Failed to queue emails: ' + e.message, 'error');
    } finally {
        btn.innerHTML = originalContent;
        btn.disabled = false;
    }
};

// Email Logic
export function openEmailModal(id) {
    const targetId = (typeof id === 'string') ? id : currentId;
    const item = allBookings.find(b => b.id === targetId);
    if (!item) return;

    const ownerName = item.owner_name || item.owner || '';
    document.getElementById('emailBookingId').value = targetId;
    document.getElementById('emailSubject').value = `Regarding your booking (${targetId})`;
    document.getElementById('emailBody').value = `Hi ${ownerName.split(' ')[0] || 'there'},\n\n`;

    document.getElementById('emailComposeModal').classList.remove('opacity-0', 'pointer-events-none');
}

export async function sendSystemEmail(btn) {
    const originalText = btn.innerText;
    const id = document.getElementById('emailBookingId').value;
    const subject = document.getElementById('emailSubject').value;
    const body = document.getElementById('emailBody').value;

    if (!subject || !body) {
        showToast("Please fill in subject and message.", 'error');
        return;
    }

    btn.innerText = "Sending...";
    btn.disabled = true;

    try {
        await sendEmail(id, subject, body);
        closeModal('emailComposeModal');
        showToast("Email queued.");
    } catch (e) {
        showToast("Error sending email: " + e.message, 'error');
    } finally {
        btn.innerText = originalText;
        btn.disabled = false;
    }
}

// Rejection & Confirmation Modal
export function confirmRejection() {
    const id = document.getElementById('rejectBookingId').value;
    const reason = document.getElementById('rejectReason').value;
    closeModal('rejectReasonModal');
    updateStatus(id, 'Rejected', reason);
}

function showConfirmModalLocal(id) {
    const booking = allBookings.find(b => b.id === id);
    if (!booking) return;

    const businessNameEl = document.getElementById('confirmBusinessName');
    if (businessNameEl) {
        businessNameEl.innerText = booking.business_name || booking.business || 'Unknown Business';
    }

    const isFree = booking.is_resident === true ||
        booking.is_charity === 'Charity' ||
        booking.is_charity === 'Not for profit';

    const recEl = document.getElementById('confirmRecommendation');
    if (isFree) {
        const reasons = [];
        if (booking.is_resident) reasons.push('Resident');
        if (booking.is_charity === 'Charity') reasons.push('Charity');
        if (booking.is_charity === 'Not for profit') reasons.push('Not for profit');
        recEl.innerHTML = "💡 Recommendation: <b>Free</b> (" + reasons.join(' & ') + ")";
        recEl.className = "mb-4 p-3 bg-blue-50 text-blue-800 text-sm rounded border border-blue-200";
    } else {
        recEl.innerHTML = "💡 Recommendation: <b>Chargeable</b> (Standard Trading Stall)";
        recEl.className = "mb-4 p-3 bg-green-50 text-green-800 text-sm rounded border border-green-200";
    }

    document.getElementById('confirmBookingId').value = id;
    const costInput = document.getElementById('confirmCostInput');
    // Calculate cost
    const prefix = booking.instance_prefix || CONFIG.INSTANCE_MAP['DEV'];
    let cost = 0;
    if (booking.stall_cost !== undefined && booking.stall_cost !== null) {
        cost = parseFloat(booking.stall_cost);
    } else {
        cost = getStallCost(prefix);
    }
    if (costInput) {
        costInput.value = cost.toFixed(2);
    }
    document.getElementById('confirmTypeModal').classList.remove('opacity-0', 'pointer-events-none');
}

export function finalizeConfirm(isChargeable) {
    const id = document.getElementById('confirmBookingId').value;
    // Read the (possibly edited) cost from the input. Deliberately NOT
    // `parseFloat(...) || null` — that would silently turn a genuine "0.00"
    // entry into null (0 is falsy), which matters now: an explicit £0
    // override must be treated as free, not fall through to a config
    // default.
    const costInput = document.getElementById('confirmCostInput');
    const rawCost = costInput ? costInput.value : '';
    const parsedCost = parseFloat(rawCost);
    const overrideCost = (rawCost !== '' && !isNaN(parsedCost)) ? parsedCost : null;
    closeModal('confirmTypeModal');

    // Free (admin's explicit choice) OR an explicit £0 cost both skip Stripe
    // entirely and go straight to Confirmed, exactly as today. Otherwise,
    // a chargeable booking immediately gets a Stripe Checkout Session and
    // moves to Payment Requested — there's no separate deliberate step in
    // between anymore.
    const isFree = !isChargeable || overrideCost === 0;
    if (isFree) {
        updateStatus(id, 'Confirmed', null, false, overrideCost);
    } else {
        confirmChargeableAndRequestPayment(id, overrideCost);
    }
}

/**
 * Chargeable-confirm path: resolves the final cost, then immediately
 * creates a Stripe Checkout Session and emails the stallholder (the Edge
 * Function itself writes the new status, 'Payment Requested', once Stripe
 * confirms the session was created — so a Stripe/email failure leaves the
 * booking exactly where it was, not stuck halfway).
 */
async function confirmChargeableAndRequestPayment(id, overrideCost) {
    const booking = allBookings.find(b => b.id === id);
    const prefix = (booking && booking.instance_prefix) || CONFIG.INSTANCE_MAP['DEV'];
    let cost = overrideCost;
    if (cost === null || cost === undefined || isNaN(cost)) {
        cost = (booking && booking.stall_cost !== undefined && booking.stall_cost !== null)
            ? parseFloat(booking.stall_cost)
            : getStallCost(prefix);
    }
    try {
        await requestPayment(id, cost);
        if (booking) { booking.stall_cost = cost; booking.status = 'Payment Requested'; }
        moveCardToStatus(id, 'Payment Requested');
        showToast('Booking confirmed — payment request sent.');
        if (currentId === id) openDetails(id);
    } catch (e) {
        showToast('Failed to send payment request: ' + e.message, 'error');
    }
}

/**
 * "Resend Payment Request" — recreates a Stripe Checkout Session server-side
 * and re-emails the stallholder. The Edge Function itself writes the status
 * ('Payment Requested', unchanged here), so this just refreshes the local
 * cache/card position rather than going through sharedUpdateStatus.
 */
async function runPaymentAction(id, action, successMessage) {
    try {
        await action(id);
        const idx = allBookings.findIndex(b => b.id === id);
        if (idx > -1) allBookings[idx].status = 'Payment Requested';
        moveCardToStatus(id, 'Payment Requested');
        showToast(successMessage);
        if (currentId === id) openDetails(id);
    } catch (e) {
        showToast('Failed: ' + e.message, 'error');
    }
}

export function resendPaymentRequestAction(id) {
    const targetId = id || currentId;
    return runPaymentAction(targetId, resendPaymentRequest, 'Payment request resent.');
}

function moveCardToStatus(id, status) {
    const card = document.getElementById(id);
    if (!card) return;
    const targetCol = document.getElementById(`col-${status}`);
    if (targetCol && card.parentNode !== targetCol) targetCol.appendChild(card);
    card.className = card.className.replace(/border-\w+-500/, '').replace('border-yellow-400', '');
    card.classList.add(cardBorderClass(status));
    updateCounts();
}

window.cancelDrag = cancelDrag; // expose

