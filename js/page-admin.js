// @ts-check
/**
 * js/page-admin.js
 * Platform Administration Workspace Controller.
 * Manages section view switching (Organisation, Events, Members, Branding, Settings, Audit).
 */
import { initAdminPage, getSupabaseClient } from './supabase.js';
import { getPlatformContext, setCurrentOrgId, CONFIG } from './config.js';
import { escapeHtml, validateSlug, parseEdgeFunctionError } from './utils.js';
import { renderAdminSidebar } from './platform/navigation.js';
import { renderPageHeader } from './platform/layout.js';
import { renderStatCard, renderCard } from './platform/cards.js';
import { renderInputField, renderToggleField, renderFormSaveBar, renderSecretField, bindSecretFieldToggles } from './platform/forms.js';
import { renderDataTable, renderStatusBadge } from './platform/tables.js';
import { openDialog } from './platform/dialogs.js';
import { notify, renderAlert } from './platform/notifications.js';
import { auditLog } from './audit.js';
import { renderProvisioningSection } from './page-provisioning.js';
import { renderLocationsSection } from './page-admin-locations.js';

let activeSection = 'dashboard';
let orgData = /** @type {Record<string, any>|null} */ (null);
let eventsList = /** @type {Record<string, any>[]} */ ([]);

initAdminPage(initAdminWorkspace);

async function initAdminWorkspace() {
    renderSidebar();
    await loadWorkspaceData();
    setupBannerControls();
    renderActiveSection();
}

function setupBannerControls() {
    const ctx = getPlatformContext();
    const labelEl = document.getElementById('orgSlugLabel');
    if (labelEl && orgData) {
        labelEl.textContent = orgData.name || ctx.orgId;
    }

    const btnSwitchDefault = document.getElementById('btnSwitchPrimaryOrg');
    if (btnSwitchDefault) {
        if (ctx.orgId !== 'org_default') {
            btnSwitchDefault.classList.remove('hidden');
            btnSwitchDefault.classList.add('inline-flex');
            btnSwitchDefault.addEventListener('click', () => {
                setCurrentOrgId('org_default');
                window.location.reload();
            });
        } else {
            btnSwitchDefault.classList.add('hidden');
        }
    }
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
        // Load Organisation details via rpc_get_organisation(), not a direct
        // select - RLS only grants SELECT on organisations to a genuine
        // member of that org (or a real platform admin, via this RPC's own
        // check), so a direct query silently returns zero rows for any org
        // the signed-in admin didn't personally provision. A previous
        // version of this code treated that as "fetch failed" and
        // substituted a hardcoded stand-in organisation - which then
        // silently rendered (and could silently overwrite, via Save) a
        // completely different organisation's identity. See the Round 2
        // operational certification, Finding 1. orgData stays null on
        // failure so the render functions can show an honest empty state
        // instead of fabricating one.
        const { data: org, error: orgErr } = await sb.rpc('rpc_get_organisation', { p_org_id: ctx.orgId });

        if (!orgErr && org) {
            orgData = org;
        } else {
            orgData = null;
            if (orgErr) console.warn('[Admin Workspace] Error loading organisation:', orgErr);
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
            eventsList = [];
            if (evtErr) console.warn('[Admin Workspace] Error loading events:', evtErr);
        }
    } catch (e) {
        console.warn('[Admin Workspace] Error loading workspace data:', e);
        orgData = null;
        eventsList = [];
    }
}

function renderActiveSection() {
    const contentEl = document.getElementById('admin-content');
    if (!contentEl) return;

    switch (activeSection) {
        case 'dashboard':
            renderDashboardSection(contentEl);
            break;
        case 'organisation':
            renderOrganisationSection(contentEl);
            break;
        case 'events':
            renderEventsSection(contentEl);
            break;
        case 'locations':
            renderLocationsSection(contentEl);
            break;
        case 'members':
            renderMembersSection(contentEl);
            break;
        case 'provisioning':
            renderProvisioningSection(contentEl);
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
            renderDashboardSection(contentEl);
    }
}

// ===================================================================
// 0. ORGANISATION DASHBOARD SECTION VIEW (Epic 2C)
// ===================================================================
function renderDashboardSection(container) {
    const headerHtml = renderPageHeader({
        title: 'Platform Overview',
        description: 'High-level summary of organisation events, members, and platform health.',
        breadcrumb: 'Platform Administration / Workspace'
    });

    const statCardsHtml = `
    <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        ${renderStatCard({ label: 'Active Events', value: eventsList.filter(e => e.is_active).length, icon: '📅', badgeClass: 'bg-blue-50 text-blue-700' })}
        ${renderStatCard({ label: 'Total Events', value: eventsList.length, icon: '🎪', badgeClass: 'bg-indigo-50 text-indigo-700' })}
        ${renderStatCard({ label: 'Team Members', value: membersList.length || 1, icon: '👥', badgeClass: 'bg-purple-50 text-purple-700' })}
        ${renderStatCard({ label: 'Platform Health', value: '100% OK', icon: '🟢', badgeClass: 'bg-emerald-50 text-emerald-700' })}
    </div>`;

    // orgData is null when it couldn't be loaded (not a member of this org,
    // or a genuine fetch error) - showing a fabricated organisation name
    // here is exactly Finding 1 of the Round 2 certification, so this is an
    // honest empty state instead, not a stand-in identity.
    let cardHtml;
    if (!orgData) {
        cardHtml = renderAlert({
            title: 'Organisation details unavailable',
            message: "Couldn't load this organisation's details. You may not have access, or the organisation record may not exist.",
            type: 'warning'
        });
    } else {
        const summaryContentHtml = `
        <div class="space-y-4">
            <p class="text-sm text-gray-600">
                Welcome to the <strong>${escapeHtml(orgData.name)}</strong> Platform Administration Workspace.
                Use the sidebar navigation to configure festival editions, manage staff access, customize branding, and inspect security audit logs.
            </p>
            <div class="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-2">
                <button data-goto-section="events" class="btn-goto-section text-left p-4 bg-gray-50 hover:bg-blue-50 border border-gray-200 hover:border-blue-200 rounded-xl transition group">
                    <div class="font-bold text-sm text-gray-900 group-hover:text-blue-600">📅 Manage Events →</div>
                    <div class="text-xs text-gray-500 mt-1">Configure event dates & prefixes</div>
                </button>
                <button data-goto-section="members" class="btn-goto-section text-left p-4 bg-gray-50 hover:bg-blue-50 border border-gray-200 hover:border-blue-200 rounded-xl transition group">
                    <div class="font-bold text-sm text-gray-900 group-hover:text-blue-600">👥 Team Directory →</div>
                    <div class="text-xs text-gray-500 mt-1">Invite & manage staff roles</div>
                </button>
                <button data-goto-section="settings" class="btn-goto-section text-left p-4 bg-gray-50 hover:bg-blue-50 border border-gray-200 hover:border-blue-200 rounded-xl transition group">
                    <div class="font-bold text-sm text-gray-900 group-hover:text-blue-600">⚙️ System Settings →</div>
                    <div class="text-xs text-gray-500 mt-1">Stripe, SMS & system controls</div>
                </button>
            </div>
        </div>`;

        cardHtml = renderCard({
            title: 'Organisation Summary',
            subtitle: `Overview for ${orgData.name}`,
            contentHtml: summaryContentHtml
        });
    }

    container.innerHTML = headerHtml + statCardsHtml + cardHtml; // innerhtml-safe: component HTML built with internal escapeHtml calls

    container.querySelectorAll('.btn-goto-section').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const targetSection = (/** @type {HTMLElement} */ (e.currentTarget)).getAttribute('data-goto-section');
            if (targetSection) {
                activeSection = targetSection;
                renderSidebar();
                renderActiveSection();
            }
        });
    });
}

