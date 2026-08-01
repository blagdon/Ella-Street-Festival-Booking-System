// @ts-check
/**
 * js/page-admin.js
 * Platform Administration Workspace Controller.
 * Manages section view switching (Organisation, Events, Members, Branding, Settings, Audit).
 */
import { initAdminPage, getSupabaseClient } from './supabase.js';
import { getPlatformContext, CONFIG } from './config.js';
import { escapeHtml } from './utils.js';
import { renderAdminSidebar } from './platform/navigation.js';
import { renderPageHeader } from './platform/layout.js';
import { renderStatCard, renderCard } from './platform/cards.js';
import { renderInputField, renderFormSaveBar } from './platform/forms.js';
import { renderDataTable, renderStatusBadge } from './platform/tables.js';
import { openDialog } from './platform/dialogs.js';
import { notify, renderAlert } from './platform/notifications.js';
import { auditLog } from './audit.js';

let activeSection = 'organisation';
let orgData = /** @type {Record<string, any>|null} */ (null);
let eventsList = /** @type {Record<string, any>[]} */ ([]);

initAdminPage(initAdminWorkspace);

async function initAdminWorkspace() {
    renderSidebar();
    await loadWorkspaceData();
    renderActiveSection();
}

function renderSidebar() {
    const sidebarEl = document.getElementById('admin-sidebar');
    if (!sidebarEl) return;
    sidebarEl.innerHTML = renderAdminSidebar(activeSection);

    // Attach click listeners to sidebar buttons
    sidebarEl.querySelectorAll('.admin-nav-item').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const target = /** @type {HTMLElement} */ (e.currentTarget);
            const sectionId = target.getAttribute('data-section');
            if (sectionId && sectionId !== activeSection) {
                activeSection = sectionId;
                renderSidebar();
                renderActiveSection();
            }
        });
    });
}

async function loadWorkspaceData() {
    const sb = getSupabaseClient();
    const ctx = getPlatformContext();

    try {
        // Load Organisation details
        const { data: org, error: orgErr } = await sb
            .from('organisations')
            .select('*')
            .eq('id', ctx.orgId)
            .maybeSingle();

        if (!orgErr && org) {
            orgData = org;
        } else {
            orgData = { id: ctx.orgId, name: CONFIG.FESTIVAL_DISPLAY_NAME || 'Ella Street Festival', slug: 'ella-street' };
        }

        // Load Events list for active organisation
        const { data: evts, error: evtErr } = await sb
            .from('events')
            .select('*')
            .eq('org_id', ctx.orgId)
            .order('created_at', { ascending: false });

        if (!evtErr && evts) {
            eventsList = evts;
        } else {
            eventsList = [{
                id: ctx.eventId,
                org_id: ctx.orgId,
                name: 'Ella Street Festival 2026',
                slug: 'esf-2026',
                booking_prefix: 'ESF26',
                is_active: true
            }];
        }
    } catch (e) {
        console.warn('[Admin Workspace] Error loading workspace data:', e);
    }
}

function renderActiveSection() {
    const contentEl = document.getElementById('admin-content');
    if (!contentEl) return;

    switch (activeSection) {
        case 'organisation':
            renderOrganisationSection(contentEl);
            break;
        case 'events':
            renderEventsSection(contentEl);
            break;
        case 'members':
            renderMembersSection(contentEl);
            break;
        case 'branding':
            renderBrandingSection(contentEl);
            break;
        case 'settings':
            renderSettingsSection(contentEl);
            break;
        case 'audit':
            renderAuditSection(contentEl);
            break;
        default:
            renderOrganisationSection(contentEl);
    }
}

