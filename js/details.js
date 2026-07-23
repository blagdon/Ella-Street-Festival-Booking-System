import { fetchKanbanData, updateBookingDetails, LIST_CAP } from './api.js';
import { showToast, notifyIfTruncated } from './ui.js';
import { escapeHtml, safeError } from './utils.js';
import { CONFIG } from './config.js';

let allBookings = [];
let currentId = null;
let originalValues = {};
const trackedFields = ['editBusiness', 'editOwner', 'editCategory', 'editType', 'editEmail', 'editPhone', 'editPower', 'editHouse', 'editWebsite', 'editDesc', 'editOther', 'editResident', 'editCharity'];

export function initDetails() {
    populateDropdowns();
    loadBookings();

    // Attach event listeners for dirty checking
    document.addEventListener('input', checkDirty);
    document.addEventListener('change', checkDirty);
}

function checkDirty(e) {
    const el = e.target;
    if (trackedFields.includes(el.id) && originalValues.hasOwnProperty(el.id)) {
        el.classList.toggle('field-dirty', el.value !== originalValues[el.id]);
    }
}

function populateDropdowns() {
    // Populate Stall Type Dropdown from Config
    const typeSelect = document.getElementById('editType');
    if (!typeSelect) return;

    // Add default option if empty (it might have been cleared or not init)
    if (typeSelect.options.length === 0) {
        const defOpt = document.createElement('option');
        defOpt.value = "";
        defOpt.innerText = "-- Select Type --";
        typeSelect.appendChild(defOpt);
    }

    if (CONFIG && CONFIG.UI && CONFIG.UI.ALLOWED_TYPES) {
        // Clear existing except first if needed, but here we assume it's fresh or we append
        // Actually best to clear and re-add
        typeSelect.innerHTML = '<option value="">-- Select Type --</option>';
        CONFIG.UI.ALLOWED_TYPES.forEach(type => {
            const opt = document.createElement('option');
            opt.value = type;
            opt.innerText = type;
            typeSelect.appendChild(opt);
        });
    }
}

// 1. FETCH DATA
export async function loadBookings() {
    const listEl = document.getElementById('bookingList');
    if (listEl) listEl.innerHTML = '<div class="text-center p-4 text-gray-400 text-xs">Loading...</div>';

    try {
        // Reuse fetchKanbanData which returns list of bookings for current instance?
        // fetchKanbanData returns all bookings for instance. adapting row is done inside?
        // wait, fetchKanbanData in api.js calls 'kanban' action which calls adaptRow.
        // update_details original used 'summary' action which is identical to 'kanban'.
        // So we can use fetchKanbanData().

        const instance = localStorage.getItem('ESF_INSTANCE') || 'DEV';
        const data = await fetchKanbanData(instance); // This function is already in api.js
        allBookings = data;
        notifyIfTruncated(data, LIST_CAP, 'bookings');
        renderList(data);
        const countEl = document.getElementById('countDisplay');
        if (countEl) countEl.innerText = `${data.length} bookings loaded`;
    } catch (err) {
        const safeMsg = (typeof safeError === 'function') ? safeError(err) : (err.message || err);
        if (listEl) listEl.innerHTML = `<div class="text-center p-4 text-red-500 text-xs">Error: ${escapeHtml(safeMsg)}</div>`;
    }
}

// 2. RENDER LIST
function renderList(data) {
    const listEl = document.getElementById('bookingList');
    if (!listEl) return;
    listEl.innerHTML = '';

    if (data.length === 0) {
        listEl.innerHTML = '<div class="text-center p-4 text-gray-400 text-xs">No bookings found.</div>';
        return;
    }

    data.forEach(item => {
        const div = document.createElement('div');
        div.className = 'p-3 rounded-lg hover:bg-blue-50 cursor-pointer border border-transparent hover:border-blue-100 transition-colors group';
        div.onclick = () => selectBooking(item.id);
        div.id = `item-${item.id}`;

        div.innerHTML = `
            <div class="flex justify-between items-start mb-0.5">
                <span class="font-bold text-sm text-gray-800 group-hover:text-blue-700 truncate">${escapeHtml(item.business_name || item.business || 'Unknown Business')}</span>
                <span class="text-xs bg-gray-100 text-gray-500 px-1.5 rounded shrink-0 whitespace-nowrap">${escapeHtml(item.status)}</span>
            </div>
            <div class="text-xs text-gray-500">${escapeHtml(item.owner_name || item.owner || 'Unknown Owner')}</div>
            <div class="font-mono text-xs text-gray-400 mt-0.5">${item.id}</div>
        `;
        listEl.appendChild(div);
    });
}

// 3. FILTER
export function filterList() {
    const term = document.getElementById('searchInput').value.toLowerCase();
    const filtered = allBookings.filter(b =>
        (b.business_name || b.business || "").toLowerCase().includes(term) ||
        (b.owner_name || b.owner || "").toLowerCase().includes(term) ||
        (b.id || "").toLowerCase().includes(term) ||
        (b.email || "").toLowerCase().includes(term)
    );
    renderList(filtered);
}

