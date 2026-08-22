// e2e/provisioning.spec.mjs
//
// Real end-to-end coverage of the Organisation Setup Wizard
// (admin.html -> Provisioning tab, powered by js/page-provisioning.js).
//
// The previous version of this file only loaded /admin.html and asserted
// the page title — it never opened the wizard, filled a field, or
// provisioned anything, and (found while rewriting it) wasn't even matched
// by any Playwright project's testMatch pattern, so it had never actually
// run in CI at all. This version drives every wizard step for real and
// verifies the resulting rows directly in the database, the same way
// tests/phase3-provisioning.test.mjs already verifies the Edge Function
// itself — this spec is the browser-driven counterpart, not a replacement.
//
// Runs as part of the "admin" Playwright project (see playwright.config.mjs),
// reusing the storageState admin.setup.mjs already produces.
import { test, expect } from '@playwright/test';
import { service } from '../tests/helpers.mjs';

const testOrgSlug = `e2e-prov-${Date.now()}`;
const testEventPrefix = `E2E${Date.now().toString().slice(-4)}`;

test.describe('Organisation Setup Wizard', () => {
  test.afterEach(async () => {
    // FK-safe order, same as provision-organisation's own rollback catch
    // block and phase3-provisioning.test.mjs's cleanup — best-effort: if the
    // test failed before provisioning completed, most of these are no-ops.
    // audit_logs first: provision-organisation's own Step E writes a
    // provision_organisation row that nothing else here would ever clean up
    // (no FK, no cascade) once the organisation below is deleted.
    await service.from('audit_logs').delete().eq('org_id', testOrgSlug);
    await service.from('events').delete().eq('org_id', testOrgSlug);
    await service.from('settings').delete().eq('org_id', testOrgSlug);
    await service.from('email_templates').delete().eq('org_id', testOrgSlug);
    await service.from('sms_templates').delete().eq('org_id', testOrgSlug);
    await service.from('organisation_members').delete().eq('org_id', testOrgSlug);
    await service.from('organisations').delete().eq('id', testOrgSlug);
  });

  test('completes every step and provisions a real organisation', async ({ page }) => {
    await page.goto('/admin.html');

    await page.getByRole('button', { name: /Provisioning/ }).click();

    // Step 1 — Organisation. Waiting on the step's own first field (not just
    // the wizard's shared heading, which is present and unchanged across all
    // 5 steps and so proves nothing about *this* step having rendered yet)
    // is what actually removed the render-race flakiness seen while writing
    // this test — each step below does the same before touching its fields.
    // A 15s timeout (Playwright's default is 5s) on each: this repo's shared
    // CI runners have measurably more latency to the test project than a
    // local machine does, even under the same 8-worker parallel load — this
    // step passed 6/6 locally, including alongside the full admin-a11y suite,
    // but still needed this headroom the first time it ran in CI.
    const CI_STEP_TIMEOUT = { timeout: 15_000 };
    await expect(page.locator('#wOrgName')).toBeVisible(CI_STEP_TIMEOUT);
    await page.locator('#wOrgName').fill('E2E Provisioning Test Org');
    await page.locator('#wOrgSlug').fill(testOrgSlug);
    await page.locator('#wOwnerEmail').fill('test-admin@example.com');
    await page.getByRole('button', { name: /Continue to Event Setup/ }).click();

    // Step 2 — Primary Event
    await expect(page.locator('#wEventName')).toBeVisible(CI_STEP_TIMEOUT);
    await page.locator('#wEventName').fill('E2E Provisioning Test Festival');
    await page.locator('#wEventPrefix').fill(testEventPrefix);
    await page.getByRole('button', { name: /Review Defaults/ }).click();

    // Step 3 — Platform Defaults preview (informational, no fields)
    await expect(page.getByRole('button', { name: /Run Pre-flight & Preview/ })).toBeVisible(CI_STEP_TIMEOUT);
    await page.getByRole('button', { name: /Run Pre-flight & Preview/ }).click();

    // Step 4 — Preview, gated on a real pre-flight check passing
    await expect(page.getByText('Pre-flight Validation Passed')).toBeVisible(CI_STEP_TIMEOUT);
    await expect(page.getByText(testOrgSlug).first()).toBeVisible(CI_STEP_TIMEOUT);
    await expect(page.locator('#btnConfirmProvision')).toBeEnabled(CI_STEP_TIMEOUT);
    await page.locator('#btnConfirmProvision').click();

    // Step 5 — Report. Heading text (not getByText) because the success
    // toast's own message overlaps enough to trip strict-mode matching. This
    // step involves a real round trip to provision-organisation, so it gets
    // the same CI-latency headroom as the pure client-side steps above.
    await expect(page.getByRole('heading', { name: /Organisation Provisioned Successfully/ })).toBeVisible(CI_STEP_TIMEOUT);
    await expect(page.getByText(testOrgSlug).first()).toBeVisible(CI_STEP_TIMEOUT);
    await expect(page.getByText('test-admin@example.com').first()).toBeVisible(CI_STEP_TIMEOUT);

    // Verify the real rows, not just the report text — matching this
    // project's own convention of trusting the database over the UI.
    const { data: org, error: orgErr } = await service
      .from('organisations')
      .select('id, name')
      .eq('id', testOrgSlug)
      .single();
    expect(orgErr).toBeNull();
    expect(org?.name).toBe('E2E Provisioning Test Org');

    const { data: evt, error: evtErr } = await service
      .from('events')
      .select('org_id, name, booking_prefix, status')
      .eq('org_id', testOrgSlug)
      .single();
    expect(evtErr).toBeNull();
    expect(evt?.name).toBe('E2E Provisioning Test Festival');
    expect(evt?.booking_prefix).toBe(testEventPrefix);
    expect(evt?.status).toBe('draft');

    const { data: settingsRows, error: settingsErr } = await service
      .from('settings')
      .select('key, value')
      .eq('org_id', testOrgSlug);
    expect(settingsErr).toBeNull();
    const settingsByKey = Object.fromEntries((settingsRows || []).map((r) => [r.key, r.value]));
    // Cloned from platform_defaults_settings — confirms rpc_initialise_tenant_defaults
    // ran, and confirms the branding keys are the ones the Branding form
    // actually reads (EP3-02), not the previously-orphaned primary_color/
    // accent_color/support_email names.
    expect(settingsByKey.brand_primary_color).toBeTruthy();
    expect(settingsByKey.org_support_email).toBeTruthy();
    expect(settingsByKey.stall_cost_food).toBeTruthy();

    const { count: emailTemplateCount } = await service
      .from('email_templates')
      .select('*', { count: 'exact', head: true })
      .eq('org_id', testOrgSlug);
    expect(emailTemplateCount).toBeGreaterThanOrEqual(4);

    const { count: smsTemplateCount } = await service
      .from('sms_templates')
      .select('*', { count: 'exact', head: true })
      .eq('org_id', testOrgSlug);
    expect(smsTemplateCount).toBeGreaterThanOrEqual(3);
  });
});
