import { ESF_PUBLIC_CONFIG } from '../supabase-public.js';

// These are intentionally static, dependency-free pages (no Supabase calls,
// no connect-src in their CSP) - reads the hardcoded/local-override
// PORTAL_URL directly rather than fetching the DB-configured value, so a
// visitor whose payment just failed always has somewhere to go instead of
// a dead "contact us" promise.
const link = document.getElementById('contact-link');
if (link && ESF_PUBLIC_CONFIG.PORTAL_URL) {
    link.href = ESF_PUBLIC_CONFIG.PORTAL_URL;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
}
