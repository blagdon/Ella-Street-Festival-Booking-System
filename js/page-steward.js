import { getSupabaseClient, initAdminPage } from './supabase.js';
import { safeError, validateBookingId, escapeHtml } from './utils.js';
import { auditLog } from './api.js';

// --- 1. CONFIGURATION (uses modules) ---
const sb = getSupabaseClient();

const DB_KEY = 'steward_data';
const LOCS_KEY = 'steward_locations_master';
const QUEUE_KEY = 'steward_sync_queue';

let localData = [];
let masterLocations = [];
let currentEditId = null;

// --- 2. INITIALIZATION ---
async function initSteward() {
    // B. Load Data
    loadFromLocal();
    updateQueueBadge();

    if (navigator.onLine) {
        await processSyncQueue();
        await syncDown();
    } else {
        document.getElementById('loading').classList.add('hidden');
    }

    // C. UI Setup
    document.getElementById('searchInput').addEventListener('input', (e) => renderList(e.target.value));

    window.addEventListener('online', async () => {
        updateStatus(true);
        // Refresh auth session first (may have expired while offline)
        try { await sb.auth.getSession(); } catch (e) { }
        // Sync queued changes BEFORE pulling fresh data
        await processSyncQueue();
        await syncDown();
        updateQueueBadge();
    });
    window.addEventListener('offline', () => {
        updateStatus(false);
        updateQueueBadge();
    });

    // Event delegation
    document.body.addEventListener('click', (e) => {
        const closeModalBtn = e.target.closest('[data-action="close-modal"]');
        if (closeModalBtn) {
            closeModal();
            return;
        }
    });

    const btnSaveLocation = document.getElementById('btn-save-location');
    if (btnSaveLocation) btnSaveLocation.addEventListener('click', saveLocation);
}

initAdminPage(initSteward, 'steward');

// --- 3. DATA & SYNC LOGIC ---

function loadFromLocal() {
    const raw = localStorage.getItem(DB_KEY);
    const rawLocs = localStorage.getItem(LOCS_KEY);

    if (raw) localData = JSON.parse(raw);
    if (rawLocs) masterLocations = JSON.parse(rawLocs);

    if (localData.length > 0) renderList('');
}

async function syncDown() {
    try {
        const [bookingsReq, locationsReq] = await Promise.all([
            sb.from('bookings').select('id, business_name, owner_name, email, phone').in('status', ['Confirmed']).in('instance_prefix', ['ESF26-FOOD-', 'ESF26-NONFOOD-', 'ESF26-MISC-']),
            sb.from('locations')
                .select('id')
                .eq('dataset', 'LIVE')
                .order('id', { ascending: true })
        ]);

        if (bookingsReq.error) throw bookingsReq.error;
        if (locationsReq.error) throw locationsReq.error;

        const bookings = bookingsReq.data || [];
        const bookingIds = bookings.map(b => b.id);
        const joinReq = bookingIds.length
            ? await sb.from('booking_locations').select('booking_id, location_id').in('booking_id', bookingIds)
            : { data: [], error: null };
        if (joinReq.error) throw joinReq.error;

        // Cache the full set of assigned locations per booking so the "taken
        // spots" check below sees every individual pitch — including ones on
        // bookings with more than one location — not just a single opaque value.
        const locsByBooking = new Map();
        (joinReq.data || []).forEach(r => {
            if (!locsByBooking.has(r.booking_id)) locsByBooking.set(r.booking_id, []);
            locsByBooking.get(r.booking_id).push(r.location_id);
        });

        localData = bookings.map(b => ({ ...b, location_ids: locsByBooking.get(b.id) || [] }));
        localStorage.setItem(DB_KEY, JSON.stringify(localData));

        masterLocations = locationsReq.data;
        localStorage.setItem(LOCS_KEY, JSON.stringify(masterLocations));

        if (document.getElementById('searchInput').value === '') renderList('');

    } catch (e) {
        // Sync failed - will continue with cached data
    } finally {
        document.getElementById('loading').classList.add('hidden');
    }
}

