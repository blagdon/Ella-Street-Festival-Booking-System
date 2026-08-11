// @ts-check
import { fetchPayments, updatePayment, resendPaymentRequest, recordBankTransferPayment, recordRefund, refundStripePayment, sendEmail, sendBookingSms, LIST_CAP } from './api.js';
import { manualSendPaymentReminder } from './shared.js';
import { getEmailFromTemplate, getSmsFromTemplate } from './message-templates.js';
import { showToast, showConfirm, notifyIfTruncated, registerModalClose, trapFocus } from './ui.js';
import { escapeHtml, formatCurrency } from './utils.js';
import { CONFIG, getActiveBookingPrefix } from './config.js';

let allRecords = [];
// Tracked separately from btn-save-refund's own disabled state: closeRefundModal
// (Cancel / overlay click) checks this specifically, since the button is only
// re-enabled in performRefund's `finally`, which runs AFTER a successful
// close already needs to have happened.
let refundInFlight = false;

// One registerModalClose() unregister function per modal on this page - set
// when opened, called (and cleared) only on the path where the modal
// actually closes. See ui.js's registerModalClose for why Escape must call
// each modal's real close function rather than a raw classList toggle.
let unregisterEditModalEsc = null;
let unregisterBankTransferModalEsc = null;
let unregisterRefundModalEsc = null;
let unregisterResendPaymentModalEsc = null;
let releaseEditModalFocus = null;
let releaseBankTransferModalFocus = null;
let releaseRefundModalFocus = null;
let releaseResendPaymentModalFocus = null;

export async function initPayments() {
    setupEventListeners();
    await loadData();
}

function setupEventListeners() {
    // Top bar actions
    document.getElementById('btn-refresh')?.addEventListener('click', loadData);
    document.getElementById('filter-status')?.addEventListener('change', renderTable);
    document.getElementById('search-input')?.addEventListener('keyup', renderTable);
    document.getElementById('btn-export-csv')?.addEventListener('click', exportCSV);

    // Modal actions
    document.getElementById('modal-overlay')?.addEventListener('click', closeModal);
    document.getElementById('btn-cancel-payment')?.addEventListener('click', closeModal);
    document.getElementById('btn-save-payment')?.addEventListener('click', savePayment);

    document.getElementById('bank-transfer-modal-overlay')?.addEventListener('click', closeBankTransferModal);
    document.getElementById('btn-cancel-bank-transfer')?.addEventListener('click', closeBankTransferModal);
    document.getElementById('btn-save-bank-transfer')?.addEventListener('click', saveBankTransferPayment);

    document.getElementById('resend-payment-modal-overlay')?.addEventListener('click', closeResendPaymentModal);
    document.getElementById('btn-cancel-resend-payment')?.addEventListener('click', closeResendPaymentModal);
    document.getElementById('btn-save-resend-payment')?.addEventListener('click', saveResendPayment);

    document.getElementById('refund-modal-overlay')?.addEventListener('click', closeRefundModal);
    document.getElementById('btn-cancel-refund')?.addEventListener('click', closeRefundModal);
    document.getElementById('btn-save-refund')?.addEventListener('click', saveRefund);

    // Event delegation for dynamic table/card buttons
    document.body.addEventListener('click', (e) => {
        const target = /** @type {Element} */ (e.target);

        const reminderBtn = target.closest('.btn-reminder');
        if (reminderBtn instanceof HTMLElement) {
            sendReminder(reminderBtn.dataset.id);
            return;
        }

        const editBtn = target.closest('.btn-edit');
        if (editBtn instanceof HTMLElement) {
            openEditModal(editBtn.dataset.id);
            return;
        }

        const resendBtn = target.closest('.btn-resend-payment');
        if (resendBtn instanceof HTMLElement) {
            openResendPaymentModal(resendBtn.dataset.id);
            return;
        }

        const bankTransferBtn = target.closest('.btn-record-bank-transfer');
        if (bankTransferBtn instanceof HTMLElement) {
            openBankTransferModal(bankTransferBtn.dataset.id);
            return;
        }

        const refundBtn = target.closest('.btn-record-refund');
        if (refundBtn instanceof HTMLElement) {
            openRefundModal(refundBtn.dataset.id);
            return;
        }
    });
}

async function loadData() {
    try {
        const currentInstance = localStorage.getItem('ESF_INSTANCE') || 'DEV';
        allRecords = await fetchPayments(currentInstance);
        notifyIfTruncated(allRecords, LIST_CAP, 'bookings — Paid/Outstanding totals only cover these');
        renderTable();
    } catch (err) {
        console.error(err);
        showToast("Failed to load payments: " + err.message, 'error');
    }
}

/**
 * The one place that decides which records the current filter selects.
 *
 * This used to be duplicated between renderTable and exportCSV, and the two
 * copies drifted: the export's copy only ever knew 'paid' and 'unpaid', so
 * picking any of the three filters added later ('awaiting', 'needs-refund',
 * 'refunded') matched NOTHING and Export reported "No data to export" while
 * the table on screen was visibly full of rows. Its 'unpaid' branch had also
 * missed the `!r.awaitingPayment` clause, so the export silently included
 * mid-Stripe-flow bookings the table was excluding.
 *
 * Both are the same failure: an export that doesn't match what the admin is
 * looking at. Keep this shared - if a filter is added to the dropdown, it
 * needs handling here once, not once per consumer.
 */
