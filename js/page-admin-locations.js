// @ts-check
/**
 * js/page-admin-locations.js
 * Epic 4, Phase 4C — Location Management.
 *
 * Replaces manual SQL as the only way to create/edit physical
 * pitches/stalls. Every operation is scoped by the active Platform
 * Context's organisation AND event (js/config.js's getPlatformContext()) —
 * no separate filtering mechanism from the rest of the Workspace, and the
 * same event_id scoping added to fetchLocationData (js/api.js) for the
 * existing Location Manager (location_admin.html) assignment workflow, so
 * both agree on the same set of rows.
 *
 * locations' primary key is the pre-existing composite (id, dataset) —
 * there is no org_id/event_id in it (Phase 4C does not change the schema).
 * That means two different organisations could pick the same location code
 * in the same dataset and collide — confirmed live while building this
 * (cloning org_default's own "P1" into a second organisation collided
 * directly). Rather than change the key: Add/Edit catch that specific
 * Postgres 23505 and report it as a plain "that code's taken" error (the
 * same way organisation/event slug collisions are already handled);
 * Duplicate/Import/Clone instead proactively check dataset-wide and
 * auto-rename, via resolveAvailableId() below, since the whole point of
 * those three is bulk-populating IDs the admin didn't hand-choose one at a
 * time.
 */
import { getSupabaseClient } from './supabase.js';
import { getPlatformContext, getCurrentInstance } from './config.js';
import { escapeHtml } from './utils.js';
import { renderPageHeader } from './platform/layout.js';
import { renderCard } from './platform/cards.js';
import { renderInputField, renderToggleField } from './platform/forms.js';
import { renderDataTable } from './platform/tables.js';
import { openDialog } from './platform/dialogs.js';
import { notify } from './platform/notifications.js';
import { auditLog } from './audit.js';

const TBL_LOCATIONS = 'locations';
const LOCATIONS_CAP = 2000; // physical pitches are a small, admin-curated set

let currentLocations = /** @type {Record<string, any>[]} */ ([]);
let selectedIds = /** @type {Set<string>} */ (new Set());
let otherEvents = /** @type {Record<string, any>[]} */ ([]);
let otherOrgs = /** @type {Record<string, any>[]} */ ([]);

/**
 * Finds an id that doesn't collide with any existing (id, dataset) row —
 * dataset-wide, not just within the current org+event — auto-suffixing
 * with -2, -3, ... the same way "Duplicate" already does for a same-event
 * collision. Needed because locations has no org_id in its primary key: a
 * generic code like "P1" cloned or imported from another organisation's
 * data (org_default's own seed being the obvious, common source) collides
 * directly rather than being scoped away, confirmed live while building
 * this feature. Returns {id, renamed} so callers can tell the admin which
 * ids were changed.
 * @param {import('@supabase/supabase-js').SupabaseClient} sb
 * @param {string} dataset
 * @param {string} candidateId
 */
async function resolveAvailableId(sb, dataset, candidateId) {
    let id = candidateId;
    let suffix = 2;
    // Capped iteration: a real collision chain this long would indicate
    // something else is wrong, not legitimate naming pressure.
    for (let attempts = 0; attempts < 50; attempts++) {
        const { data, error } = await sb.from(TBL_LOCATIONS).select('id').eq('id', id).eq('dataset', dataset).maybeSingle();
        if (error) throw error;
        if (!data) return { id, renamed: id !== candidateId };
        id = `${candidateId}-${suffix}`;
        suffix += 1;
    }
    throw new Error(`Could not find an available id for '${candidateId}' after 50 attempts.`);
}

