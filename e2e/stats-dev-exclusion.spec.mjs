// e2e/stats-dev-exclusion.spec.mjs
//
// Regression coverage for a Sprint 2 review finding: js/stats.js's Refunded
// Revenue figure excluded DEV-instance bookings via a hardcoded
// 'ESF26-DEV-' prefix literal, so a non-ESF26 organisation's own DEV/test
// refunds were never excluded from that total the way ESF26's are.
//
// Investigation (not assumed from the original report) found booking_type
// is NOT a reliable "is this a DEV booking" signal - a genuine Misc entry
// created via add_misc.html gets booking_type 'dev' (the bookings table's
// default for any insert that omits the column), not a food/general
// booking submitted to the DEV instance, which gets booking_type 'food' or
// 'general' from submit-booking's own isFoodPrefix() logic. instance_prefix
// ending "-DEV-" is the only reliable signal (also used by the
// booking_locations_check_conflict trigger), so the fix keeps that
// mechanism but resolves it per-organisation via CONFIG.INSTANCE_MAP.DEV -
// the same mechanism js/page-steward.js already uses for this exact class
// of bug - instead of a literal string.
//
// Runs as part of the "admin" Playwright project for its .env.test/
// service-role access (seeding a disposable org/event/bookings/payments
// directly) and its authenticated storageState.
import { test, expect } from '@playwright/test';
import { service } from '../tests/helpers.mjs';

const stamp = Date.now();
const orgSlug = `e2e-statsdev-${stamp}`;
const orgId = `org_e2e_statsdev_${stamp}`;
const eventId = `event_e2e_statsdev_${stamp}`;
const prefix = `BLCR${String(stamp).slice(-3)}`;

const normalBookingId = `${prefix}-FOOD-0001-${stamp}`;
const devBookingId = `${prefix}-DEV-0001-${stamp}`;

test.describe.serial('Stats page Refunded Revenue excludes DEV bookings for a non-ESF26 organisation', () => {
  test.beforeAll(async () => {
    await service.from('organisations').insert({ id: orgId, name: 'Bellcross Music Festival', slug: orgSlug });
    await service.from('events').insert({
      id: eventId, org_id: orgId, name: 'Bellcross Summer 2027', slug: `${orgSlug}-event`,
      booking_prefix: prefix, is_active: true, status: 'open',
    });

    await service.from('bookings').insert([
      {
        id: normalBookingId, org_id: orgId, event_id: eventId, status: 'Cancelled',
        business_name: 'Bellcross Food Trader', owner_name: 'Owner', email: 'food@example.test',
        instance_prefix: `${prefix}-FOOD-`, booking_type: 'food',
        payment_link_code: `${normalBookingId}-code`,
      },
      {
        id: devBookingId, org_id: orgId, event_id: eventId, status: 'Cancelled',
        business_name: 'Bellcross DEV Test Entry (must be excluded)', owner_name: 'Owner', email: 'dev@example.test',
        instance_prefix: `${prefix}-DEV-`, booking_type: 'general',
        payment_link_code: `${devBookingId}-code`,
      },
    ]);

    // refund_amount set directly (service role) - this test is about the
    // Stats page's own rendering logic, not the rpc_record_refund path
    // already covered by tests/refunds.test.mjs.
    await service.from('payments').insert([
      { booking_id: normalBookingId, org_id: orgId, paid: true, refund_amount: 25 },
      { booking_id: devBookingId, org_id: orgId, paid: true, refund_amount: 10 },
    ]);
  });

  test.afterAll(async () => {
    await service.from('payments').delete().in('booking_id', [normalBookingId, devBookingId]);
    await service.from('bookings').delete().in('id', [normalBookingId, devBookingId]);
    await service.from('events').delete().eq('id', eventId);
    await service.from('organisations').delete().eq('id', orgId);
  });

  test('the DEV booking\'s refund is excluded from Refunded Revenue; the real refund is included', async ({ page }) => {
    await page.addInitScript(({ org, evt }) => {
      window.localStorage.setItem('ESF_ORG_ID', org);
      window.localStorage.setItem('ESF_EVENT_ID', evt);
    }, { org: orgId, evt: eventId });
    await page.goto('/stats.html');
    await page.waitForLoadState('networkidle');

    // Only the £25 real refund should count - not £35 (25 + the DEV
    // booking's 10), which is what the pre-fix hardcoded ESF26 literal
    // would have produced for this organisation (it would never match
    // 'BLCR27-DEV-', so the DEV refund would leak into the total).
    await expect(page.locator('#revenue-refunded')).toHaveText('£25.00', { timeout: 10000 });
    await expect(page.locator('#revenue-refunded-count')).toHaveText('1');
  });
});