function matchesFilters(r, statusFilter, searchTerm) {
    const matchesStatus = (statusFilter === 'all') ||
        (statusFilter === 'paid' && r.paid) ||
        (statusFilter === 'unpaid' && !r.paid && !r.awaitingPayment) ||
        (statusFilter === 'awaiting' && r.awaitingPayment) ||
        (statusFilter === 'needs-refund' && r.needsRefundFollowUp) ||
        (statusFilter === 'refunded' && r.refunded);
    const matchesSearch = (r.business || r.business_name || '').toLowerCase().includes(searchTerm) ||
        (r.owner || r.owner_name || '').toLowerCase().includes(searchTerm);
    return matchesStatus && matchesSearch;
}

/**
 * Reconciliation totals for a set of payment records — shared by the header
 * stat tiles (over whatever's currently filtered) and exportNetBilledSummary
 * (over every record for the loaded instance, regardless of filter), so the
 * two can never drift apart into reporting different numbers for the same
 * underlying data.
 *
 * `paid` deliberately stays true after a refund - the payment really did
 * happen, and the refund is separate state layered on top of it (see the
 * refund migration's header for why). The consequence is that Paid must net
 * refunds out HERE, explicitly: without this, a fully refunded booking goes
 * on inflating the headline figure forever, so the dashboard reports money
 * the festival no longer holds. rpc_record_refund caps a refund at the
 * booking cost, so a row can never contribute a negative amount.
 */
function computeTotals(records) {
    const totalPaid = records.reduce((sum, r) =>
        sum + (r.paid ? (parseFloat(r.stall_cost) || 0) - (parseFloat(r.refund_amount) || 0) : 0), 0);
    const totalRefunded = records.reduce((sum, r) => sum + (parseFloat(r.refund_amount) || 0), 0);
    // A refunded booking keeps paid = true, so it is already excluded from
    // Outstanding - correct, since a refunded cancellation is not money owed.
    //
    // Includes r.awaitingPayment (status 'Payment Requested', no payments
    // row yet - see fetchPayments()'s comment on why those are synthesised
    // separately) alongside unpaid 'Confirmed' rows. Previously only the
    // latter counted, so a booking the table itself badges "AWAITING
    // PAYMENT" was invisible in this total - confirmed live during the RC
    // operational certification (Finding 7): a real £45 awaiting-payment
    // booking showed £0.00 Pending here while Statistics' own "Awaiting
    // Payment" figure correctly showed £45.00 for the same booking.
    // The two statuses are mutually exclusive (awaitingPayment only ever
    // applies to 'Payment Requested' rows), so this can't double-count.
    const totalOutstanding = records.reduce((sum, r) => sum + (!r.paid && (r.status === 'Confirmed' || r.awaitingPayment) ? (parseFloat(r.stall_cost) || 0) : 0), 0);
    return { totalPaid, totalRefunded, totalOutstanding };
}

