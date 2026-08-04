// e2e/event-configuration.spec.mjs
//
// Real browser coverage of the Event Configuration page (Phase 4B.1,
// js/settings/event-config.js) — the interactive override/reset/validation
// flow tests/phase4b-event-configuration.test.mjs deliberately doesn't cover
// (that file is DB/RLS-only, same convention as every other tests/*.test.mjs
// against a DOM-coupled page module). This spec drives the real page and
// verifies both the UI and the resulting event_settings rows, the same
// db-verification pattern e2e/provisioning.spec.mjs already uses.
//
// Runs as part of the "admin" Playwright project (see playwright.config.mjs),
// reusing the storageState admin.setup.mjs produces. That session has no
// ESF_EVENT_ID override, so it defaults to org_default/event_default — this
// spec points it at a scratch event instead (via an init script setting
// ESF_EVENT_ID before the page loads) so it never touches event_default's
// real configuration.
import { test, expect } from '@playwright/test';
import { service } from '../tests/helpers.mjs';

const eventId = `e2e_4b_${Date.now()}`;
const bookingPrefix = `E4B${Date.now().toString().slice(-4)}`;

test.describe('Event Configuration page', () => {
  test.beforeEach(async ({ page }) => {
    await service.from('events').insert({
      id: eventId, org_id: 'org_default', name: 'E2E Event Config Test',
      slug: eventId.replace(/_/g, '-'), booking_prefix: bookingPrefix, is_active: false,
    });
    await service.from('settings').upsert(
      { org_id: 'org_default', key: 'stall_cost_general', value: '3.00' },
      { onConflict: 'org_id,key' }
    );

    // Point the active event at the scratch event before any page script runs.
    await page.addInitScript((id) => { window.localStorage.setItem('ESF_EVENT_ID', id); }, eventId);
  });

  test.afterEach(async () => {
    await service.from('event_settings').delete().eq('event_id', eventId);
    await service.from('events').delete().eq('id', eventId);
  });

  test('creating an override flips the badge and persists to event_settings', async ({ page }) => {
    await page.goto('/event_settings.html');
    await expect(page.locator('[data-field="stall_cost_general"] [data-role="badge"]')).toHaveText('Inherited from Organisation');

    await page.locator('[data-field="stall_cost_general"] [data-role="toggle"]').click();
    await page.locator('[data-field="stall_cost_general"] [data-role="input"]').fill('8.50');
    await page.locator('#btn-save-event-config').click();

    await expect(page.getByText('Event configuration saved')).toBeVisible();
    await expect(page.locator('[data-field="stall_cost_general"] [data-role="badge"]')).toHaveText('Overridden for this Event');

    const { data, error } = await service.from('event_settings').select('value').eq('event_id', eventId).eq('key', 'stall_cost_general').single();
    expect(error).toBeNull();
    expect(data.value).toBe('8.50');
  });

  test('resetting deletes the override rather than copying the organisation value', async ({ page }) => {
    await service.from('event_settings').insert({ event_id: eventId, key: 'stall_cost_general', value: '99.00' });

    await page.goto('/event_settings.html');
    await expect(page.locator('[data-field="stall_cost_general"] [data-role="badge"]')).toHaveText('Overridden for this Event');

    await page.locator('[data-field="stall_cost_general"] [data-role="reset"]').click();
    await expect(page.locator('[data-field="stall_cost_general"] [data-role="badge"]')).toHaveText('Inherited from Organisation');
    await expect(page.locator('[data-field="stall_cost_general"] [data-role="input"]')).toHaveValue('3.00');

    const { data, error } = await service.from('event_settings').select('*').eq('event_id', eventId).eq('key', 'stall_cost_general');
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  test('rejects a negative price with a friendly message and saves nothing', async ({ page }) => {
    await page.goto('/event_settings.html');
    await page.locator('[data-field="stall_cost_general"] [data-role="toggle"]').click();
    await page.locator('[data-field="stall_cost_general"] [data-role="input"]').fill('-5');
    await page.locator('#btn-save-event-config').click();

    await expect(page.locator('#toastMsg')).toContainText(/valid, non-negative price/i);

    const { data, error } = await service.from('event_settings').select('*').eq('event_id', eventId).eq('key', 'stall_cost_general');
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  test('allowed stall types can be overridden by adding a chip, and it persists', async ({ page }) => {
    await page.goto('/event_settings.html');
    await page.locator('[data-field="allowed_stall_types"] [data-role="toggle"]').click();
    await page.locator('[data-field="allowed_stall_types"] [data-role="new-type"]').fill('Craft Stall');
    await page.locator('[data-field="allowed_stall_types"] [data-role="add-type"]').click();
    await expect(page.locator('[data-field="allowed_stall_types"]').getByText('Craft Stall')).toBeVisible();

    await page.locator('#btn-save-event-config').click();
    await expect(page.getByText('Event configuration saved')).toBeVisible();

    const { data, error } = await service.from('event_settings').select('value').eq('event_id', eventId).eq('key', 'allowed_stall_types').single();
    expect(error).toBeNull();
    expect(data.value.split(',')).toContain('Craft Stall');
  });
});
