// @ts-check
import { initAdminPage, getSupabaseClient } from './supabase.js';
import { getCurrentOrgId, getCurrentEventId } from './config.js';
import { fetchAvailableEvents } from './event-service.js';
import { escapeHtml } from './utils.js';
import { showToast } from './ui.js';

const PAGE_SIZE = 100;

// Every action string any auditLog() call site in the app currently uses -
// purely to populate the filter dropdown with friendly labels. Not
// authoritative: the search box matches on the raw `action` column
// regardless of whether it's listed here, so a newly added auditLog()
// action still shows up via search even before this list is updated.
const KNOWN_ACTIONS = [
    'add_admin_note', 'admin_login', 'admin_logout', 'allocate_location',
    'check_sms_delivery', 'email_sent', 'finalize_confirmation', 'hcc_bulk_email_sent',
    'hcc_bulk_save_updated', 'hcc_mobile_status_updated', 'hcc_status_updated',
    'insert_misc_booking', 'location_email_queued', 'location_sms_queued', 'request_payment',
    'refund_issued_stripe', 'refund_recorded', 'resend_confirmation',
    'resend_payment_request', 'retry_queued_email', 'retry_queued_sms',
    'send_payment_reminder', 'sms_bulk_queued', 'sms_sent',
    'steward_location_change', 'steward_location_change_sync',
    'toggle_booking_form', 'toggle_sms_test_mode', 'toggle_stripe_test_mode',
    'update_details', 'update_payment', 'update_serpapi_settings',
    'update_sms_settings', 'update_stall_costs', 'update_stall_types',
    'update_status', 'update_stripe_settings', 'update_system_constants',
    'update_zoho_settings',
];

let sb;
let offset = 0;
let hasMore = true;
let searchDebounceTimer = null;

