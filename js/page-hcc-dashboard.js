import { initAdminPage, getSupabaseClient } from './supabase.js';
import { CONFIG } from './config.js';
import { showToast, showConfirm } from './ui.js';
import { safeError, escapeHtml } from './utils.js';
import { auditLog, sendEmailDirect } from './api.js';

const sb = getSupabaseClient();
let currentData = [];
let offset = 0;
const limit = 25;
let allRecordsLoaded = false;

function initHcc() {
    loadData(true);

    const statusFilter = document.getElementById('statusFilter');
    if (statusFilter) {
        statusFilter.addEventListener('change', filterByStatus);
    }

    const btnBulkEmail = document.getElementById('btnBulkEmail');
    if (btnBulkEmail) {
        btnBulkEmail.addEventListener('click', sendBulkEmail);
    }

    const btnSaveAll = document.getElementById('btnSaveAll');
    if (btnSaveAll) {
        btnSaveAll.addEventListener('click', saveAllChanges);
    }

    const btnLoadMore = document.getElementById('btnLoadMore');
    if (btnLoadMore) {
        btnLoadMore.addEventListener('click', () => loadData(false));
    }
}

initAdminPage(initHcc);

// Load Data
async function loadData(reset = true) {
    const loadingEl = document.getElementById('loading');
    const btnLoadMore = document.getElementById('btnLoadMore');
    const pagContainer = document.getElementById('pagination-container');

    if (reset) {
        offset = 0;
        currentData = [];
        allRecordsLoaded = false;
        const tbody = document.getElementById('hccTableBody');
        const mobileContainer = document.getElementById('mobile-cards');
        if (tbody) tbody.innerHTML = '';
        if (mobileContainer) mobileContainer.innerHTML = '';
        if (loadingEl) {
            loadingEl.innerHTML = 'Loading records...';
            loadingEl.classList.remove('hidden');
        }
        if (pagContainer) pagContainer.classList.add('hidden');
    } else {
        if (btnLoadMore) {
            btnLoadMore.disabled = true;
            btnLoadMore.innerText = "Loading...";
        }
    }

    try {
        // We use a JOIN to fetch email, phone, status, business_name, owner_name, and registered_business_name from the referenced 'bookings' table
        const { data, error } = await sb
            .from('hcc_checks')
            .select('*, bookings(business_name, owner_name, registered_business_name, email, phone, status)')
            .order('submitted_at', { ascending: false })
            .range(offset, offset + limit - 1);

        if (error) {
            console.error('Supabase error:', error);
            const safeMsg = (typeof safeError === 'function') ? safeError(error) : error.message;
            showToast("Error loading data: " + safeMsg, 'error');
            if (loadingEl) loadingEl.innerHTML = '<div class="text-center py-10 text-red-500">Error: ' + escapeHtml(safeMsg) + '</div>';
            return;
        }

        if (!data || data.length < limit) {
            allRecordsLoaded = true;
        }

        const newRecords = (data || []).map(r => ({
            ...r,
            business_name: r.bookings?.business_name || 'Unknown',
            owner_name: r.bookings?.owner_name || 'Unknown',
            registered_business_name: r.bookings?.registered_business_name || ''
        }));

        currentData = [...currentData, ...newRecords];
        offset += newRecords.length;

        if (loadingEl) loadingEl.classList.add('hidden');

        renderTable(newRecords, !reset);

        if (pagContainer) {
            if (allRecordsLoaded || newRecords.length === 0) {
                pagContainer.classList.add('hidden');
            } else {
                pagContainer.classList.remove('hidden');
            }
        }

        // Apply selected status filter if any
        filterByStatus();

    } catch (err) {
        console.error('Exception in loadData:', err);
        const safeMsg = (typeof safeError === 'function') ? safeError(err) : err.message;
        showToast("Exception loading data: " + safeMsg, 'error');
        if (loadingEl) loadingEl.innerHTML = '<div class="text-center py-10 text-red-500">Error: ' + escapeHtml(safeMsg) + '</div>';
    } finally {
        if (btnLoadMore) {
            btnLoadMore.disabled = false;
            btnLoadMore.innerText = "Load More Records";
        }
    }
}

