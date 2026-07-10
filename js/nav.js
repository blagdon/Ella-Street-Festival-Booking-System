/**
 * nav.js
 * Handles dynamic injection of the Admin Header and Mobile Menu.
 */
import { getCurrentInstance, CONFIG } from './config.js';
import { signOut } from './supabase.js';

export function initNavigation() {
    const container = document.getElementById('nav-container');
    if (!container) return;

    const current = getCurrentInstance();
    const isMobile = window.innerWidth < 768;

    // Helper to get badge style
    const getBadgeStyle = (val) => {
        switch (val) {
            case 'FOOD': return "bg-red-50 text-red-700 border-red-200";
            case 'GENERAL': return "bg-blue-50 text-blue-700 border-blue-200";
            case 'MISC': return "bg-purple-50 text-purple-700 border-purple-200";
            default: return "bg-gray-100 text-gray-600 border-gray-300";
        }
    };

    const isHub = window.location.pathname.endsWith('index.html') || window.location.pathname.endsWith('/');

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
                <a href="index.html" class="flex items-center hover:opacity-80 transition">
                    <h1 class="text-base md:text-xl font-bold tracking-wide truncate">
                        Ella Street Festival 
                        <span class="hidden sm:inline opacity-50 font-normal text-sm md:text-lg">| ${year} Admin</span>
                    </h1>
                </a>
                <span id="instanceBadge" class="text-xs font-bold px-2 py-1 rounded ml-2 border shrink-0 ${getBadgeStyle(current)}">${current}</span>
            </div>
            
            <!-- Desktop Controls -->
            <div class="hidden md:flex items-center gap-4">
                <div class="flex items-center bg-gray-50 rounded px-3 py-1 border border-gray-200">
                    <span class="text-xs text-gray-500 mr-2 uppercase font-bold tracking-wider">Database:</span>
                    <select id="instanceSelect" class="bg-transparent text-sm font-bold text-gray-700 focus:outline-none cursor-pointer">
                        <option value="DEV">🛠️ DEV (Test Data)</option>
                        <option value="FOOD">🍔 FOOD Stalls</option>
                        <option value="GENERAL">🎨 GENERAL Traders</option>
                        <option value="MISC">⚡ MISC (Facilities)</option>
                    </select>
                </div>

                <button id="btnSignOut" class="text-sm text-gray-500 hover:text-red-600 font-medium px-4 py-2 transition">
                    Sign Out
                </button>
            </div>
            
            <!-- Mobile Menu Button -->
            <button id="mobileMenuBtn" class="md:hidden p-2 text-gray-600 hover:text-gray-900">
                <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h16"></path>
                </svg>
            </button>
        </div>
        
        <!-- Mobile Menu -->
        <div id="mobileMenu" class="mobile-menu hidden mt-4 pt-4 border-t border-gray-200 space-y-3">
             ${backBtnMobile}
             <div class="flex flex-col gap-2">
                <span class="text-xs text-gray-500 uppercase font-bold tracking-wider">Database:</span>
                <select id="instanceSelectMobile" class="bg-gray-50 border border-gray-200 rounded px-3 py-2 text-sm font-bold text-gray-700 focus:outline-none cursor-pointer">
                    <option value="DEV">🛠️ DEV (Test Data)</option>
                    <option value="FOOD">🍔 FOOD Stalls</option>
                    <option value="GENERAL">🎨 GENERAL Traders</option>
                    <option value="MISC">⚡ MISC (Facilities)</option>
                </select>
            </div>
            <button id="btnSignOutMobile" class="w-full text-left text-sm text-gray-500 hover:text-red-600 font-medium px-3 py-2 bg-gray-50 rounded transition">
                Sign Out
            </button>
        </div>
    </div>
    `;

    container.innerHTML = headerHTML;

    // Dynamically update document title to use current prefix
    if (document.title.includes('ESF26')) {
        document.title = document.title.replace('ESF26', prefix);
    }

    // Attach Event Listeners

    // Instance Selectors
    const setInstance = (val) => {
        localStorage.setItem('ESF_INSTANCE', val);
        window.location.reload();
    };

    const sel = document.getElementById('instanceSelect');
    if (sel) {
        sel.value = current;
        sel.addEventListener('change', (e) => setInstance(e.target.value));
    }

    const selMobile = document.getElementById('instanceSelectMobile');
    if (selMobile) {
        selMobile.value = current;
        selMobile.addEventListener('change', (e) => setInstance(e.target.value));
    }

    // Sign Out
    document.getElementById('btnSignOut')?.addEventListener('click', signOut);
    document.getElementById('btnSignOutMobile')?.addEventListener('click', signOut);

    // Mobile Menu Toggle
    document.getElementById('mobileMenuBtn')?.addEventListener('click', () => {
        const menu = document.getElementById('mobileMenu');
        if (menu.classList.contains('hidden')) {
            menu.classList.remove('hidden');
        } else {
            menu.classList.add('hidden');
        }
    });
}