function renderTable() {
    const statusFilter = (/** @type {HTMLSelectElement} */ (document.getElementById('filter-status'))).value;
    const searchTerm = (/** @type {HTMLInputElement} */ (document.getElementById('search-input'))).value.toLowerCase();
    const tbody = document.getElementById('payments-body');
    const mobileContainer = document.getElementById('mobile-cards');

    // Filter Data
    const filtered = allRecords.filter(r => matchesFilters(r, statusFilter, searchTerm));

    const { totalPaid, totalRefunded, totalOutstanding } = computeTotals(filtered);

    // Update Totals Display
    const elPaid = document.getElementById('total-paid');
    const elOut = document.getElementById('total-outstanding');
    if (elPaid) elPaid.innerText = formatCurrency(totalPaid);
    if (elOut) elOut.innerText = formatCurrency(totalOutstanding);

    // Refunded is shown only when there is something to show. Netting it out
    // of Paid above would otherwise make money silently disappear from the
    // header with nothing accounting for where it went.
    const elRefunded = document.getElementById('total-refunded');
    const elRefundedWrap = document.getElementById('total-refunded-wrap');
    if (elRefunded) elRefunded.innerText = formatCurrency(totalRefunded);
    if (elRefundedWrap) elRefundedWrap.classList.toggle('hidden', totalRefunded === 0);

    // Update Count
    const elCount = document.getElementById('count-display');
    if (elCount) elCount.innerText = String(filtered.length);

    // Build Desktop Table HTML
    if (tbody) {
        tbody.innerHTML = filtered.map(r => {
            let paidClass = r.paid ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800';
            let paidText = r.paid ? 'PAID' : 'UNPAID';
            if (r.awaitingPayment) {
                paidClass = 'bg-indigo-100 text-indigo-800';
                paidText = 'AWAITING PAYMENT';
            }
            // Refunded supersedes PAID: the money came back, so showing a
            // bare "PAID" badge would actively misrepresent the current state.
            if (r.refunded) {
                paidClass = 'bg-amber-100 text-amber-800';
                paidText = 'REFUNDED';
            }

            // Get Status Color
            let statusColor = 'bg-gray-100 text-gray-800';
            if (CONFIG.UI && CONFIG.UI.STATUS_COLORS && CONFIG.UI.STATUS_COLORS[r.status]) {
                statusColor = CONFIG.UI.STATUS_COLORS[r.status];
            } else {
                // Fallback if config not fully loaded or structure different
                if (r.status === 'Confirmed') statusColor = 'bg-green-100 text-green-800';
                else if (r.status === 'Pending') statusColor = 'bg-yellow-100 text-yellow-800';
            }

            return `
            <tr>
                <td class="px-6 py-4 whitespace-nowrap">
                    <div class="flex flex-col items-start gap-1">
                        <span class="px-2 inline-flex text-[10px] md:text-xs leading-5 font-semibold rounded-full ${statusColor}">
                            ${escapeHtml(r.status)}
                        </span>
                        <span class="text-xs font-mono text-gray-500">
                            ${escapeHtml(r.id)}
                        </span>
                    </div>
                </td>
                <td class="px-6 py-4 whitespace-nowrap">
                    <div class="text-sm font-medium text-gray-900">${escapeHtml(r.business || r.business_name)}</div>
                    <div class="text-sm text-gray-500">${escapeHtml(r.owner || r.owner_name)}</div>
                </td>
                <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-900 font-mono">
                    ${formatCurrency(r.stall_cost)}
                </td>
                <td class="px-6 py-4 whitespace-nowrap text-center">
                    <span class="px-2 inline-flex text-xs leading-5 font-semibold rounded-full ${paidClass}">
                        ${paidText}
                    </span>
                    ${r.needsRefundFollowUp ? `
                        <div class="mt-1 text-[10px] font-bold text-amber-700" title="This booking was cancelled after payment was taken. Decide whether to refund, then record it here.">
                            ⚠ CANCELLED — REFUND?
                        </div>` : ''}
                    ${r.refunded ? `
                        <div class="mt-1 text-[10px] text-gray-500">
                            ${formatCurrency(r.refund_amount)} on ${escapeHtml(r.refunded_at ? new Date(r.refunded_at).toLocaleDateString('en-GB') : '')}
                        </div>` : ''}
                </td>
                <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                    ${r.date_paid ? new Date(r.date_paid).toLocaleDateString() : '-'}
                </td>
                <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                    ${escapeHtml(r.bank_ref || '-')}
                </td>
                <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                    ${escapeHtml((r.refunded ? r.refunded_by : r.editor) || '-')}
                </td>
                <td class="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                    ${r.awaitingPayment
                    ? (r.status === 'Payment Requested' ? `
                        <div class="flex flex-col items-end gap-1.5">
                            <button data-id="${escapeHtml(r.id)}" class="btn-resend-payment text-indigo-600 hover:text-indigo-900 font-bold">Resend Payment Link</button>
                            <button data-id="${escapeHtml(r.id)}" class="btn-record-bank-transfer text-green-600 hover:text-green-900 font-bold">Record Bank Transfer</button>
                        </div>
                    ` : '')
                    : `
                        <div class="flex items-center justify-end gap-3">
                            ${!r.paid ? `<button data-id="${escapeHtml(r.id)}" class="btn-reminder text-purple-600 hover:text-purple-900 font-bold">Reminder</button>` : ''}
                            ${r.paid && !r.refunded ? `<button data-id="${escapeHtml(r.id)}" class="btn-record-refund text-amber-600 hover:text-amber-900 font-bold">Refund</button>` : ''}
                            <button data-id="${escapeHtml(r.id)}" class="btn-edit text-blue-600 hover:text-blue-900">Edit</button>
                        </div>
                    `}
                </td>
            </tr>
        `}).join('');
    }

    // Build Mobile Cards HTML
    if (mobileContainer) {
        mobileContainer.innerHTML = filtered.map(r => {
            const paidClass = r.paid ? 'paid' : (r.awaitingPayment ? 'awaiting' : 'unpaid');
            let paidBadgeClass = r.paid ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800';
            let paidText = r.paid ? 'PAID' : 'UNPAID';
            if (r.awaitingPayment) {
                paidBadgeClass = 'bg-indigo-100 text-indigo-800';
                paidText = 'AWAITING PAYMENT';
            }
            // Same supersede rule as the desktop table above.
            if (r.refunded) {
                paidBadgeClass = 'bg-amber-100 text-amber-800';
                paidText = 'REFUNDED';
            }
            let statusColor = (CONFIG.UI && CONFIG.UI.STATUS_COLORS && CONFIG.UI.STATUS_COLORS[r.status]) || 'bg-gray-100 text-gray-800';

            return `
            <div class="payment-card ${paidClass} bg-white rounded-lg border border-gray-200 p-4 shadow-sm">
                <div class="flex justify-between items-start mb-3">
                    <div class="flex-1 min-w-0">
                        <h3 class="font-bold text-gray-900 text-base mb-1 truncate">${escapeHtml(r.business || r.business_name)}</h3>
                        <p class="text-sm text-gray-600">${escapeHtml(r.owner || r.owner_name)}</p>
                    </div>
                    <span class="px-2 py-1 inline-flex text-xs leading-5 font-semibold rounded-full ${paidBadgeClass} ml-2 shrink-0">
                        ${paidText}
                    </span>
                </div>
                
                <div class="grid grid-cols-2 gap-3 mb-3">
                    <div>
                        <span class="text-xs uppercase text-gray-400 font-bold block mb-1">Amount</span>
                        <p class="text-lg font-bold text-gray-900">${formatCurrency(r.stall_cost)}</p>
                    </div>
                    <div>
                        <span class="text-xs uppercase text-gray-400 font-bold block mb-1">Status</span>
                        <span class="px-2 py-1 inline-flex text-xs leading-5 font-semibold rounded-full ${statusColor}">
                            ${escapeHtml(r.status)}
                        </span>
                    </div>
                </div>
                
                ${r.paid ? `
                <div class="grid grid-cols-2 gap-3 mb-3 text-sm">
                    <div>
                        <span class="text-xs uppercase text-gray-400 font-bold block mb-1">Date Paid</span>
                        <p class="text-gray-700">${new Date(r.date_paid).toLocaleDateString()}</p>
                    </div>
                    <div>
                        <span class="text-xs uppercase text-gray-400 font-bold block mb-1">Reference</span>
                        <p class="text-gray-700 font-mono text-xs truncate">${escapeHtml(r.bank_ref || '-')}</p>
                    </div>
                </div>
                ` : ''}
                
                <div class="flex justify-between items-center pt-3 border-t border-gray-100">
                    <span class="text-xs text-gray-400 font-mono">${escapeHtml(r.id)}</span>
                    <div class="flex gap-2">
                        ${r.awaitingPayment
                    ? (r.status === 'Payment Requested' ? `
                        <button data-id="${escapeHtml(r.id)}" class="btn-resend-payment bg-indigo-100 text-indigo-700 px-3 py-2 rounded-lg text-sm font-semibold hover:bg-indigo-200">
                            Resend Payment Link
                        </button>
                        <button data-id="${escapeHtml(r.id)}" class="btn-record-bank-transfer bg-green-100 text-green-700 px-3 py-2 rounded-lg text-sm font-semibold hover:bg-green-200">
                            Record Bank Transfer
                        </button>` : '')
                    : `
                        ${!r.paid ? `
                        <button data-id="${escapeHtml(r.id)}" class="btn-reminder bg-purple-100 text-purple-700 px-3 py-2 rounded-lg text-sm font-semibold hover:bg-purple-200">
                            Reminder
                        </button>` : ''}
                        ${r.paid && !r.refunded ? `
                        <button data-id="${escapeHtml(r.id)}" class="btn-record-refund bg-amber-100 text-amber-700 px-3 py-2 rounded-lg text-sm font-semibold hover:bg-amber-200">
                            Refund
                        </button>` : ''}
                        <button data-id="${escapeHtml(r.id)}" class="btn-edit bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-semibold hover:bg-blue-700 transition">
                            Edit Payment
                        </button>
                    `}
                    </div>
                </div>
            </div>
        `}).join('');
    }
}