function renderTable(records, append = false) {
    const tbody = document.getElementById('hccTableBody');
    const mobileContainer = document.getElementById('mobile-cards');
    if (!tbody || !mobileContainer) return;

    if (!append) {
        tbody.innerHTML = '';
        mobileContainer.innerHTML = '';
    }

    if (records.length === 0 && !append) {
        tbody.innerHTML = '<tr><td colspan="8" class="px-6 py-4 text-center text-gray-500">No records in HCC Checks yet.</td></tr>';
        mobileContainer.innerHTML = '<div class="text-center py-10 text-gray-500">No records in HCC Checks yet.</div>';
        return;
    }

    records.forEach(r => {
        // Desktop Table Row
        const row = document.createElement('tr');

        // Status Color Logic
        let statusColor = 'bg-yellow-100 text-yellow-800';
        if (r.council_status === 'Email Sent') statusColor = 'bg-blue-100 text-blue-800';
        if (r.council_status === 'Approved') statusColor = 'bg-green-100 text-green-800';
        if (r.council_status === 'Rejected') statusColor = 'bg-red-100 text-red-800';

        // Only allow selection if Pending
        const canSelect = (r.council_status === 'Pending');
        const checkboxHtml = canSelect
            ? `<input type="checkbox" class="row-select w-5 h-5 text-blue-600 rounded border-gray-300 focus:ring-blue-500 cursor-pointer" value="${r.id}">`
            : `<span class="text-gray-300">-</span>`;

        // Main Status colors for the badge
        const mainStatus = escapeHtml(r.bookings?.status || 'Unknown');
        let mainStatusColor = 'bg-gray-100 text-gray-700';
        if (mainStatus === 'Pending') mainStatusColor = 'bg-yellow-100 text-yellow-700';
        if (mainStatus === 'Confirmed') mainStatusColor = 'bg-green-100 text-green-700';
        if (mainStatus === 'Rejected') mainStatusColor = 'bg-red-100 text-red-700';
        if (mainStatus === 'Cancelled') mainStatusColor = 'bg-gray-100 text-gray-700';
        if (mainStatus === 'On Hold') mainStatusColor = 'bg-purple-100 text-purple-700';
        if (mainStatus === 'HCC Checks') mainStatusColor = 'bg-orange-100 text-orange-700';

        row.innerHTML = `
                  <td class="px-6 py-4 whitespace-nowrap">
                      <div class="text-sm font-bold text-blue-600 mb-1">${escapeHtml(r.booking_id)}</div>
                      <span class="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${mainStatusColor}">
                          ${mainStatus}
                      </span>
                  </td>
                  <td class="px-6 py-4">
                      <div class="text-sm font-medium text-gray-900">${escapeHtml(r.business_name)}</div>
                      <div class="text-xs text-gray-500">${escapeHtml(r.owner_name)}</div>
                      <div class="text-xs text-gray-400 font-mono mt-1">${escapeHtml(r.registered_business_name || '')}</div>
                  </td>
                  <td class="px-6 py-4 text-sm text-gray-500">${new Date(r.submitted_at).toLocaleDateString()}</td>
                  <td class="px-6 py-4">
                      <select id="status-${r.id}" class="hcc-status-select tracking-wider text-xs font-bold rounded border-0 px-2 py-1 ${statusColor} focus:ring-2 focus:ring-blue-500 cursor-pointer" data-id="${r.id}">
                          <option value="Pending" ${r.council_status === 'Pending' ? 'selected' : ''}>Pending</option>
                          <option value="Email Sent" ${r.council_status === 'Email Sent' ? 'selected' : ''}>Email Sent</option>
                          <option value="Approved" ${r.council_status === 'Approved' ? 'selected' : ''}>Approved</option>
                          <option value="Rejected" ${r.council_status === 'Rejected' ? 'selected' : ''}>Rejected</option>
                      </select>
                  </td>
                  <td class="px-6 py-4">
                      <input type="date" id="date-${r.id}" value="${escapeHtml(r.approval_date || '')}" class="text-sm border-gray-300 rounded focus:border-blue-500 focus:ring-blue-500">
                  </td>
                  <td class="px-6 py-4">
                      <input type="text" id="editor-${r.id}" placeholder="Your Name" value="${escapeHtml(r.updated_by || '')}" class="text-sm w-24 border-gray-300 rounded focus:border-blue-500 focus:ring-blue-500">
                  </td>
                  <td class="px-6 py-4 text-right">
                      <button data-id="${r.id}" class="btn-save-row bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold py-1.5 px-3 rounded transition">Save</button>
                  </td>
                  <td class="px-6 py-4 text-center">
                      ${checkboxHtml}
                  </td>
              `;
        tbody.appendChild(row);

        // Mobile Card
        const statusClass = r.council_status.toLowerCase().replace(' ', '-');
        const card = document.createElement('div');
        card.className = `hcc-card ${statusClass} bg-white rounded-lg border border-gray-200 p-4 shadow-sm`;
        card.dataset.recordId = r.id;

        card.innerHTML = `
                  <div class="flex justify-between items-start mb-3">
                      <div class="flex-1 min-w-0">
                          <h3 class="font-bold text-gray-900 text-base mb-1">${escapeHtml(r.business_name)}</h3>
                          <p class="text-sm text-gray-600">${escapeHtml(r.owner_name)}</p>
                          ${r.registered_business_name ? `<p class="text-xs text-gray-400 font-mono mt-1">${escapeHtml(r.registered_business_name)}</p>` : ''}
                      </div>
                      ${canSelect ? `
                      <label class="flex items-center cursor-pointer ml-2">
                          <input type="checkbox" class="mobile-select w-6 h-6 text-blue-600 rounded border-gray-300 focus:ring-blue-500" value="${r.id}">
                      </label>
                      ` : ''}
                  </div>
                  
                  <div class="grid grid-cols-2 gap-3 mb-3 text-sm">
                      <div>
                          <span class="text-xs uppercase text-gray-400 font-bold block mb-1">Booking ID & Status</span>
                          <p class="text-blue-600 font-bold font-mono text-xs mb-1">${escapeHtml(r.booking_id)}</p>
                          <span class="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${mainStatusColor}">
                              ${mainStatus}
                          </span>
                      </div>
                      <div>
                          <span class="text-xs uppercase text-gray-400 font-bold block mb-1">Submitted</span>
                          <p class="text-gray-700">${new Date(r.submitted_at).toLocaleDateString()}</p>
                      </div>
                  </div>
                  
                  <div class="space-y-3 mb-3">
                      <div>
                          <label class="text-xs uppercase text-gray-400 font-bold block mb-1">Council Status</label>
                          <select id="status-mobile-${r.id}" data-id="${r.id}" class="hcc-mobile-status-select w-full text-sm font-bold rounded px-3 py-2 ${statusColor} focus:ring-2 focus:ring-blue-500">
                              <option value="Pending" ${r.council_status === 'Pending' ? 'selected' : ''}>Pending</option>
                              <option value="Email Sent" ${r.council_status === 'Email Sent' ? 'selected' : ''}>Email Sent</option>
                              <option value="Approved" ${r.council_status === 'Approved' ? 'selected' : ''}>Approved</option>
                              <option value="Rejected" ${r.council_status === 'Rejected' ? 'selected' : ''}>Rejected</option>
                          </select>
                      </div>
                      
                      <div>
                          <label class="text-xs uppercase text-gray-400 font-bold block mb-1">Approval Date</label>
                          <input type="date" id="date-mobile-${r.id}" value="${escapeHtml(r.approval_date || '')}" class="w-full text-sm border-gray-300 rounded px-3 py-2 focus:border-blue-500 focus:ring-blue-500">
                      </div>
                      
                      <div>
                          <label class="text-xs uppercase text-gray-400 font-bold block mb-1">Updated By</label>
                          <input type="text" id="editor-mobile-${r.id}" placeholder="Your Name" value="${escapeHtml(r.updated_by || '')}" class="w-full text-sm border-gray-300 rounded px-3 py-2 focus:border-blue-500 focus:ring-blue-500">
                      </div>
                  </div>
                  
                  <button data-id="${r.id}" class="btn-save-row-mobile w-full bg-blue-600 hover:bg-blue-700 text-white text-sm font-bold py-3 rounded-lg transition">
                      Save Changes
                  </button>
              `;

        mobileContainer.appendChild(card);
    });

    // Attach event listeners dynamically to newly created elements
    document.querySelectorAll('.row-select').forEach(el => {
        el.addEventListener('change', toggleBulkBtn);
    });
    document.querySelectorAll('.mobile-select').forEach(el => {
        el.addEventListener('change', (e) => toggleMobileSelect(e.target, e.target.value));
    });
    document.querySelectorAll('.hcc-status-select').forEach(el => {
        el.addEventListener('change', (e) => updateColor(e.target));
    });
    document.querySelectorAll('.hcc-mobile-status-select').forEach(el => {
        el.addEventListener('change', (e) => {
            updateColor(e.target);
            syncStatus(e.target.dataset.id, e.target.value);
        });
    });
    document.querySelectorAll('.btn-save-row').forEach(el => {
        el.addEventListener('click', (e) => saveRow(e.target.dataset.id));
    });
    document.querySelectorAll('.btn-save-row-mobile').forEach(el => {
        el.addEventListener('click', (e) => saveRowMobile(e.target.dataset.id));
    });

    toggleBulkBtn();
}

