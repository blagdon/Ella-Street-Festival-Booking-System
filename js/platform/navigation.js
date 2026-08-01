// @ts-check
/**
 * js/platform/navigation.js
 * Sub-navigation section routing for the Platform Administration Workspace.
 */
import { escapeHtml } from '../utils.js';

export const ADMIN_SECTIONS = [
    { id: 'dashboard', label: 'Dashboard', icon: '📊' },
    { id: 'organisation', label: 'Organisation', icon: '🏢' },
    { id: 'events', label: 'Events', icon: '📅' },
    { id: 'members', label: 'Members', icon: '👥' },
    { id: 'branding', label: 'Branding', icon: '🎨' },
    { id: 'settings', label: 'Settings', icon: '⚙️' },
    { id: 'audit', label: 'Audit Log', icon: '📋' }
];

/**
 * Renders the sidebar navigation for the Admin Workspace.
 * @param {string} activeSectionId
 * @returns {string} HTML string
 */
export function renderAdminSidebar(activeSectionId) {
    const navItems = ADMIN_SECTIONS.map(section => {
        const isActive = section.id === activeSectionId;
        const activeClass = isActive
            ? 'bg-blue-50 text-blue-700 font-bold border-l-4 border-blue-600'
            : 'text-gray-600 hover:bg-gray-50 hover:text-gray-900 font-medium';

        return `
        <button 
            data-section="${escapeHtml(section.id)}"
            class="admin-nav-item w-full flex items-center px-4 py-3 text-sm rounded-r-lg transition text-left gap-3 ${activeClass}"
        >
            <span class="text-base">${section.icon}</span>
            <span>${escapeHtml(section.label)}</span>
        </button>`;
    }).join('');

    return `
    <nav class="space-y-1 pr-2" aria-label="Platform Administration Sections">
        <div class="px-4 py-2 text-xs font-bold text-gray-400 uppercase tracking-wider">Workspace</div>
        ${navItems}
    </nav>`;
}