// --- 4. RENDER LOGIC ---
function renderList(query) {
    const list = document.getElementById('resultsList');
    list.innerHTML = '';
    const q = query.toLowerCase().trim();

    const matches = localData.filter(b =>
        (b.business_name || '').toLowerCase().includes(q) ||
        (b.owner_name || '').toLowerCase().includes(q) ||
        (b.id || '').toLowerCase().includes(q) ||
        (b.email || '').toLowerCase().includes(q)
    );

    if (matches.length === 0) {
        list.innerHTML = '<div class="text-center mt-10 opacity-50"><div>No traders found</div></div>';
        return;
    }

    matches.slice(0, 50).forEach(b => {
        const div = document.createElement('div');
        const safeBiz = escapeHtml(b.business_name || 'Unknown Business');
        const safeLoc = escapeHtml((b.location_ids && b.location_ids.length) ? b.location_ids.join(', ') : '---');
        const hasLoc = !!(b.location_ids && b.location_ids.length);

        div.className = "bg-white p-5 rounded-2xl shadow-sm border border-gray-100 touch-card flex justify-between items-center mb-3";
        div.innerHTML = `
        <div class="flex-1 pr-4">
            <div class="font-bold text-lg text-gray-900 leading-tight">${safeBiz}</div>
            <div class="text-sm text-gray-500 mt-1">${escapeHtml(b.owner_name)}</div>
            <div class="mt-2 text-xs bg-gray-100 inline-block px-2 py-1 rounded font-mono">${escapeHtml(b.id)}</div>
        </div>
        <div class="text-right pl-4 border-l border-gray-100 min-w-[80px] cursor-pointer location-edit-btn">
            <div class="text-[10px] text-gray-400 font-bold tracking-wider uppercase mb-1">Location</div>
            <div class="text-3xl font-black ${hasLoc ? 'text-blue-600' : 'text-gray-300'}">${safeLoc}</div>
        </div>
    `;
        div.querySelector('.location-edit-btn').addEventListener('click', () => openEdit(b.id));
        list.appendChild(div);
    });
}

// --- 5. EDIT LOGIC ---

function openEdit(id) {
    const b = localData.find(x => x.id === id);
    if (!b) return;
    currentEditId = id;

    document.getElementById('modalBizName').innerText = b.business_name || 'Unknown Business';
    const select = document.getElementById('newLocationInput');

    select.innerHTML = '';

    const takenSpots = new Set(
        localData
            .filter(item => item.id !== id)
            .flatMap(item => item.location_ids || [])
    );

    const nullOpt = document.createElement('option');
    nullOpt.value = "";
    nullOpt.text = "--- Unassigned ---";
    select.appendChild(nullOpt);

    if (masterLocations.length === 0) {
        const opt = document.createElement('option');
        opt.text = "No location data (Sync needed)";
        select.appendChild(opt);
    } else {
        const sortedLocs = [...masterLocations].sort((a, b) =>
            a.id.localeCompare(b.id, undefined, { numeric: true, sensitivity: 'base' })
        );

        sortedLocs.forEach(loc => {
            const locId = loc.id;
            if (takenSpots.has(locId)) return;

            const opt = document.createElement('option');
            opt.value = locId;
            opt.text = locId;
            if ((b.location_ids || []).includes(locId)) opt.selected = true;
            select.appendChild(opt);
        });
    }

    document.getElementById('editModal').classList.remove('hidden');
}

function closeModal() {
    document.getElementById('editModal').classList.add('hidden');
    currentEditId = null;
}

async function saveLocation() {
    const rawVal = document.getElementById('newLocationInput').value;
    const newLoc = rawVal === "" ? null : rawVal;

    if (!currentEditId) return;
    const bookingId = currentEditId; // Capture before closeModal clears it

    // 1. Snapshot for rollback
    const idx = localData.findIndex(b => b.id === bookingId);
    if (idx === -1) return;
    const previousLocIds = localData[idx].location_ids || [];

    // 2. Optimistic Update — steward always assigns/clears a single location,
    // replacing whatever set of locations (if any) the booking had before.
    const newLocIds = newLoc ? [newLoc] : [];
    localData[idx].location_ids = newLocIds;
    localStorage.setItem(DB_KEY, JSON.stringify(localData));
    renderList(document.getElementById('searchInput').value);
    closeModal();

    // 3. Network Sync
    if (navigator.onLine) {
        try {
            // Verify we have an active session before attempting update
            const { data: { session } } = await sb.auth.getSession();
            if (!session) {
                throw new Error("Session expired. Please log in again.");
            }

            const safeId = validateBookingId(bookingId);

            const { error } = await sb.rpc('rpc_set_booking_locations', {
                p_booking_id: safeId,
                p_location_ids: newLocIds
            });

            if (error) throw error;

            await auditLog('steward_location_change', bookingId, { previous: previousLocIds, new_location: newLoc });
            showToast("Location saved!");

        } catch (err) {
            // If session expired, redirect to login
            if (err.message && err.message.includes('Session expired')) {
                showToast("Session expired. Redirecting to login...");
                setTimeout(() => {
                    window.location.href = 'steward_login.html';
                }, 2000);
                return;
            }

            showToast("⚠️ Update Failed: " + safeError(err) + " (Changes reverted)");

            // 4. Revert Optimistic Update
            localData[idx].location_ids = previousLocIds;
            localStorage.setItem(DB_KEY, JSON.stringify(localData));
            renderList(document.getElementById('searchInput').value);
        }
    } else {
        addToQueue(bookingId, newLoc);
    }
}