// --- UI LOGIC ---

function toggleBulkBtn() {
    const desktopChecked = document.querySelectorAll('.row-select:checked').length;
    const mobileChecked = document.querySelectorAll('.mobile-select:checked').length;
    const totalChecked = desktopChecked + mobileChecked;

    const btn = document.getElementById('btnBulkEmail');
    const countSpan = document.getElementById('selectedCount');

    if (btn) {
        if (totalChecked > 0) {
            btn.classList.remove('hidden');
            if (countSpan) countSpan.textContent = totalChecked;
        } else {
            btn.classList.add('hidden');
        }
    }
}

function filterByStatus() {
    const val = document.getElementById('statusFilter').value;
    let visibleCount = 0;

    // Filter desktop table rows
    const rows = document.querySelectorAll('#hccTableBody tr');
    rows.forEach(row => {
        const select = row.querySelector('select[id^="status-"]');
        if (!select) { row.style.display = ''; return; }
        const match = (val === 'All') || (select.value === val);
        row.style.display = match ? '' : 'none';
        if (match) visibleCount++;
    });

    // Filter mobile cards
    const cards = document.querySelectorAll('#mobile-cards .hcc-card');
    cards.forEach(card => {
        const select = card.querySelector('select[id^="status-mobile-"]');
        if (!select) { card.parentElement.style.display = ''; return; }
        const match = (val === 'All') || (select.value === val);
        card.style.display = match ? '' : 'none';
        if (match) visibleCount++;
    });

    // Update record count badge if present
    const countEl = document.getElementById('filterCount');
    if (countEl) countEl.textContent = val === 'All' ? '' : `${visibleCount} shown`;
}


