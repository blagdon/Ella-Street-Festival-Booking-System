import { fetchLocationData, updateLocation } from './api.js';
import { queueLocationEmail } from './shared.js';
import { showToast } from './ui.js';
import { escapeHtml } from './utils.js';

let allBookings = [];
let allLocations = [];
let globalOccupiedIds = [];
let currentFilter = 'all';
let currentMobileBookingId = null;

export async function initLocations() {
    initInstanceBadge();
    await loadData();
}

function initInstanceBadge() {
    const instance = localStorage.getItem('ESF_INSTANCE') || 'DEV';
    const badge = document.getElementById('instanceBadge');
    if (badge) {
        if (instance === 'FOOD') {
            badge.className = "bg-red-100 text-red-800 text-xs font-bold px-2 py-1 rounded uppercase tracking-wide";
            badge.innerText = "Food Stalls";
        } else if (instance === 'GENERAL') {
            badge.className = "bg-blue-100 text-blue-800 text-xs font-bold px-2 py-1 rounded uppercase tracking-wide";
            badge.innerText = "Non-Food";
        } else if (instance === 'MISC') {
            badge.className = "bg-purple-100 text-purple-800 text-xs font-bold px-2 py-1 rounded uppercase tracking-wide";
            badge.innerText = "Misc / Facilities";
        } else {
            badge.className = "bg-green-100 text-green-800 text-xs font-bold px-2 py-1 rounded uppercase tracking-wide";
            badge.innerText = "Dev Environment";
        }
    }
}

export async function loadData() {
    const statusEl = document.getElementById('statusMsg');
    if (statusEl) {
        statusEl.innerText = "Loading...";
        statusEl.classList.remove('hidden');
    }

    try {
        const instance = localStorage.getItem('ESF_INSTANCE') || 'DEV';
        const response = await fetchLocationData(instance);
        allBookings = response.bookings || [];
        allLocations = response.locations || [];
        globalOccupiedIds = response.occupied_ids || [];
        renderTable();
        renderMobileCards();
    } catch (err) {
        showToast("Error loading data: " + (err.message || err), 'error');
    } finally {
        if (statusEl) statusEl.classList.add('hidden');
    }
}

function renderTable() {
    const tbody = document.getElementById('tableBody');
    if (!tbody) return;
    tbody.innerHTML = '';

    // 1. CALCULATE OCCUPIED SET
    const occupiedSet = new Set(
        globalOccupiedIds.filter(id => id && id !== "")
    );

    // 2. APPLY FILTER
    const filtered = allBookings.filter(b => {
        if (currentFilter === 'unassigned') return !b.location_id;
        if (currentFilter === 'assigned') return b.location_id;
        return true;
    });

    // 3. SORT MASTER LIST
    const sortedLocs = [...allLocations].sort((a, b) =>
        a.id.toString().localeCompare(b.id.toString(), undefined, { numeric: true })
    );

    filtered.forEach(b => {
        const row = document.createElement('tr');
        row.className = 'hover-row group';
        const isAssigned = b.location_id && b.location_id !== "";

        const validOptions = sortedLocs.filter(l =>
            !occupiedSet.has(l.id) || l.id == b.location_id
        );

        let optionsHtml = validOptions.map(l => {
            const safeId = escapeHtml(l.id);
            return `<option value="${safeId}" ${l.id == b.location_id ? 'selected' : ''}>${safeId}</option>`;
        }).join('');

        if (b.location_id && !allLocations.find(l => l.id == b.location_id)) {
            optionsHtml = `<option value="${b.location_id}" selected>${b.location_id} (Custom)</option>` + optionsHtml;
        }

        row.innerHTML = `
        <td class="px-6 py-4 text-xs font-mono text-gray-400">${b.id}</td>
        <td class="px-6 py-4">
            <p class="text-sm md:text-sm text-xs font-bold text-gray-800">${escapeHtml(b.business || b.business_name)}</p>
            <p class="text-xs text-gray-500">${escapeHtml(b.owner || b.owner_name)}</p>
        </td>
        <td class="px-6 py-4 hide-mobile">
            <span class="text-xs bg-gray-100 text-gray-600 px-2 py-1 rounded">${escapeHtml(b.stall_type || 'General')}</span>
            ${b.power_required && b.power_required !== 'No power' ? '<span class="ml-1 text-xs bg-yellow-100 text-yellow-700 px-2 py-1 rounded">⚡ Power</span>' : ''}
        </td>
        <td class="px-6 py-4">
            <div class="relative">
                <select data-action="assign-location" data-id="${b.id}" 
                        class="block w-full text-sm md:text-sm text-xs border-gray-300 rounded-md shadow-sm focus:border-blue-500 focus:ring focus:ring-blue-200 focus:ring-opacity-50 bg-white py-1 pl-2 pr-8 ${isAssigned ? 'font-bold text-blue-700' : 'text-gray-500 italic'}">
                    <option value="">-- Unassigned --</option>
                    ${optionsHtml}
                </select>
            </div>
        </td>
        <td class="px-6 py-4 text-center">
            ${isAssigned ?
                `<button data-action="send-email" data-id="${b.id}" class="text-gray-400 hover:text-blue-600 transition" title="Send Confirmation Email">
                    <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"></path></svg>
                </button>`
                : '<span class="text-gray-200">-</span>'}
        </td>
        `;
        tbody.appendChild(row);
    });
}