// ===================================================================
// 1. ORGANISATION SECTION VIEW (Epic 2A)
// ===================================================================
function renderOrganisationSection(container) {
    const org = orgData || { name: 'Ella Street Festival', slug: 'ella-street', id: 'org_default' };

    const headerHtml = renderPageHeader({
        title: 'Organisation Settings',
        description: 'Manage core organization attributes, contact info, and status.',
        breadcrumb: 'Platform Administration / Workspace'
    });

    const statCardsHtml = `
    <div class="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
        ${renderStatCard({ label: 'Active Events', value: eventsList.filter(e => e.is_active).length, icon: '📅', badgeClass: 'bg-blue-50 text-blue-700' })}
        ${renderStatCard({ label: 'Total Events', value: eventsList.length, icon: '🎪', badgeClass: 'bg-indigo-50 text-indigo-700' })}
        ${renderStatCard({ label: 'Status', value: 'Active', icon: '✅', badgeClass: 'bg-emerald-50 text-emerald-700' })}
    </div>`;

    const formContentHtml = `
    <form id="orgDetailsForm">
        <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
            ${renderInputField({ id: 'orgName', label: 'Organisation Name', value: org.name || '', required: true })}
            ${renderInputField({ id: 'orgSlug', label: 'Organisation Slug', value: org.slug || '', helpText: 'Used in subdomains and URLs' })}
        </div>
        <div class="grid grid-cols-1 md:grid-cols-2 gap-4 mt-2">
            ${renderInputField({ id: 'orgContactEmail', label: 'Contact Email', value: org.contact_email || 'admin@ellastreetfestival.co.uk', type: 'email' })}
            ${renderInputField({ id: 'orgWebsite', label: 'Official Website', value: org.website || 'https://ellastreetfestival.co.uk' })}
        </div>
        ${renderFormSaveBar({ submitId: 'btnSaveOrg', submitLabel: 'Save Organisation Details' })}
    </form>`;

    const cardHtml = renderCard({
        title: 'Organisation Details',
        subtitle: 'General settings for the platform tenant',
        contentHtml: formContentHtml
    });

    container.innerHTML = headerHtml + statCardsHtml + cardHtml; // innerhtml-safe: component HTML built with internal escapeHtml calls

    // Attach Save Listener
    document.getElementById('orgDetailsForm')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        await saveOrganisationDetails();
    });
}

async function saveOrganisationDetails() {
    const sb = getSupabaseClient();
    const ctx = getPlatformContext();
    const btn = /** @type {HTMLButtonElement|null} */ (document.getElementById('btnSaveOrg'));

    const name = (/** @type {HTMLInputElement} */ (document.getElementById('orgName'))).value.trim();
    const slug = (/** @type {HTMLInputElement} */ (document.getElementById('orgSlug'))).value.trim();
    const email = (/** @type {HTMLInputElement} */ (document.getElementById('orgContactEmail'))).value.trim();
    const website = (/** @type {HTMLInputElement} */ (document.getElementById('orgWebsite'))).value.trim();

    if (!name) {
        notify('Organisation Name is required.', 'error');
        return;
    }

    if (btn) {
        btn.disabled = true;
        btn.innerText = 'Saving...';
    }

    try {
        const { error } = await sb
            .from('organisations')
            .upsert({
                id: ctx.orgId,
                name,
                slug,
                contact_email: email,
                website
            }, { onConflict: 'id' });

        if (error) throw error;

        await auditLog('update_organisation', 'organisation', { org_id: ctx.orgId, name, slug });
        notify('Organisation details updated successfully!', 'success');
        if (orgData) {
            orgData.name = name;
            orgData.slug = slug;
            orgData.contact_email = email;
            orgData.website = website;
        }
    } catch (err) {
        notify(`Failed to update organisation: ${err.message}`, 'error');
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerText = 'Save Organisation Details';
        }
    }
}

// ===================================================================
// 2. EVENTS SECTION VIEW (Epic 2A)
// ===================================================================
function renderEventsSection(container) {
    const headerHtml = renderPageHeader({
        title: 'Event Administration',
        description: 'Manage festival editions, booking prefixes, dates, and active status.',
        breadcrumb: 'Platform Administration / Workspace',
        actionHtml: `
        <button id="btnCreateEvent" class="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white font-semibold text-sm rounded-lg shadow-sm transition flex items-center gap-2">
            <span>➕</span>
            <span>New Event</span>
        </button>`
    });

    const columns = [
        { key: 'name', label: 'Event Name' },
        { key: 'booking_prefix', label: 'Booking Prefix' },
        { key: 'slug', label: 'Slug' },
        { key: 'is_active', label: 'Status' },
        { key: 'actions', label: 'Actions' }
    ];

    const tableHtml = renderDataTable({
        columns,
        rows: eventsList,
        emptyMessage: 'No events created yet.',
        renderCell: (row, colKey) => {
            if (colKey === 'name') {
                return `<div><div class="font-bold text-gray-900">${escapeHtml(row.name)}</div><div class="text-xs text-gray-400">ID: ${escapeHtml(row.id)}</div></div>`;
            }
            if (colKey === 'is_active') {
                return renderStatusBadge(row.is_active ? 'Active' : 'Archived', row.is_active ? 'active' : 'inactive');
            }
            if (colKey === 'actions') {
                return `
                <button data-event-id="${escapeHtml(row.id)}" class="btn-edit-event text-xs font-semibold text-blue-600 hover:text-blue-800 mr-3">Edit</button>
                <button data-event-id="${escapeHtml(row.id)}" class="btn-toggle-event text-xs font-semibold ${row.is_active ? 'text-amber-600 hover:text-amber-800' : 'text-emerald-600 hover:text-emerald-800'}">
                    ${row.is_active ? 'Archive' : 'Activate'}
                </button>`;
            }
            return escapeHtml(String(row[colKey] ?? ''));
        }
    });

    const cardHtml = renderCard({
        title: 'All Events',
        subtitle: 'Configured events for this organisation',
        contentHtml: tableHtml
    });

    container.innerHTML = headerHtml + cardHtml; // innerhtml-safe: component HTML built with internal escapeHtml calls

    // Attach Event Handlers
    document.getElementById('btnCreateEvent')?.addEventListener('click', openCreateEventDialog);

    container.querySelectorAll('.btn-edit-event').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const evtId = (/** @type {HTMLElement} */ (e.currentTarget)).getAttribute('data-event-id');
            const evt = eventsList.find(x => x.id === evtId);
            if (evt) openEditEventDialog(evt);
        });
    });

    container.querySelectorAll('.btn-toggle-event').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            const evtId = (/** @type {HTMLElement} */ (e.currentTarget)).getAttribute('data-event-id');
            const evt = eventsList.find(x => x.id === evtId);
            if (evt) await toggleEventStatus(evt);
        });
    });
}

