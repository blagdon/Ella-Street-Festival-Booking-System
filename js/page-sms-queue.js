import { getSupabaseClient } from './supabase.js';
import { escapeHtml } from './utils.js';
import { showToast } from './ui.js';
import { retryQueuedSms } from './api.js';

// SMS twin of page-email-queue.js. Same paging, search, status-filter and
// retry mechanics; only the columns differ (Message body instead of Subject,
// a billed-segment badge, and phone recipients).
//
// Formerly a standalone page (sms_queue.html), now one pane of
// message_queue.html (see page-message-queue.js, which imports
// initSmsQueue() and calls initAdminPage() exactly once for the whole merged
// page — this module must NOT call initAdminPage itself). Every element id
// below is prefixed `sms-` so it can coexist with the email pane's ids
// (page-email-queue.js), which were identical to these when each lived on
// its own page.
const PAGE_SIZE = 100;

let sb;
let offset = 0;
let hasMore = true;
let searchDebounceTimer = null;

export function initSmsQueue() {
    sb = getSupabaseClient();

    // Delegated so rows added by "Load older entries" get the handler too.
    document.getElementById('sms-tableBody').addEventListener('click', (e) => {
        const btn = e.target.closest('[data-retry-id]');
        if (btn) handleRetry(btn);
    });

    document.getElementById('sms-btn-refresh').addEventListener('click', () => { loadPage(true); loadCounts(); });
    document.getElementById('sms-btn-load-more').addEventListener('click', () => loadPage(false));
    document.getElementById('sms-statusFilter').addEventListener('change', () => loadPage(true));
    document.getElementById('sms-searchInput').addEventListener('input', () => {
        clearTimeout(searchDebounceTimer);
        searchDebounceTimer = setTimeout(() => loadPage(true), 400);
    });

    loadPage(true);
    loadCounts();
}

/**
 * Total / Successful / Unsuccessful counts shown above the table, plus how
 * many of the "Successful" total were only simulated (SMS Test Mode ON, so
 * the send never left the system via the mock provider) — without that
 * caveat, "500 sent successfully" is a misleading vanity metric if most of
 * them never really went anywhere. Deliberately unfiltered (independent of
 * the search box / status dropdown, which scope the table only) and uses
 * head:true count-only queries rather than fetching rows, since this must
 * stay cheap as the queue grows into the thousands.
 *
 * A simulated send is identified by provider_message_id's `mock-` prefix —
 * the same marker _shared/sms.ts's mock adapter has always used, reused here
 * rather than adding a new column.
 */
async function loadCounts() {
    const totalEl = document.getElementById('sms-statsTotal');
    const sentEl = document.getElementById('sms-statsSent');
    const errorEl = document.getElementById('sms-statsError');
    const simWrap = document.getElementById('sms-statsSimulatedWrap');
    const simEl = document.getElementById('sms-statsSimulated');
    if (!totalEl || !sentEl || !errorEl) return;

    try {
        const [total, sent, errored, simulated] = await Promise.all([
            sb.from('sms_queue').select('*', { count: 'exact', head: true }),
            sb.from('sms_queue').select('*', { count: 'exact', head: true }).eq('status', 'Sent'),
            sb.from('sms_queue').select('*', { count: 'exact', head: true }).eq('status', 'Error'),
            sb.from('sms_queue').select('*', { count: 'exact', head: true })
                .eq('status', 'Sent').like('provider_message_id', 'mock-%'),
        ]);
        if (total.error) throw total.error;
        if (sent.error) throw sent.error;
        if (errored.error) throw errored.error;
        if (simulated.error) throw simulated.error;

        totalEl.textContent = total.count ?? 0;
        sentEl.textContent = sent.count ?? 0;
        errorEl.textContent = errored.count ?? 0;

        if (simWrap && simEl) {
            const simCount = simulated.count ?? 0;
            simWrap.classList.toggle('hidden', simCount === 0);
            simEl.textContent = simCount;
        }
    } catch (err) {
        // Non-fatal — the table itself still loads and works without these.
        [totalEl, sentEl, errorEl].forEach(el => { el.textContent = '?'; });
        console.warn('Failed to load SMS queue counts:', err.message);
    }
}

