// e2e/provisioning.spec.mjs
// End-to-end Playwright UI test for the Self-Service Tenant Provisioning Wizard (provisioning.html).

import { test, expect } from '@playwright/test';

test.describe('Self-Service Tenant Provisioning Wizard UI', () => {
  test('loads provisioning page and displays wizard steps', async ({ page }) => {
    await page.goto('/provisioning.html');
    await page.waitForLoadState('networkidle');

    // Title and step navigation check
    await expect(page).toHaveTitle(/Platform Tenant Onboarding Wizard/i);
    await expect(page.locator('h1')).toContainText(/Platform Tenant Onboarding/i);

    // Form controls check
    const orgInput = page.locator('#org_name');
    const slugInput = page.locator('#org_slug');
    await expect(orgInput).toBeVisible();
    await expect(slugInput).toBeVisible();
  });
});