function openEditModal(id) {
    const r = allRecords.find(item => item.id === id);
    if (!r) return;

    (/** @type {HTMLInputElement} */ (document.getElementById('modal-id'))).value = r.id;
    (/** @type {HTMLInputElement} */ (document.getElementById('modal-paid'))).checked = r.paid;

    // Format date for input type=date (YYYY-MM-DD)
    let dateVal = '';
    if (r.date_paid) {
        dateVal = new Date(r.date_paid).toISOString().split('T')[0];
    } else if (r.paid) {
        // Default to today if marked paid but no date set yet
        dateVal = new Date().toISOString().split('T')[0];
    }
    (/** @type {HTMLInputElement} */ (document.getElementById('modal-date'))).value = dateVal;

    (/** @type {HTMLInputElement} */ (document.getElementById('modal-ref'))).value = r.bank_ref || '';
    (/** @type {HTMLInputElement} */ (document.getElementById('modal-editor'))).value = r.editor || '';

    document.getElementById('edit-modal').classList.remove('hidden');
    unregisterEditModalEsc = registerModalClose(closeModal);
    releaseEditModalFocus = trapFocus(document.getElementById('edit-modal'));
}

function closeModal() {
    document.getElementById('edit-modal').classList.add('hidden');
    if (unregisterEditModalEsc) { unregisterEditModalEsc(); unregisterEditModalEsc = null; }
    if (releaseEditModalFocus) { releaseEditModalFocus(); releaseEditModalFocus = null; }
}