// 4. SELECT & POPULATE FORM
export function selectBooking(id) {
    const item = allBookings.find(b => b.id === id);
    if (!item) return;

    currentId = id;

    // Mobile: switch to detail view
    const viewContainer = document.getElementById('mobile-view-container');
    if (viewContainer) viewContainer.classList.add('mobile-detail-active');

    // Highlight selected in list
    document.querySelectorAll('#bookingList > div').forEach(d => d.classList.remove('bg-blue-100', 'border-blue-300'));
    const activeItem = document.getElementById(`item-${id}`);
    if (activeItem) activeItem.classList.add('bg-blue-100', 'border-blue-300');

    // Hide Empty State, Show Form
    const emptyState = document.getElementById('emptyState');
    if (emptyState) emptyState.classList.add('hidden');

    const form = document.getElementById('formContainer');
    if (form) form.classList.remove('opacity-0');

    // Enable Save Button
    const btn = document.getElementById('saveBtn');
    if (btn) {
        btn.disabled = false;
        btn.classList.remove('opacity-50', 'cursor-not-allowed');
    }

    // Populate Fields
    setText('edit-id-badge', item.id);

    const statusBadge = document.getElementById('status-badge');
    if (statusBadge) {
        statusBadge.innerText = item.status;
        if (item.status === 'Confirmed') statusBadge.className = "px-3 py-1 rounded-full text-xs font-bold uppercase bg-green-100 text-green-700";
        else if (item.status === 'Rejected') statusBadge.className = "px-3 py-1 rounded-full text-xs font-bold uppercase bg-red-100 text-red-700";
        else statusBadge.className = "px-3 py-1 rounded-full text-xs font-bold uppercase bg-yellow-100 text-yellow-800";
    }

    const raw = item._raw || item;

    setVal('editBusiness', raw.business_name || raw.business || ""); // business_name is db field
    setVal('editOwner', raw.owner_name || raw.owner || "");
    setVal('editCategory', raw.category || "");
    setVal('editType', raw.stall_type || "");
    setVal('editEmail', raw.email || "");
    setVal('editPhone', raw.phone || "");

    const powerValue = item.power_required || item.power || 'No power';
    setVal('editPower', powerValue);

    setVal('editHouse', raw.address || raw.house || ""); // address is db field
    setVal('editWebsite', raw.website || "");
    setVal('editResident', (item.is_resident === true || item.is_resident === 'true') ? 'true' : 'false');

    const charityValue = item.is_charity || 'Commercial';
    setVal('editCharity', charityValue);

    setVal('editDesc', raw.description || "");
    setVal('editOther', raw.other_requirements || raw.other || "");

    // Store originals and clear dirty highlights
    originalValues = {};
    trackedFields.forEach(fid => {
        const el = document.getElementById(fid);
        if (el) {
            originalValues[fid] = el.value;
            el.classList.remove('field-dirty');
        }
    });
}

// 5. SAVE CHANGES
export async function saveChanges() {
    if (!currentId) return;

    const btn = document.getElementById('saveBtn');
    if (btn) {
        btn.innerText = "Saving...";
        btn.disabled = true;
    }

    const payload = {
        id: currentId,
        business: getVal('editBusiness'),
        owner: getVal('editOwner'),
        category: getVal('editCategory'),
        type: getVal('editType'),
        email: getVal('editEmail'),
        phone: getVal('editPhone'),
        power: getVal('editPower'),
        house: getVal('editHouse'),
        website: getVal('editWebsite'),
        description: getVal('editDesc'),
        other: getVal('editOther'),
        is_resident: getVal('editResident') === 'true',
        is_charity: getVal('editCharity')
    };

    try {
        await updateBookingDetails(payload);

        // Success Feedback
        if (typeof showToast === 'function') {
            showToast("Changes saved successfully", 'success');
        } else {
            const statusEl = document.getElementById('saveStatus');
            if (statusEl) statusEl.classList.remove('hidden');
            setTimeout(() => { if (statusEl) statusEl.classList.add('hidden'); }, 3000);
        }

        // Clear dirty highlights and update originals
        trackedFields.forEach(fid => {
            const el = document.getElementById(fid);
            if (el) { el.classList.remove('field-dirty'); originalValues[fid] = el.value; }
        });

        // Update Local Data
        const idx = allBookings.findIndex(b => b.id === currentId);
        if (idx > -1) {
            const updated = {
                ...allBookings[idx],
                business: payload.business,
                business_name: payload.business,
                owner: payload.owner,
                owner_name: payload.owner,
                category: payload.category,
                stall_type: payload.type,
                type: payload.type,
                email: payload.email,
                phone: payload.phone,
                power: payload.power,
                power_required: payload.power,
                house: payload.house,
                address: payload.house,
                website: payload.website,
                description: payload.description,
                other: payload.other,
                other_requirements: payload.other,
                is_resident: payload.is_resident,
                is_charity: payload.is_charity,
                status: allBookings[idx].status
            };

            if (allBookings[idx]._raw) {
                updated._raw = {
                    ...allBookings[idx]._raw,
                    business_name: payload.business,
                    owner_name: payload.owner,
                    category: payload.category,
                    stall_type: payload.type,
                    email: payload.email,
                    phone: payload.phone,
                    power_required: payload.power,
                    address: payload.house,
                    website: payload.website,
                    description: payload.description,
                    other_requirements: payload.other,
                    is_resident: payload.is_resident,
                    is_charity: payload.is_charity
                };
            }

            allBookings[idx] = updated;

            // Refresh list item display
            renderList(allBookings);
            // Reselect to keep highlighted
            selectBooking(currentId);
        }

    } catch (err) {
        showToast("Error saving: " + err.message, 'error');
    } finally {
        if (btn) {
            btn.innerText = "Save Changes";
            btn.disabled = false;
        }
    }
}

// Helpers
function setText(id, text) {
    const el = document.getElementById(id);
    if (el) el.innerText = text;
}
function setVal(id, val) {
    const el = document.getElementById(id);
    if (el) el.value = val;
}
function getVal(id) {
    const el = document.getElementById(id);
    return el ? el.value : '';
}

// Mobile: navigate back from detail pane to list
export function backToList() {
    const viewContainer = document.getElementById('mobile-view-container');
    if (viewContainer) viewContainer.classList.remove('mobile-detail-active');
}