// ===================================================================
// === MAIN SECTION VIEW ===
// ===================================================================
export async function renderLocationsSection(container) {
    const ctx = getPlatformContext();
    const dataset = getCurrentInstance() === 'DEV' ? 'DEV' : 'LIVE';

    const headerHtml = renderPageHeader({
        title: 'Location Management',
        description: 'Add, edit, import, and clone the physical pitches/stalls for this organisation\'s active event.',
        breadcrumb: 'Platform Administration / Workspace',
        actionHtml: `
        <div class="flex flex-wrap gap-2">
            <button id="btnImportLocations" class="px-3 py-1.5 bg-white border border-gray-300 hover:bg-gray-50 text-gray-700 text-xs font-semibold rounded-lg transition">Import CSV</button>
            <button id="btnExportLocations" class="px-3 py-1.5 bg-white border border-gray-300 hover:bg-gray-50 text-gray-700 text-xs font-semibold rounded-lg transition">Export CSV</button>
            <button id="btnCloneLocations" class="px-3 py-1.5 bg-white border border-gray-300 hover:bg-gray-50 text-gray-700 text-xs font-semibold rounded-lg transition">Clone From…</button>
            <button id="btnAddLocation" class="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold rounded-lg transition">+ Add Location</button>
        </div>`
    });

    container.innerHTML = headerHtml + `<div id="locationsCardMount"></div>`; // innerhtml-safe: component HTML built with internal escapeHtml calls

    await loadAndRenderTable(container, ctx, dataset);

    document.getElementById('btnAddLocation')?.addEventListener('click', () => openLocationDialog(null));
    document.getElementById('btnImportLocations')?.addEventListener('click', openImportDialog);
    document.getElementById('btnExportLocations')?.addEventListener('click', () => exportLocationsCsv(ctx, dataset));
    document.getElementById('btnCloneLocations')?.addEventListener('click', () => openCloneDialog(ctx, dataset));
}

async function loadAndRenderTable(container, ctx, dataset) {
    const sb = getSupabaseClient();
    const mount = document.getElementById('locationsCardMount') || container;

    const { data, error } = await sb
        .from(TBL_LOCATIONS)
        .select('*')
        .eq('org_id', ctx.orgId)
        .eq('event_id', ctx.eventId)
        .eq('dataset', dataset)
        .order('id', { ascending: true })
        .limit(LOCATIONS_CAP);

    if (error) {
        notify(`Failed to load locations: ${error.message}`, 'error');
        currentLocations = [];
    } else {
        currentLocations = data || [];
    }
    selectedIds = new Set();

    const bulkBarHtml = `
    <div id="bulkActionBar" class="hidden flex items-center justify-between mb-3 px-4 py-2 bg-blue-50 border border-blue-200 rounded-lg text-sm">
        <span id="bulkActionCount" class="font-semibold text-blue-800"></span>
        <button id="btnBulkDelete" class="px-3 py-1 bg-red-600 hover:bg-red-700 text-white text-xs font-semibold rounded-lg transition">Delete Selected</button>
    </div>`;

    const tableHtml = renderDataTable({
        columns: [
            { key: 'select', label: '' },
            { key: 'id', label: 'Location ID' },
            { key: 'lat', label: 'Lat' },
            { key: 'lng', label: 'Lng' },
            { key: 'has_power', label: 'Power' },
            { key: 'actions', label: '' }
        ],
        rows: currentLocations,
        emptyMessage: 'No locations yet for this event. Add one, import a CSV, or clone from another event/organisation.',
        renderCell: (row, key) => renderLocationCell(row, key)
    });

    const cardHtml = renderCard({
        title: 'Locations',
        subtitle: `${currentLocations.length} location${currentLocations.length === 1 ? '' : 's'} — ${dataset} dataset`,
        contentHtml: bulkBarHtml + tableHtml
    });

    mount.outerHTML = `<div id="locationsCardMount">${cardHtml}</div>`; // innerhtml-safe: component HTML built with internal escapeHtml calls

    wireTableRowEvents(container, ctx, dataset);
}

