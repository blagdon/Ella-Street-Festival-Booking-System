import { requireAuth } from './supabase.js';

document.addEventListener('DOMContentLoaded', async () => {
    try {
        await requireAuth('steward');
    } catch (e) {
        // Redirection handled in requireAuth
    }
});
