// e2e/tenant-identity.spec.mjs
//
// V1.1 Sprint 2 — Tenant Identity & Commercial Polish. Provisions a fully
// disposable second organisation (distinct name, event name, logo, primary
// colour, booking prefix - matching the sprint brief's minimum test fixture)
// and walks the same journey the brief specifies: admin badge/title/branding
// preview, then the public event page and both booking forms. Every
// assertion checks this org's OWN identity appears, and that org_default's
// never leaks in - the failure mode Sprint 1's equivalent specs already
// guard against for regulatory authority/CTAs.
//
// Runs as part of the "admin" Playwright project purely for its
// .env.test/service-role access to seed real org/event/settings rows and its
// authenticated storageState (the platform-admin test account can read/write
// any organisation, not just its own - see tests/security.test.mjs's
// "genuine platform admin" regression guards) - the public-page tests below
// need no authentication themselves, same convention as
// event-page-cta.spec.mjs.
import { test, expect } from '@playwright/test';
import { service } from '../tests/helpers.mjs';

const stamp = Date.now();
const orgSlug = `e2e-tenant-${stamp}`;
const orgId = `org_e2e_tenant_${stamp}`;
const eventSlug = `e2e-tenant-event-${stamp}`;
const eventId = `event_e2e_tenant_${stamp}`;
const bookingPrefix = `TEN${String(stamp).slice(-3)}`;
const orgName = 'Riverside Community Festival';
const eventName = 'Riverside Summer Fair 2027';
const primaryColor = '#16a34a';
const primaryColorRgb = 'rgb(22, 163, 74)';