function renderLocationCell(row, key) {
    switch (key) {
        case 'select':
            return `<input type="checkbox" class="row-select h-4 w-4 rounded border-gray-300" data-loc-id="${escapeHtml(row.id)}">`;
        case 'id':
            return `<span class="font-mono font-semibold">${escapeHtml(row.id)}</span>`;
        case 'lat':
            return escapeHtml(row.lat === null || row.lat === undefined ? '—' : String(row.lat));
        case 'lng':
            return escapeHtml(row.lng === null || row.lng === undefined ? '—' : String(row.lng));
        case 'has_power':
            return row.has_power
                ? `<span class="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold bg-amber-50 text-amber-700 border border-amber-200">⚡ Power</span>`
                : `<span class="text-gray-400">—</span>`;
        case 'actions':
            return `
            <div class="flex gap-2 justify-end">
                <button class="btn-edit-loc text-xs font-semibold text-blue-600 hover:text-blue-800" data-loc-id="${escapeHtml(row.id)}">Edit</button>
                <button class="btn-duplicate-loc text-xs font-semibold text-gray-600 hover:text-gray-900" data-loc-id="${escapeHtml(row.id)}">Duplicate</button>
                <button class="btn-delete-loc text-xs font-semibold text-red-600 hover:text-red-800" data-loc-id="${escapeHtml(row.id)}">Delete</button>
            </div>`;
        default:
            return '';
    }
}

function wireTableRowEvents(container, ctx, dataset) {
    container.querySelectorAll('.row-select').forEach((el) => {
        el.addEventListener('change', () => {
            const id = /** @type {HTMLElement} */ (el).getAttribute('data-loc-id');
            const checked = /** @type {HTMLInputElement} */ (el).checked;
            if (!id) return;
            if (checked) selectedIds.add(id); else selectedIds.delete(id);
            updateBulkBar(container, ctx, dataset);
        });
    });

    container.querySelectorAll('.btn-edit-loc').forEach((el) => {
        el.addEventListener('click', () => {
            const id = el.getAttribute('data-loc-id');
            const loc = currentLocations.find((l) => String(l.id) === id);
            if (loc) openLocationDialog(loc);
        });
    });

    container.querySelectorAll('.btn-duplicate-loc').forEach((el) => {
        el.addEventListener('click', async () => {
            const id = el.getAttribute('data-loc-id');
            const loc = currentLocations.find((l) => String(l.id) === id);
            if (loc) await duplicateLocation(container, ctx, dataset, loc);
        });
    });

    container.querySelectorAll('.btn-delete-loc').forEach((el) => {
        el.addEventListener('click', async () => {
            const id = el.getAttribute('data-loc-id');
            if (id) await deleteLocations(container, ctx, dataset, [id]);
        });
    });

    document.getElementById('btnBulkDelete')?.addEventListener('click', async () => {
        await deleteLocations(container, ctx, dataset, [...selectedIds]);
    });
}

function updateBulkBar(container, ctx, dataset) {
    const bar = document.getElementById('bulkActionBar');
    const countEl = document.getElementById('bulkActionCount');
    if (!bar || !countEl) return;
    if (selectedIds.size === 0) {
        bar.classList.add('hidden');
        return;
    }
    bar.classList.remove('hidden');
    countEl.textContent = `${selectedIds.size} location${selectedIds.size === 1 ? '' : 's'} selected`;
}

// ===================================================================
// === ADD / EDIT ===
// ===================================================================
function openLocationDialog(existing) {
    const isEdit = !!existing;
    const bodyHtml = `
    <form id="locationForm">
        ${renderInputField({ id: 'locId', label: 'Location ID', value: existing?.id || '', placeholder: 'e.g. P1, Gate-A', required: true, helpText: 'Shown to stewards and traders. Cannot be changed after creation.', readonly: isEdit })}
        <div class="grid grid-cols-2 gap-4 mt-2">
            ${renderInputField({ id: 'locLat', label: 'Latitude', type: 'number', value: existing?.lat ?? '', placeholder: '53.7457' })}
            ${renderInputField({ id: 'locLng', label: 'Longitude', type: 'number', value: existing?.lng ?? '', placeholder: '-0.3367' })}
        </div>
        <div class="mt-2">
            ${renderToggleField({ id: 'locHasPower', label: 'Has power hookup', checked: !!existing?.has_power })}
        </div>
    </form>`;

    const actionHtml = `
    <button type="button" class="btn-close-modal px-4 py-2 text-sm font-medium text-gray-600 hover:text-gray-900 transition">Cancel</button>
    <button type="button" id="btnConfirmLocation" class="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white font-semibold text-sm rounded-lg transition">${isEdit ? 'Save Changes' : 'Add Location'}</button>`;

    openDialog({ id: 'dialogLocation', title: isEdit ? `Edit Location — ${existing.id}` : 'Add Location', bodyHtml, actionHtml });

    document.getElementById('btnConfirmLocation')?.addEventListener('click', () => submitLocationForm(existing));
}