function openBankTransferModal(id) {
    const r = allRecords.find(item => item.id === id);
    if (!r) return;

    (/** @type {HTMLInputElement} */ (document.getElementById('bt-modal-id'))).value = r.id;
    document.getElementById('bt-modal-booking-display').innerText = `${r.business || r.business_name} (${r.id})`;
    document.getElementById('bt-modal-amount-display').innerText = formatCurrency(r.stall_cost);
    // Payment reference defaults to the booking ID, per spec — editable if the
    // stallholder actually used a different reference on their transfer.
    (/** @type {HTMLInputElement} */ (document.getElementById('bt-modal-reference'))).value = r.id;
    (/** @type {HTMLTextAreaElement} */ (document.getElementById('bt-modal-notes'))).value = '';
    // Reset every open so a ticked state never carries over to the next
    // booking, matching every other opt-in SMS tickbox in this app.
    const smsCb = /** @type {HTMLInputElement | null} */ (document.getElementById('btAlsoSms'));
    if (smsCb) smsCb.checked = false;

    document.getElementById('bank-transfer-modal').classList.remove('hidden');
    unregisterBankTransferModalEsc = registerModalClose(closeBankTransferModal);
    releaseBankTransferModalFocus = trapFocus(document.getElementById('bank-transfer-modal'));
}

function closeBankTransferModal() {
    document.getElementById('bank-transfer-modal').classList.add('hidden');
    if (unregisterBankTransferModalEsc) { unregisterBankTransferModalEsc(); unregisterBankTransferModalEsc = null; }
    if (releaseBankTransferModalFocus) { releaseBankTransferModalFocus(); releaseBankTransferModalFocus = null; }
}

async function saveBankTransferPayment() {
    const id = (/** @type {HTMLInputElement} */ (document.getElementById('bt-modal-id'))).value;
    const reference = (/** @type {HTMLInputElement} */ (document.getElementById('bt-modal-reference'))).value;
    const notes = (/** @type {HTMLTextAreaElement} */ (document.getElementById('bt-modal-notes'))).value;
    // Read before closeBankTransferModal() below, which would otherwise be
    // the last chance to see the tickbox's state.
    const alsoSms = !!(/** @type {HTMLInputElement | null} */ (document.getElementById('btAlsoSms')))?.checked;

    if (!reference.trim()) {
        showToast('Payment reference is required.', 'error');
        return;
    }

    const btn = /** @type {HTMLButtonElement} */ (document.getElementById('btn-save-bank-transfer'));
    btn.disabled = true;
    btn.textContent = 'Recording...';

    try {
        await recordBankTransferPayment({
            booking_id: id,
            payment_reference: reference,
            notes: notes || null
        });

        closeBankTransferModal();
        showToast('Bank transfer recorded — booking confirmed.');

        // Mirrors the outcome of a successful Stripe payment, which always
        // sends this same template from stripe-webhook after confirming —
        // a bank-transfer confirmation should look identical to the
        // stallholder. Wrapped separately: the payment/confirmation itself
        // already succeeded by this point, so an email failure here is a
        // lesser, distinct problem and must not read as "the payment wasn't
        // recorded."
        try {
            const booking = allRecords.find(item => item.id === id);
            if (booking) {
                const { subject, body } = await getEmailFromTemplate('confirmed_chargeable', booking, id);
                await sendEmail(id, subject, body);
            }
        } catch (emailErr) {
            showToast('Payment recorded, but the confirmation email failed to send: ' + emailErr.message, 'error');
        }

        // Independent of the email above: reuses the same "booking_confirmed"
        // template the free-confirm path already sends (js/shared.js's
        // maybeSendStatusSms) — a bank-transfer confirmation should text the
        // stallholder the same cost/bank-details/cancel-link content, not a
        // different message. Opt-in (unlike stripe-webhook's automatic send,
        // which has no admin present to tick anything): the admin is right
        // here clicking this button, so it follows the same tickbox pattern
        // as every other admin-initiated SMS in this app.
        if (alsoSms) {
            try {
                const booking = allRecords.find(item => item.id === id);
                if (booking) {
                    const smsBody = await getSmsFromTemplate('booking_confirmed', booking, id);
                    await sendBookingSms(id, smsBody);
                }
            } catch (smsErr) {
                showToast('Payment recorded, but the text failed to send: ' + smsErr.message, 'error');
            }
        }

        await loadData();
    } catch (err) {
        showToast('Error recording payment: ' + err.message, 'error');
    } finally {
        btn.disabled = false;
        btn.textContent = 'Record Payment & Confirm Booking';
    }
}

