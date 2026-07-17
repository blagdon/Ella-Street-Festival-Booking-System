import { fetchKanbanData, updateBookingStatus, addNote, sendEmail, queueBulkEmail, requestPayment, resendPaymentRequest } from './api.js';
import { sharedUpdateStatus, populateDetailPane } from './shared.js';
import { showToast, renderInstanceBadge, showConfirm } from './ui.js';
import { escapeHtml, sortBookings } from './utils.js';
import { CONFIG, getStallCost } from './config.js';

let allBookings = [];
let currentId = null;

export function initSummary() {
    renderInstanceBadge('pageInstanceBadge');
    loadData();
}

async function loadData() {
    const tbody = document.getElementById('tableBody');
    tbody.innerHTML = '<tr><td colspan="7" class="px-6 py-10 text-center text-gray-500 animate-pulse">Loading bookings...</td></tr>';

    try {
        const currentInstance = localStorage.getItem('ESF_INSTANCE') || 'DEV';
        const data = await fetchKanbanData(currentInstance);
        allBookings = data;
        renderTable(data);
    } catch (err) {
        tbody.innerHTML = `<tr><td colspan="7" class="px-6 py-4 text-center text-red-500 font-bold">Error: ${escapeHtml(err.message)}</td></tr>`;
    }
}