/**
 * Basic map validation: real-world latitude/longitude bounds. Not an
 * interactive click-to-place map — that's a larger, separate UI investment
 * flagged as follow-up work, not part of this pass.
 */
function validateLatLng(latRaw, lngRaw) {
    const lat = latRaw === '' ? null : parseFloat(latRaw);
    const lng = lngRaw === '' ? null : parseFloat(lngRaw);
    if (lat !== null && (isNaN(lat) || lat < -90 || lat > 90)) {
        throw new Error('Latitude must be a number between -90 and 90.');
    }
    if (lng !== null && (isNaN(lng) || lng < -180 || lng > 180)) {
        throw new Error('Longitude must be a number between -180 and 180.');
    }
    return { lat, lng };
}

async function submitLocationForm(existing) {
    const ctx = getPlatformContext();
    const dataset = getCurrentInstance() === 'DEV' ? 'DEV' : 'LIVE';
    const sb = getSupabaseClient();

    const rawId = (/** @type {HTMLInputElement} */ (document.getElementById('locId'))).value.trim();
    const latRaw = (/** @type {HTMLInputElement} */ (document.getElementById('locLat'))).value.trim();
    const lngRaw = (/** @type {HTMLInputElement} */ (document.getElementById('locLng'))).value.trim();
    const hasPower = (/** @type {HTMLInputElement} */ (document.getElementById('locHasPower'))).checked;

    if (!rawId) {
        notify('Location ID is required.', 'error');
        return;
    }

    let lat, lng;
    try {
        ({ lat, lng } = validateLatLng(latRaw, lngRaw));
    } catch (err) {
        notify(err.message, 'error');
        return;
    }

    try {
        if (existing) {
            const { error } = await sb.from(TBL_LOCATIONS)
                .update({ lat, lng, has_power: hasPower })
                .eq('id', existing.id).eq('dataset', existing.dataset).eq('org_id', ctx.orgId).eq('event_id', ctx.eventId);
            if (error) throw error;
            await auditLog('update_location', existing.id, { org_id: ctx.orgId, event_id: ctx.eventId, lat, lng, has_power: hasPower });
            notify('Location updated.', 'success');
        } else {
            const { error } = await sb.from(TBL_LOCATIONS).insert({
                id: rawId, dataset, lat, lng, has_power: hasPower, org_id: ctx.orgId, event_id: ctx.eventId
            });
            if (error) throw error;
            await auditLog('create_location', rawId, { org_id: ctx.orgId, event_id: ctx.eventId, dataset });
            notify('Location added.', 'success');
        }
        document.getElementById('dialogLocation')?.classList.add('hidden');
        await refreshLocationsSection();
    } catch (err) {
        const message = err.code === '23505'
            ? `Location ID '${rawId}' already exists in the ${dataset} dataset (it may belong to another organisation or event) — try a different code.`
            : `Failed to save location: ${err.message}`;
        notify(message, 'error');
    }
}

