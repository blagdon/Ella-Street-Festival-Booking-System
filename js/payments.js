import { fetchPayments, updatePayment } from './api.js';
import { manualSendPaymentReminder } from './shared.js';
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
            (statusFilter === 'unpaid' && !r.paid);
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
            const paidClass = r.paid ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800';
            const paidText = r.paid ? 'PAID' : 'UNPAID';

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
                <td class="px-6 py-4 pr-12 whitespace-nowrap text-right text-sm font-medium space-x-3">
                    ${!r.paid ? `<button data-id="${escapeHtml(r.id)}" class="btn-reminder text-purple-600 hover:text-purple-900 font-bold">Reminder</button>` : ''}
                    <button data-id="${escapeHtml(r.id)}" class="btn-edit text-blue-600 hover:text-blue-900">Edit</button>
                </td>
            </tr>
        `}).join('');
    }

    // Build Mobile Cards HTML
    if (mobileContainer) {
        mobileContainer.innerHTML = filtered.map(r => {
            const paidClass = r.paid ? 'paid' : 'unpaid';
            const paidBadgeClass = r.paid ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800';
            const paidText = r.paid ? 'PAID' : 'UNPAID';
            let statusColor = 'bg-gray-100 text-gray-800';
            if (r.status === 'Confirmed') statusColor = 'bg-green-100 text-green-800';

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
                        ${!r.paid ? `
                        <button data-id="${escapeHtml(r.id)}" class="btn-reminder bg-purple-100 text-purple-700 px-3 py-2 rounded-lg text-sm font-semibold hover:bg-purple-200">
                            Reminder
                        </button>` : ''}
                        <button data-id="${escapeHtml(r.id)}" class="btn-edit bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-semibold hover:bg-blue-700 transition">
                            Edit Payment
                        </button>
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
