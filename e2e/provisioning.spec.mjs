// e2e/provisioning.spec.mjs
// End-to-end Playwright UI test for the Platform Administration Workspace (admin.html).

import { test, expect } from '@playwright/test';

test.describe('Platform Administration Workspace UI', () => {
  test('loads admin workspace page and displays banner', async ({ page }) => {
    await page.goto('/admin.html');
    await page.waitForLoadState('networkidle');

    // Title and banner check
    await expect(page).toHaveTitle(/Platform Administration Workspace/i);
    await expect(page.locator('h1')).toContainText(/Platform Administration/i);
  });
});
