// @ts-check
/**
 * nav.js
 * Handles dynamic injection of the Admin Header and Mobile Menu.
 */
import { getPlatformContext, getCurrentInstance, setCurrentOrgId, CONFIG } from './config.js';
import { signOut, getSupabaseClient } from './supabase.js';
import { escapeHtml } from './utils.js';
import { getCurrentEvent, setCurrentEvent, fetchAvailableEvents } from './event-service.js';

export async function initNavigation() {
    const container = document.getElementById('nav-container');
    if (!container) return;

    const current = getCurrentInstance();
    const ctx = getPlatformContext();
    const activeEvent = getCurrentEvent();
    const isPrimaryOrg = ctx.orgId === 'org_default';

    // Helper to get badge style
    const getBadgeStyle = (val) => {
        switch (val) {
            case 'FOOD': return "bg-red-50 text-red-700 border-red-200";
            case 'GENERAL': return "bg-blue-50 text-blue-700 border-blue-200";
            case 'MISC': return "bg-purple-50 text-purple-700 border-purple-200";
            default: return "bg-gray-100 text-gray-600 border-gray-300";
        }
    };

    const isHub = window.location.pathname.endsWith('index.html') || window.location.pathname.endsWith('index') || window.location.pathname.endsWith('/');

    const backBtnDesktop = isHub ? '' : `
    <a href="index.html" class="hidden md:inline-flex items-center text-gray-500 hover:text-blue-600 text-sm font-medium transition mr-4 group">
        <svg class="w-4 h-4 mr-1 group-hover:-translate-x-0.5 transition-transform" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 19l-7-7m0 0l7-7m-7 7h18"></path></svg>
        Back to Hub
    </a>`;

    const backBtnMobile = isHub ? '' : `
    <a href="index.html" class="block w-full text-left text-sm text-gray-500 hover:text-blue-600 font-medium px-3 py-2 bg-gray-50 rounded transition mb-2">
        ← Back to Hub
    </a>`;

    const prefix = window.ESF_PUBLIC_CONFIG?.BOOKING_PREFIX || "ESF26";
    const yearMatch = prefix.match(/\d+$/);
    const year = yearMatch ? `20${yearMatch[0]}` : "2026";

    const headerHTML = `
    <div class="bg-white text-gray-900 px-4 md:px-6 py-4 shadow-sm border-b border-gray-200">
        <div class="flex justify-between items-center">
            <!-- Title -->
            <div class="flex items-center flex-1 min-w-0">
                ${backBtnDesktop}
                <a href="index.html" class="flex items-center hover:opacity-80 transition min-w-0">
                    ${CONFIG.BRANDING.LOGO_URL ? `
                    <img id="navOrgLogo" src="${escapeHtml(CONFIG.BRANDING.LOGO_URL)}" alt="${escapeHtml(CONFIG.FESTIVAL_DISPLAY_NAME)}" class="h-7 md:h-8 w-auto max-w-[140px] object-contain mr-2 shrink-0">
                    ` : ''}
                    <h1 class="text-base md:text-xl font-bold tracking-wide truncate">
                        ${escapeHtml(CONFIG.FESTIVAL_DISPLAY_NAME)}
                        <span class="hidden sm:inline font-normal text-sm md:text-lg text-gray-600">| ${year} Admin</span>
                    </h1>
                </a>
                <span id="instanceBadge" class="text-xs font-bold px-2 py-1 rounded ml-2 border shrink-0 ${getBadgeStyle(current)}">${current}</span>
                <span id="tenantBadge" class="inline-flex items-center text-xs font-semibold px-2 py-0.5 rounded ml-2 border shrink-0 ${isPrimaryOrg ? 'bg-blue-50 text-blue-800 border-blue-200' : 'bg-amber-50 text-amber-800 border-amber-300'}" title="Organisation / Event Context">
                    ${escapeHtml(ctx.orgId)} | ${escapeHtml(activeEvent.booking_prefix || ctx.eventId)}
                </span>
                ${!isPrimaryOrg ? `
                <button id="btnSwitchPrimaryOrgNav" class="inline-flex items-center ml-1 px-2 py-0.5 rounded text-xs font-semibold border shrink-0 bg-amber-500 text-white border-amber-600 hover:bg-amber-600 transition" title="Switch back to the primary organisation (org_default)">
                    ↩ Primary org
                </button>` : ''}
            </div>
            
            <!-- Desktop Controls -->
            <div class="hidden md:flex items-center gap-3">
                <div class="flex items-center bg-gray-50 rounded px-3 py-1 border border-gray-200">
                    <span class="text-xs text-gray-500 mr-2 uppercase font-bold tracking-wider">Org:</span>
                    <select id="orgSelect" aria-label="Select active organisation" class="bg-transparent text-sm font-bold text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500 rounded cursor-pointer max-w-[160px] truncate">
                        <option value="${escapeHtml(ctx.orgId)}">${escapeHtml(ctx.orgId)}</option>
                    </select>
                    <span id="orgScopeBadge" class="hidden ml-1.5 text-[10px] font-bold px-1.5 py-0.5 rounded bg-purple-100 text-purple-700 border border-purple-200 shrink-0" title="You hold the platform administrator role, so every organisation is listed here - not just ones you're a member of.">🛡️ ALL ORGS</span>
                </div>

                <div class="flex items-center bg-gray-50 rounded px-3 py-1 border border-gray-200">
                    <span class="text-xs text-gray-500 mr-2 uppercase font-bold tracking-wider">Event:</span>
                    <select id="eventSelect" aria-label="Select active festival event" class="bg-transparent text-sm font-bold text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500 rounded cursor-pointer max-w-[160px] truncate">
                        <option value="${escapeHtml(activeEvent.id)}">${escapeHtml(activeEvent.name)}</option>
                    </select>
                </div>

                <div class="flex items-center bg-gray-50 rounded px-3 py-1 border border-gray-200">
                    <span class="text-xs text-gray-500 mr-2 uppercase font-bold tracking-wider">Type:</span>
                    <select id="instanceSelect" aria-label="Select database instance" class="bg-transparent text-sm font-bold text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500 rounded cursor-pointer">
                        <option value="DEV">🛠️ DEV (Test Data)</option>
                        <option value="FOOD">🍔 FOOD Stalls</option>
                        <option value="GENERAL">🎨 GENERAL Traders</option>
                        <option value="MISC">⚡ MISC (Facilities)</option>
                    </select>
                </div>

                <a href="admin.html" class="px-3 py-1.5 bg-blue-50 text-blue-700 hover:bg-blue-100 border border-blue-200 rounded text-xs font-bold transition">
                    Workspace
                </a>

                <button id="btnSignOut" class="text-sm text-gray-500 hover:text-red-600 font-medium px-2 py-1 transition">
                    Sign Out
                </button>
            </div>
            
            <!-- Mobile Menu Button -->
            <button id="mobileMenuBtn" class="md:hidden p-2 text-gray-600 hover:text-gray-900" aria-label="Toggle menu" aria-expanded="false" aria-controls="mobileMenu">
                <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h16"></path>
                </svg>
            </button>
        </div>
        
        <!-- Mobile Menu -->
        <div id="mobileMenu" class="mobile-menu hidden mt-4 pt-4 border-t border-gray-200 space-y-3">
             ${backBtnMobile}
             <div class="flex flex-col gap-2">
                <span class="text-xs text-gray-500 uppercase font-bold tracking-wider">Organisation: <span id="orgScopeBadgeMobile" class="hidden ml-1 text-[10px] font-bold px-1.5 py-0.5 rounded bg-purple-100 text-purple-700 border border-purple-200 normal-case tracking-normal" title="You hold the platform administrator role, so every organisation is listed here - not just ones you're a member of.">🛡️ All orgs (platform admin)</span></span>
                <select id="orgSelectMobile" aria-label="Select active organisation" class="bg-gray-50 border border-gray-200 rounded px-3 py-2 text-sm font-bold text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500 cursor-pointer">
                    <option value="${escapeHtml(ctx.orgId)}">${escapeHtml(ctx.orgId)}</option>
                </select>
            </div>
             <div class="flex flex-col gap-2">
                <span class="text-xs text-gray-500 uppercase font-bold tracking-wider">Database:</span>
                <select id="instanceSelectMobile" aria-label="Select database instance" class="bg-gray-50 border border-gray-200 rounded px-3 py-2 text-sm font-bold text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500 cursor-pointer">
                    <option value="DEV">🛠️ DEV (Test Data)</option>
                    <option value="FOOD">🍔 FOOD Stalls</option>
                    <option value="GENERAL">🎨 GENERAL Traders</option>
                    <option value="MISC">⚡ MISC (Facilities)</option>
                </select>
            </div>
            <a href="admin.html" class="block w-full text-left text-sm text-blue-700 font-bold px-3 py-2 bg-blue-50 rounded transition">
                Platform Administration Workspace
            </a>
            <button id="btnSignOutMobile" class="w-full text-left text-sm text-gray-500 hover:text-red-600 font-medium px-3 py-2 bg-gray-50 rounded transition">
                Sign Out
            </button>
        </div>
    </div>
    `;

    container.innerHTML = headerHTML; // innerhtml-safe: component HTML built with internal escapeHtml calls

    // Remove the logo on a broken/unreachable URL rather than showing the
    // browser's default broken-image icon. Must be addEventListener, not an
    // inline onerror= attribute — this app's CSP has no 'unsafe-inline' for
    // script-src, so an inline handler is silently blocked, not just
    // discouraged (see HANDOVER.md's "No inline event handlers" gotcha).
    document.getElementById('navOrgLogo')?.addEventListener('error', function () {
        this.remove();
    });

    // Switch back to the primary organisation from any admin page — mirrors
    // js/page-admin.js's own btnSwitchPrimaryOrg, but available everywhere
    // nav.js is injected (not just admin.html's workspace), since an admin
    // can end up viewing a non-primary org from the header dropdown or the
    // provisioning wizard and would otherwise have no way back except
    // navigating to the Platform Administration Workspace specifically.
    document.getElementById('btnSwitchPrimaryOrgNav')?.addEventListener('click', () => {
        setCurrentOrgId('org_default');
        window.location.reload();
    });

    // Populate Organisation Selectors - via rpc_list_switchable_organisations(),
    // not a raw organisations SELECT. The org switcher used to list every
    // organisation on the platform for any authenticated admin regardless of
    // membership - a confidentiality leak of every tenant's existence, name,
    // slug and website (RC operational certification, Finding 6). The RPC
    // returns only the organisations the caller genuinely belongs to, unless
    // they hold the platform-wide admin role, in which case it returns every
    // organisation - the same distinction check_user_role() already makes,
    // just applied here explicitly and labelled in the UI (orgScopeBadge)
    // rather than silently baked into a blanket RLS bypass.
    const sb = getSupabaseClient();
    sb.rpc('rpc_list_switchable_organisations').then(({ data: result, error }) => {
        const orgs = result?.organisations;
        const isPlatformAdminScope = result?.scope === 'platform_admin';

        let list = (orgs && orgs.length > 0)
            ? orgs
            : [{ id: 'org_default', name: 'Ella Street Festival', slug: 'org_default' }];

        // Ensure org_default is always present in list
        if (!list.some(o => o.id === 'org_default')) {
            list.unshift({ id: 'org_default', name: 'Ella Street Festival (Default)', slug: 'org_default' });
        }

        ['orgScopeBadge', 'orgScopeBadgeMobile'].forEach(id => {
            document.getElementById(id)?.classList.toggle('hidden', !isPlatformAdminScope);
        });

        ['orgSelect', 'orgSelectMobile'].forEach(id => {
            const selectEl = /** @type {HTMLSelectElement|null} */ (document.getElementById(id));
            if (!selectEl) return;

            selectEl.innerHTML = list.map(o =>
                `<option value="${escapeHtml(o.id)}" ${o.id === ctx.orgId ? 'selected' : ''}>🏢 ${escapeHtml(o.name)}</option>`
            ).join('');

            selectEl.addEventListener('change', (evt) => {
                const target = /** @type {HTMLSelectElement} */ (evt.target);
                setCurrentOrgId(target.value);
                window.location.reload();
            });
        });
    });

    // Populate Event Selector
    try {
        const events = await fetchAvailableEvents();
        const selectEl = /** @type {HTMLSelectElement|null} */ (document.getElementById('eventSelect'));
        if (selectEl) {
            const currentEvt = getCurrentEvent();
            selectEl.innerHTML = events.map(e =>
                `<option value="${escapeHtml(e.id)}" ${e.id === currentEvt.id ? 'selected' : ''}>${escapeHtml(e.name)}</option>`
            ).join(''); // innerhtml-safe: component HTML built with internal escapeHtml calls

            selectEl.addEventListener('change', (evt) => {
                const target = /** @type {HTMLSelectElement} */ (evt.target);
                const selectedEvt = events.find(x => x.id === target.value);
                if (selectedEvt) {
                    setCurrentEvent(selectedEvt);
                    window.location.reload();
                }
            });
        }

        const tenantBadge = document.getElementById('tenantBadge');
        if (tenantBadge) {
            const resolvedEvt = getCurrentEvent();
            tenantBadge.textContent = `${ctx.orgId} | ${resolvedEvt.booking_prefix || ctx.eventId}`;
        }
    } catch (e) {
        console.warn('Failed to fetch events for nav:', e);
    }

    // Dynamically update document title to use current prefix
    if (document.title.includes('ESF26')) {
        document.title = document.title.replace('ESF26', prefix);
    }

    // Instance Selectors
    const setInstance = (val) => {
        localStorage.setItem('ESF_INSTANCE', val);
        window.location.reload();
    };

    const instSelect = /** @type {HTMLSelectElement} */ (document.getElementById('instanceSelect'));
    const instSelectMobile = /** @type {HTMLSelectElement} */ (document.getElementById('instanceSelectMobile'));

    if (instSelect) {
        instSelect.value = current;
        instSelect.addEventListener('change', (e) => setInstance(/** @type {HTMLSelectElement} */ (e.target).value));
    }
    if (instSelectMobile) {
        instSelectMobile.value = current;
        instSelectMobile.addEventListener('change', (e) => setInstance(/** @type {HTMLSelectElement} */ (e.target).value));
    }

    // Sign Out Buttons
    const handleSignOut = async () => {
        try {
            await signOut();
            window.location.href = 'login.html';
        } catch (e) {
            console.error('Sign out error:', e);
        }
    };

    document.getElementById('btnSignOut')?.addEventListener('click', handleSignOut);
    document.getElementById('btnSignOutMobile')?.addEventListener('click', handleSignOut);

    // Mobile Menu Toggle
    const mobileMenuBtn = document.getElementById('mobileMenuBtn');
    const mobileMenu = document.getElementById('mobileMenu');

    if (mobileMenuBtn && mobileMenu) {
        mobileMenuBtn.addEventListener('click', () => {
            const isExpanded = mobileMenuBtn.getAttribute('aria-expanded') === 'true';
            mobileMenuBtn.setAttribute('aria-expanded', String(!isExpanded));
            mobileMenu.classList.toggle('hidden');
        });
    }
}
