// e2e/settings-secrets.spec.mjs
//
// Version 1.1 Sprint 1, Issue 5 — Stripe Secret Fields. admin.html's
// Settings -> Payments tab used to fetch and render the organisation's real
// Stripe secret key/webhook secret in a plain type="text" input, visible in
// cleartext the moment the page loaded. Covers: fields load masked, the
// show/hide toggle works both directions, and save/reload still round-trips
// the value correctly (js/platform/forms.js's renderSecretField/
// bindSecretFieldToggles only change the input's `type` - the id/name/value
// read by js/page-admin.js's saveCategorySettings() are untouched).
//
// Runs as part of the "admin" Playwright project (storageState from
// admin.setup.mjs). Restores whatever was there before in afterEach so this
// test never leaves org_default's real Stripe settings altered.
import { test, expect } from '@playwright/test';
import { service } from '../tests/helpers.mjs';

const STRIPE_KEYS = ['stripe_secret_key_test', 'stripe_webhook_secret_test'];

async function openPaymentsTab(page) {
  await page.goto('/admin.html');
  await page.locator('[data-section="settings"]').click();
  await page.getByRole('button', { name: 'Payments', exact: true }).click();
}

// .serial: every test in this block reads/writes org_default's real
// stripe_secret_key_test/stripe_webhook_secret_test rows (the field is
// necessarily scoped to the signed-in admin session's current org) - run in
// parallel workers, one test's save can race another's setup/restore and
// read back the wrong value, a false failure rather than a real one. Same
// class of issue as public-booking-routing.spec.mjs's regulatory-authority
// block, just without an easy per-test-org fixture to fall back on here.
test.describe.serial('Stripe secret fields are masked with a show/hide toggle (Phase V1.1-S1 Issue 5)', () => {
  let originalValues = {};

  test.beforeEach(async () => {
    const { data } = await service.from('settings').select('key, value').eq('org_id', 'org_default').in('key', STRIPE_KEYS);
    originalValues = Object.fromEntries((data || []).map((r) => [r.key, r.value]));
  });

  test.afterEach(async () => {
    const rows = STRIPE_KEYS.map((key) => ({ org_id: 'org_default', key, value: originalValues[key] ?? '' }));
    await service.from('settings').upsert(rows, { onConflict: 'org_id,key' });
  });

  test('both Stripe fields load as password-type inputs, not plaintext', async ({ page }) => {
    await openPaymentsTab(page);
    await expect(page.locator('#setStripeKeyTest')).toHaveAttribute('type', 'password');
    await expect(page.locator('#setStripeWebhookTest')).toHaveAttribute('type', 'password');
  });

  test('the show/hide toggle reveals and re-hides the value without changing it', async ({ page }) => {
    await service.from('settings').upsert(
      { org_id: 'org_default', key: 'stripe_secret_key_test', value: 'sk_test_e2e_fixture_value' },
      { onConflict: 'org_id,key' }
    );

    await openPaymentsTab(page);
    const input = page.locator('#setStripeKeyTest');
    const toggle = page.locator('[data-toggle-secret="setStripeKeyTest"]');

    await expect(input).toHaveAttribute('type', 'password');
    await expect(input).toHaveValue('sk_test_e2e_fixture_value');

    await toggle.click();
    await expect(input).toHaveAttribute('type', 'text');
    await expect(input).toHaveValue('sk_test_e2e_fixture_value');
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');

    await toggle.click();
    await expect(input).toHaveAttribute('type', 'password');
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  });

  test('saving and reloading preserves the value and the masked default', async ({ page }) => {
    await openPaymentsTab(page);
    await page.locator('#setStripeWebhookTest').fill('whsec_e2e_roundtrip_test');
    await page.getByRole('button', { name: 'Save Payment Settings' }).click();
    await expect(page.getByText(/saved successfully/i)).toBeVisible();

    await openPaymentsTab(page);
    await expect(page.locator('#setStripeWebhookTest')).toHaveAttribute('type', 'password');
    await expect(page.locator('#setStripeWebhookTest')).toHaveValue('whsec_e2e_roundtrip_test');

    const { data } = await service.from('settings').select('value').eq('org_id', 'org_default').eq('key', 'stripe_webhook_secret_test').single();
    expect(data.value).toBe('whsec_e2e_roundtrip_test');
  });
});
