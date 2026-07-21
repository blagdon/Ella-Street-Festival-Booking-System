import { fetchPayments, updatePayment, resendPaymentRequest, recordBankTransferPayment, recordRefund, refundStripePayment, sendEmail, LIST_CAP } from './api.js';
import { manualSendPaymentReminder, getEmailFromTemplate } from './shared.js';
import { showToast, showConfirm, notifyIfTruncated } from './ui.js';
import { escapeHtml } from './utils.js';
import { CONFIG } from './config.js';

let allRecords = [];

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

    document.getElementById('refund-modal-overlay')?.addEventListener('click', closeRefundModal);
    document.getElementById('btn-cancel-refund')?.addEventListener('click', closeRefundModal);
    document.getElementById('btn-save-refund')?.addEventListener('click', saveRefund);

    // Event delegation for dynamic table/card buttons
    document.body.addEventListener('click', (e) => {
        const reminderBtn = e.target.closest('.btn-reminder');
        if (reminderBtn) {
            sendReminder(reminderBtn.dataset.id);
            return;
        }

        const editBtn = e.target.closest('.btn-edit');
        if (editBtn) {
            openEditModal(editBtn.dataset.id);
            return;
        }

        const resendBtn = e.target.closest('.btn-resend-payment');
        if (resendBtn) {
            resendPaymentRequestRow(resendBtn.dataset.id);
            return;
        }

        const bankTransferBtn = e.target.closest('.btn-record-bank-transfer');
        if (bankTransferBtn) {
            openBankTransferModal(bankTransferBtn.dataset.id);
            return;
        }

        const refundBtn = e.target.closest('.btn-record-refund');
        if (refundBtn) {
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

function renderTable() {
    const statusFilter = document.getElementById('filter-status').value;
    const searchTerm = document.getElementById('search-input').value.toLowerCase();
    const tbody = document.getElementById('payments-body');
    const mobileContainer = document.getElementById('mobile-cards');

    // Filter Data
    const filtered = allRecords.filter(r => {
        const matchesStatus = (statusFilter === 'all') ||
            (statusFilter === 'paid' && r.paid) ||
            (statusFilter === 'unpaid' && !r.paid && !r.awaitingPayment) ||
            (statusFilter === 'awaiting' && r.awaitingPayment) ||
            (statusFilter === 'needs-refund' && r.needsRefundFollowUp) ||
            (statusFilter === 'refunded' && r.refunded);
        const matchesSearch = (r.business || r.business_name || '').toLowerCase().includes(searchTerm) ||
            (r.owner || r.owner_name || '').toLowerCase().includes(searchTerm);
        return matchesStatus && matchesSearch;
    });

    // Calculate Totals
    //
    // `paid` deliberately stays true after a refund - the payment really did
    // happen, and the refund is separate state layered on top of it (see the
    // refund migration's header for why). The consequence is that Paid must
    // net refunds out HERE, explicitly: without this, a fully refunded booking
    // goes on inflating the headline figure forever, so the dashboard reports
    // money the festival no longer holds. rpc_record_refund caps a refund at
    // the booking cost, so a row can never contribute a negative amount.
    const totalPaid = filtered.reduce((sum, r) =>
        sum + (r.paid ? (parseFloat(r.stall_cost) || 0) - (parseFloat(r.refund_amount) || 0) : 0), 0);
    const totalRefunded = filtered.reduce((sum, r) => sum + (parseFloat(r.refund_amount) || 0), 0);
    // A refunded booking keeps paid = true, so it is already excluded from
    // Outstanding - correct, since a refunded cancellation is not money owed.
    const totalOutstanding = filtered.reduce((sum, r) => sum + (!r.paid && r.status === 'Confirmed' ? (parseFloat(r.stall_cost) || 0) : 0), 0);

    // Update Totals Display
    const elPaid = document.getElementById('total-paid');
    const elOut = document.getElementById('total-outstanding');
    if (elPaid) elPaid.innerText = "£" + totalPaid.toLocaleString('en-GB', { minimumFractionDigits: 2 });
    if (elOut) elOut.innerText = "£" + totalOutstanding.toLocaleString('en-GB', { minimumFractionDigits: 2 });

    // Refunded is shown only when there is something to show. Netting it out
    // of Paid above would otherwise make money silently disappear from the
    // header with nothing accounting for where it went.
    const elRefunded = document.getElementById('total-refunded');
    const elRefundedWrap = document.getElementById('total-refunded-wrap');
    if (elRefunded) elRefunded.innerText = "£" + totalRefunded.toLocaleString('en-GB', { minimumFractionDigits: 2 });
    if (elRefundedWrap) elRefundedWrap.classList.toggle('hidden', totalRefunded === 0);

    // Update Count
    const elCount = document.getElementById('count-display');
    if (elCount) elCount.innerText = filtered.length;

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
                    ${r.stall_cost}
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
                            £${Number(r.refund_amount).toFixed(2)} on ${escapeHtml(r.refunded_at ? new Date(r.refunded_at).toLocaleDateString('en-GB') : '')}
                        </div>` : ''}
                </td>
                <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                    ${r.date_paid ? new Date(r.date_paid).toLocaleDateString() : '-'}
                </td>
                <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                    ${escapeHtml(r.bank_ref || '-')}
                </td>
                <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                    ${escapeHtml(r.editor || '-')}
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
                        <p class="text-lg font-bold text-gray-900">${r.stall_cost}</p>
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

    document.getElementById('modal-id').value = r.id;
    document.getElementById('modal-paid').checked = r.paid;

    // Format date for input type=date (YYYY-MM-DD)
    let dateVal = '';
    if (r.date_paid) {
        dateVal = new Date(r.date_paid).toISOString().split('T')[0];
    } else if (r.paid) {
        // Default to today if marked paid but no date set yet
        dateVal = new Date().toISOString().split('T')[0];
    }
    document.getElementById('modal-date').value = dateVal;

    document.getElementById('modal-ref').value = r.bank_ref || '';
    document.getElementById('modal-editor').value = r.editor || '';

    document.getElementById('edit-modal').classList.remove('hidden');
}

function closeModal() {
    document.getElementById('edit-modal').classList.add('hidden');
}

function openBankTransferModal(id) {
    const r = allRecords.find(item => item.id === id);
    if (!r) return;

    document.getElementById('bt-modal-id').value = r.id;
    document.getElementById('bt-modal-booking-display').innerText = `${r.business || r.business_name} (${r.id})`;
    document.getElementById('bt-modal-amount-display').innerText = r.stall_cost != null ? `£${parseFloat(r.stall_cost).toFixed(2)}` : '—';
    // Payment reference defaults to the booking ID, per spec — editable if the
    // stallholder actually used a different reference on their transfer.
    document.getElementById('bt-modal-reference').value = r.id;
    document.getElementById('bt-modal-notes').value = '';

    document.getElementById('bank-transfer-modal').classList.remove('hidden');
}

function closeBankTransferModal() {
    document.getElementById('bank-transfer-modal').classList.add('hidden');
}

async function saveBankTransferPayment() {
    const id = document.getElementById('bt-modal-id').value;
    const reference = document.getElementById('bt-modal-reference').value;
    const notes = document.getElementById('bt-modal-notes').value;

    if (!reference.trim()) {
        showToast('Payment reference is required.', 'error');
        return;
    }

    const btn = document.getElementById('btn-save-bank-transfer');
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

    document.getElementById('refund-modal-id').value = r.id;
    document.getElementById('refund-modal-booking-display').innerText = `${r.business || r.business_name} (${r.id})`;
    document.getElementById('refund-modal-paid-display').innerText = paidAmount != null ? `£${paidAmount.toFixed(2)}` : '—';
    document.getElementById('refund-modal-method-display').innerText =
        r.payment_method === 'stripe' ? 'Stripe' + (isStripe ? '' : ' (no payment intent recorded — manual refund only)')
            : r.payment_method === 'bank_transfer' ? 'Bank transfer'
                : 'Unknown';

    const intro = document.getElementById('refund-modal-intro');
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
    document.getElementById('refund-modal-amount').value = paidAmount != null ? paidAmount.toFixed(2) : '';
    document.getElementById('refund-modal-reference').value = '';
    document.getElementById('refund-modal-notes').value = '';

    document.getElementById('refund-modal').classList.remove('hidden');
}

function closeRefundModal() {
    document.getElementById('refund-modal').classList.add('hidden');
}

async function saveRefund() {
    const id = document.getElementById('refund-modal-id').value;
    const amount = document.getElementById('refund-modal-amount').value;
    const reference = document.getElementById('refund-modal-reference').value;
    const notes = document.getElementById('refund-modal-notes').value;

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
            `This will immediately refund £${parsedAmount.toFixed(2)} to the trader's card via Stripe. This cannot be undone from here.`,
            () => performRefund(id, parsedAmount, reference, notes, true)
        );
        return;
    }

    await performRefund(id, parsedAmount, reference, notes, false);
}

async function performRefund(id, parsedAmount, reference, notes, isStripe) {
    const btn = document.getElementById('btn-save-refund');
    const originalLabel = btn.textContent;

    btn.disabled = true;
    btn.textContent = isStripe ? 'Refunding...' : 'Recording...';

    try {
        if (isStripe) {
            const result = await refundStripePayment({
                booking_id: id,
                amount: parsedAmount,
                notes: notes || null
            });
            closeRefundModal();
            showToast(`Refund of £${parsedAmount.toFixed(2)} issued via Stripe (${result?.refund_id || 'no id returned'}).`);
        } else {
            await recordRefund({
                booking_id: id,
                refund_amount: parsedAmount,
                refund_reference: reference,
                notes: notes || null
            });
            closeRefundModal();
            showToast('Refund recorded.');
        }

        await loadData();
    } catch (err) {
        showToast('Refund failed: ' + err.message, 'error');
    } finally {
        btn.disabled = false;
        btn.textContent = originalLabel;
    }
}

async function savePayment() {
    const id = document.getElementById('modal-id').value;
    const paid = document.getElementById('modal-paid').checked;
    const date = document.getElementById('modal-date').value;
    const ref = document.getElementById('modal-ref').value;
    const editor = document.getElementById('modal-editor').value;

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

async function refreshData() {
    await loadData();
}

async function sendReminder(id) {
    if (!id) return;
    await manualSendPaymentReminder(id);
}

async function resendPaymentRequestRow(id) {
    if (!id) return;
    try {
        await resendPaymentRequest(id);
        showToast('Payment request resent.');
        await loadData();
    } catch (e) {
        showToast('Failed to resend: ' + e.message, 'error');
    }
}

/**
 * Exports the currently filtered payments as a CSV file.
 */
function exportCSV() {
    const statusFilter = document.getElementById('filter-status')?.value || 'all';
    const searchTerm = (document.getElementById('search-input')?.value || '').toLowerCase();

    const filtered = allRecords.filter(r => {
        const matchesStatus = (statusFilter === 'all') ||
            (statusFilter === 'paid' && r.paid) ||
            (statusFilter === 'unpaid' && !r.paid);
        const matchesSearch = (r.business || r.business_name || '').toLowerCase().includes(searchTerm) ||
            (r.owner || r.owner_name || '').toLowerCase().includes(searchTerm);
        return matchesStatus && matchesSearch;
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

    const headers = ['Booking ID', 'Business', 'Owner', 'Email', 'Stall Cost', 'Paid', 'Date Paid', 'Bank Reference', 'Updated By'];
    const rows = filtered.map(r => [
        r.id,
        r.business || r.business_name,
        r.owner || r.owner_name,
        r.email,
        r.stall_cost || '',
        r.paid ? 'Yes' : 'No',
        r.date_paid ? new Date(r.date_paid).toLocaleDateString('en-GB') : '',
        r.bank_ref || '',
        r.editor || ''
    ].map(escape).join(','));

    const csv = [headers.join(','), ...rows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const instance = localStorage.getItem('ESF_INSTANCE') || 'DEV';
    a.href = url;
    a.download = `ESF26_Payments_${instance}_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    showToast(`Exported ${filtered.length} records.`);
}
