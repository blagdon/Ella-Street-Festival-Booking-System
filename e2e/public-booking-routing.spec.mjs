// e2e/public-booking-routing.spec.mjs
//
// Real browser coverage of the Phase 4D booking-form gating states
// (js/public-context.js's initPublicBookingForm(), consumed by
// page-general-booking.js/page-food-booking.js) - the client-side UX
// tests/phase4d-public-booking-routing.test.mjs doesn't reach. Deliberately
// does NOT attempt a full successful-submission flow through the real form:
// Turnstile requires a live widget challenge Playwright can't solve
// headlessly (same limitation noted in accessibility.spec.mjs for
// pay.html/cancel_booking.html) - that path is proven server-side instead,
// in tests/phase4d-public-booking-routing.test.mjs, which calls
// submit-booking directly with Cloudflare's official always-passes test
// token.
//
// Runs as part of the "admin" Playwright project (see playwright.config.mjs)
// purely for its .env.test/service-role access to seed real org/event rows -
// the pages under test need no authentication at all.
import { test, expect } from '@playwright/test';
import { service } from '../tests/helpers.mjs';

const orgSlug = `e2e-4d-${Date.now()}`;
const openEventSlug = `e2e-4d-open-${Date.now()}`;
const readyEventSlug = `e2e-4d-ready-${Date.now()}`;
const draftEventSlug = `e2e-4d-draft-${Date.now()}`;
const orgId = `org_${orgSlug.replace(/-/g, '_')}`;
const openEventId = `event_${openEventSlug.replace(/-/g, '_')}`;
const readyEventId = `event_${readyEventSlug.replace(/-/g, '_')}`;
const draftEventId = `event_${draftEventSlug.replace(/-/g, '_')}`;
const bookingPrefix = `E4D${Date.now().toString().slice(-3)}`;

test.describe('Public booking form routing (Phase 4D)', () => {
  test.beforeAll(async () => {
    await service.from('organisations').insert({ id: orgId, name: 'E2E Phase 4D Org', slug: orgSlug });
    await service.from('events').insert([
      { id: openEventId, org_id: orgId, name: 'E2E Open Event', slug: openEventSlug, booking_prefix: bookingPrefix, is_active: true, status: 'open' },
      { id: readyEventId, org_id: orgId, name: 'E2E Ready Event', slug: readyEventSlug, booking_prefix: `${bookingPrefix}R`, is_active: true, status: 'ready' },
      // Deliberately never queried by these tests through the public path
      // except to prove it's unreachable there - draft events are excluded
      // from public_events_info entirely (Phase 4A), so this row exists only
      // to show a draft slug resolves exactly like a nonexistent one below.
      { id: draftEventId, org_id: orgId, name: 'E2E Draft Event', slug: draftEventSlug, booking_prefix: `${bookingPrefix}D`, is_active: true, status: 'draft' },
    ]);
  });

  test.afterAll(async () => {
    await service.from('events').delete().in('id', [openEventId, readyEventId, draftEventId]);
    await service.from('organisations').delete().eq('id', orgId);
  });

  test('a broken/nonexistent org+event slug shows "not found", not the default organisation\'s form', async ({ page }) => {
    await page.goto('/General_Booking.html?org=no-such-org-e2e&event=no-such-event-e2e');
    await expect(page.locator('#closed-section-heading')).toHaveText('Booking Link Not Found');
    await expect(page.locator('#form-section')).toBeHidden();
  });

  test('a valid slug for a real but not-yet-open event shows the event-specific closed message, naming its status', async ({ page }) => {
    await page.goto(`/General_Booking.html?org=${orgSlug}&event=${readyEventSlug}`);
    await expect(page.locator('#closed-section-heading')).toHaveText('Not Currently Accepting Applications');
    await expect(page.locator('#closed-section-body')).toContainText('READY');
    await expect(page.locator('#form-section')).toBeHidden();
  });

  test('a draft event\'s slug resolves exactly like a broken link, not a status-specific message', async ({ page }) => {
    // public_events_info excludes draft rows entirely (Phase 4A) so a
    // visitor can't discover a still-being-configured event by guessing its
    // slug - this proves that holds for the booking form too, not just
    // event.html, rather than silently regressing to a more informative
    // "closed" message that would leak the event's existence.
    await page.goto(`/General_Booking.html?org=${orgSlug}&event=${draftEventSlug}`);
    await expect(page.locator('#closed-section-heading')).toHaveText('Booking Link Not Found');
    await expect(page.locator('#form-section')).toBeHidden();
  });

  test('a valid slug for an open event shows the real form, not a closed state', async ({ page }) => {
    await page.goto(`/General_Booking.html?org=${orgSlug}&event=${openEventSlug}`);
    await expect(page.locator('#form-section')).toBeVisible();
    await expect(page.locator('#closed-section')).toBeHidden();
  });

  test('the resolved organisation/event name replaces the page\'s default branding, not just the gating state', async ({ page }) => {
    // Found during the Epic 4 operational review: resolution/gating worked
    // correctly from the very first version of this page, but the visible
    // header still always said "Ella Street Festival 2026" regardless of
    // which organisation's link a trader actually followed - the resolved
    // context was never applied to the DOM. Locks in the fix.
    await page.goto(`/General_Booking.html?org=${orgSlug}&event=${openEventSlug}`);
    await expect(page.locator('#event-context-subtitle')).toContainText('E2E Phase 4D Org');
    await expect(page.locator('#event-context-subtitle')).toContainText('E2E Open Event');
    await expect(page.locator('#event-context-subtitle')).not.toContainText('Ella Street Festival');
    await expect(page).toHaveTitle(/E2E Open Event/);
  });

  test('the Food Stall booking form resolves the same way', async ({ page }) => {
    await page.goto(`/Food_Stall_booking.html?org=${orgSlug}&event=${readyEventSlug}`);
    await expect(page.locator('#closed-section-heading')).toHaveText('Not Currently Accepting Applications');
    await expect(page.locator('#form-section')).toBeHidden();
  });
});