function openCreateEventDialog() {
    const bodyHtml = `
    <form id="createEventForm">
        ${renderInputField({ id: 'newEventName', label: 'Event Name', placeholder: 'e.g. Ella Street Festival 2027', required: true })}
        ${renderInputField({ id: 'newEventPrefix', label: 'Booking Prefix', placeholder: 'e.g. ESF27', required: true, helpText: 'Used for reference IDs like ESF27-FOOD-0001' })}
        ${renderInputField({ id: 'newEventSlug', label: 'Event Slug', placeholder: 'e.g. esf-2027' })}
    </form>`;

    const actionHtml = `
    <button type="button" class="btn-close-modal px-4 py-2 text-sm font-medium text-gray-600 hover:text-gray-900 transition">Cancel</button>
    <button type="button" id="btnConfirmCreateEvent" class="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white font-semibold text-sm rounded-lg transition">Create Event</button>`;

    openDialog({
        id: 'dialogCreateEvent',
        title: 'Create New Event',
        bodyHtml,
        actionHtml
    });

    document.getElementById('btnConfirmCreateEvent')?.addEventListener('click', async () => {
        await submitCreateEvent();
    });
}

async function submitCreateEvent() {
    const sb = getSupabaseClient();
    const ctx = getPlatformContext();

    const name = (/** @type {HTMLInputElement} */ (document.getElementById('newEventName'))).value.trim();
    const prefix = (/** @type {HTMLInputElement} */ (document.getElementById('newEventPrefix'))).value.trim();
    const slug = (/** @type {HTMLInputElement} */ (document.getElementById('newEventSlug'))).value.trim() || prefix.toLowerCase();

    if (!name || !prefix) {
        notify('Event Name and Booking Prefix are required.', 'error');
        return;
    }

    const newId = `event_${Date.now()}`;

    try {
        const { error } = await sb.from('events').insert({
            id: newId,
            org_id: ctx.orgId,
            name,
            slug,
            booking_prefix: prefix,
            is_active: true
        });

        if (error) throw error;

        await auditLog('create_event', 'events', { org_id: ctx.orgId, event_id: newId, name, prefix });
        notify('Event created successfully!', 'success');
        document.getElementById('dialogCreateEvent')?.classList.add('hidden');
        await loadWorkspaceData();
        renderActiveSection();
    } catch (err) {
        notify(`Failed to create event: ${err.message}`, 'error');
    }
}

function openEditEventDialog(evt) {
    const bodyHtml = `
    <form id="editEventForm">
        ${renderInputField({ id: 'editEventName', label: 'Event Name', value: evt.name, required: true })}
        ${renderInputField({ id: 'editEventPrefix', label: 'Booking Prefix', value: evt.booking_prefix, required: true })}
        ${renderInputField({ id: 'editEventSlug', label: 'Event Slug', value: evt.slug })}
    </form>`;

    const actionHtml = `
    <button type="button" class="btn-close-modal px-4 py-2 text-sm font-medium text-gray-600 hover:text-gray-900 transition">Cancel</button>
    <button type="button" id="btnConfirmEditEvent" class="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white font-semibold text-sm rounded-lg transition">Save Changes</button>`;

    openDialog({
        id: 'dialogEditEvent',
        title: `Edit Event: ${evt.name}`,
        bodyHtml,
        actionHtml
    });

    document.getElementById('btnConfirmEditEvent')?.addEventListener('click', async () => {
        await submitEditEvent(evt.id);
    });
}

