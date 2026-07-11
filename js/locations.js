import { fetchLocationData, updateLocation } from './api.js';
import { queueLocationEmail } from './shared.js';
import { showToast } from './ui.js';
import { escapeHtml } from './utils.js';

let allBookings = [];
let allLocations = [];
let globalOccupiedIds = [];
let currentFilter = 'all';
let currentMobileBookingId = null;
let activeConfirmCallback = null;

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
    const occupiedSet = new Set();
    globalOccupiedIds.forEach(id => {
        if (id) {
            id.split(',').forEach(part => {
                const trimmed = part.trim();
                if (trimmed) occupiedSet.add(trimmed);
            });
        }
    });

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

        const assignedLocs = b.location_id 
            ? b.location_id.split(',').map(s => s.trim()).filter(s => s !== "")
            : [];
        const isAssigned = assignedLocs.length > 0;

        // Render badges
        const badgesHtml = assignedLocs.map(loc => {
            const safeLoc = escapeHtml(loc);
            return `
            <span class="inline-flex items-center gap-1 bg-blue-100 text-blue-800 text-xs font-bold px-2 py-1 rounded">
                ${safeLoc}
                <button data-action="remove-allocated-location" data-booking-id="${b.id}" data-location-id="${safeLoc}" class="text-blue-500 hover:text-blue-700 font-bold ml-0.5 text-sm leading-none focus:outline-none" title="Remove Location">×</button>
            </span>`;
        }).join('');

        // Find available locations that are not occupied
        const availableLocs = sortedLocs.filter(l => !occupiedSet.has(l.id));

        const addSelectHtml = `
        <select data-action="add-allocated-location" data-booking-id="${b.id}" class="hidden inline-block text-xs border-gray-300 rounded bg-white py-0.5 px-1 focus:ring-1 focus:ring-blue-500">
            <option value="">-- Select location --</option>
            ${availableLocs.map(l => `<option value="${escapeHtml(l.id)}">${escapeHtml(l.id)}</option>`).join('')}
            <option value="__cancel__">-- Cancel --</option>
        </select>`;

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
            <div class="flex flex-wrap gap-1.5 items-center">
                ${badgesHtml}
                <button data-action="show-add-select" class="inline-flex items-center gap-0.5 bg-gray-100 hover:bg-gray-200 text-gray-600 text-xs font-bold px-2 py-1 rounded transition-colors focus:outline-none" title="Add Location">
                    + Add
                </button>
                ${addSelectHtml}
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

        // Rebuild globalOccupiedIds based on active local model
        globalOccupiedIds = [];
        allBookings.forEach(x => {
            if (x.location_id) {
                x.location_id.split(',').forEach(part => {
                    const trimmed = part.trim();
                    if (trimmed) globalOccupiedIds.push(trimmed);
                });
            }
        });

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
    showConfirmModal(
        "Send Email",
        "Send confirmation email to this stallholder?",
        async () => {
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
    );
}