function toggleMobileSelect(checkbox, recordId) {
    const card = document.querySelector(`[data-record-id="${recordId}"]`);
    if (checkbox.checked) {
        card.classList.add('selected');
    } else {
        card.classList.remove('selected');
    }
    toggleBulkBtn();
}

function syncStatus(recordId, value) {
    // Sync desktop select if it exists
    const desktopSelect = document.getElementById(`status-${recordId}`);
    if (desktopSelect) {
        desktopSelect.value = value;
        updateColor(desktopSelect);
    }
}

// Mobile save function
async function saveRowMobile(id) {
    const status = document.getElementById(`status-mobile-${id}`).value;
    const date = document.getElementById(`date-mobile-${id}`).value;
    const editor = document.getElementById(`editor-mobile-${id}`).value;
    const msg = document.getElementById('statusMsg');

    if (status === 'Approved') {
        if (!date || !editor.trim()) {
            showToast("Approval Date and Updated By are required when setting status to Approved.", 'error');
            return;
        }
    }

    msg.classList.remove('hidden');
    msg.innerText = "Saving...";

    try {
        const { error } = await sb
            .from('hcc_checks')
            .update({
                council_status: status,
                approval_date: date || null,
                updated_by: editor
            })
            .eq('id', id);

        if (error) throw error;

        showToast("Record updated successfully.");
        if (msg) msg.classList.add('hidden');

        // Sync desktop fields
        const desktopStatus = document.getElementById(`status-${id}`);
        const desktopDate = document.getElementById(`date-${id}`);
        const desktopEditor = document.getElementById(`editor-${id}`);
        if (desktopStatus) desktopStatus.value = status;
        if (desktopDate) desktopDate.value = date;
        if (desktopEditor) desktopEditor.value = editor;

        // Log Audit
        const card = document.querySelector(`[data-record-id="${id}"]`);
        const bookingId = card?.querySelector('.text-blue-600.font-bold.font-mono')?.innerText || 'Unknown';
        await auditLog('hcc_mobile_status_updated', bookingId, { new_council_status: status, approval_date: date, editor: editor });

    } catch (err) {
        showToast("Error saving: " + err.message, 'error');
        if (msg) msg.classList.add('hidden');
    }
}



