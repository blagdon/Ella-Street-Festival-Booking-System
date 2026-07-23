// These are intentionally static, dependency-free pages (no Supabase calls,
// no connect-src in their CSP). Points at the site's real contact page
// directly rather than ESF_PUBLIC_CONFIG.PORTAL_URL - that value is
// currently a dead link (ellastreet.co.uk/fest26/portal 404s), and this is
// hardcoded rather than made DB-configurable since it's a fixed page on the
// festival's own site, not something that changes per environment.
const CONTACT_URL = 'https://www.ellastreet.co.uk/contact';

const link = document.getElementById('contact-link');
if (link) {
    link.href = CONTACT_URL;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
}