function openRefundModal(id) {
    const r = allRecords.find(item => item.id === id);
    if (!r) return;

    const paidAmount = r.stall_cost != null ? parseFloat(r.stall_cost) : null;
    // Only a Stripe payment with a recorded payment intent can be refunded
    // through the API — everything else is record-only, because there is no
    // API that moves the money back.
    const isStripe = r.payment_method === 'stripe' && !!r.stripe_payment_intent_id;

    (/** @type {HTMLInputElement} */ (document.getElementById('refund-modal-id'))).value = r.id;
    document.getElementById('refund-modal-booking-display').innerText = `${r.business || r.business_name} (${r.id})`;
    document.getElementById('refund-modal-paid-display').innerText = formatCurrency(paidAmount);
    document.getElementById('refund-modal-method-display').innerText =
        r.payment_method === 'stripe' ? 'Stripe' + (isStripe ? '' : ' (no payment intent recorded — manual refund only)')
            : r.payment_method === 'bank_transfer' ? 'Bank transfer'
                : 'Unknown';

    const intro = /** @type {HTMLElement} */ (document.getElementById('refund-modal-intro'));
    const refWrap = document.getElementById('refund-modal-reference-wrap');
    const saveBtn = document.getElementById('btn-save-refund');

    if (isStripe) {
        intro.innerText = 'This will issue a REAL refund through Stripe immediately, then record it. The money goes back to the trader\'s card.';
        intro.className = 'mt-1 text-sm text-amber-700 font-medium';
        // Stripe generates the refund id — asking the admin for one would be
        // meaningless, and the RPC gets it from the API response instead.
        refWrap.classList.add('hidden');
        saveBtn.textContent = 'Issue Refund via Stripe';
    } else {
        intro.innerText = 'This records a refund that has already been issued — it does not move any money itself. Transfer the money back first, then record it here.';
        intro.className = 'mt-1 text-sm text-gray-500';
        refWrap.classList.remove('hidden');
        saveBtn.textContent = 'Record Refund';
    }

    // Default to a full refund — the common case — while leaving the field
    // editable for a partial one.
    (/** @type {HTMLInputElement} */ (document.getElementById('refund-modal-amount'))).value = paidAmount != null ? paidAmount.toFixed(2) : '';
    (/** @type {HTMLInputElement} */ (document.getElementById('refund-modal-reference'))).value = '';
    (/** @type {HTMLTextAreaElement} */ (document.getElementById('refund-modal-notes'))).value = '';

    document.getElementById('refund-modal').classList.remove('hidden');
    unregisterRefundModalEsc = registerModalClose(closeRefundModal);
    releaseRefundModalFocus = trapFocus(document.getElementById('refund-modal'));
}

function closeRefundModal() {
    // Refuse to close while a refund request is in flight. Cancel, the
    // overlay click, and now Escape all route here, and used to just hide
    // the modal — letting an admin close it, reopen it against stale
    // (not-yet-refreshed) local data, and fire a second concurrent refund
    // request before the first had even resolved. rpc_record_refund's
    // atomic claim (see its 2026-07-31 migration) closes that race
    // server-side; this guard closes the other way into it — and since
    // Escape calls this SAME function rather than toggling the modal
    // directly, it's covered by the guard for free.
    if (refundInFlight) return;
    document.getElementById('refund-modal').classList.add('hidden');
    if (unregisterRefundModalEsc) { unregisterRefundModalEsc(); unregisterRefundModalEsc = null; }
    if (releaseRefundModalFocus) { releaseRefundModalFocus(); releaseRefundModalFocus = null; }
}

async function saveRefund() {
    const id = (/** @type {HTMLInputElement} */ (document.getElementById('refund-modal-id'))).value;
    const amount = (/** @type {HTMLInputElement} */ (document.getElementById('refund-modal-amount'))).value;
    const reference = (/** @type {HTMLInputElement} */ (document.getElementById('refund-modal-reference'))).value;
    const notes = (/** @type {HTMLTextAreaElement} */ (document.getElementById('refund-modal-notes'))).value;

    const r = allRecords.find(item => item.id === id);
    const isStripe = r && r.payment_method === 'stripe' && !!r.stripe_payment_intent_id;

    // Only the record-only path needs a reference from the admin — Stripe
    // supplies its own refund id.
    if (!isStripe && !reference.trim()) {
        showToast('Refund reference is required.', 'error');
        return;
    }

    const parsedAmount = parseFloat(amount);
    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
        showToast('Refund amount must be greater than zero.', 'error');
        return;
    }

    // Issuing a real refund is irreversible, so it gets an explicit
    // confirmation naming the amount — recording one doesn't, since that only
    // writes a row that can be corrected. showConfirm is callback-based (not
    // promise-returning), so the actual work is deferred into the callback
    // rather than awaited.
    if (isStripe) {
        showConfirm(
            'Issue Stripe refund?',
            `This will immediately refund ${formatCurrency(parsedAmount)} to the trader's card via Stripe. This cannot be undone from here.`,
            () => performRefund(id, parsedAmount, reference, notes, true)
        );
        return;
    }

    await performRefund(id, parsedAmount, reference, notes, false);
}

async function performRefund(id, parsedAmount, reference, notes, isStripe) {
    const btn = /** @type {HTMLButtonElement} */ (document.getElementById('btn-save-refund'));
    const cancelBtn = /** @type {HTMLButtonElement | null} */ (document.getElementById('btn-cancel-refund'));
    const originalLabel = btn.textContent;

    refundInFlight = true;
    btn.disabled = true;
    if (cancelBtn) cancelBtn.disabled = true;
    btn.textContent = isStripe ? 'Refunding...' : 'Recording...';

    try {
        if (isStripe) {
            const result = await refundStripePayment({
                booking_id: id,
                amount: parsedAmount,
                notes: notes || null
            });
            refundInFlight = false;
            closeRefundModal();
            showToast(`Refund of ${formatCurrency(parsedAmount)} issued via Stripe (${result?.refund_id || 'no id returned'}).`);
        } else {
            await recordRefund({
                booking_id: id,
                refund_amount: parsedAmount,
                refund_reference: reference,
                notes: notes || null
            });
            refundInFlight = false;
            closeRefundModal();
            showToast('Refund recorded.');
        }

        await loadData();
    } catch (err) {
        showToast('Refund failed: ' + err.message, 'error');
    } finally {
        refundInFlight = false;
        btn.disabled = false;
        if (cancelBtn) cancelBtn.disabled = false;
        btn.textContent = originalLabel;
    }
}