// ===================================================================
// 1. ORGANISATION SECTION VIEW (Epic 2A)
// ===================================================================
function renderOrganisationSection(container) {
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

    let cardHtml;
    if (!orgData) {
        // No fabricated form here either: rendering one pre-filled with
        // stand-in values, editable and connected to a working Save button,
        // is exactly how Finding 1 turned "can't read this org" into "can
        // silently overwrite it" - refuse to render an editable identity
        // form when the real current values aren't actually known.
        cardHtml = renderAlert({
            title: 'Organisation details unavailable',
            message: "Couldn't load this organisation's details, so there's nothing safe to edit here. You may not have access, or the organisation record may not exist.",
            type: 'warning'
        });
    } else {
        const formContentHtml = `
        <form id="orgDetailsForm">
            <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                ${renderInputField({ id: 'orgName', label: 'Organisation Name', value: orgData.name || '', required: true })}
                ${renderInputField({ id: 'orgSlug', label: 'Organisation Slug', value: orgData.slug || '', helpText: 'Used in subdomains and URLs' })}
            </div>
            <div class="grid grid-cols-1 md:grid-cols-2 gap-4 mt-2">
                ${renderInputField({ id: 'orgContactEmail', label: 'Contact Email', value: orgData.contact_email || '', type: 'email' })}
                ${renderInputField({ id: 'orgWebsite', label: 'Official Website', value: orgData.website || '' })}
            </div>
            ${renderFormSaveBar({ submitId: 'btnSaveOrg', submitLabel: 'Save Organisation Details' })}
        </form>`;

        cardHtml = renderCard({
            title: 'Organisation Details',
            subtitle: 'General settings for the platform tenant',
            contentHtml: formContentHtml
        });
    }

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
    const rawSlug = (/** @type {HTMLInputElement} */ (document.getElementById('orgSlug'))).value.trim();
    const email = (/** @type {HTMLInputElement} */ (document.getElementById('orgContactEmail'))).value.trim();
    const website = (/** @type {HTMLInputElement} */ (document.getElementById('orgWebsite'))).value.trim();

    if (!name) {
        notify('Organisation Name is required.', 'error');
        return;
    }

    let slug;
    try {
        slug = validateSlug(rawSlug, 'Organisation slug');
    } catch (err) {
        notify(err.message, 'error');
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
        const message = err.code === '23505'
            ? `Slug '${slug}' is already in use by another organisation.`
            : `Failed to update organisation: ${err.message}`;
        notify(message, 'error');
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
        { key: 'status', label: 'Lifecycle State' },
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
            if (colKey === 'status') {
                const st = row.status || (row.is_active ? 'open' : 'archived');
                const badgeType = st === 'open' ? 'active' : st === 'draft' ? 'warning' : 'inactive';
                return renderStatusBadge(st.toUpperCase(), badgeType);
            }
            if (colKey === 'actions') {
                const currentStatus = row.status || (row.is_active ? 'open' : 'archived');
                let toggleAction = 'Publish / Open';
                let nextStatus = 'open';

                if (currentStatus === 'open') {
                    toggleAction = 'Close Applications';
                    nextStatus = 'closed';
                } else if (currentStatus === 'closed') {
                    toggleAction = 'Archive Event';
                    nextStatus = 'archived';
                } else if (currentStatus === 'archived') {
                    toggleAction = 'Re-open Event';
                    nextStatus = 'open';
                }

                return `
                <button data-event-id="${escapeHtml(row.id)}" class="btn-edit-event text-xs font-semibold text-blue-600 hover:text-blue-800 mr-3">Edit</button>
                <button data-event-id="${escapeHtml(row.id)}" data-next-status="${nextStatus}" class="btn-toggle-event text-xs font-semibold text-emerald-600 hover:text-emerald-800">
                    ${toggleAction}
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
            const nextStatus = (/** @type {HTMLElement} */ (e.currentTarget)).getAttribute('data-next-status') || 'open';
            const evt = eventsList.find(x => x.id === evtId);
            if (evt) await toggleEventStatus(evt, nextStatus);
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
    const rawSlug = (/** @type {HTMLInputElement} */ (document.getElementById('newEventSlug'))).value.trim() || prefix;

    if (!name || !prefix) {
        notify('Event Name and Booking Prefix are required.', 'error');
        return;
    }

    let slug;
    try {
        slug = validateSlug(rawSlug, 'Event slug');
    } catch (err) {
        notify(err.message, 'error');
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
        const message = err.code === '23505'
            ? `Slug '${slug}' is already in use by another event in this organisation.`
            : `Failed to create event: ${err.message}`;
        notify(message, 'error');
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
    const rawSlug = (/** @type {HTMLInputElement} */ (document.getElementById('editEventSlug'))).value.trim();

    if (!name || !prefix) {
        notify('Event Name and Booking Prefix are required.', 'error');
        return;
    }

    let slug;
    try {
        slug = validateSlug(rawSlug, 'Event slug');
    } catch (err) {
        notify(err.message, 'error');
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
        const message = err.code === '23505'
            ? `Slug '${slug}' is already in use by another event in this organisation.`
            : `Failed to update event: ${err.message}`;
        notify(message, 'error');
    }
}

async function toggleEventStatus(evt, targetStatus = 'open') {
    const sb = getSupabaseClient();
    const isNowActive = targetStatus === 'open' || targetStatus === 'ready';

    try {
        const { error } = await sb.from('events').update({
            status: targetStatus,
            is_active: isNowActive
        }).eq('id', evt.id);

        if (error) throw error;

        await auditLog('update_event_status', 'events', { event_id: evt.id, status: targetStatus });
        notify(`Event lifecycle state set to '${targetStatus.toUpperCase()}'!`, 'success');
        await loadWorkspaceData();
        renderActiveSection();
    } catch (err) {
        notify(`Failed to change event status: ${err.message}`, 'error');
    }
}

// ===================================================================
// 3. MEMBERS SECTION VIEW (Epic 2B)
// ===================================================================
let membersList = /** @type {Record<string, any>[]} */ ([]);

async function renderMembersSection(container) {
    const sb = getSupabaseClient();
    const ctx = getPlatformContext();

    const headerHtml = renderPageHeader({
        title: 'Team & Members',
        description: 'Manage organisation staff, stewards, and role permissions.',
        breadcrumb: 'Platform Administration / Workspace',
        actionHtml: `
        <button id="btnAddMember" class="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white font-semibold text-sm rounded-lg shadow-sm transition flex items-center gap-2">
            <span>👤</span>
            <span>Add Member</span>
        </button>`
    });

    try {
        // organisation_members has no email column of its own (see
        // 20260801003_create_organisation_members.sql), so the caller's
        // email is resolved via a second lookup against user_roles by id -
        // every member currently gets a user_roles row too (both
        // provision-organisation and invite-organisation-member upsert
        // both tables for the same user), so this join is reliable in
        // practice even though the tables are only related by convention,
        // not a foreign key.
        //
        // Previously this queried user_roles directly with no org filter at
        // all, so it showed the same platform-wide roster regardless of
        // which organisation was selected via View-As - see the Round 2
        // certification, Finding 2.
        const { data: orgMembers, error } = await sb
            .from('organisation_members')
            .select('id, user_id, role, created_at')
            .eq('org_id', ctx.orgId)
            .order('created_at', { ascending: false });

        if (!error && orgMembers) {
            const userIds = orgMembers.map(m => m.user_id);
            let emailById = {};
            if (userIds.length) {
                const { data: roles } = await sb.from('user_roles').select('id, email').in('id', userIds);
                emailById = Object.fromEntries((roles || []).map(r => [r.id, r.email]));
            }
            membersList = orgMembers.map(m => ({
                id: m.user_id,
                email: emailById[m.user_id] || null,
                role: m.role,
                created_at: m.created_at
            }));
        } else {
            membersList = [];
            if (error) console.warn('[Members] Failed to load organisation members:', error);
        }
    } catch (e) {
        console.warn('[Members] Failed to load organisation members:', e);
        membersList = [];
    }

    const columns = [
        { key: 'email', label: 'Member Email' },
        { key: 'role', label: 'Role' },
        { key: 'created_at', label: 'Added Date' },
        { key: 'actions', label: 'Actions' }
    ];

    const tableHtml = renderDataTable({
        columns,
        rows: membersList,
        emptyMessage: 'No members found.',
        renderCell: (row, colKey) => {
            if (colKey === 'email') {
                return `<div><div class="font-bold text-gray-900">${escapeHtml(row.email || 'User ' + row.id.slice(0, 8))}</div><div class="text-xs text-gray-400">ID: ${escapeHtml(row.id)}</div></div>`;
            }
            if (colKey === 'role') {
                return renderStatusBadge(row.role.toUpperCase(), row.role === 'admin' ? 'active' : 'info');
            }
            if (colKey === 'created_at') {
                return escapeHtml(row.created_at ? new Date(row.created_at).toLocaleDateString() : 'N/A');
            }
            if (colKey === 'actions') {
                return `
                <button data-user-id="${escapeHtml(row.id)}" data-role="${escapeHtml(row.role)}" class="btn-change-role text-xs font-semibold text-blue-600 hover:text-blue-800 mr-3">Change Role</button>
                <button data-user-id="${escapeHtml(row.id)}" class="btn-remove-member text-xs font-semibold text-red-600 hover:text-red-800">Remove</button>`;
            }
            return escapeHtml(String(row[colKey] ?? ''));
        }
    });

    const cardHtml = renderCard({
        title: 'Organisation Members',
        subtitle: 'Users with a role in this organisation',
        contentHtml: tableHtml
    });

    container.innerHTML = headerHtml + cardHtml; // innerhtml-safe: component HTML built with internal escapeHtml calls

    document.getElementById('btnAddMember')?.addEventListener('click', openAddMemberDialog);

    container.querySelectorAll('.btn-change-role').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const target = /** @type {HTMLElement} */ (e.currentTarget);
            const uid = target.getAttribute('data-user-id');
            const currentRole = target.getAttribute('data-role') || 'steward';
            if (uid) openChangeRoleDialog(uid, currentRole);
        });
    });

    container.querySelectorAll('.btn-remove-member').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            const uid = (/** @type {HTMLElement} */ (e.currentTarget)).getAttribute('data-user-id');
            if (uid) await removeMember(uid);
        });
    });
}

function openAddMemberDialog() {
    const bodyHtml = `
    <form id="addMemberForm">
        ${renderInputField({ id: 'memberEmail', label: 'User Email Address', type: 'email', required: true, placeholder: 'colleague@example.co.uk' })}
        <div class="mb-4">
            <label for="memberRole" class="block text-xs font-bold text-gray-700 uppercase tracking-wider mb-1.5">Role <span class="text-red-500">*</span></label>
            <select id="memberRole" class="w-full px-3.5 py-2 bg-white border border-gray-300 rounded-lg text-sm text-gray-900 focus:ring-2 focus:ring-blue-500">
                <option value="steward">Steward (Read-Only Event Access)</option>
                <option value="admin">Admin (Full Platform Administration)</option>
            </select>
        </div>
    </form>`;

    const actionHtml = `
    <button type="button" class="btn-close-modal px-4 py-2 text-sm font-medium text-gray-600 hover:text-gray-900 transition">Cancel</button>
    <button type="button" id="btnConfirmAddMember" class="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white font-semibold text-sm rounded-lg transition">Add Member</button>`;

    openDialog({
        id: 'dialogAddMember',
        title: 'Add Member to Organisation',
        bodyHtml,
        actionHtml
    });

    document.getElementById('btnConfirmAddMember')?.addEventListener('click', async () => {
        await submitAddMember();
    });
}

async function submitAddMember() {
    const sb = getSupabaseClient();
    const ctx = getPlatformContext();

    const email = (/** @type {HTMLInputElement} */ (document.getElementById('memberEmail'))).value.trim();
    const role = (/** @type {HTMLSelectElement} */ (document.getElementById('memberRole'))).value;

    if (!email) {
        notify('User email address is required.', 'error');
        return;
    }

    try {
        // Goes through invite-organisation-member (not sb.rpc directly) so a
        // brand-new member gets a real Supabase invite email, not just a
        // placeholder row nobody's ever told about. The Edge Function still
        // calls rpc_add_organisation_member itself, as the caller, so the
        // authorization/org-scoping there is unchanged.
        const { data, error } = await sb.functions.invoke('invite-organisation-member', {
            body: { email, role }
        });

        if (error) {
            const msg = await parseEdgeFunctionError(error, 'Failed to add member');
            throw new Error(msg);
        }
        if (data?.error) throw new Error(data.error);

        await auditLog('add_member', 'organisation_members', { org_id: ctx.orgId, email, role, user_id: data?.user_id, invite_sent: data?.invite_sent });
        notify(
            data?.invite_sent
                ? `Invite email sent to ${email}!`
                : `Member ${email} added as ${role}.`,
            'success'
        );
        document.getElementById('dialogAddMember')?.classList.add('hidden');
        await loadWorkspaceData();
        renderActiveSection();
    } catch (err) {
        notify(`Failed to add member: ${err.message}`, 'error');
    }
}

function openChangeRoleDialog(userId, currentRole) {
    const newRole = currentRole === 'admin' ? 'steward' : 'admin';
    const bodyHtml = `<p class="text-sm text-gray-600">Change role from <strong class="text-gray-900 uppercase">${escapeHtml(currentRole)}</strong> to <strong class="text-blue-600 uppercase">${escapeHtml(newRole)}</strong>?</p>`;
    const actionHtml = `
    <button type="button" class="btn-close-modal px-4 py-2 text-sm font-medium text-gray-600 hover:text-gray-900 transition">Cancel</button>
    <button type="button" id="btnConfirmRoleChange" class="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white font-semibold text-sm rounded-lg transition">Confirm Change</button>`;

    openDialog({
        id: 'dialogChangeRole',
        title: 'Change Member Role',
        bodyHtml,
        actionHtml
    });

    document.getElementById('btnConfirmRoleChange')?.addEventListener('click', async () => {
        const sb = getSupabaseClient();
        const ctx = getPlatformContext();
        try {
            // organisation_members, scoped to this org - not user_roles.
            // Writing to user_roles here would change the member's GLOBAL
            // platform role instead of their role within this organisation
            // (see Round 2 certification, Finding 2).
            const { error } = await sb
                .from('organisation_members')
                .update({ role: newRole })
                .eq('org_id', ctx.orgId)
                .eq('user_id', userId);
            if (error) throw error;

            await auditLog('change_member_role', 'organisation_members', { org_id: ctx.orgId, target_user: userId, new_role: newRole });
            notify(`Role changed to ${newRole}!`, 'success');
            document.getElementById('dialogChangeRole')?.classList.add('hidden');
            await loadWorkspaceData();
            renderActiveSection();
        } catch (err) {
            notify(`Failed to change role: ${err.message}`, 'error');
        }
    });
}

async function removeMember(userId) {
    const sb = getSupabaseClient();
    const ctx = getPlatformContext();

    if (!confirm('Are you sure you want to remove this member from this organisation?')) return;

    try {
        // organisation_members, scoped to this org - not user_roles. Deleting
        // from user_roles here would revoke the member's platform access
        // everywhere, not just remove them from this one organisation (see
        // Round 2 certification, Finding 2).
        const { error } = await sb
            .from('organisation_members')
            .delete()
            .eq('org_id', ctx.orgId)
            .eq('user_id', userId);
        if (error) throw error;

        await auditLog('remove_member', 'organisation_members', { org_id: ctx.orgId, target_user: userId });
        notify('Member removed from this organisation.', 'success');
        await loadWorkspaceData();
        renderActiveSection();
    } catch (err) {
        notify(`Failed to remove member: ${err.message}`, 'error');
    }
}

// ===================================================================
// 4. BRANDING SECTION VIEW (Epic 2B)
// ===================================================================
async function renderBrandingSection(container) {
    const sb = getSupabaseClient();
    const ctx = getPlatformContext();

    const headerHtml = renderPageHeader({
        title: 'Branding & Identity',
        description: 'Customize organisation logos, accent colors, and email/SMS footers.',
        breadcrumb: 'Platform Administration / Workspace'
    });

    let brandingSettings = /** @type {Record<string, string>} */ ({});

    try {
        const { data } = await sb
            .from('settings')
            .select('key, value')
            .eq('org_id', ctx.orgId);

        if (data) {
            data.forEach(r => { brandingSettings[r.key] = r.value; });
        }
    } catch (e) {
        console.warn('[Branding] Error loading branding settings:', e);
    }

    const formContentHtml = `
    <form id="brandingForm">
        <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
            ${renderInputField({ id: 'logoUrl', label: 'Primary Logo URL', value: brandingSettings.logo_url || '', placeholder: 'https://example.com/logo.png' })}
            ${renderInputField({ id: 'logoLightUrl', label: 'Light Logo URL', value: brandingSettings.logo_light_url || '', placeholder: 'https://example.com/logo-light.png' })}
        </div>
        <div class="grid grid-cols-1 md:grid-cols-2 gap-4 mt-2">
            ${renderInputField({ id: 'brandPrimaryColor', label: 'Primary Accent Color', value: brandingSettings.brand_primary_color || '', placeholder: '#2563EB' })}
            ${renderInputField({ id: 'brandAccentColor', label: 'Secondary Color', value: brandingSettings.brand_accent_color || '', placeholder: '#64748B' })}
        </div>
        <div class="grid grid-cols-1 md:grid-cols-2 gap-4 mt-2">
            ${renderInputField({ id: 'smsSenderId', label: 'SMS Sender Name (Alphanumeric)', value: brandingSettings.sms_sender_id || '', placeholder: 'YOURORG', helpText: '3-11 characters displayed on mobile phones' })}
            ${renderInputField({ id: 'orgSupportEmail', label: 'Public Support Email', value: brandingSettings.org_support_email || '', placeholder: 'support@example.com', type: 'email' })}
        </div>
        <div class="mt-4">
            <label for="emailFooterText" class="block text-xs font-bold text-gray-700 uppercase tracking-wider mb-1.5">Email Signature / Footer Text</label>
            <textarea id="emailFooterText" rows="3" placeholder="Your Organisation Name | Registered status" class="w-full px-3.5 py-2 bg-white border border-gray-300 rounded-lg text-sm text-gray-900 focus:ring-2 focus:ring-blue-500">${escapeHtml(brandingSettings.email_footer_text || '')}</textarea>
        </div>
        ${renderFormSaveBar({ submitId: 'btnSaveBranding', submitLabel: 'Save Branding Settings' })}
    </form>
    <div class="mt-6 pt-6 border-t border-gray-200">
        <h3 class="text-xs font-bold text-gray-700 uppercase tracking-wider mb-1.5">Preview</h3>
        <p class="text-xs text-gray-500 mb-3">
            Approximates how your logo and primary colour appear on the admin header and your public event page today. Updates as you type.
        </p>
        <div id="brandingPreviewHeader" class="flex items-center gap-3 p-4 bg-white border border-gray-200 rounded-lg">
            <img id="brandingPreviewLogo" alt="" class="h-8 w-auto max-w-[140px] object-contain hidden">
            <div id="brandingPreviewLogoFallback" class="h-8 w-8 rounded-full bg-gray-200 flex items-center justify-center text-xs font-bold text-gray-500" aria-hidden="true">🏢</div>
            <span id="brandingPreviewName" class="text-base font-bold text-gray-900"></span>
        </div>
        <div class="mt-3 flex flex-wrap items-center gap-3">
            <span id="brandingPreviewButton" class="inline-flex items-center justify-center px-4 py-2 rounded-lg font-bold text-white text-sm shadow-sm">Apply for a Food Stall</span>
            <span class="text-xs text-gray-500">Primary colour, as used on your public event page's booking buttons.</span>
        </div>
        <div class="mt-3 flex items-center gap-2">
            <span id="brandingPreviewAccentSwatch" class="h-5 w-5 rounded border border-gray-300 shrink-0"></span>
            <span class="text-xs text-gray-500">Secondary colour: <span id="brandingPreviewAccentValue" class="font-mono">not set</span> — saved, but not currently applied anywhere in the interface.</span>
        </div>
    </div>`;

    const cardHtml = renderCard({
        title: 'Organisation Identity',
        subtitle: 'Logos, colors, and communication signatures',
        contentHtml: formContentHtml
    });

    container.innerHTML = headerHtml + cardHtml; // innerhtml-safe: component HTML built with internal escapeHtml calls

    document.getElementById('brandingForm')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        await saveBrandingSettings();
    });

    initBrandingPreview();
}

/**
 * Live preview for Settings -> Branding & Identity (V1.1 Sprint 2, Issue 1).
 * Reads straight from the same form fields saveBrandingSettings() reads from
 * - no separate state, no new fetch. Updates on every keystroke so an admin
 * sees the effect before saving. Deliberately does NOT wire brand_accent_color
 * into the mock button or anything else: it has no real consumer anywhere in
 * the app today, and inventing one here would make the preview lie about
 * what the app actually does with it (see HANDOVER's Sprint 2 write-up).
 */
function initBrandingPreview() {
    const logoInput = /** @type {HTMLInputElement|null} */ (document.getElementById('logoUrl'));
    const primaryInput = /** @type {HTMLInputElement|null} */ (document.getElementById('brandPrimaryColor'));
    const accentInput = /** @type {HTMLInputElement|null} */ (document.getElementById('brandAccentColor'));

    const previewLogo = /** @type {HTMLImageElement|null} */ (document.getElementById('brandingPreviewLogo'));
    const previewLogoFallback = document.getElementById('brandingPreviewLogoFallback');
    const previewName = document.getElementById('brandingPreviewName');
    const previewButton = document.getElementById('brandingPreviewButton');
    const previewAccentSwatch = document.getElementById('brandingPreviewAccentSwatch');
    const previewAccentValue = document.getElementById('brandingPreviewAccentValue');

    if (!logoInput || !primaryInput || !accentInput || !previewLogo || !previewName || !previewButton || !previewAccentSwatch || !previewAccentValue) return;

    // Same display name shown today in the real nav header (js/nav.js) and
    // browser tab title - the preview should match what's actually visible
    // elsewhere on this same page load, not a separately-fetched name.
    if (previewName) previewName.textContent = CONFIG.FESTIVAL_DISPLAY_NAME || 'Your Organisation';

    // Neutral fallback so an invalid CSS colour value doesn't just silently
    // vanish (browsers ignore an invalid color assignment rather than
    // throwing) - the swatch/button always show *something*.
    const FALLBACK_COLOR = '#9CA3AF';

    /** @param {string} value @returns {boolean} */
    function isValidCssColor(value) {
        if (!value || !value.trim()) return false;
        const probe = document.createElement('div');
        probe.style.color = '';
        probe.style.color = value.trim();
        return probe.style.color !== '';
    }

    function updateLogoPreview() {
        const url = logoInput.value.trim();
        if (!url) {
            previewLogo.classList.add('hidden');
            previewLogoFallback?.classList.remove('hidden');
            return;
        }
        previewLogo.alt = previewName?.textContent || '';
        previewLogo.src = url;
        previewLogo.classList.remove('hidden');
        previewLogoFallback?.classList.add('hidden');
    }

    // CSP here has no 'unsafe-inline' for script-src, so this must be a real
    // listener, not an onerror= attribute (see js/page-event.js's identical
    // comment on its own org-logo image for the incident this refers to).
    previewLogo.addEventListener('error', () => {
        previewLogo.classList.add('hidden');
        previewLogoFallback?.classList.remove('hidden');
    });

    function updatePrimaryPreview() {
        const value = primaryInput.value.trim();
        const color = isValidCssColor(value) ? value : FALLBACK_COLOR;
        if (previewButton) previewButton.style.backgroundColor = color;
    }

    function updateAccentPreview() {
        const value = accentInput.value.trim();
        const valid = isValidCssColor(value);
        if (previewAccentSwatch) previewAccentSwatch.style.backgroundColor = valid ? value : FALLBACK_COLOR;
        if (previewAccentValue) previewAccentValue.textContent = valid ? value : 'not set';
    }

    updateLogoPreview();
    updatePrimaryPreview();
    updateAccentPreview();

    logoInput.addEventListener('input', updateLogoPreview);
    primaryInput.addEventListener('input', updatePrimaryPreview);
    accentInput.addEventListener('input', updateAccentPreview);
}

async function saveBrandingSettings() {
    const sb = getSupabaseClient();
    const ctx = getPlatformContext();
    const btn = /** @type {HTMLButtonElement|null} */ (document.getElementById('btnSaveBranding'));

    const settingsToSave = [
        { key: 'logo_url', value: (/** @type {HTMLInputElement} */ (document.getElementById('logoUrl'))).value.trim() },
        { key: 'logo_light_url', value: (/** @type {HTMLInputElement} */ (document.getElementById('logoLightUrl'))).value.trim() },
        { key: 'brand_primary_color', value: (/** @type {HTMLInputElement} */ (document.getElementById('brandPrimaryColor'))).value.trim() },
        { key: 'brand_accent_color', value: (/** @type {HTMLInputElement} */ (document.getElementById('brandAccentColor'))).value.trim() },
        { key: 'sms_sender_id', value: (/** @type {HTMLInputElement} */ (document.getElementById('smsSenderId'))).value.trim() },
        { key: 'org_support_email', value: (/** @type {HTMLInputElement} */ (document.getElementById('orgSupportEmail'))).value.trim() },
        { key: 'email_footer_text', value: (/** @type {HTMLTextAreaElement} */ (document.getElementById('emailFooterText'))).value.trim() }
    ];

    if (btn) {
        btn.disabled = true;
        btn.innerText = 'Saving...';
    }

    try {
        const rows = settingsToSave.map(item => ({
            org_id: ctx.orgId,
            key: item.key,
            value: item.value
        }));

        const { error } = await sb.from('settings').upsert(rows, { onConflict: 'org_id,key' });
        if (error) throw error;

        await auditLog('update_branding', 'settings', { org_id: ctx.orgId, keys: settingsToSave.map(x => x.key) });
        notify('Branding settings updated successfully!', 'success');
    } catch (err) {
        notify(`Failed to save branding: ${err.message}`, 'error');
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerText = 'Save Branding Settings';
        }
    }
}

// ===================================================================
// 5. CATEGORISED SETTINGS HUB (Epic 2B)
// ===================================================================
let activeSettingsTab = 'general';

async function renderSettingsSection(container) {
    const sb = getSupabaseClient();
    const ctx = getPlatformContext();

    const headerHtml = renderPageHeader({
        title: 'System Settings Hub',
        description: 'Categorised application configuration (General, Bookings, Comms, Payments, Advanced).',
        breadcrumb: 'Platform Administration / Workspace'
    });

    let currentSettings = /** @type {Record<string, string>} */ ({});

    try {
        const { data } = await sb
            .from('settings')
            .select('key, value')
            .eq('org_id', ctx.orgId);

        if (data) {
            data.forEach(r => { currentSettings[r.key] = r.value; });
        }
    } catch (e) {
        console.warn('[Settings Hub] Error loading settings:', e);
    }

    const tabs = [
        { id: 'general', label: 'General' },
        { id: 'bookings', label: 'Bookings' },
        { id: 'comms', label: 'Communications' },
        { id: 'payments', label: 'Payments' },
        { id: 'advanced', label: 'Advanced' }
    ];

    const tabNavHtml = `
    <div class="border-b border-gray-200 mb-6">
        <nav class="flex space-x-6" aria-label="Settings Categories">
            ${tabs.map(t => {
                const isActive = t.id === activeSettingsTab;
                const cls = isActive ? 'border-blue-600 text-blue-600 font-bold border-b-2 py-3 text-sm' : 'text-gray-500 hover:text-gray-700 font-medium py-3 text-sm transition';
                return `<button data-settings-tab="${escapeHtml(t.id)}" class="btn-settings-tab ${cls}">${escapeHtml(t.label)}</button>`;
            }).join('')}
        </nav>
    </div>`;

    let tabFormHtml;

    if (activeSettingsTab === 'general') {
        tabFormHtml = `
        <form id="settingsCategoryForm">
            <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                ${renderInputField({ id: 'setFestivalName', label: 'Festival Display Name', value: currentSettings.festival_display_name || '', placeholder: 'e.g. Riverside Community Festival' })}
                ${renderInputField({ id: 'setBookingPrefix', label: 'Default Booking Prefix', value: currentSettings.booking_prefix || 'ESF26' })}
            </div>
            <div class="grid grid-cols-1 md:grid-cols-2 gap-4 mt-2">
                ${renderInputField({ id: 'setCancelUrl', label: 'Cancellation URL', value: currentSettings.cancel_url || 'https://app.ellastreet.co.uk/cancel_booking.html' })}
                ${renderInputField({ id: 'setBucketName', label: 'Documents Storage Bucket', value: currentSettings.bucket_name || 'esf-documents' })}
            </div>
            <div class="grid grid-cols-1 md:grid-cols-2 gap-4 mt-2">
                ${renderInputField({ id: 'setRegulatoryAuthorityName', label: 'Regulatory Authority', value: currentSettings.regulatory_authority_name || '', placeholder: 'e.g. Hull City Council', helpText: 'Shown on the public food-stall declaration. Leave blank for generic wording ("all applicable food and hygiene regulations").' })}
                ${renderInputField({ id: 'setInsuranceMinimumAmount', label: 'Insurance Minimum Amount', value: currentSettings.insurance_minimum_amount || '', placeholder: 'e.g. £5,000,000', helpText: 'Shown on the public food-stall declaration. Leave blank for generic wording ("appropriate for this event").' })}
            </div>
            ${renderFormSaveBar({ submitId: 'btnSaveCatSettings', submitLabel: 'Save General Settings' })}
        </form>`;
    } else if (activeSettingsTab === 'bookings') {
        tabFormHtml = `
        <form id="settingsCategoryForm">
            <div class="space-y-2 mb-4">
                ${renderToggleField({ id: 'setFoodOpen', label: 'Food Stall Applications Open', checked: currentSettings.food_bookings_open !== 'false', helpText: 'Controls public food booking form access' })}
                ${renderToggleField({ id: 'setGeneralOpen', label: 'General Trader Applications Open', checked: currentSettings.general_bookings_open !== 'false', helpText: 'Controls public general trader form access' })}
            </div>
            ${renderFormSaveBar({ submitId: 'btnSaveCatSettings', submitLabel: 'Save Booking Settings' })}
        </form>`;
    } else if (activeSettingsTab === 'comms') {
        tabFormHtml = `
        <form id="settingsCategoryForm">
            <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                ${renderInputField({ id: 'setSmsProvider', label: 'SMS Provider', value: currentSettings.sms_provider || 'mock', helpText: 'mock | thesmsworks' })}
                ${renderInputField({ id: 'setSmsTestMode', label: 'SMS Test Mode', value: currentSettings.sms_test_mode || 'true', helpText: 'true | false' })}
            </div>
            ${renderFormSaveBar({ submitId: 'btnSaveCatSettings', submitLabel: 'Save Communications Settings' })}
        </form>`;
    } else if (activeSettingsTab === 'payments') {
        tabFormHtml = `
        <form id="settingsCategoryForm">
            <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                ${renderSecretField({ id: 'setStripeKeyTest', label: 'Stripe Test Secret Key', value: currentSettings.stripe_secret_key_test || '', placeholder: 'sk_test_...' })}
                ${renderSecretField({ id: 'setStripeWebhookTest', label: 'Stripe Test Webhook Secret', value: currentSettings.stripe_webhook_secret_test || '', placeholder: 'whsec_...' })}
            </div>
            <div class="grid grid-cols-1 md:grid-cols-3 gap-4 mt-2">
                ${renderInputField({ id: 'setBankName', label: 'Bank Account Name', value: currentSettings.bank_account_name || '', placeholder: 'e.g. Riverside Community Festival' })}
                ${renderInputField({ id: 'setBankSortCode', label: 'Sort Code', value: currentSettings.bank_sort_code || '12-34-56' })}
                ${renderInputField({ id: 'setBankAccountNo', label: 'Account Number', value: currentSettings.bank_account_number || '12345678' })}
            </div>
            ${renderFormSaveBar({ submitId: 'btnSaveCatSettings', submitLabel: 'Save Payment Settings' })}
        </form>`;
    } else {
        tabFormHtml = `
        <form id="settingsCategoryForm">
            ${renderInputField({ id: 'setSentryUrl', label: 'Sentry Loader URL', value: currentSettings.sentry_browser_loader_url || '', placeholder: 'https://js-de.sentry-cdn.com/...' })}
            ${renderFormSaveBar({ submitId: 'btnSaveCatSettings', submitLabel: 'Save Advanced Settings' })}
        </form>`;
    }

    const cardHtml = renderCard({
        title: `${activeSettingsTab.toUpperCase()} Configuration`,
        subtitle: 'Manage categorised setting parameters',
        contentHtml: tabNavHtml + tabFormHtml
    });

    container.innerHTML = headerHtml + cardHtml; // innerhtml-safe: component HTML built with internal escapeHtml calls

    bindSecretFieldToggles(container);

    container.querySelectorAll('.btn-settings-tab').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const tabId = (/** @type {HTMLElement} */ (e.currentTarget)).getAttribute('data-settings-tab');
            if (tabId) {
                activeSettingsTab = tabId;
                renderSettingsSection(container);
            }
        });
    });

    document.getElementById('settingsCategoryForm')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        await saveCategorySettings(currentSettings);
    });
}

async function saveCategorySettings(currentSettings) {
    const sb = getSupabaseClient();
    const ctx = getPlatformContext();
    const btn = /** @type {HTMLButtonElement|null} */ (document.getElementById('btnSaveCatSettings'));

    /** @type {{ key: string, value: string }[]} */
    const updates = [];

    if (activeSettingsTab === 'general') {
        updates.push(
            { key: 'festival_display_name', value: (/** @type {HTMLInputElement} */ (document.getElementById('setFestivalName'))).value.trim() },
            { key: 'booking_prefix', value: (/** @type {HTMLInputElement} */ (document.getElementById('setBookingPrefix'))).value.trim() },
            { key: 'cancel_url', value: (/** @type {HTMLInputElement} */ (document.getElementById('setCancelUrl'))).value.trim() },
            { key: 'bucket_name', value: (/** @type {HTMLInputElement} */ (document.getElementById('setBucketName'))).value.trim() },
            { key: 'regulatory_authority_name', value: (/** @type {HTMLInputElement} */ (document.getElementById('setRegulatoryAuthorityName'))).value.trim() },
            { key: 'insurance_minimum_amount', value: (/** @type {HTMLInputElement} */ (document.getElementById('setInsuranceMinimumAmount'))).value.trim() }
        );
    } else if (activeSettingsTab === 'bookings') {
        // food_bookings_open / general_bookings_open are the keys every
        // reader actually checks (js/config.js's applySettingsToConfig(),
        // js/settings/system.js's initToggles(), and the public booking
        // form's own open/closed gate in js/public-context.js). This tab
        // previously wrote food_applications_open /
        // general_trader_applications_open - names nothing else in the app
        // recognised, so toggling "open"/"closed" here saved successfully
        // but had zero effect on whether the public forms were actually
        // open (RC operational certification, Finding 8).
        updates.push(
            { key: 'food_bookings_open', value: String((/** @type {HTMLInputElement} */ (document.getElementById('setFoodOpen'))).checked) },
            { key: 'general_bookings_open', value: String((/** @type {HTMLInputElement} */ (document.getElementById('setGeneralOpen'))).checked) }
        );
    } else if (activeSettingsTab === 'comms') {
        updates.push(
            { key: 'sms_provider', value: (/** @type {HTMLInputElement} */ (document.getElementById('setSmsProvider'))).value.trim() },
            { key: 'sms_test_mode', value: (/** @type {HTMLInputElement} */ (document.getElementById('setSmsTestMode'))).value.trim() }
        );
    } else if (activeSettingsTab === 'payments') {
        updates.push(
            { key: 'stripe_secret_key_test', value: (/** @type {HTMLInputElement} */ (document.getElementById('setStripeKeyTest'))).value.trim() },
            { key: 'stripe_webhook_secret_test', value: (/** @type {HTMLInputElement} */ (document.getElementById('setStripeWebhookTest'))).value.trim() },
            { key: 'bank_account_name', value: (/** @type {HTMLInputElement} */ (document.getElementById('setBankName'))).value.trim() },
            { key: 'bank_sort_code', value: (/** @type {HTMLInputElement} */ (document.getElementById('setBankSortCode'))).value.trim() },
            { key: 'bank_account_number', value: (/** @type {HTMLInputElement} */ (document.getElementById('setBankAccountNo'))).value.trim() }
        );
    } else {
        // sentry_browser_loader_url is the key config.js/system.js actually
        // read - same mismatch as the bookings tab above.
        updates.push(
            { key: 'sentry_browser_loader_url', value: (/** @type {HTMLInputElement} */ (document.getElementById('setSentryUrl'))).value.trim() }
        );
    }

    if (btn) {
        btn.disabled = true;
        btn.innerText = 'Saving...';
    }

    try {
        const rows = updates.map(item => ({
            org_id: ctx.orgId,
            key: item.key,
            value: item.value
        }));

        const { error } = await sb.from('settings').upsert(rows, { onConflict: 'org_id,key' });
        if (error) throw error;

        await auditLog('update_settings_category', 'settings', { org_id: ctx.orgId, category: activeSettingsTab, keys: updates.map(x => x.key) });
        notify(`${activeSettingsTab.toUpperCase()} settings saved successfully!`, 'success');
    } catch (err) {
        notify(`Failed to save settings: ${err.message}`, 'error');
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerText = `Save ${activeSettingsTab.toUpperCase()} Settings`;
        }
    }
}

// ===================================================================
// 6. AUDIT LOG SECTION VIEW (Epic 2B)
// ===================================================================
async function renderAuditSection(container) {
    const sb = getSupabaseClient();
    const ctx = getPlatformContext();

    const headerHtml = renderPageHeader({
        title: 'Platform Audit Log',
        description: 'View full audit trails of administrative actions across this organisation.',
        breadcrumb: 'Platform Administration / Workspace'
    });

    let auditRows = /** @type {Record<string, any>[]} */ ([]);

    try {
        const { data, error } = await sb
            .from('audit_logs')
            .select('*')
            .eq('org_id', ctx.orgId)
            .order('created_at', { ascending: false })
            .limit(50);

        if (!error && data) {
            auditRows = data;
        }
    } catch (e) {
        console.warn('[Audit Log] Failed to fetch audit logs:', e);
    }

    const columns = [
        { key: 'action', label: 'Action' },
        { key: 'user_email', label: 'Actor' },
        { key: 'target_id', label: 'Target' },
        { key: 'created_at', label: 'Timestamp' }
    ];

    const tableHtml = renderDataTable({
        columns,
        rows: auditRows,
        emptyMessage: 'No audit records logged yet.',
        renderCell: (row, colKey) => {
            if (colKey === 'action') {
                return `<span class="font-bold text-gray-900">${escapeHtml(row.action)}</span>`;
            }
            if (colKey === 'user_email') {
                return escapeHtml(row.user_email || 'System');
            }
            if (colKey === 'created_at') {
                return escapeHtml(row.created_at ? new Date(row.created_at).toLocaleString() : 'N/A');
            }
            return escapeHtml(String(row[colKey] ?? ''));
        }
    });

    const cardHtml = renderCard({
        title: 'Recent Activity Trail',
        subtitle: 'Latest 50 logged security and administrative events',
        contentHtml: tableHtml
    });

    container.innerHTML = headerHtml + cardHtml; // innerhtml-safe: component HTML built with internal escapeHtml calls
}

