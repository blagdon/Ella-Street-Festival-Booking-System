// Automated regression guard for trapFocus() (js/ui.js) — previously only
// verified once, by hand, via the browser tool: real Tab/Shift+Tab wrapping
// within an open modal, and focus landing somewhere sane on close. Nothing
// caught a regression here until now.
//
// Reuses the same authenticated storage state as admin-accessibility.spec.mjs
// (see playwright.config.mjs's "admin" project) since every modal lives
// behind a sign-in. Seeds its own fixture booking rather than relying on
// whatever data happens to already exist in the shared test project, so this
// stays deterministic regardless of what other suites' fixtures look like.
import { test, expect } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';

const url = process.env.TEST_SUPABASE_URL;
const serviceRoleKey = process.env.TEST_SUPABASE_SERVICE_ROLE_KEY;
const service = createClient(url, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });

const bookingId = 'ESF26-E2EFOCUSTRAP-0001';

// The config's fullyParallel:true can shard one file's tests across several
// workers - fine for accessibility.spec.mjs's independent pages, but these
// three tests all share ONE mutable fixture booking via file-level
// beforeAll/afterAll. Sharded, a second worker's afterAll cleanup can delete
// that booking mid-test for a first worker still using it - intermittent,
// hard to reproduce in isolation (confirmed: each test passes alone, and
// only sometimes fails as part of the full file). Serial mode keeps this
// file's tests - and its one beforeAll/afterAll pair - in a single worker.
test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  await service.from('payments').delete().eq('booking_id', bookingId);
  await service.from('bookings').delete().eq('id', bookingId);

  const { error } = await service.from('bookings').insert({
    id: bookingId,
    org_id: 'org_default',
    event_id: 'event_default',
    status: 'Confirmed',
    business_name: 'Focus Trap Test Stall',
    owner_name: 'Focus Trap Tester',
    email: 'focustrap-test@example.test',
    instance_prefix: 'ESF26-DEV-',
    stall_type: 'Food',
    stall_cost: 50,
  });
  if (error) throw new Error(`Fixture setup failed: ${error.message}`);

  const { error: paymentErr } = await service.from('payments').upsert({ booking_id: bookingId, org_id: 'org_default', paid: false }, { onConflict: 'booking_id' });
  if (paymentErr) throw new Error(`Fixture setup failed (payments): ${paymentErr.message}`);
});

test.afterAll(async () => {
  await service.from('payments').delete().eq('booking_id', bookingId);
  await service.from('bookings').delete().eq('id', bookingId);
});

test('showConfirm dialog: Tab/Shift+Tab wrap within it, Escape restores focus to the trigger', async ({ page }) => {
  await page.goto('/audit_log.html');

  await page.evaluate(() => {
    const btn = document.createElement('button');
    btn.id = 'e2e-trigger';
    btn.textContent = 'trigger';
    document.body.appendChild(btn);
    btn.focus();
  });

  await page.evaluate(async () => {
    const ui = await import('/js/ui.js');
    ui.showConfirm('Delete booking', 'This action cannot be undone.', () => {});
  });

  const cancelBtn = page.locator('#btn-cancel-confirm');
  const confirmBtn = page.locator('#confirmButton');

  await expect(cancelBtn).toBeFocused();

  await page.keyboard.press('Tab');
  await expect(confirmBtn).toBeFocused();

  // Tab from the last item wraps forward to the first, not out to the page.
  await page.keyboard.press('Tab');
  await expect(cancelBtn).toBeFocused();

  // Shift+Tab from the first item wraps backward to the last.
  await page.keyboard.press('Shift+Tab');
  await expect(confirmBtn).toBeFocused();

  await page.keyboard.press('Escape');
  await expect(page.locator('#e2e-trigger')).toBeFocused();
});

test('a real modal (payments.html edit-modal) restores focus to the button that opened it', async ({ page }) => {
  await page.goto('/payments.html');

  // Two Edit buttons exist for the same booking - a desktop table row and a
  // mobile-card duplicate, both in the DOM regardless of viewport. .first()
  // is the desktop one, the only one visible at this default viewport size.
  const editBtn = page.locator(`button.btn-edit[data-id="${bookingId}"]`).first();
  await editBtn.waitFor({ state: 'visible' });
  await editBtn.click();

  await expect(page.locator('#edit-modal')).not.toHaveClass(/hidden/);
  await expect(editBtn).not.toBeFocused();

  await page.keyboard.press('Escape');
  await expect(editBtn).toBeFocused();
});

test('a modal opened from a non-focusable trigger (kanban card) does not strand focus on close', async ({ page }) => {
  await page.goto('/kanban_m.html');

  const card = page.locator(`#${bookingId}`);
  await card.waitFor({ state: 'visible' });
  await card.click();

  await expect(page.locator('#detailModal')).not.toHaveClass(/opacity-0/);

  await page.keyboard.press('Escape');

  const strandedInModal = await page.evaluate(() => {
    const modal = document.getElementById('detailModal');
    return modal.contains(document.activeElement) && document.activeElement !== document.body;
  });
  expect(strandedInModal).toBe(false);
});
