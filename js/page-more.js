import { requireAuth } from './supabase.js';
import { initNavigation } from './nav.js';

document.addEventListener('DOMContentLoaded', async () => {
    try {
        await requireAuth('admin');
        initNavigation();
    } catch (e) {
        // Redirection handled in requireAuth
    }
});