// --- ACTIONS ---

// 1. Send Bulk Email
async function sendBulkEmail() {
    const desktopCheckboxes = document.querySelectorAll('.row-select:checked');
    const mobileCheckboxes = document.querySelectorAll('.mobile-select:checked');
    const allCheckboxes = [...desktopCheckboxes, ...mobileCheckboxes];

    if (allCheckboxes.length === 0) return;

    const ids = Array.from(allCheckboxes).map(cb => cb.value);
    const uniqueIds = [...new Set(ids)]; // Remove duplicates
    const selectedRecords = currentData.filter(r => uniqueIds.includes(r.id));
    const btn = document.getElementById('btnBulkEmail');

    showConfirm(
        "Send Bulk Details",
        `Send details for ${uniqueIds.length} traders to Hull City Council?`,
        async () => {
            const originalContent = btn.innerHTML;
            btn.innerHTML = `<svg class="animate-spin -ml-1 mr-2 h-4 w-4 text-white inline-block align-text-bottom" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg> Sending...`;
            btn.disabled = true;

            try {
                // Fetch template from database
                const { data: template, error: templateErr } = await sb
                    .from('email_templates')
                    .select('subject, body_html')
                    .eq('id', 'hcc_batch_check')
                    .single();

                if (templateErr) throw new Error("Failed to load email template: " + templateErr.message);
                if (!template) throw new Error("HCC Batch Check template not found in database");

                // Build trader list table
                const traderRows = selectedRecords.map(r => `
                  <tr style="border-bottom: 1px solid #ddd;">
                    <td style="padding: 8px; border: 1px solid #ddd; vertical-align: top;">${escapeHtml(r.booking_id)}</td>
                    <td style="padding: 8px; border: 1px solid #ddd; vertical-align: top;">${escapeHtml(r.business_name)}</td>
                    <td style="padding: 8px; border: 1px solid #ddd; vertical-align: top;">${escapeHtml(r.owner_name)}</td>
                    <td style="padding: 8px; border: 1px solid #ddd; vertical-align: top;">${escapeHtml(r.registered_business_name || 'N/A')}</td>
                    <td style="padding: 8px; border: 1px solid #ddd; vertical-align: top;">${escapeHtml(r.bookings?.email || 'N/A')}</td>
                    <td style="padding: 8px; border: 1px solid #ddd; vertical-align: top;">${escapeHtml(r.bookings?.phone || 'N/A')}</td>
                  </tr>
                `).join('');

                const traderTable = `
                  <table style="width: 100%; border-collapse: collapse; margin: 10px 0; font-family: sans-serif; font-size: 13px; table-layout: fixed;">
                    <thead>
                      <tr style="background-color: #f3f4f6;">
                        <th style="padding: 10px; border: 1px solid #ddd; text-align: left; font-weight: bold; width: 12%;">ID</th>
                        <th style="padding: 10px; border: 1px solid #ddd; text-align: left; font-weight: bold; width: 20%;">Business</th>
                        <th style="padding: 10px; border: 1px solid #ddd; text-align: left; font-weight: bold; width: 18%;">Owner</th>
                        <th style="padding: 10px; border: 1px solid #ddd; text-align: left; font-weight: bold; width: 18%;">Registered</th>
                        <th style="padding: 10px; border: 1px solid #ddd; text-align: left; font-weight: bold; width: 20%;">Email</th>
                        <th style="padding: 10px; border: 1px solid #ddd; text-align: left; font-weight: bold; width: 12%;">Phone</th>
                      </tr>
                    </thead>
                    <tbody>
                      ${traderRows}
                    </tbody>
                  </table>
                `;

                // Replace placeholders in template
                const emailBody = template.body_html.replace('{{trader_list}}', traderTable);
                const emailSubject = template.subject;

                const currentInstance = localStorage.getItem('ESF_INSTANCE') || 'DEV';
                const prefix = CONFIG.INSTANCE_MAP[currentInstance] || CONFIG.INSTANCE_MAP['DEV'];

                const { data: { session } } = await sb.auth.getSession();
                const userEmail = session?.user?.email;
                const recipientEmail = (currentInstance === 'DEV' && userEmail)
                    ? userEmail
                    : CONFIG.HCC_COUNCIL_EMAIL;

                // Send Email directly via Zoho
                await sendEmailDirect(recipientEmail, emailSubject, emailBody, null, prefix);

                // Update Records Status
                const { error: updateErr } = await sb
                    .from('hcc_checks')
                    .update({ council_status: 'Email Sent' })
                    .in('id', uniqueIds);

                if (updateErr) throw updateErr;

                showToast(`Email sent for ${uniqueIds.length} records.`);

                // Log Audit for bulk sent
                for (const r of selectedRecords) {
                    await auditLog('hcc_bulk_email_sent', r.booking_id, { batch_size: uniqueIds.length });
                }

                await loadData(); // Refresh table

            } catch (err) {
                showToast("Failed to send email: " + err.message, 'error');
            } finally {
                btn.innerHTML = originalContent;
                btn.disabled = false;
            }
        }
    );
}