// ===================================================================
// === DUPLICATE ===
// ===================================================================
async function duplicateLocation(container, ctx, dataset, loc) {
    const sb = getSupabaseClient();
    let newId;
    try {
        // Dataset-wide, not just this org+event — a plain "-copy" could
        // still belong to a different organisation already.
        ({ id: newId } = await resolveAvailableId(sb, dataset, `${loc.id}-copy`));
    } catch (err) {
        notify(`Failed to duplicate location: ${err.message}`, 'error');
        return;
    }

    try {
        const { error } = await sb.from(TBL_LOCATIONS).insert({
            id: newId, dataset, lat: loc.lat, lng: loc.lng, has_power: loc.has_power, org_id: ctx.orgId, event_id: ctx.eventId
        });
        if (error) throw error;
        await auditLog('duplicate_location', newId, { org_id: ctx.orgId, event_id: ctx.eventId, source_id: loc.id });
        notify(`Duplicated as '${newId}'.`, 'success');
        await refreshLocationsSection();
    } catch (err) {
        // Still possible in a race (another admin/tab claimed newId between
        // the check above and this insert) — the check is a courtesy, not
        // the real guarantee; this catch is.
        const message = err.code === '23505'
            ? `Location ID '${newId}' was just taken by someone else — try duplicating again.`
            : `Failed to duplicate location: ${err.message}`;
        notify(message, 'error');
    }
}

// ===================================================================
// === DELETE (single + bulk) ===
// ===================================================================
async function deleteLocations(container, ctx, dataset, ids) {
    if (ids.length === 0) return;
    const label = ids.length === 1 ? `location '${ids[0]}'` : `${ids.length} locations`;
    if (!window.confirm(`Delete ${label}? This cannot be undone. Any booking currently assigned to ${ids.length === 1 ? 'it' : 'them'} will be unassigned.`)) {
        return;
    }

    const sb = getSupabaseClient();
    try {
        const { error } = await sb.from(TBL_LOCATIONS)
            .delete()
            .in('id', ids)
            .eq('dataset', dataset)
            .eq('org_id', ctx.orgId)
            .eq('event_id', ctx.eventId);
        if (error) throw error;
        await auditLog('delete_location', ids.join(','), { org_id: ctx.orgId, event_id: ctx.eventId, count: ids.length });
        notify(`Deleted ${label}.`, 'success');
        await refreshLocationsSection();
    } catch (err) {
        notify(`Failed to delete: ${err.message}`, 'error');
    }
}

// ===================================================================
// === IMPORT / EXPORT (CSV) ===
// ===================================================================
/**
 * Minimal CSV line parser: handles quoted fields and escaped quotes, no
 * external dependency for a format this simple (id,lat,lng,has_power).
 */
function parseCsv(text) {
    const rows = [];
    let row = [];
    let field = '';
    let inQuotes = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (inQuotes) {
            if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
            else if (c === '"') { inQuotes = false; }
            else { field += c; }
        } else if (c === '"') {
            inQuotes = true;
        } else if (c === ',') {
            row.push(field); field = '';
        } else if (c === '\n' || c === '\r') {
            if (c === '\r' && text[i + 1] === '\n') i++;
            row.push(field); field = '';
            if (row.some((f) => f.trim() !== '')) rows.push(row);
            row = [];
        } else {
            field += c;
        }
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows;
}