// --- 6. UTILS ---

function addToQueue(id, location) {
    const queue = JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]');
    const filtered = queue.filter(item => item.id !== id);
    const safeLoc = (location === "" || location === null) ? null : location;

    filtered.push({ id, location: safeLoc, timestamp: Date.now(), retries: 0 });
    localStorage.setItem(QUEUE_KEY, JSON.stringify(filtered));
    updateQueueBadge();
    showToast("Saved offline — will sync when back online");
}

async function processSyncQueue() {
    const queue = JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]');
    if (queue.length === 0) return;

    showToast(`Syncing ${queue.length} change${queue.length > 1 ? 's' : ''}...`);

    const failedQueue = [];
    let successCount = 0;

    for (const item of queue) {
        try {
            // Verify we have auth
            const { data: { session } } = await sb.auth.getSession();
            if (!session) {
                // Can't sync without auth — keep everything in queue
                failedQueue.push(...queue.slice(queue.indexOf(item)));
                showToast("Session expired. Please log in again.");
                break;
            }

            // Validate item.id before sending to DB
            const safeId = validateBookingId(item.id);
            const newLocIds = item.location ? [item.location] : [];

            const { error } = await sb.rpc('rpc_set_booking_locations', {
                p_booking_id: safeId,
                p_location_ids: newLocIds
            });

            if (error) throw error;

            // Audit log the synced change
            await auditLog('steward_location_change_sync', item.id, {
                new_location: item.location,
                queued_at: new Date(item.timestamp).toISOString()
            });

            successCount++;
        } catch (err) {
            // Keep failed items for retry, but limit retries
            item.retries = (item.retries || 0) + 1;
            if (item.retries <= 5) {
                failedQueue.push(item);
            }
            // Items with > 5 retries are silently dropped
        }
    }

    localStorage.setItem(QUEUE_KEY, JSON.stringify(failedQueue));
    updateQueueBadge();

    if (successCount > 0) {
        showToast(`✅ Synced ${successCount} change${successCount > 1 ? 's' : ''}!`);
    }
    if (failedQueue.length > 0) {
        showToast(`⚠️ ${failedQueue.length} change${failedQueue.length > 1 ? 's' : ''} pending`);
    }
}

function updateQueueBadge() {
    const queue = JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]');
    let badge = document.getElementById('queueBadge');

    if (queue.length === 0) {
        if (badge) badge.classList.add('hidden');
        return;
    }

    if (!badge) {
        badge = document.createElement('div');
        badge.id = 'queueBadge';
        badge.className = 'bg-yellow-500 text-white text-center text-xs py-1 font-bold cursor-pointer';
        badge.onclick = () => { if (navigator.onLine) processSyncQueue(); };
        document.querySelector('.offline-badge').insertAdjacentElement('afterend', badge);
    }

    badge.classList.remove('hidden');
    badge.innerText = `📤 ${queue.length} pending change${queue.length > 1 ? 's' : ''} — ${navigator.onLine ? 'tap to sync' : 'will sync when online'}`;
}

function updateStatus(isOnline) {
    const el = document.getElementById('statusIndicator');
    if (isOnline) {
        el.innerText = "ONLINE";
        el.className = "text-xs font-bold bg-green-500 text-white px-2 py-1 rounded shadow";
        document.body.classList.remove('is-offline');
    } else {
        el.innerText = "OFFLINE";
        el.className = "text-xs font-bold bg-red-500 text-white px-2 py-1 rounded shadow animate-pulse";
        document.body.classList.add('is-offline');
    }
}

function showToast(msg) {
    const toast = document.createElement('div');
    toast.className = "fixed bottom-6 left-1/2 transform -translate-x-1/2 bg-gray-900 text-white px-6 py-3 rounded-full shadow-2xl text-sm font-bold z-50 animate-slide-up";
    toast.innerText = msg;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 2500);
}
