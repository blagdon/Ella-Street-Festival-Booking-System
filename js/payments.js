import { fetchPayments, updatePayment, resendPaymentRequest, recordBankTransferPayment, sendEmail } from './api.js';
import { manualSendPaymentReminder, getEmailFromTemplate } from './shared.js';
import { showToast } from './ui.js';
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
    });
}

async function loadData() {
    try {
        const currentInstance = localStorage.getItem('ESF_INSTANCE') || 'DEV';
        allRecords = await fetchPayments(currentInstance);
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
            (statusFilter === 'awaiting' && r.awaitingPayment);
        const matchesSearch = (r.business || r.business_name || '').toLowerCase().includes(searchTerm) ||
            (r.owner || r.owner_name || '').toLowerCase().includes(searchTerm);
        return matchesStatus && matchesSearch;
    });

    // Calculate Totals
    const totalPaid = filtered.reduce((sum, r) => sum + (r.paid ? (parseFloat(r.stall_cost) || 0) : 0), 0);
    const totalOutstanding = filtered.reduce((sum, r) => sum + (!r.paid && r.status === 'Confirmed' ? (parseFloat(r.stall_cost) || 0) : 0), 0);

    // Update Totals Display
    const elPaid = document.getElementById('total-paid');
    const elOut = document.getElementById('total-outstanding');
    if (elPaid) elPaid.innerText = "£" + totalPaid.toLocaleString('en-GB', { minimumFractionDigits: 2 });
    if (elOut) elOut.innerText = "£" + totalOutstanding.toLocaleString('en-GB', { minimumFractionDigits: 2 });

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