function renderTable(data) {
    const tbody = document.getElementById('tableBody');
    const cardContainer = document.getElementById('cardContainer');
    const countEl = document.getElementById('recordCount');

    tbody.innerHTML = '';
    cardContainer.innerHTML = '';
    countEl.innerText = `${data.length} records found`;

    if (data.length === 0) {
        tbody.innerHTML = `<tr><td colspan="7" class="px-6 py-10 text-center text-gray-400">No bookings found for this instance.</td></tr>`;
        cardContainer.innerHTML = `<div class="text-center py-10 text-gray-400">No bookings found for this instance.</div>`;
        return;
    }

    data.forEach(item => {
        // DESKTOP: Table Row
        const tr = document.createElement('tr');
        tr.className = 'hover-row border-b border-gray-100 last:border-0';
        tr.onclick = () => openDetails(item.id);

        const statusClass = (CONFIG.UI && CONFIG.UI.STATUS_COLORS && CONFIG.UI.STATUS_COLORS[item.status])
            || "bg-gray-100 text-gray-800";

        tr.innerHTML = `
            <td class="px-6 py-4 whitespace-nowrap text-xs font-mono text-gray-400">${escapeHtml(item.id)}</td>
            <td class="px-6 py-4 whitespace-nowrap"><span class="px-2 inline-flex text-xs leading-5 font-semibold rounded-full ${statusClass}">${escapeHtml(item.status)}</span></td>
            <td class="px-6 py-4 whitespace-nowrap font-medium text-gray-900 text-sm">${escapeHtml(item.business_name || item.business)}</td>
            <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                <div class="font-bold text-gray-700">${escapeHtml(item.owner_name || item.owner)}</div>
                <div class="text-xs text-gray-400">${escapeHtml(item.email)}</div>
            </td>
            <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-500">${escapeHtml(item.category || '-')}</td>
            <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-500">${(item.power_required || item.power) === 'No power' ? 'No' : '<span class="text-yellow-500 text-lg">\u26A1</span>'}</td>
            <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-500 font-mono">${escapeHtml(item.location_display || '-')}</td>
        `;
        tbody.appendChild(tr);

        // MOBILE: Card
        const cardWrapper = document.createElement('div');
        cardWrapper.className = 'relative';
        cardWrapper.style.overflow = 'hidden';
        cardWrapper.style.borderRadius = '0.5rem';

        const leftAction = document.createElement('div');
        leftAction.className = 'swipe-actions left';
        leftAction.innerHTML = `
        <div class="text-center">
            <svg class="w-6 h-6 mx-auto mb-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"></path>
            </svg>
            <div>Confirm</div>
        </div>
        `;

        const rightAction = document.createElement('div');
        rightAction.className = 'swipe-actions right';
        rightAction.innerHTML = `
        <div class="text-center">
            <svg class="w-6 h-6 mx-auto mb-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path>
            </svg>
            <div>Reject</div>
        </div>
        `;

        const card = document.createElement('div');
        card.className = 'swipe-card bg-white p-4 rounded-lg border border-gray-200 shadow-sm';
        card.style.position = 'relative';
        card.style.zIndex = '2';
        card.dataset.bookingId = item.id;

        const powerIcon = (item.power_required || item.power) !== 'No power' ? '<span class="text-yellow-500 text-sm">\u26A1 Power</span>' : '';

        card.innerHTML = `
            <div class="flex justify-between items-start mb-3">
                <div class="flex-1">
                    <div class="font-bold text-gray-900 text-base mb-1">${escapeHtml(item.business_name || item.business)}</div>
                    <div class="text-sm text-gray-600">${escapeHtml(item.owner_name || item.owner)}</div>
                </div>
                <span class="px-2 py-1 inline-flex text-xs leading-5 font-semibold rounded-full ${statusClass} ml-2 shrink-0">${escapeHtml(item.status)}</span>
            </div>
            <div class="space-y-1.5 text-sm text-gray-600">
                <div class="flex items-center">
                    <svg class="w-4 h-4 mr-2 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"></path></svg>
                    <span class="text-xs truncate">${escapeHtml(item.email)}</span>
                </div>
                <div class="flex items-center justify-between">
                    <div class="flex items-center">
                        <svg class="w-4 h-4 mr-2 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z"></path></svg>
                        <span class="text-xs text-gray-500">${escapeHtml(item.category || 'Uncategorized')}</span>
                    </div>
                    ${powerIcon}
                </div>
                <div class="flex items-center justify-between">
                    <div class="flex items-center">
                        <svg class="w-4 h-4 mr-2 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z"></path></svg>
                        <span class="text-xs font-mono ${item.location_display ? 'text-blue-600 font-semibold' : 'text-gray-400'}">${escapeHtml(item.location_display || 'No location')}</span>
                    </div>
                    <span class="text-xs font-mono text-gray-400">${escapeHtml(item.id)}</span>
                </div>
            </div>
        `;

        card.addEventListener('click', (e) => {
            if (!card.classList.contains('swiping')) {
                openDetails(item.id);
            }
        });

        setupSwipeActions(card, item.id, leftAction, rightAction);

        cardWrapper.appendChild(leftAction);
        cardWrapper.appendChild(rightAction);
        cardWrapper.appendChild(card);
        cardContainer.appendChild(cardWrapper);
    });
}

function setupSwipeActions(card, bookingId, leftAction, rightAction) {
    let startX = 0;
    let currentX = 0;
    let isDragging = false;
    const threshold = 80;

    card.addEventListener('touchstart', (e) => {
        startX = e.touches[0].clientX;
        currentX = startX;
        isDragging = true;
        card.classList.add('swiping');
    });

    card.addEventListener('touchmove', (e) => {
        if (!isDragging) return;

        currentX = e.touches[0].clientX;
        const diff = currentX - startX;

        // Limit swipe distance
        const maxSwipe = 120;
        const constrainedDiff = Math.max(-maxSwipe, Math.min(maxSwipe, diff));

        card.style.transform = `translateX(${constrainedDiff}px)`;

        // Show visual feedback
        if (constrainedDiff > threshold) {
            leftAction.style.opacity = '1';
        } else {
            leftAction.style.opacity = '0.5';
        }

        if (constrainedDiff < -threshold) {
            rightAction.style.opacity = '1';
        } else {
            rightAction.style.opacity = '0.5';
        }
    });

    card.addEventListener('touchend', (e) => {
        if (!isDragging) return;

        const diff = currentX - startX;

        card.classList.remove('swiping');
        isDragging = false;

        // Trigger actions
        if (diff > threshold) {
            // Swipe right -> Confirm
            card.style.transform = 'translateX(100%)';
            setTimeout(() => {
                currentId = bookingId;
                window.changeStatus('Confirmed');
            }, 200);
        } else if (diff < -threshold) {
            // Swipe left -> Reject
            card.style.transform = 'translateX(-100%)';
            setTimeout(() => {
                currentId = bookingId;
                window.changeStatus('Rejected');
            }, 200);
        } else {
            // Reset
            card.style.transform = 'translateX(0)';
        }
    });
}