// Strip commas/parens so a search term can't corrupt PostgREST's .or() filter
// string — same guard as page-email-queue.js / page-audit-log.js.
function sanitizeForOrFilter(term) {
    return term.replace(/[,()]/g, '');
}

async function loadPage(reset) {
    const tbody = document.getElementById('sms-tableBody');
    const loadMoreBtn = document.getElementById('sms-btn-load-more');

    if (reset) {
        offset = 0;
        hasMore = true;
        tbody.innerHTML = '<tr><td colspan="7" class="px-4 py-10 text-center text-gray-400 text-sm animate-pulse">Loading SMS queue...</td></tr>';
    } else {
        loadMoreBtn.disabled = true;
        loadMoreBtn.textContent = 'Loading...';
    }

    const rawTerm = document.getElementById('sms-searchInput').value.trim();
    const term = sanitizeForOrFilter(rawTerm);
    const statusFilter = document.getElementById('sms-statusFilter').value;

    try {
        let query = sb.from('sms_queue').select('*').order('id', { ascending: false });

        if (term) {
            query = query.or(`recipient.ilike.%${term}%,body.ilike.%${term}%,error_message.ilike.%${term}%,instance_prefix.ilike.%${term}%`);
        }
        if (statusFilter !== 'All') {
            query = query.eq('status', statusFilter);
        }

        query = query.range(offset, offset + PAGE_SIZE - 1);

        const { data, error } = await query;
        if (error) throw error;

        if (reset) tbody.innerHTML = '';

        if (reset && (!data || data.length === 0)) {
            tbody.innerHTML = '<tr><td colspan="7" class="px-4 py-10 text-center text-gray-400 text-sm">No matching SMS queue entries.</td></tr>';
        } else {
            (data || []).forEach((row) => tbody.insertAdjacentHTML('beforeend', renderRow(row)));
        }

        offset += (data || []).length;
        hasMore = (data || []).length === PAGE_SIZE;
        loadMoreBtn.classList.toggle('hidden', !hasMore);

        const currentCount = tbody.querySelectorAll('tr[data-log-row]').length;
        document.getElementById('sms-recordCount').textContent =
            `${currentCount} record${currentCount !== 1 ? 's' : ''} shown${hasMore ? ' (more available)' : ''}`;
    } catch (err) {
        if (reset) {
            tbody.innerHTML = `<tr><td colspan="7" class="px-4 py-10 text-center text-red-500 text-sm">Error: ${escapeHtml(err.message)}</td></tr>`;
        } else {
            showToast('Failed to load more entries: ' + err.message, 'error');
        }
    } finally {
        loadMoreBtn.disabled = false;
        loadMoreBtn.textContent = 'Load older entries';
    }
}

function statusBadgeClass(status) {
    switch (status) {
        case 'Error': return 'bg-red-100 text-red-700';
        case 'Sent': return 'bg-green-100 text-green-700';
        case 'Processing': return 'bg-blue-100 text-blue-700';
        default: return 'bg-yellow-100 text-yellow-700'; // Pending
    }
}

/**
 * The message body, collapsed to a one-line preview that expands to the full
 * text (parity with the error cell). A tiny segment badge follows, since each
 * segment is billed and a 2+ segment "confirmation" is worth noticing.
 */
function renderMessageCell(row) {
    const body = row.body || '';
    const seg = Number(row.segments);
    const segBadge = Number.isFinite(seg) && seg > 0
        ? `<span class="ml-1 inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium ${seg > 1 ? 'bg-amber-100 text-amber-700' : 'bg-gray-100 text-gray-500'}">${seg} part${seg !== 1 ? 's' : ''}</span>`
        : '';

    if (body.length <= 60) {
        return `<span class="text-xs text-gray-700 break-words">${escapeHtml(body) || '<span class="text-gray-300">—</span>'}</span>${segBadge}`;
    }
    const preview = body.slice(0, 60) + '…';
    return `
        <details class="details-cell">
            <summary class="text-xs text-gray-700 cursor-pointer hover:text-blue-700 break-words">${escapeHtml(preview)}${segBadge}</summary>
            <pre class="text-xs font-sans text-gray-700 bg-gray-50 border border-gray-100 rounded p-2 whitespace-pre-wrap break-words max-w-xl mt-1">${escapeHtml(body)}</pre>
        </details>`;
}

