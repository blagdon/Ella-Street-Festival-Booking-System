import { initAdminPage, getSupabaseClient } from './supabase.js';
import { escapeHtml } from './utils.js';
import { showToast } from './ui.js';

const PAGE_SIZE = 100;

let sb;
let offset = 0;
let hasMore = true;
let searchDebounceTimer = null;

function initEmailQueue() {
    sb = getSupabaseClient();

    document.getElementById('btn-refresh').addEventListener('click', () => loadPage(true));
    document.getElementById('btn-load-more').addEventListener('click', () => loadPage(false));
    document.getElementById('statusFilter').addEventListener('change', () => loadPage(true));
    document.getElementById('searchInput').addEventListener('input', () => {
        clearTimeout(searchDebounceTimer);
        searchDebounceTimer = setTimeout(() => loadPage(true), 400);
    });

    loadPage(true);
}

initAdminPage(initEmailQueue);

// PostgREST's .or() filter string uses commas to separate conditions and
// parentheses for grouping - strip them so a comma/paren in a search term
// can't corrupt the filter string, same guard as page-audit-log.js.
function sanitizeForOrFilter(term) {
    return term.replace(/[,()]/g, '');
}

async function loadPage(reset) {
    const tbody = document.getElementById('tableBody');
    const loadMoreBtn = document.getElementById('btn-load-more');

    if (reset) {
        offset = 0;
        hasMore = true;
        tbody.innerHTML = '<tr><td colspan="6" class="px-4 py-10 text-center text-gray-400 text-sm animate-pulse">Loading email queue...</td></tr>';
    } else {
        loadMoreBtn.disabled = true;
        loadMoreBtn.textContent = 'Loading...';
    }

    const rawTerm = document.getElementById('searchInput').value.trim();
    const term = sanitizeForOrFilter(rawTerm);
    const statusFilter = document.getElementById('statusFilter').value;

    try {
        let query = sb.from('email_queue').select('*').order('id', { ascending: false });

        if (term) {
            query = query.or(`recipient.ilike.%${term}%,subject.ilike.%${term}%,error_message.ilike.%${term}%,instance_prefix.ilike.%${term}%`);
        }
        if (statusFilter !== 'All') {
            query = query.eq('status', statusFilter);
        }

        query = query.range(offset, offset + PAGE_SIZE - 1);

        const { data, error } = await query;
        if (error) throw error;

        if (reset) tbody.innerHTML = '';

        if (reset && (!data || data.length === 0)) {
            tbody.innerHTML = '<tr><td colspan="6" class="px-4 py-10 text-center text-gray-400 text-sm">No matching email queue entries.</td></tr>';
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

function statusBadgeClass(status) {
    switch (status) {
        case 'Error': return 'bg-red-100 text-red-700';
        case 'Sent': return 'bg-green-100 text-green-700';
        case 'Processing': return 'bg-blue-100 text-blue-700';
        default: return 'bg-yellow-100 text-yellow-700'; // Pending
    }
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

function renderRow(row) {
    const time = row.created_at ? new Date(row.created_at).toLocaleString('en-GB') : '—';

    return `
        <tr data-log-row class="hover:bg-gray-50 align-top ${row.status === 'Error' ? 'bg-red-50/40' : ''}">
            <td class="px-4 py-3 text-xs text-gray-500 whitespace-nowrap">${escapeHtml(time)}</td>
            <td class="px-4 py-3">
                <span class="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${statusBadgeClass(row.status)}">${escapeHtml(row.status || 'Pending')}</span>
            </td>
            <td class="px-4 py-3 text-xs text-gray-600 break-words">${escapeHtml(row.recipient)}</td>
            <td class="px-4 py-3 text-xs text-gray-700 break-words">${escapeHtml(row.subject)}</td>
            <td class="px-4 py-3 text-xs text-gray-500">${escapeHtml(row.instance_prefix || '—')}</td>
            <td class="px-4 py-3">${renderErrorCell(row)}</td>
        </tr>`;
}