// Search & Filter
let currentSortField = null;
let currentSortDir = 'asc';

window.filterTable = function () {
    const term = document.getElementById('searchInput').value.toLowerCase();
    const statusVal = document.getElementById('statusFilter').value;
    let filtered = allBookings.filter(b => {
        const matchStatus = (statusVal === 'All') || b.status === statusVal;
        const matchSearch = (b.business_name || b.business || "").toLowerCase().includes(term) ||
            (b.owner_name || b.owner || "").toLowerCase().includes(term) ||
            (b.id || "").toLowerCase().includes(term) ||
            (b.email || "").toLowerCase().includes(term);
        return matchStatus && matchSearch;
    });
    if (currentSortField === 'id' || currentSortField === 'business') {
        // Shared helper correctly falls back business_name || business,
        // unlike the bare-field compare below.
        filtered = sortBookings(filtered, currentSortField, currentSortDir);
    } else if (currentSortField) {
        filtered.sort((a, b) => {
            const va = (a[currentSortField] || "").toString().toLowerCase();
            const vb = (b[currentSortField] || "").toString().toLowerCase();
            return currentSortDir === 'asc' ? va.localeCompare(vb) : vb.localeCompare(va);
        });
    }
    renderTable(filtered);
}

window.sortTable = function (field) {
    if (currentSortField === field) {
        currentSortDir = (currentSortDir === 'asc') ? 'desc' : 'asc';
    } else {
        currentSortField = field;
        currentSortDir = 'asc';
    }
    syncSortUI();
    window.filterTable();
}

// Sets sort field/direction from the "Sort:" dropdown (id-asc, business-desc, etc).
window.setSortOption = function (value) {
    const [field, direction] = value.split('-');
    currentSortField = field;
    currentSortDir = direction;
    syncSortUI();
    window.filterTable();
}

function syncSortUI() {
    ['id', 'status', 'business', 'owner', 'category'].forEach(f => {
        const el = document.getElementById('sort-' + f);
        if (el) el.innerText = (f === currentSortField) ? (currentSortDir === 'asc' ? '\u25B2' : '\u25BC') : '';
    });
    const sortSelect = document.getElementById('sortSelect');
    if (sortSelect && (currentSortField === 'id' || currentSortField === 'business')) {
        sortSelect.value = `${currentSortField}-${currentSortDir}`;
    }
}

// Details Pane
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

    const globalInstance = localStorage.getItem('ESF_INSTANCE') || 'DEV';
    const bookingInstance = item.instance_prefix || '';
    const isFoodBooking = globalInstance === 'FOOD' || bookingInstance.includes('FOOD');

    // Mobile HCC button
    const hccMobileBtn = document.getElementById('hccChecksMobileBtn');
    if (hccMobileBtn) {
        if (isFoodBooking) {
            hccMobileBtn.style.display = 'block';
            hccMobileBtn.classList.remove('hcc-hidden');
            hccMobileBtn.classList.add('hcc-visible');
        } else {
            hccMobileBtn.style.display = 'none';
            hccMobileBtn.classList.add('hcc-hidden');
            hccMobileBtn.classList.remove('hcc-visible');
        }
    }
}