function openImportDialog() {
    const bodyHtml = `
    <p class="text-sm text-gray-600 mb-3">CSV with a header row: <code class="font-mono text-xs bg-gray-100 px-1 rounded">id,lat,lng,has_power</code>. Existing location IDs are skipped, not overwritten.</p>
    <input type="file" id="importCsvFile" accept=".csv,text/csv" class="w-full text-sm border border-gray-300 rounded-lg px-3 py-2">
    <p id="importPreview" class="text-xs text-gray-500 mt-2"></p>
    `;
    const actionHtml = `
    <button type="button" class="btn-close-modal px-4 py-2 text-sm font-medium text-gray-600 hover:text-gray-900 transition">Cancel</button>
    <button type="button" id="btnConfirmImport" class="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white font-semibold text-sm rounded-lg transition" disabled>Import</button>`;

    openDialog({ id: 'dialogImportLocations', title: 'Import Locations', bodyHtml, actionHtml });

    let parsedRows = [];
    const fileInput = /** @type {HTMLInputElement} */ (document.getElementById('importCsvFile'));
    const confirmBtn = /** @type {HTMLButtonElement} */ (document.getElementById('btnConfirmImport'));
    const preview = document.getElementById('importPreview');

    fileInput?.addEventListener('change', async () => {
        const file = fileInput.files?.[0];
        if (!file) return;
        const text = await file.text();
        const rows = parseCsv(text);
        const [header, ...body] = rows;
        const idx = {
            id: header.findIndex((h) => h.trim().toLowerCase() === 'id'),
            lat: header.findIndex((h) => h.trim().toLowerCase() === 'lat'),
            lng: header.findIndex((h) => h.trim().toLowerCase() === 'lng'),
            has_power: header.findIndex((h) => h.trim().toLowerCase() === 'has_power')
        };
        if (idx.id === -1) {
            if (preview) preview.textContent = 'CSV must have an "id" column.';
            confirmBtn.disabled = true;
            return;
        }
        parsedRows = body
            .filter((r) => r[idx.id] && r[idx.id].trim())
            .map((r) => ({
                id: r[idx.id].trim(),
                lat: idx.lat > -1 && r[idx.lat] ? parseFloat(r[idx.lat]) : null,
                lng: idx.lng > -1 && r[idx.lng] ? parseFloat(r[idx.lng]) : null,
                has_power: idx.has_power > -1 ? /^(true|1|yes)$/i.test((r[idx.has_power] || '').trim()) : false
            }));
        if (preview) preview.textContent = `${parsedRows.length} location${parsedRows.length === 1 ? '' : 's'} ready to import.`;
        confirmBtn.disabled = parsedRows.length === 0;
    });

    confirmBtn?.addEventListener('click', async () => {
        await importLocations(parsedRows);
    });
}

async function importLocations(rows) {
    if (!rows || rows.length === 0) return;
    const ctx = getPlatformContext();
    const dataset = getCurrentInstance() === 'DEV' ? 'DEV' : 'LIVE';
    const sb = getSupabaseClient();

    const existingIds = new Set(currentLocations.map((l) => String(l.id)));
    const skippedExisting = rows.filter((r) => existingIds.has(r.id)).length;
    const candidates = rows.filter((r) => !existingIds.has(r.id));

    if (candidates.length === 0) {
        notify('Every row in that file already exists for this event — nothing to import.', 'info');
        return;
    }

    // Dataset-wide collision check per row, not just against this org+event —
    // a generic code like "P1" very plausibly already belongs to a different
    // organisation in the same dataset (confirmed live while building this
    // feature, via the equivalent path in Clone). Auto-renamed rather than
    // failing the whole import, same as Duplicate; also guards against two
    // rows in the same file resolving to the same renamed id.
    const claimedInBatch = new Set();
    const toInsert = [];
    const renamedRows = [];
    try {
        for (const r of candidates) {
            let { id } = await resolveAvailableId(sb, dataset, r.id);
            let suffix = 2;
            while (claimedInBatch.has(id)) {
                id = `${r.id}-${suffix}`;
                suffix += 1;
            }
            claimedInBatch.add(id);
            if (id !== r.id) renamedRows.push(`${r.id} → ${id}`);
            toInsert.push({ ...r, id, dataset, org_id: ctx.orgId, event_id: ctx.eventId });
        }
    } catch (err) {
        notify(`Import failed while checking for id collisions: ${err.message}`, 'error');
        return;
    }

    const { error } = await sb.from(TBL_LOCATIONS).insert(toInsert);
    if (error) {
        notify(`Import failed: ${error.message}`, 'error');
        return;
    }

    await auditLog('import_locations', 'locations', { org_id: ctx.orgId, event_id: ctx.eventId, count: toInsert.length, renamed: renamedRows });
    const parts = [`Imported ${toInsert.length} location${toInsert.length === 1 ? '' : 's'}.`];
    if (skippedExisting > 0) parts.push(`${skippedExisting} already existed and were skipped.`);
    if (renamedRows.length > 0) parts.push(`Renamed to avoid a clash with another organisation: ${renamedRows.join(', ')}.`);
    notify(parts.join(' '), 'success');
    document.getElementById('dialogImportLocations')?.classList.add('hidden');
    await refreshLocationsSection();
}

