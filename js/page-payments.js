import { requireAuth } from './supabase.js';
import { initNavigation } from './nav.js';
import { initPayments } from './payments.js';

document.addEventListener('DOMContentLoaded', async () => {
    try {
        await requireAuth('admin');
        initNavigation();
        await initPayments();
    } catch (e) {
        // Redirection handled in requireAuth
    }
});