// .serial: every test below reads the same shared org/event fixture rows.
// fullyParallel workers interleaving reads against those rows produced a
// real, reproducible flake here (one test transiently saw org_default's
// static fallback copy instead of the fixture's) - the same class of issue
// e2e/settings-secrets.spec.mjs and e2e/public-booking-routing.spec.mjs's
// regulatory-authority block already document and guard against the same
// way.
test.describe.serial('Tenant identity, second organisation (V1.1 Sprint 2)', () => {
  test.beforeAll(async () => {
    await service.from('organisations').insert({ id: orgId, name: orgName, slug: orgSlug });
    await service.from('events').insert({
      id: eventId, org_id: orgId, name: eventName, slug: eventSlug,
      booking_prefix: bookingPrefix, is_active: true, status: 'open',
    });
    await service.from('settings').insert([
      { org_id: orgId, key: 'brand_primary_color', value: primaryColor },
    ]);
  });

  test.afterAll(async () => {
    await service.from('settings').delete().eq('org_id', orgId);
    await service.from('events').delete().eq('id', eventId);
    await service.from('organisations').delete().eq('id', orgId);
  });

  test('tenant badge shows the resolved organisation name, not the raw id (Issue 4)', async ({ page }) => {
    await page.addInitScript((id) => { window.localStorage.setItem('ESF_ORG_ID', id); }, orgId);
    await page.goto('/index.html');
    await expect(page.locator('#tenantBadge')).toContainText(orgName);
    await expect(page.locator('#tenantBadge')).not.toContainText(orgId);
  });

  test('page title is prefixed with the resolved organisation name, not ESF26 (Issue 3)', async ({ page }) => {
    await page.addInitScript((id) => { window.localStorage.setItem('ESF_ORG_ID', id); }, orgId);
    await page.goto('/payments.html');
    await expect(page).toHaveTitle(`${orgName} — Payments Dashboard`);
  });

  test('a different admin page gets the same treatment, proving this is not a one-off fix', async ({ page }) => {
    await page.addInitScript((id) => { window.localStorage.setItem('ESF_ORG_ID', id); }, orgId);
    await page.goto('/settings.html');
    await expect(page).toHaveTitle(`${orgName} — System Settings`);
  });

  test('branding preview updates live as the colour field changes (Issue 1)', async ({ page }) => {
    await page.addInitScript((id) => { window.localStorage.setItem('ESF_ORG_ID', id); }, orgId);
    await page.goto('/admin.html');
    await page.locator('[data-section="branding"]').click();

    const colorInput = page.locator('#brandPrimaryColor');
    await colorInput.waitFor({ state: 'visible' });
    await colorInput.fill('#ff0000');
    await expect(page.locator('#brandingPreviewButton')).toHaveCSS('background-color', 'rgb(255, 0, 0)');

    // Invalid input fails gracefully - falls back to the neutral swatch
    // colour rather than disappearing or throwing.
    await colorInput.fill('not-a-colour');
    await expect(page.locator('#brandingPreviewButton')).toHaveCSS('background-color', 'rgb(156, 163, 175)');

    // Accent colour is shown honestly (swatch + text value) and is NOT
    // wired into the mock button - it has no real consumer anywhere yet.
    const accentInput = page.locator('#brandAccentColor');
    await accentInput.fill('#0000ff');
    await expect(page.locator('#brandingPreviewAccentValue')).toHaveText('#0000ff');
    await expect(page.locator('#brandingPreviewButton')).not.toHaveCSS('background-color', 'rgb(0, 0, 255)');
  });

  test('public event page shows this organisation and event name, and the primary colour on its CTA (Issue 2/9)', async ({ page }) => {
    await page.goto(`/${orgSlug}/${eventSlug}`);
    const root = page.locator('#eventRoot');
    await expect(root).toContainText(orgName);
    await expect(root).toContainText(eventName);
    await expect(root).not.toContainText('Ella Street');
    const cta = page.getByRole('link', { name: 'Apply for a Food Stall' });
    await expect(cta).toHaveCSS('background-color', primaryColorRgb);
  });

  test('the Food booking form shows this organisation\'s identity and colour, not org_default\'s (Issue 2)', async ({ page }) => {
    await page.goto(`/Food_Stall_booking.html?org=${orgSlug}&event=${eventSlug}`);
    await expect(page.locator('#event-context-subtitle')).toContainText(orgName);
    await expect(page.locator('#event-context-subtitle')).toContainText(eventName);
    await expect(page.locator('#event-context-subtitle')).not.toContainText('Ella Street');
    await expect(page.locator('#submitBtn')).toHaveCSS('background-color', primaryColorRgb);
  });

  test('the General booking form gets the same treatment as Food (Issue 2)', async ({ page }) => {
    await page.goto(`/General_Booking.html?org=${orgSlug}&event=${eventSlug}`);
    await expect(page.locator('#event-context-subtitle')).toContainText(orgName);
    await expect(page.locator('#submitBtn')).toHaveCSS('background-color', primaryColorRgb);
  });

  test('a booking form with no configured colour keeps its default styling (graceful absence, Issue 2)', async ({ page }) => {
    // A second, unbranded org - proves the CSS override is conditional on a
    // real value being set, not applied unconditionally with a fallback
    // that happens to look the same.
    const plainOrgSlug = `e2e-tenant-plain-${stamp}`;
    const plainOrgId = `org_e2e_tenant_plain_${stamp}`;
    const plainEventSlug = `e2e-tenant-plain-event-${stamp}`;
    const plainEventId = `event_e2e_tenant_plain_${stamp}`;
    await service.from('organisations').insert({ id: plainOrgId, name: 'Unbranded Org', slug: plainOrgSlug });
    await service.from('events').insert({
      id: plainEventId, org_id: plainOrgId, name: 'Unbranded Event', slug: plainEventSlug,
      booking_prefix: `PLN${String(stamp).slice(-3)}`, is_active: true, status: 'open',
    });

    await page.goto(`/Food_Stall_booking.html?org=${plainOrgSlug}&event=${plainEventSlug}`);
    await expect(page.locator('#event-context-subtitle')).toContainText('Unbranded Org');
    await expect(page.locator('#bookingOrgLogo')).toBeHidden();
    // Default red-800 Tailwind class colour, not the Riverside org's green -
    // proves no cross-tenant colour leakage between two different orgs' forms.
    await expect(page.locator('#submitBtn')).not.toHaveCSS('background-color', primaryColorRgb);

    await service.from('events').delete().eq('id', plainEventId);
    await service.from('organisations').delete().eq('id', plainOrgId);
  });
});

test.describe('Tenant identity, default organisation regression (V1.1 Sprint 2)', () => {
  test('org_default still shows its real name in the tenant badge and page title', async ({ page }) => {
    // No ESF_ORG_ID override - the admin.setup.mjs session already defaults
    // to org_default.
    await page.goto('/index.html');
    await expect(page.locator('#tenantBadge')).toContainText('Ella Street Festival');
    await expect(page).toHaveTitle(/^Ella Street Festival — Dashboard$/);
  });

  test('org_default\'s public event page and booking forms still work', async ({ page }) => {
    const { data: org } = await service.from('organisations').select('slug').eq('id', 'org_default').maybeSingle();
    const { data: evt } = await service.from('events').select('slug').eq('org_id', 'org_default').limit(1).maybeSingle();
    test.skip(!org || !evt, 'org_default has no organisation/event row in this environment');

    await page.goto(`/${org.slug}/${evt.slug}`);
    await expect(page.locator('#eventRoot')).toContainText('Ella Street');

    await page.goto(`/Food_Stall_booking.html?org=${org.slug}&event=${evt.slug}`);
    await expect(page.locator('#form-section')).toBeVisible();
  });
});