function renderErrorCell(row) {
    if (row.status !== 'Error' || !row.error_message) return '<span class="text-gray-300">—</span>';
    const preview = row.error_message.length > 60 ? row.error_message.slice(0, 60) + '…' : row.error_message;
    return `
        <details class="details-cell">
            <summary class="text-xs font-mono text-red-600 cursor-pointer hover:text-red-800">${escapeHtml(preview)}</summary>
            <pre class="text-xs font-mono text-red-700 bg-red-50 border border-red-100 rounded p-2 whitespace-pre-wrap break-words max-w-xl">${escapeHtml(row.error_message)}</pre>
        </details>`;
}

/**
 * Only failed sends are retryable — the Edge Function enforces this too, but
 * not offering the button for Sent/Pending/Processing rows keeps the admin
 * from discovering the rule by hitting an error.
 */
function renderActionsCell(row) {
    if (row.status !== 'Error') return '<span class="text-gray-300 text-xs">—</span>';
    return `
        <button data-retry-id="${row.id}"
                class="px-2.5 py-1 text-xs font-semibold rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed">
            Retry
        </button>`;
}

/**
 * Surfaces prior retry attempts so a repeatedly-failing row is visibly
 * different from a first-time failure — repeated failures usually mean a bad
 * number or a provider config problem rather than something a retry will fix.
 */
function renderRetryInfo(row) {
    if (!row.retry_count) return '';
    const when = row.last_retry_at ? new Date(row.last_retry_at).toLocaleString('en-GB') : '';
    return `<div class="text-[10px] text-gray-400 mt-1">retried ${row.retry_count}×${when ? ` · last ${escapeHtml(when)}` : ''}</div>`;
}

function renderRow(row) {
    const time = row.created_at ? new Date(row.created_at).toLocaleString('en-GB') : '—';

    return `
        <tr data-log-row data-row-id="${row.id}" class="hover:bg-gray-50 align-top ${row.status === 'Error' ? 'bg-red-50/40' : ''}">
            <td class="px-4 py-3 text-xs text-gray-500 whitespace-nowrap">${escapeHtml(time)}</td>
            <td class="px-4 py-3">
                <span class="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${statusBadgeClass(row.status)}">${escapeHtml(row.status || 'Pending')}</span>
                ${renderRetryInfo(row)}
            </td>
            <td class="px-4 py-3 text-xs text-gray-600 break-words whitespace-nowrap">${escapeHtml(row.recipient)}</td>
            <td class="px-4 py-3">${renderMessageCell(row)}</td>
            <td class="px-4 py-3 text-xs text-gray-500">${escapeHtml(row.instance_prefix || '—')}</td>
            <td class="px-4 py-3">${renderErrorCell(row)}</td>
            <td class="px-4 py-3">${renderActionsCell(row)}</td>
        </tr>`;
}

async function handleRetry(btn) {
    const id = Number(btn.dataset.retryId);
    if (!Number.isInteger(id)) return;

    // Disabling immediately is the first line of defence against a double-click;
    // the Edge Function's row claim is the authoritative guard (this alone
    // can't stop two tabs).
    btn.disabled = true;
    btn.textContent = 'Sending...';

    try {
        const result = await retryQueuedSms(id);
        if (result?.success) {
            showToast('SMS sent successfully.', 'success');
        } else {
            // A retry that fails again is an expected outcome, not an exception
            // — report the fresh provider error so the admin can judge whether
            // retrying again is worth it.
            showToast('Retry failed: ' + (result?.error_message || 'unknown error'), 'error');
        }
    } catch (err) {
        console.error('Retry failed:', err);
        showToast(err.message || 'Failed to retry SMS.', 'error');
    } finally {
        // Reload so the row reflects its true stored state (status, retry count,
        // fresh error) rather than being patched up locally. A retry can move
        // a row between Error and Sent, so the counts need refreshing too.
        await loadPage(true);
        loadCounts();
    }
}