// 2. Save Row
async function saveRow(id) {
    const status = document.getElementById(`status-${id}`).value;
    const date = document.getElementById(`date-${id}`).value;
    const editor = document.getElementById(`editor-${id}`).value;
    const msg = document.getElementById('statusMsg');

    if (status === 'Approved') {
        if (!date || !editor.trim()) {
            showToast("Approval Date and Updated By are required when setting status to Approved.", 'error');
            return;
        }
    }

    if (msg) {
        msg.classList.remove('hidden');
        msg.innerText = "Saving...";
    }

    try {
        const { error } = await sb
            .from('hcc_checks')
            .update({
                council_status: status,
                approval_date: date || null,
                updated_by: editor
            })
            .eq('id', id);

        if (error) throw error;

        showToast("Record updated successfully.");
        if (msg) msg.classList.add('hidden');

        const rMatch = currentData.find(r => r.id === id);
        if (rMatch) {
            await auditLog('hcc_status_updated', rMatch.booking_id, { new_council_status: status, approval_date: date, editor: editor });
        }
    } catch (err) {
        showToast("Error saving: " + err.message, 'error');
        if (msg) msg.classList.add('hidden');
    }
}

// 3. Dynamic Color Change
function updateColor(select) {
    select.className = select.className.replace(/bg-\w+-100 text-\w+-800/, '');
    if (select.value === 'Approved') select.classList.add('bg-green-100', 'text-green-800');
    else if (select.value === 'Rejected') select.classList.add('bg-red-100', 'text-red-800');
    else if (select.value === 'Email Sent') select.classList.add('bg-blue-100', 'text-blue-800');
    else select.classList.add('bg-yellow-100', 'text-yellow-800');

    const rowId = select.dataset.id;
    const dateInput = document.getElementById(`date-${rowId}`);
    if (select.value === 'Approved' && !dateInput.value) {
        dateInput.value = new Date().toISOString().split('T')[0];
    }
}

