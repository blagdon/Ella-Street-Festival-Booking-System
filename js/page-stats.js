import { initNavigation } from './nav.js';
import { requireAuth } from './supabase.js';
import { loadGlobalStats } from './stats.js';

document.addEventListener('DOMContentLoaded', async () => {
    try {
        await requireAuth('admin');
        initNavigation();
        await loadGlobalStats();
    } catch (err) {
        console.error("Initialization failed:", err);
    }
});