export async function assignLocation(id, newLocId) {
    try {
        const statusEl = document.getElementById('statusMsg');
        if (statusEl) {
            statusEl.innerText = "Saving...";
            statusEl.classList.remove('hidden');
        }

        await updateLocation(id, newLocId);

        // Update local model
        const b = allBookings.find(x => x.id === id);
        if (b) b.location_id = newLocId;

        if (newLocId) globalOccupiedIds.push(newLocId);

        renderTable();
        renderMobileCards();
        showToast("Location Saved");

    } catch (err) {
        showToast("Save Failed: " + (err.message || err), 'error');
    } finally {
        const statusEl = document.getElementById('statusMsg');
        if (statusEl) statusEl.classList.add('hidden');
    }
}

export async function sendEmail(id) {
    if (!confirm("Send confirmation email to this stallholder?")) return;

    try {
        const statusEl = document.getElementById('statusMsg');
        if (statusEl) {
            statusEl.innerText = "Queuing Email...";
            statusEl.classList.remove('hidden');
        }
        await queueLocationEmail(id);
        showToast("Email Added to Queue");
    } catch (err) {
        showToast("Email Failed: " + (err.message || err), 'error');
    } finally {
        const statusEl = document.getElementById('statusMsg');
        if (statusEl) statusEl.classList.add('hidden');
    }
}

export async function sendBulkEmails() {
    const targets = allBookings.filter(b => b.location_id && b.location_id !== "");
    if (targets.length === 0) {
        showToast("No assigned bookings found.", 'warning');
        return;
    }

    if (!confirm(`Send emails to ALL ${targets.length} assigned stalls?`)) return;

    let count = 0;
    const statusEl = document.getElementById('statusMsg');
    if (statusEl) statusEl.classList.remove('hidden');

    for (const b of targets) {
        count++;
        try {
            if (statusEl) statusEl.innerText = `Queuing ${count}/${targets.length}...`;
            await queueLocationEmail(b.id);
        } catch (e) {
            // Silently continue
        }
        await new Promise(r => setTimeout(r, 50));
    }

    if (statusEl) statusEl.classList.add('hidden');
    showToast(`Queued ${count} Emails`);
}

export function setFilter(type) {
    currentFilter = type;
    ['all', 'unassigned', 'assigned'].forEach(t => {
        const btn = document.getElementById(`btn-filter-${t}`);
        if (btn) {
            btn.className = (t === type)
                ? "px-3 py-2 min-h-11 text-xs font-bold rounded-md bg-white shadow text-gray-800 active:bg-gray-100 transition-colors"
                : "px-3 py-2 min-h-11 text-xs font-bold rounded-md text-gray-500 hover:bg-white hover:shadow active:bg-gray-100 transition-colors";
        }
    });
    renderTable();
    renderMobileCards();
}


// ==========================================
// MOBILE FEATURES
// ==========================================