// 4. Save All Changes
async function saveAllChanges() {
    const btn = document.getElementById('btnSaveAll');
    const msg = document.getElementById('statusMsg');

    showConfirm(
        "Save All Changes",
        "Save all changes for all records?",
        async () => {
            if (btn) {
                btn.innerText = "Saving...";
                btn.disabled = true;
            }
            if (msg) {
                msg.classList.remove('hidden');
                msg.innerText = "Saving all changes...";
            }

            try {
                let successCount = 0;
                let failCount = 0;

                // Process all records from currentData
                for (const record of currentData) {
                    const id = record.id;

                    // Try desktop inputs first, fallback to mobile
                    const statusDesktop = document.getElementById(`status-${id}`);
                    const dateDesktop = document.getElementById(`date-${id}`);
                    const editorDesktop = document.getElementById(`editor-${id}`);

                    const statusMobile = document.getElementById(`status-mobile-${id}`);
                    const dateMobile = document.getElementById(`date-mobile-${id}`);
                    const editorMobile = document.getElementById(`editor-mobile-${id}`);

                    // CRITICAL FIX: On mobile, both desktop and mobile elements exist in DOM
                    // Desktop table is just hidden with CSS, but elements are still there
                    // We need to prioritize MOBILE inputs on small screens
                    const isMobileView = window.innerWidth <= 768;

                    // Get values from whichever input is visible
                    let status = '';
                    let date = '';
                    let editor = '';

                    try {
                        if (isMobileView) {
                            // Mobile view: use mobile inputs (they're visible)
                            status = statusMobile ? statusMobile.value : (statusDesktop ? statusDesktop.value : '');
                            date = dateMobile ? dateMobile.value : (dateDesktop ? dateDesktop.value : '');
                            editor = editorMobile ? editorMobile.value : (editorDesktop ? editorDesktop.value : '');
                        } else {
                            // Desktop view: use desktop inputs
                            status = statusDesktop ? statusDesktop.value : (statusMobile ? statusMobile.value : '');
                            date = dateDesktop ? dateDesktop.value : (dateMobile ? dateMobile.value : '');
                            editor = editorDesktop ? editorDesktop.value : (editorMobile ? editorMobile.value : '');
                        }

                        // Validate required fields for Approved status
                        if (status === 'Approved') {
                            if (!date || !editor.trim()) {
                                console.warn(`Record ${id} requires Date and Editor when Approved.`);
                                throw new Error(`Approval Date and Updated By are required for ${record.business_name}`);
                            }
                        }
                    } catch (err) {
                        console.error(`Error reading values for record ${id}:`, err);
                        failCount++;
                        continue;
                    }

                    // Normalize values for comparison (empty string = null for date)
                    const normalizeDate = (val) => val === '' || val === null || val === undefined ? null : val;
                    const normalizeText = (val) => val === '' || val === null || val === undefined ? '' : val;

                    const currentDateNorm = normalizeDate(date);
                    const recordDateNorm = normalizeDate(record.approval_date);
                    const currentEditorNorm = normalizeText(editor);
                    const recordEditorNorm = normalizeText(record.updated_by);

                    // Skip if no changes detected (compare with original record)
                    if (status === record.council_status &&
                        currentDateNorm === recordDateNorm &&
                        currentEditorNorm === recordEditorNorm) {
                        continue;
                    }

                    const updateData = {
                        council_status: status,
                        approval_date: date || null,
                        updated_by: editor || ''
                    };

                    try {
                        const { error } = await sb
                            .from('hcc_checks')
                            .update(updateData)
                            .eq('id', id);

                        if (error) {
                            console.error(`Failed to save record ${id}:`, error);
                            failCount++;
                        } else {
                            successCount++;
                            await auditLog('hcc_bulk_save_updated', record.booking_id, { new_council_status: status, approval_date: date, editor: editor });
                        }
                    } catch (err) {
                        console.error(`Exception saving record ${id}:`, err);
                        failCount++;
                    }
                }

                msg.classList.add('hidden');

                if (successCount > 0) {
                    showToast(`Successfully saved ${successCount} record(s)${failCount > 0 ? `, ${failCount} failed` : ''}.`);
                    await loadData(); // Refresh to show updated data
                } else if (failCount > 0) {
                    showToast(`Failed to save ${failCount} record(s). Check console for details.`, 'error');
                } else {
                    showToast("No changes detected.", 'info');
                }

            } catch (err) {
                console.error('Error in saveAllChanges:', err);
                showToast("Error during save all: " + err.message, 'error');
                if (msg) msg.classList.add('hidden');
            } finally {
                if (btn) {
                    btn.innerText = "Save All Changes";
                    btn.disabled = false;
                }
            }
        }
    );
}