export async function sendBulkEmails() {
    const targets = allBookings.filter(b => b.location_id && b.location_id !== "");
    if (targets.length === 0) {
        showToast("No assigned bookings found.", 'warning');
        return;
    }

    showConfirmModal(
        "Send Bulk Emails",
        `Send emails to ALL ${targets.length} assigned stalls?`,
        async () => {
            let count = 0;
            let failedCount = 0;
            const failedIds = [];
            const statusEl = document.getElementById('statusMsg');
            if (statusEl) statusEl.classList.remove('hidden');

            const btn = document.getElementById('btn-send-bulk-emails');
            const originalContent = btn ? btn.innerHTML : '';
            if (btn) {
                btn.innerHTML = `<svg class="animate-spin -ml-1 mr-2 h-4 w-4 text-white inline-block align-text-bottom" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg> Sending...`;
                btn.disabled = true;
            }

            try {
                for (const b of targets) {
                    count++;
                    try {
                        if (statusEl) statusEl.innerText = `Queuing ${count}/${targets.length}...`;
                        await queueLocationEmail(b.id);
                    } catch (e) {
                        failedCount++;
                        failedIds.push(b.id);
                        console.warn(`Failed to queue location email for ${b.id}:`, e);
                    }
                    await new Promise(r => setTimeout(r, 50));
                }

                if (statusEl) statusEl.classList.add('hidden');
                if (failedCount > 0) {
                    showToast(`Queued ${count - failedCount} emails. Failed: ${failedCount} (IDs: ${failedIds.join(', ')})`, 'warning');
                } else {
                    showToast(`Queued all ${count} Emails successfully.`);
                }
            } finally {
                if (btn) {
                    btn.innerHTML = originalContent;
                    btn.disabled = false;
                }
                if (statusEl) statusEl.classList.add('hidden');
            }
        }
    );
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
        const assignedLocs = booking.location_id 
            ? booking.location_id.split(',').map(s => s.trim()).filter(s => s !== "")
            : [];
        const isAssigned = assignedLocs.length > 0;
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

        // Render multiple badges for location display on mobile card
        const badgesHtml = assignedLocs.map(loc => {
            return `<span class="bg-blue-100 text-blue-800 text-xs font-bold px-2 py-0.5 rounded">${escapeHtml(loc)}</span>`;
        }).join('');

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
                <div class="flex items-center gap-2">
                    <div class="flex flex-wrap gap-1 max-w-[150px] justify-end">
                        ${badgesHtml}
                    </div>
                    <button class="location-btn mobile-action-pill ${isAssigned ? 'bg-green-100 text-green-700' : 'bg-yellow-100 text-yellow-700'}" 
                            data-action="open-location-sheet" data-id="${escapeHtml(booking.id)}">
                        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z"></path>
                        </svg>
                        ${isAssigned ? 'Manage' : 'Assign'}
                    </button>
                </div>
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
    const occupiedSet = new Set();
    globalOccupiedIds.forEach(id => {
        if (id) {
            id.split(',').forEach(part => {
                const trimmed = part.trim();
                if (trimmed) occupiedSet.add(trimmed);
            });
        }
    });

    const assignedLocs = booking.location_id 
        ? booking.location_id.split(',').map(s => s.trim()).filter(s => s !== "")
        : [];

    const sortedLocs = [...allLocations].sort((a, b) =>
        a.id.toString().localeCompare(b.id.toString(), undefined, { numeric: true })
    );

    const optionsContainer = document.getElementById('locationOptions');
    if (optionsContainer) {
        optionsContainer.innerHTML = '';

        sortedLocs.forEach(loc => {
            const isCurrent = assignedLocs.includes(loc.id);
            const isOccupied = occupiedSet.has(loc.id) && !isCurrent;

            if (!isOccupied || isCurrent) {
                const option = document.createElement('div');
                option.className = `location-option ${isCurrent ? 'current' : 'available'} cursor-pointer`;

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

                option.addEventListener('click', async () => {
                    let newAssignedLocs;
                    if (isCurrent) {
                        newAssignedLocs = assignedLocs.filter(x => x !== loc.id);
                    } else {
                        newAssignedLocs = [...assignedLocs, loc.id];
                    }
                    const newLocationString = newAssignedLocs.join(', ');
                    await assignLocation(bookingId, newLocationString);
                    openLocationSheet(bookingId); // Re-open dynamically to refresh option list
                });
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

export function showConfirmModal(title, message, onConfirm) {
    const modal = document.getElementById('confirmModal');
    const titleEl = document.getElementById('confirmTitle');
    const msgEl = document.getElementById('confirmMessage');

    if (!modal) return;

    if (titleEl) titleEl.innerText = title;
    if (msgEl) msgEl.innerText = message;

    activeConfirmCallback = onConfirm;

    modal.classList.remove('opacity-0', 'pointer-events-none');
}

export function closeConfirmModal() {
    const modal = document.getElementById('confirmModal');
    if (modal) {
        modal.classList.add('opacity-0', 'pointer-events-none');
    }
    activeConfirmCallback = null;
}

export function confirmAction() {
    if (typeof activeConfirmCallback === 'function') {
        activeConfirmCallback();
    }
    closeConfirmModal();
}