window.closeModal = function (id) {
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

window.saveNote = async function () {
    const note = document.getElementById('d-notes').value;
    try {
        await addNote(currentId, note);
        showToast("Note saved");
        const idx = allBookings.findIndex(b => b.id === currentId);
        if (idx > -1) allBookings[idx].admin_notes = note;
    } catch (e) { showToast("Error saving note: " + e.message, 'error'); }
}

async function promptStatusChange(newStatus) {
    if (newStatus === 'Confirmed') {
        window.closeModal('detailModal');
        showConfirmModalLocal(currentId);
        return;
    }

    showConfirm(
        "Confirm Status Change",
        `Are you sure you want to mark this as ${newStatus}?`,
        async () => {
            try {
                if (newStatus === 'Rejected') {
                    window.closeModal('detailModal');
                    document.getElementById('rejectBookingId').value = currentId;
                    document.getElementById('rejectReason').value = "";
                    document.getElementById('rejectReasonModal').classList.remove('opacity-0', 'pointer-events-none');
                } else {
                    await updateStatus(currentId, newStatus);
                    window.closeModal('detailModal');
                    window.filterTable();
                }
            } catch (e) { showToast("Error changing status: " + e.message, 'error'); }
        }
    );
}

window.changeStatus = function (newStatus) {
    promptStatusChange(newStatus);
}

// Confirmation 
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
        recEl.innerHTML = "💡 Recommendation: <b>Free</b> (" + escapeHtml(reasons.join(' & ')) + ")";
        recEl.className = "mb-4 p-3 bg-blue-50 text-blue-800 text-sm rounded border border-blue-200";
    } else {
        recEl.innerHTML = "💡 Recommendation: <b>Chargeable</b> (Standard Trading Stall)";
        recEl.className = "mb-4 p-3 bg-green-50 text-green-800 text-sm rounded border border-green-200";
    }

    document.getElementById('confirmBookingId').value = id;
    const costInput = document.getElementById('confirmCostInput');
    // Simplified cost logic
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

window.finalizeConfirm = function (isChargeable) {
    const id = document.getElementById('confirmBookingId').value;
    // Deliberately NOT `parseFloat(...) || null` — that would silently turn
    // a genuine "0.00" entry into null (0 is falsy), and an explicit £0
    // override must be treated as free, not fall through to a config default.
    const costInput = document.getElementById('confirmCostInput');
    const rawCost = costInput ? costInput.value : '';
    const parsedCost = parseFloat(rawCost);
    const overrideCost = (rawCost !== '' && !isNaN(parsedCost)) ? parsedCost : null;
    window.closeModal('confirmTypeModal');

    // Free (admin's explicit choice) OR an explicit £0 cost both skip
    // Stripe entirely and go straight to Confirmed, exactly as today.
    // Otherwise, a chargeable booking immediately gets a Stripe Checkout
    // Session and moves to Payment Requested — no separate step in between.
    const isFree = !isChargeable || overrideCost === 0;
    if (isFree) {
        updateStatus(id, 'Confirmed');
    } else {
        confirmChargeableAndRequestPayment(id, overrideCost);
    }
}

/**
 * Chargeable-confirm path: resolves the final cost, then immediately
 * creates a Stripe Checkout Session and emails the stallholder (mirrors
 * js/kanban.js's equivalent). The Edge Function writes the new status
 * ('Payment Requested') itself once Stripe confirms the session, so a
 * Stripe/email failure leaves the booking exactly where it was.
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
        showToast('Booking confirmed — payment request sent.');
        window.filterTable();
        if (currentId === id) openDetails(id);
    } catch (e) {
        showToast('Failed to send payment request: ' + e.message, 'error');
    }
}

/**
 * "Resend Payment Request" — mirrors js/kanban.js's equivalent. The Edge
 * Function already writes the new status server-side, so this just
 * refreshes the local cache/table rather than going through
 * sharedUpdateStatus.
 */
async function runPaymentAction(id, action, newStatus, successMessage) {
    try {
        await action(id);
        const idx = allBookings.findIndex(b => b.id === id);
        if (idx > -1) allBookings[idx].status = newStatus;
        showToast(successMessage);
        window.filterTable();
        if (currentId === id) openDetails(id);
    } catch (e) {
        showToast('Failed: ' + e.message, 'error');
    }
}