async function savePayment() {
    const id = (/** @type {HTMLInputElement} */ (document.getElementById('modal-id'))).value;
    const paid = (/** @type {HTMLInputElement} */ (document.getElementById('modal-paid'))).checked;
    const date = (/** @type {HTMLInputElement} */ (document.getElementById('modal-date'))).value;
    const ref = (/** @type {HTMLInputElement} */ (document.getElementById('modal-ref'))).value;
    const editor = (/** @type {HTMLInputElement} */ (document.getElementById('modal-editor'))).value;

    // Unticking Paid on a refunded booking is refused by the database's
    // payments_refund_requires_payment CHECK, which is correct - a refund
    // against a payment that never happened is meaningless. Without this
    // branch the admin just gets the raw Postgres text ("new row for relation
    // \"payments\" violates check constraint ...") in a toast, which reads
    // like a fault rather than a rule. Caught here purely for the wording; the
    // constraint remains the actual guarantee.
    const record = allRecords.find(r => r.id === id);
    if (record && record.refunded && !paid) {
        showToast("This booking has a refund recorded against it, so it can't be marked unpaid — the refund is already what records the money going back. Undoing a refund isn't supported here.", 'error');
        return;
    }

    if (paid && (!date || !ref.trim() || !editor.trim())) {
        showToast("Date Paid, Bank Reference, and Updated By are required when marking as Paid.", 'error');
        return;
    }

    try {
        await updatePayment({
            booking_id: id,
            paid: paid,
            date_paid: date,
            bank_ref: ref,
            editor: editor
        });

        closeModal();
        showToast("Payment updated!");
        await loadData();

    } catch (err) {
        showToast("Error saving: " + err.message, 'error');
    }
}

async function sendReminder(id) {
    if (!id) return;
    await manualSendPaymentReminder(id);
}

// Reported live as a gap: this used to fire resendPaymentRequest(id) with no
// second argument, so a resend could never text the stallholder no matter
// what — there was no tickbox anywhere on this page to even ask. Mirrors the
// bank-transfer modal's own "Also send a text message" tickbox shape below.
function openResendPaymentModal(id) {
    const r = allRecords.find(item => item.id === id);
    if (!r) return;

    (/** @type {HTMLInputElement} */ (document.getElementById('resend-modal-id'))).value = r.id;
    document.getElementById('resend-modal-booking-display').innerText = `${r.business || r.business_name} (${r.id})`;
    // Reset every open so a ticked state never carries over to the next
    // booking, matching every other opt-in SMS tickbox in this app.
    const smsCb = /** @type {HTMLInputElement | null} */ (document.getElementById('resendAlsoSms'));
    if (smsCb) smsCb.checked = false;

    document.getElementById('resend-payment-modal').classList.remove('hidden');
    unregisterResendPaymentModalEsc = registerModalClose(closeResendPaymentModal);
    releaseResendPaymentModalFocus = trapFocus(document.getElementById('resend-payment-modal'));
}

function closeResendPaymentModal() {
    document.getElementById('resend-payment-modal').classList.add('hidden');
    if (unregisterResendPaymentModalEsc) { unregisterResendPaymentModalEsc(); unregisterResendPaymentModalEsc = null; }
    if (releaseResendPaymentModalFocus) { releaseResendPaymentModalFocus(); releaseResendPaymentModalFocus = null; }
}

async function saveResendPayment() {
    const id = (/** @type {HTMLInputElement} */ (document.getElementById('resend-modal-id'))).value;
    // Read before closeResendPaymentModal() below, which would otherwise be
    // the last chance to see the tickbox's state.
    const sendSms = !!(/** @type {HTMLInputElement | null} */ (document.getElementById('resendAlsoSms')))?.checked;

    const btn = /** @type {HTMLButtonElement} */ (document.getElementById('btn-save-resend-payment'));
    btn.disabled = true;
    btn.textContent = 'Resending...';

    try {
        await resendPaymentRequest(id, sendSms);
        closeResendPaymentModal();
        showToast('Payment request resent.');
        await loadData();
    } catch (e) {
        showToast('Failed to resend: ' + e.message, 'error');
    } finally {
        btn.disabled = false;
        btn.textContent = 'Resend Payment Request';
    }
}

function csvEscape(val) {
    if (val === null || val === undefined) return '';
    const str = String(val);
    return str.includes(',') || str.includes('"') || str.includes('\n')
        ? `"${str.replace(/"/g, '""')}"` : str;
}

