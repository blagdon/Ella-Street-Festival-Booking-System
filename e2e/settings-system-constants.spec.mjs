// e2e/settings-system-constants.spec.mjs
//
// Regression coverage for a Medium-severity finding from Sprint 2 review:
// js/settings/system.js's initSystemConstants() populated the Settings ->
// System Constants form from CONFIG.FESTIVAL_DISPLAY_NAME / ESF_PUBLIC_
// CONFIG.BOOKING_PREFIX - globals carrying hardcoded platform-identity
// fallbacks ('Ella Street Festival' / 'ESF26') meant for contexts where
// *something* must render before settings load. For any organisation with
// no festival_display_name/booking_prefix row of its own, this presented
// the platform's own defaults as if they were that org's actual configured
// values, in a form whose Save button would then persist them verbatim -
// an admin who didn't notice could silently brand their own org as "Ella
// Street Festival" with prefix "ESF26".
//
// Fix: load this org's own settings rows directly (the same pattern already
// used by initSentrySettings()/initSerpApiSettings() in the same file),
// leaving genuinely unset fields empty instead of falling back to the
// platform defaults.
//
// Runs as part of the "admin" Playwright project for its .env.test/
// service-role access (seeding a disposable org's settings rows directly)
// and its authenticated storageState - same reasoning as
// tenant-identity.spec.mjs, which this deliberately does not duplicate
// (this file is a bug-fix regression, not a Sprint 2 feature walkthrough).
import { test, expect } from '@playwright/test';
import { service } from '../tests/helpers.mjs';

const stamp = Date.now();
const orgSlug = `e2e-sysconst-${stamp}`;
const orgId = `org_e2e_sysconst_${stamp}`;

test.describe.serial('Settings System Constants — no hardcoded platform identity for a new org', () => {
  test.beforeAll(async () => {
    // Deliberately no settings rows at all - this org has never configured
    // festival_display_name, booking_prefix, or anything else on this form.
    await service.from('organisations').insert({ id: orgId, name: 'Fenwick Folk Festival', slug: orgSlug });
  });

  test.afterAll(async () => {
    await service.from('settings').delete().eq('org_id', orgId);
    await service.from('organisations').delete().eq('id', orgId);
  });

  test('a fresh organisation with no settings sees empty fields, not the platform defaults', async ({ page }) => {
    await page.addInitScript((id) => { window.localStorage.setItem('ESF_ORG_ID', id); }, orgId);
    await page.goto('/settings.html');
    await page.waitForLoadState('networkidle');

    const festivalName = page.locator('#festival-display-name');
    const bookingPrefix = page.locator('#booking-prefix');
    await expect(festivalName).toHaveValue('', { timeout: 10000 });
    await expect(bookingPrefix).toHaveValue('');
    // Not just empty - specifically never the platform's own values.
    await expect(festivalName).not.toHaveValue('Ella Street Festival');
    await expect(bookingPrefix).not.toHaveValue('ESF26');
  });

  test('saving with the identity fields left empty does not persist the platform defaults', async ({ page }) => {
    await page.addInitScript((id) => { window.localStorage.setItem('ESF_ORG_ID', id); }, orgId);
    await page.goto('/settings.html');
    await page.waitForLoadState('networkidle');
    await expect(page.locator('#festival-display-name')).toHaveValue('', { timeout: 10000 });

    // Every field on this form is required (pre-existing validation, not
    // part of this fix) - attempting to save while genuinely empty must be
    // rejected outright, which is itself the safest possible outcome: there
    // is no path from "unset" to a silently-persisted platform identity.
    await page.click('#btn-save-constants');
    await expect(page.locator('#toastMsg')).toContainText(/required/i, { timeout: 5000 });

    const { data } = await service.from('settings')
      .select('key, value')
      .eq('org_id', orgId)
      .in('key', ['festival_display_name', 'booking_prefix']);
    expect(data).toEqual([]);
  });

  test('entering genuine values and saving persists this org\'s own identity, not the platform\'s', async ({ page }) => {
    await page.addInitScript((id) => { window.localStorage.setItem('ESF_ORG_ID', id); }, orgId);
    await page.goto('/settings.html');
    await page.waitForLoadState('networkidle');
    await expect(page.locator('#festival-display-name')).toHaveValue('', { timeout: 10000 });

    await page.fill('#festival-display-name', 'Fenwick Folk Festival');
    await page.fill('#turnstile-key', 'test-turnstile-key');
    await page.fill('#base-url', 'https://fenwick.example.test');
    await page.fill('#cancel-url', 'https://fenwick.example.test/cancel.html');
    await page.fill('#portal-url', 'https://fenwick.example.test/portal');
    await page.fill('#council-email', 'safety@fenwick.example.test');
    await page.fill('#bucket-name', 'fenwick-documents');
    await page.fill('#booking-prefix', 'FNWK27');
    await page.click('#btn-save-constants');
    await expect(page.locator('#toastMsg')).toContainText(/saved successfully/i, { timeout: 5000 });

    const { data } = await service.from('settings')
      .select('key, value')
      .eq('org_id', orgId)
      .in('key', ['festival_display_name', 'booking_prefix']);
    const row = (key) => data.find(r => r.key === key)?.value;
    expect(row('festival_display_name')).toBe('Fenwick Folk Festival');
    expect(row('booking_prefix')).toBe('FNWK27');
  });
});

test.describe('Settings System Constants — org_default regression', () => {
  test('org_default still displays its own explicitly-configured values (not blanked by the fix)', async ({ page }) => {
    // No ESF_ORG_ID override - admin.setup.mjs's session already defaults to
    // org_default, which (unlike the fixture above) has real, previously-
    // saved settings rows for every field on this form.
    await page.goto('/settings.html');
    await page.waitForLoadState('networkidle');
    await expect(page.locator('#festival-display-name')).toHaveValue('Ella Street Festival', { timeout: 10000 });
    await expect(page.locator('#booking-prefix')).toHaveValue('ESF26');
  });
});