function exportLocationsCsv(ctx, dataset) {
    if (currentLocations.length === 0) {
        notify('No locations to export.', 'info');
        return;
    }
    const header = 'id,lat,lng,has_power';
    const lines = currentLocations.map((l) =>
        [l.id, l.lat ?? '', l.lng ?? '', l.has_power ? 'true' : 'false']
            .map((v) => (String(v).includes(',') ? `"${v}"` : v))
            .join(',')
    );
    const csv = [header, ...lines].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `locations_${ctx.orgId}_${dataset}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
}

// ===================================================================
// === CLONE (from another event, or another organisation — admin only) ===
// ===================================================================
async function openCloneDialog(ctx, dataset) {
    const sb = getSupabaseClient();

    const { data: events } = await sb.from('events').select('id, name, org_id').eq('org_id', ctx.orgId).neq('id', ctx.eventId);
    otherEvents = events || [];

    const { data: orgs } = await sb.from('organisations').select('id, name').neq('id', ctx.orgId);
    otherOrgs = orgs || [];

    const eventOptionsHtml = otherEvents.map((e) => `<option value="${escapeHtml(e.id)}">${escapeHtml(e.name)}</option>`).join('');
    const orgOptionsHtml = otherOrgs.map((o) => `<option value="${escapeHtml(o.id)}">${escapeHtml(o.name)}</option>`).join('');

    const bodyHtml = `
    <div class="space-y-4">
        <div>
            <label class="block text-xs font-bold text-gray-700 uppercase tracking-wider mb-1.5">Source</label>
            <select id="cloneSourceType" class="w-full px-3.5 py-2 bg-white border border-gray-300 rounded-lg text-sm">
                <option value="event">Another event in this organisation</option>
                <option value="org">Another organisation (admin only)</option>
            </select>
        </div>
        <div id="cloneEventPicker">
            ${otherEvents.length
                ? `<label class="block text-xs font-bold text-gray-700 uppercase tracking-wider mb-1.5">Event</label>
                   <select id="cloneEventId" class="w-full px-3.5 py-2 bg-white border border-gray-300 rounded-lg text-sm">${eventOptionsHtml}</select>`
                : `<p class="text-sm text-gray-500">No other events exist in this organisation yet.</p>`}
        </div>
        <div id="cloneOrgPicker" class="hidden">
            ${otherOrgs.length
                ? `<label class="block text-xs font-bold text-gray-700 uppercase tracking-wider mb-1.5">Organisation</label>
                   <select id="cloneOrgId" class="w-full px-3.5 py-2 bg-white border border-gray-300 rounded-lg text-sm">${orgOptionsHtml}</select>
                   <p class="text-xs text-gray-500 mt-1">Clones that organisation's own active-event locations into this event.</p>`
                : `<p class="text-sm text-gray-500">No other organisations exist yet.</p>`}
        </div>
    </div>`;

    const actionHtml = `
    <button type="button" class="btn-close-modal px-4 py-2 text-sm font-medium text-gray-600 hover:text-gray-900 transition">Cancel</button>
    <button type="button" id="btnConfirmClone" class="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white font-semibold text-sm rounded-lg transition">Clone Locations</button>`;

    openDialog({ id: 'dialogCloneLocations', title: 'Clone Locations', bodyHtml, actionHtml });

    document.getElementById('cloneSourceType')?.addEventListener('change', (e) => {
        const val = /** @type {HTMLSelectElement} */ (e.target).value;
        document.getElementById('cloneEventPicker')?.classList.toggle('hidden', val !== 'event');
        document.getElementById('cloneOrgPicker')?.classList.toggle('hidden', val !== 'org');
    });

    document.getElementById('btnConfirmClone')?.addEventListener('click', () => submitClone(ctx, dataset));
}

async function submitClone(ctx, dataset) {
    const sourceType = (/** @type {HTMLSelectElement} */ (document.getElementById('cloneSourceType'))).value;
    const sb = getSupabaseClient();

    let sourceOrgId = ctx.orgId;
    let sourceEventId;

    if (sourceType === 'event') {
        const sel = /** @type {HTMLSelectElement|null} */ (document.getElementById('cloneEventId'));
        if (!sel || !sel.value) { notify('Choose a source event.', 'error'); return; }
        sourceEventId = sel.value;
    } else {
        const sel = /** @type {HTMLSelectElement|null} */ (document.getElementById('cloneOrgId'));
        if (!sel || !sel.value) { notify('Choose a source organisation.', 'error'); return; }
        sourceOrgId = sel.value;
        const { data: activeEvt } = await sb.from('events').select('id').eq('org_id', sourceOrgId).eq('is_active', true).limit(1).maybeSingle();
        if (!activeEvt) { notify('That organisation has no active event to clone from.', 'error'); return; }
        sourceEventId = activeEvt.id;
    }

    const { data: sourceLocs, error: fetchErr } = await sb
        .from(TBL_LOCATIONS)
        .select('id, lat, lng, has_power')
        .eq('org_id', sourceOrgId)
        .eq('event_id', sourceEventId)
        .eq('dataset', dataset);

    if (fetchErr) { notify(`Failed to read source locations: ${fetchErr.message}`, 'error'); return; }
    if (!sourceLocs || sourceLocs.length === 0) { notify('The source event has no locations in this dataset to clone.', 'info'); return; }

    const existingIds = new Set(currentLocations.map((l) => String(l.id)));
    const skippedExisting = sourceLocs.filter((l) => existingIds.has(String(l.id))).length;
    const candidates = sourceLocs.filter((l) => !existingIds.has(String(l.id)));

    if (candidates.length === 0) {
        notify('Every location from that source already exists in this event.', 'info');
        return;
    }

    // Same dataset-wide auto-rename as Import (see resolveAvailableId) — this
    // is exactly the case that surfaced it: cloning from org_default, whose
    // generic pitch codes (P1, P2, ...) any other organisation is likely to
    // collide with directly, since locations has no org_id in its key.
    const claimedInBatch = new Set();
    const toInsert = [];
    const renamedRows = [];
    try {
        for (const l of candidates) {
            let { id } = await resolveAvailableId(sb, dataset, String(l.id));
            let suffix = 2;
            while (claimedInBatch.has(id)) {
                id = `${l.id}-${suffix}`;
                suffix += 1;
            }
            claimedInBatch.add(id);
            if (id !== String(l.id)) renamedRows.push(`${l.id} → ${id}`);
            toInsert.push({ ...l, id, dataset, org_id: ctx.orgId, event_id: ctx.eventId });
        }
    } catch (err) {
        notify(`Clone failed while checking for id collisions: ${err.message}`, 'error');
        return;
    }

    const { error: insertErr } = await sb.from(TBL_LOCATIONS).insert(toInsert);
    if (insertErr) {
        notify(`Clone failed: ${insertErr.message}`, 'error');
        return;
    }

    await auditLog('clone_locations', 'locations', {
        org_id: ctx.orgId, event_id: ctx.eventId, source_org_id: sourceOrgId, source_event_id: sourceEventId, count: toInsert.length, renamed: renamedRows
    });
    const parts = [`Cloned ${toInsert.length} location${toInsert.length === 1 ? '' : 's'}.`];
    if (skippedExisting > 0) parts.push(`${skippedExisting} already existed and were skipped.`);
    if (renamedRows.length > 0) parts.push(`Renamed to avoid a clash with another organisation: ${renamedRows.join(', ')}.`);
    notify(parts.join(' '), 'success');
    document.getElementById('dialogCloneLocations')?.classList.add('hidden');
    await refreshLocationsSection();
}

// ===================================================================
// === SHARED REFRESH ===
// ===================================================================
async function refreshLocationsSection() {
    const container = document.getElementById('admin-content');
    if (!container) return;
    const ctx = getPlatformContext();
    const dataset = getCurrentInstance() === 'DEV' ? 'DEV' : 'LIVE';
    await loadAndRenderTable(container, ctx, dataset);
}