async function submitEditEvent(eventId) {
    const sb = getSupabaseClient();
    const ctx = getPlatformContext();

    const name = (/** @type {HTMLInputElement} */ (document.getElementById('editEventName'))).value.trim();
    const prefix = (/** @type {HTMLInputElement} */ (document.getElementById('editEventPrefix'))).value.trim();
    const slug = (/** @type {HTMLInputElement} */ (document.getElementById('editEventSlug'))).value.trim();

    if (!name || !prefix) {
        notify('Event Name and Booking Prefix are required.', 'error');
        return;
    }

    try {
        const { error } = await sb.from('events').update({
            name,
            booking_prefix: prefix,
            slug
        }).eq('id', eventId);

        if (error) throw error;

        await auditLog('update_event', 'events', { org_id: ctx.orgId, event_id: eventId, name, prefix });
        notify('Event updated successfully!', 'success');
        document.getElementById('dialogEditEvent')?.classList.add('hidden');
        await loadWorkspaceData();
        renderActiveSection();
    } catch (err) {
        notify(`Failed to update event: ${err.message}`, 'error');
    }
}

async function toggleEventStatus(evt) {
    const sb = getSupabaseClient();
    const newActiveState = !evt.is_active;

    try {
        const { error } = await sb.from('events').update({
            is_active: newActiveState
        }).eq('id', evt.id);

        if (error) throw error;

        await auditLog(newActiveState ? 'activate_event' : 'archive_event', 'events', { event_id: evt.id });
        notify(`Event ${newActiveState ? 'activated' : 'archived'} successfully!`, 'success');
        await loadWorkspaceData();
        renderActiveSection();
    } catch (err) {
        notify(`Failed to change event status: ${err.message}`, 'error');
    }
}

// ===================================================================
// 3. PLACEHOLDER SECTION VIEWS (Members, Branding, Settings, Audit)
// ===================================================================
function renderMembersSection(container) {
    const headerHtml = renderPageHeader({
        title: 'Team & Members',
        description: 'Manage organisation staff, stewards, and role permissions.',
        breadcrumb: 'Platform Administration / Workspace'
    });
    const infoHtml = renderAlert({
        title: 'Coming in Epic 2B',
        message: 'Member directory, role management (admin/steward), and access revocation will be expanded in Sub-Epic 2B.',
        type: 'info'
    });
    container.innerHTML = headerHtml + infoHtml; // innerhtml-safe: component HTML built with internal escapeHtml calls
}

function renderBrandingSection(container) {
    const headerHtml = renderPageHeader({
        title: 'Branding & Identity',
        description: 'Customize organisation logos, accent colors, and email/SMS footers.',
        breadcrumb: 'Platform Administration / Workspace'
    });
    const infoHtml = renderAlert({
        title: 'Coming in Epic 2B',
        message: 'Branding options (Logos, Accent Colors, Email & SMS Sender Info) will be expanded in Sub-Epic 2B.',
        type: 'info'
    });
    container.innerHTML = headerHtml + infoHtml; // innerhtml-safe: component HTML built with internal escapeHtml calls
}

function renderSettingsSection(container) {
    const headerHtml = renderPageHeader({
        title: 'Categorised System Settings',
        description: 'Manage categorised configuration settings across General, Bookings, Comms, Payments, and Advanced.',
        breadcrumb: 'Platform Administration / Workspace'
    });
    const infoHtml = renderAlert({
        title: 'Coming in Epic 2B',
        message: 'Tabbed categorised system settings hub will be integrated in Sub-Epic 2B.',
        type: 'info'
    });
    container.innerHTML = headerHtml + infoHtml; // innerhtml-safe: component HTML built with internal escapeHtml calls
}

function renderAuditSection(container) {
    const headerHtml = renderPageHeader({
        title: 'Platform Audit Log',
        description: 'View full audit trails of all administrative actions across this organisation.',
        breadcrumb: 'Platform Administration / Workspace'
    });
    const infoHtml = renderAlert({
        title: 'Platform Audit Logs Active',
        message: 'Audit logging is active and capturing organisation and event administrative actions.',
        type: 'success'
    });
    container.innerHTML = headerHtml + infoHtml; // innerhtml-safe: component HTML built with internal escapeHtml calls
}