function friendlyAction(action) {
    return (action || '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

async function initAuditLog() {
    sb = getSupabaseClient();

    populateActionFilter();
    await populateEventFilter();

    // Deep-link support: audit_log.html?target=<bookingId>, used by the
    // "History" link in the kanban/summary booking detail pane.
    const params = new URLSearchParams(window.location.search);
    const targetParam = params.get('target');
    if (targetParam) {
        const searchInput = /** @type {HTMLInputElement} */ (document.getElementById('searchInput'));
        searchInput.value = targetParam;
    }

    document.getElementById('btn-refresh').addEventListener('click', () => loadPage(true));
    document.getElementById('btn-load-more').addEventListener('click', () => loadPage(false));
    document.getElementById('actionFilter').addEventListener('change', () => loadPage(true));
    document.getElementById('eventFilter').addEventListener('change', () => loadPage(true));
    document.getElementById('searchInput').addEventListener('input', () => {
        clearTimeout(searchDebounceTimer);
        searchDebounceTimer = setTimeout(() => loadPage(true), 400);
    });

    document.getElementById('tableBody').addEventListener('click', (e) => {
        const target = /** @type {Element} */ (e.target);
        const btn = target.closest('button[data-action="filter-target"]');
        if (btn instanceof HTMLElement) {
            const searchInput = /** @type {HTMLInputElement} */ (document.getElementById('searchInput'));
            searchInput.value = btn.dataset.target;
            loadPage(true);
        }
    });

    loadPage(true);
}

initAdminPage(initAuditLog);

function populateActionFilter() {
    const sel = document.getElementById('actionFilter');
    KNOWN_ACTIONS
        .slice()
        .sort((a, b) => friendlyAction(a).localeCompare(friendlyAction(b)))
        .forEach((action) => {
            const opt = document.createElement('option');
            opt.value = action;
            opt.textContent = friendlyAction(action);
            sel.appendChild(opt);
        });
}

// audit_logs.event_id is already correctly populated on every write
// (js/audit.js's sole writer always supplies a real event_id) - this is
// purely a read-side filter, defaulting to the currently-selected event
// (consistent with every other event-scoped admin view) with an explicit
// "All Events" option for genuinely cross-event review, same pattern as
// the existing actionFilter's "All" option (Multi-Event Phase 2).
async function populateEventFilter() {
    const sel = /** @type {HTMLSelectElement} */ (document.getElementById('eventFilter'));
    const events = await fetchAvailableEvents();
    events.forEach((evt) => {
        const opt = document.createElement('option');
        opt.value = evt.id;
        opt.textContent = evt.name || evt.id;
        sel.appendChild(opt);
    });
    const currentEventId = getCurrentEventId();
    if (events.some((evt) => evt.id === currentEventId)) {
        sel.value = currentEventId;
    }
}

// PostgREST's .or() filter string uses commas to separate conditions and
// parentheses for grouping - strip them so a comma/paren in a search term
// can't corrupt the filter string. Only affects free-text search; the
// exact-match action dropdown and target-id "drill in" links are
// unaffected since they never build an .or() string.
function sanitizeForOrFilter(term) {
    return term.replace(/[,()]/g, '');
}

async function loadPage(reset) {
    const tbody = document.getElementById('tableBody');
    const loadMoreBtn = /** @type {HTMLButtonElement} */ (document.getElementById('btn-load-more'));

    if (reset) {
        offset = 0;
        hasMore = true;
        tbody.innerHTML = '<tr><td colspan="6" class="px-4 py-10 text-center text-gray-400 text-sm animate-pulse">Loading audit log...</td></tr>';
    } else {
        loadMoreBtn.disabled = true;
        loadMoreBtn.textContent = 'Loading...';
    }

    const rawTerm = (/** @type {HTMLInputElement} */ (document.getElementById('searchInput'))).value.trim();
    const term = sanitizeForOrFilter(rawTerm);
    const actionFilter = (/** @type {HTMLSelectElement} */ (document.getElementById('actionFilter'))).value;
    const eventFilter = (/** @type {HTMLSelectElement} */ (document.getElementById('eventFilter'))).value;

    try {
        let query = sb.from('audit_logs').select('*').eq('org_id', getCurrentOrgId()).order('id', { ascending: false });

        if (term) {
            query = query.or(`target_id.ilike.%${term}%,user_email.ilike.%${term}%,action.ilike.%${term}%,details.ilike.%${term}%`);
        }
        if (actionFilter !== 'All') {
            query = query.eq('action', actionFilter);
        }
        if (eventFilter !== 'All') {
            query = query.eq('event_id', eventFilter);
        }

        query = query.range(offset, offset + PAGE_SIZE - 1);

        const { data, error } = await query;
        if (error) throw error;

        if (reset) tbody.innerHTML = '';

        if (reset && (!data || data.length === 0)) {
            tbody.innerHTML = '<tr><td colspan="6" class="px-4 py-10 text-center text-gray-400 text-sm">No matching audit log entries.</td></tr>';
        } else {
            (data || []).forEach((row) => tbody.insertAdjacentHTML('beforeend', renderRow(row)));
        }

        offset += (data || []).length;
        hasMore = (data || []).length === PAGE_SIZE;
        loadMoreBtn.classList.toggle('hidden', !hasMore);

        const currentCount = tbody.querySelectorAll('tr[data-log-row]').length;
        document.getElementById('recordCount').textContent =
            `${currentCount} record${currentCount !== 1 ? 's' : ''} shown${hasMore ? ' (more available)' : ''}`;
    } catch (err) {
        if (reset) {
            tbody.innerHTML = `<tr><td colspan="6" class="px-4 py-10 text-center text-red-500 text-sm">Error: ${escapeHtml(err.message)}</td></tr>`;
        } else {
            showToast('Failed to load more entries: ' + err.message, 'error');
        }
    } finally {
        loadMoreBtn.disabled = false;
        loadMoreBtn.textContent = 'Load older entries';
    }
}

function renderDetailsCell(detailsRaw) {
    if (!detailsRaw) return '<span class="text-gray-300">—</span>';
    let pretty = detailsRaw;
    let preview = detailsRaw;
    try {
        const parsed = JSON.parse(detailsRaw);
        pretty = JSON.stringify(parsed, null, 2);
        preview = JSON.stringify(parsed);
    } catch (e) {
        // Not JSON (or legacy plain-text details) - show the raw text as-is.
    }
    const shortPreview = preview.length > 60 ? preview.slice(0, 60) + '…' : preview;
    return `
        <details class="details-cell">
            <summary class="text-xs font-mono text-gray-500 cursor-pointer hover:text-gray-800">${escapeHtml(shortPreview)}</summary>
            <pre class="text-xs font-mono text-gray-700 bg-gray-50 border border-gray-100 rounded p-2 whitespace-pre-wrap break-words max-w-xl">${escapeHtml(pretty)}</pre>
        </details>`;
}

function renderRow(row) {
    const time = row.created_at ? new Date(row.created_at).toLocaleString('en-GB') : '—';
    const targetCell = row.target_id
        ? `<button data-action="filter-target" data-target="${escapeHtml(row.target_id)}" class="text-xs font-mono text-blue-700 hover:text-blue-900 hover:underline text-left">${escapeHtml(row.target_id)}</button>`
        : '<span class="text-gray-300">—</span>';

    return `
        <tr data-log-row class="hover:bg-gray-50 align-top">
            <td class="px-4 py-3 text-xs text-gray-500 whitespace-nowrap">${escapeHtml(time)}</td>
            <td class="px-4 py-3">
                <span class="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-700">${escapeHtml(friendlyAction(row.action))}</span>
            </td>
            <td class="px-4 py-3">${targetCell}</td>
            <td class="px-4 py-3 text-xs text-gray-600 break-words">${escapeHtml(row.user_email || '—')}</td>
            <td class="px-4 py-3 text-xs text-gray-500">${escapeHtml(row.instance || '—')}</td>
            <td class="px-4 py-3">${renderDetailsCell(row.details)}</td>
        </tr>`;
}