/**
 * Triggers a browser download of a CSV built from headers + pre-escaped row
 * strings. Shared by the per-booking export and the summary export, so the
 * filename convention and download mechanics can't drift between them.
 * @param {string} filenameSuffix e.g. 'Refunded', 'Summary' - inserted into
 *   the same <prefix>_Payments_<instance>_<suffix>_<date>.csv shape.
 */
function downloadCsv(headers, rows, filenameSuffix) {
    const csv = [headers.join(','), ...rows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const instance = localStorage.getItem('ESF_INSTANCE') || 'DEV';
    const suffix = filenameSuffix ? `_${filenameSuffix}` : '';
    a.href = url;
    a.download = `${getActiveBookingPrefix()}_Payments_${instance}${suffix}_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
}

/**
 * Exports payments as a CSV file. #export-preset controls which records:
 *   - 'current' (default): whatever filter-status/search-input currently
 *     show — the original, only behaviour this used to have.
 *   - 'all' / 'refunded': every record for the loaded instance regardless of
 *     the status filter/search currently on screen, so "Export Refunded
 *     Only" means every refund ever recorded, not just whichever ones a
 *     leftover search term happens to still be narrowing.
 */
function exportCSV() {
    const preset = (/** @type {HTMLSelectElement | null} */ (document.getElementById('export-preset')))?.value || 'current';

    if (preset === 'summary') {
        exportNetBilledSummary();
        return;
    }

    let filtered;
    if (preset === 'all') {
        filtered = allRecords;
    } else if (preset === 'refunded') {
        filtered = allRecords.filter(r => r.refunded);
    } else {
        const statusFilter = (/** @type {HTMLSelectElement | null} */ (document.getElementById('filter-status')))?.value || 'all';
        const searchTerm = ((/** @type {HTMLInputElement | null} */ (document.getElementById('search-input')))?.value || '').toLowerCase();
        filtered = allRecords.filter(r => matchesFilters(r, statusFilter, searchTerm));
    }

    if (filtered.length === 0) {
        showToast('No data to export.', 'info');
        return;
    }

    // "Paid" stays a truthful record of whether a payment was ever taken, so
    // a refunded booking still reads Yes - but on its own that made the export
    // claim money the festival had already given back, which matters more here
    // than anywhere else on the page: this file is what gets reconciled against
    // the bank. The refund columns and Net Paid exist so the number someone
    // sums in a spreadsheet is the number actually held.
    const headers = ['Booking ID', 'Business', 'Owner', 'Email', 'Stall Cost', 'Paid', 'Date Paid',
        'Refund Amount', 'Refunded On', 'Net Paid', 'Bank Reference', 'Updated By'];
    const rows = filtered.map(r => {
        const cost = parseFloat(r.stall_cost) || 0;
        const refund = parseFloat(r.refund_amount) || 0;
        return [
            r.id,
            r.business || r.business_name,
            r.owner || r.owner_name,
            r.email,
            r.stall_cost || '',
            r.paid ? 'Yes' : 'No',
            r.date_paid ? new Date(r.date_paid).toLocaleDateString('en-GB') : '',
            refund ? refund.toFixed(2) : '',
            r.refunded_at ? new Date(r.refunded_at).toLocaleDateString('en-GB') : '',
            (r.paid ? cost - refund : 0).toFixed(2),
            r.bank_ref || '',
            r.editor || ''
        ].map(csvEscape).join(',');
    });

    const suffix = preset === 'all' ? 'All' : preset === 'refunded' ? 'Refunded' : '';
    downloadCsv(headers, rows, suffix);
    showToast(`Exported ${filtered.length} records.`);
}

/**
 * A single-row reconciliation summary — the same totals already shown in
 * the header stat tiles (computeTotals()), not a fresh aggregation, so this
 * can never report a different number than what's on screen. Deliberately
 * over the WHOLE loaded instance (allRecords), ignoring whatever
 * filter-status/search-input currently show: a preset meant for festival
 * close-out reconciliation should give the same answer regardless of
 * whatever the admin happened to have filtered moments before clicking it.
 */
function exportNetBilledSummary() {
    if (allRecords.length === 0) {
        showToast('No data to export.', 'info');
        return;
    }

    const { totalPaid, totalRefunded, totalOutstanding } = computeTotals(allRecords);
    // totalPaid is already net of refunds; adding totalRefunded back gives
    // the gross amount actually collected before any refund, and +
    // totalOutstanding adds what's still owed - together, every pound this
    // instance's Confirmed bookings were ever billed for.
    const totalBilled = totalPaid + totalRefunded + totalOutstanding;

    const instance = localStorage.getItem('ESF_INSTANCE') || 'DEV';
    const headers = ['Instance', 'Total Billed (Gross)', 'Total Collected (Net of Refunds)', 'Total Refunded', 'Total Outstanding', 'Export Date'];
    const row = [
        instance,
        totalBilled.toFixed(2),
        totalPaid.toFixed(2),
        totalRefunded.toFixed(2),
        totalOutstanding.toFixed(2),
        new Date().toLocaleDateString('en-GB')
    ].map(csvEscape).join(',');

    downloadCsv(headers, [row], 'Summary');
    showToast('Exported net billed summary.');
}