function renderMobileCards() {
    const container = document.getElementById('mobileCards');
    if (!container) return;

    container.innerHTML = '';

    // Calculate stats
    const totalCount = allBookings.length;
    const assignedCount = allBookings.filter(b => b.location_id).length;
    const unassignedCount = totalCount - assignedCount;

    const elTotal = document.getElementById('mobile-total');
    if (elTotal) elTotal.textContent = totalCount;
    const elAssigned = document.getElementById('mobile-assigned');
    if (elAssigned) elAssigned.textContent = assignedCount;
    const elUnassigned = document.getElementById('mobile-unassigned');
    if (elUnassigned) elUnassigned.textContent = unassignedCount;

    // Filter bookings
    const filtered = allBookings.filter(b => {
        if (currentFilter === 'unassigned') return !b.location_id;
        if (currentFilter === 'assigned') return b.location_id;
        return true;
    });

    if (filtered.length === 0) {
        container.innerHTML = '<div class="text-center py-10 text-gray-400">No bookings found</div>';
        return;
    }

    filtered.forEach(booking => {
        const card = document.createElement('div');
        const isAssigned = booking.location_id && booking.location_id !== '';
        card.className = `location-card ${isAssigned ? 'assigned' : 'unassigned'}`;

        // Create email button element if assigned
        let emailButtonHtml = '';
        if (isAssigned) {
            emailButtonHtml = `
                <button class="email-btn ml-2 p-2 text-blue-600 hover:bg-blue-50 rounded-lg transition" 
                        data-action="send-email" data-id="${escapeHtml(booking.id)}">
                    <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"></path>
                    </svg>
                </button>
            `;
        }

        card.innerHTML = `
            <div class="flex justify-between items-start mb-3">
                <div class="flex-1">
                    <div class="font-bold text-gray-900 mb-1">${escapeHtml(booking.business || booking.business_name)}</div>
                    <div class="text-sm text-gray-600">${escapeHtml(booking.owner || booking.owner_name)}</div>
                </div>
                ${emailButtonHtml}
            </div>
            
            <div class="flex flex-wrap gap-2 mb-3">
                <span class="mobile-action-pill bg-gray-100 text-gray-700">
                    ${escapeHtml(booking.stall_type || 'General')}
                </span>
                ${(booking.power === '⚡' || (booking.power_required && booking.power_required !== 'No power')) ?
                '<span class="mobile-action-pill bg-yellow-100 text-yellow-700">⚡ Power</span>' : ''}
            </div>
            
            <div class="flex justify-between items-center">
                <div class="text-xs text-gray-400 font-mono">${escapeHtml(booking.id)}</div>
                <button class="location-btn mobile-action-pill ${isAssigned ? 'bg-green-100 text-green-700' : 'bg-yellow-100 text-yellow-700'}" 
                        data-action="open-location-sheet" data-id="${escapeHtml(booking.id)}">
                    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z"></path>
                    </svg>
                    ${isAssigned ? escapeHtml(booking.location_id) : 'Assign Location'}
                </button>
            </div>
        `;

        container.appendChild(card);
    });
}