window.resendPaymentRequestAction = function (id) {
    return runPaymentAction(id || currentId, resendPaymentRequest, 'Payment Requested', 'Payment request resent.');
}

window.confirmRejection = function () {
    const id = document.getElementById('rejectBookingId').value;
    const reason = document.getElementById('rejectReason').value;
    window.closeModal('rejectReasonModal');
    updateStatus(id, 'Rejected', reason);
}

async function updateStatus(id, status, reason = null) {
    await sharedUpdateStatus(id, status, allBookings, {
        reason: reason,
        onSuccess: () => { window.filterTable(); },
        onError: () => { }
    });
}

// Emails
window.openEmailModal = function (id) {
    const targetId = (typeof id === 'string') ? id : currentId;
    const item = allBookings.find(b => b.id === targetId);
    if (!item) return;

    const ownerName = item.owner_name || item.owner || '';
    document.getElementById('emailBookingId').value = targetId;
    document.getElementById('emailSubject').value = `Regarding your booking (${targetId})`;
    document.getElementById('emailBody').value = `Hi ${ownerName.split(' ')[0] || 'there'},\n\n`;

    document.getElementById('emailComposeModal').classList.remove('opacity-0', 'pointer-events-none');
}

window.sendSystemEmail = async function (btn) {
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
        window.closeModal('emailComposeModal');
        showToast("Email queued.");
    } catch (e) {
        showToast("Error sending email: " + e.message, 'error');
    } finally {
        btn.innerText = originalText;
        btn.disabled = false;
    }
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
window.emailAllConfirmed = function () {
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
window.sendBulkEmail = async function (btn) {
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
        window.closeModal('bulkEmailModal');
        showToast(`${queued} email${queued !== 1 ? 's' : ''} queued and sending.`);
    } catch (e) {
        showToast('Failed to queue emails: ' + e.message, 'error');
    } finally {
        btn.innerHTML = originalContent;
        btn.disabled = false;
    }
};

/**
 * Exports the currently filtered booking list as a CSV file.
 */
window.exportCSV = function () {
    // Re-apply the current filter to get the visible rows
    const statusFilter = document.getElementById('statusFilter')?.value || 'All';
    const searchTerm = (document.getElementById('searchInput')?.value || '').toLowerCase();

    const filtered = allBookings.filter(item => {
        const matchesStatus = statusFilter === 'All' || item.status === statusFilter;
        const searchable = [
            item.id, item.business_name, item.business,
            item.owner_name, item.owner, item.email, item.category
        ].join(' ').toLowerCase();
        return matchesStatus && searchable.includes(searchTerm);
    });

    if (filtered.length === 0) {
        showToast('No data to export.', 'info');
        return;
    }

    const escape = (val) => {
        if (val === null || val === undefined) return '';
        const str = String(val);
        return str.includes(',') || str.includes('"') || str.includes('\n')
            ? `"${str.replace(/"/g, '""')}"` : str;
    };

    const headers = ['ID', 'Status', 'Business', 'Owner', 'Email', 'Phone', 'Category', 'Stall Type', 'Power Required', 'Location', 'Stall Cost', 'Created'];
    const rows = filtered.map(b => [
        b.id,
        b.status,
        b.business_name || b.business,
        b.owner_name || b.owner,
        b.email,
        b.phone,
        b.category,
        b.stall_type,
        b.power_required || b.power,
        b.location_display || '',
        b.stall_cost || '',
        b.created_at ? new Date(b.created_at).toLocaleDateString('en-GB') : ''
    ].map(escape).join(','));

    const csv = [headers.join(','), ...rows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const instance = localStorage.getItem('ESF_INSTANCE') || 'DEV';
    a.href = url;
    a.download = `ESF26_Bookings_${instance}_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    showToast(`Exported ${filtered.length} records.`);
}