export function openLocationSheet(bookingId) {
    const booking = allBookings.find(b => b.id === bookingId);
    if (!booking) return;

    currentMobileBookingId = bookingId;

    const infoEl = document.getElementById('sheetBookingInfo');
    if (infoEl) {
        infoEl.innerHTML = `
            <div class="font-semibold text-gray-900">${escapeHtml(booking.business || booking.business_name)}</div>
            <div class="text-xs text-gray-500 mt-1">
                ${escapeHtml(booking.stall_type || 'General')} 
                ${(booking.power === '⚡' || (booking.power_required && booking.power_required !== 'No power')) ? ' • ⚡ Needs Power' : ''}
            </div>
        `;
    }

    // Build location options
    const occupiedSet = new Set(
        globalOccupiedIds.filter(id => id && id !== "")
    );

    const sortedLocs = [...allLocations].sort((a, b) =>
        a.id.toString().localeCompare(b.id.toString(), undefined, { numeric: true })
    );

    const optionsContainer = document.getElementById('locationOptions');
    if (optionsContainer) {
        optionsContainer.innerHTML = '';

        // Add unassigned
        const unassignedOption = document.createElement('div');
        unassignedOption.className = 'location-option' + (!booking.location_id ? ' current' : ' available');
        unassignedOption.innerHTML = `
            <div>
                <div class="font-semibold text-gray-700">Unassigned</div>
                <div class="text-xs text-gray-500">No location assigned</div>
            </div>
            ${!booking.location_id ? '<svg class="w-5 h-5 text-blue-600" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd"></path></svg>' : ''}
        `;
        unassignedOption.addEventListener('click', () => assignMobileLocation(null));
        optionsContainer.appendChild(unassignedOption);

        sortedLocs.forEach(loc => {
            const isOccupied = occupiedSet.has(loc.id) && loc.id !== booking.location_id;
            const isCurrent = loc.id === booking.location_id;

            if (!isOccupied || isCurrent) {
                const option = document.createElement('div');
                option.className = `location-option ${isCurrent ? 'current' : 'available'}`;

                option.innerHTML = `
                    <div class="flex-1">
                        <div class="font-semibold ${isCurrent ? 'text-blue-700' : 'text-gray-900'}">${escapeHtml(loc.id)}</div>
                        <div class="text-xs text-gray-500">
                            ${loc.has_power ? '⚡ Power' : 'No power'}
                            ${loc.size ? ' • ' + escapeHtml(loc.size) : ''}
                        </div>
                    </div>
                    ${isCurrent ?
                        '<svg class="w-5 h-5 text-blue-600" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd"></path></svg>'
                        : ''}
                `;

                option.addEventListener('click', () => assignMobileLocation(loc.id));
                optionsContainer.appendChild(option);
            }
        });
    }

    // Show sheet
    const backdrop = document.getElementById('locationSheetBackdrop');
    const sheet = document.getElementById('locationSheet');
    if (backdrop) backdrop.classList.add('open');
    if (sheet) sheet.classList.add('open');
}

export function closeLocationSheet() {
    const backdrop = document.getElementById('locationSheetBackdrop');
    const sheet = document.getElementById('locationSheet');
    if (backdrop) backdrop.classList.remove('open');
    if (sheet) sheet.classList.remove('open');
    currentMobileBookingId = null;
}

export async function assignMobileLocation(locationId) {
    const bookingId = currentMobileBookingId;
    if (!bookingId) return;

    closeLocationSheet();
    await assignLocation(bookingId, locationId || '');
}

// ==========================================
// PULL TO REFRESH
// ==========================================
let pullStartY = 0;
let isPulling = false;

window.addEventListener('touchstart', (e) => {
    if (window.scrollY === 0 && window.innerWidth < 768) {
        pullStartY = e.touches[0].clientY;
    }
}, { passive: true });

window.addEventListener('touchmove', (e) => {
    if (window.scrollY === 0 && pullStartY > 0 && window.innerWidth < 768) {
        const pullDistance = e.touches[0].clientY - pullStartY;
        const pullIndicator = document.getElementById('pullIndicator');
        const pullText = document.getElementById('pullText');

        if (pullIndicator && pullDistance > 60 && !isPulling) {
            isPulling = true;
            pullIndicator.classList.add('pulling');
            if (pullText) pullText.textContent = 'Release to refresh';
        } else if (pullIndicator && pullDistance < 60 && isPulling) {
            isPulling = false;
            pullIndicator.classList.remove('pulling');
            if (pullText) pullText.textContent = 'Pull to refresh';
        }
    }
}, { passive: true });

window.addEventListener('touchend', (e) => {
    if (isPulling && window.innerWidth < 768) {
        const pullIndicator = document.getElementById('pullIndicator');
        const spinner = document.getElementById('pullSpinner');
        const pullText = document.getElementById('pullText');

        if (pullText) pullText.textContent = 'Refreshing...';
        if (spinner) spinner.classList.remove('hidden');

        loadData().then(() => {
            setTimeout(() => {
                if (pullIndicator) pullIndicator.classList.remove('pulling');
                if (spinner) spinner.classList.add('hidden');
                if (pullText) pullText.textContent = 'Pull to refresh';
                isPulling = false;
                pullStartY = 0;
            }, 500);
        });
    } else {
        pullStartY = 0;
    }
});

export function closeConfirmModal() {
    // Need to implement this if it is used
}

export function confirmAction() {
    // Need to implement this if it is used
}
