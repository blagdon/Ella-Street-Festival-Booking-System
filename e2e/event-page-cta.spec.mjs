// e2e/event-page-cta.spec.mjs
//
// Version 1.1 Sprint 1, Issue 1 — Public Event Page. Before this sprint,
// event.html (the public /{orgSlug}/{eventSlug} landing page) rendered a
// "Bookings open" badge with no way to actually start a booking - the single
// highest-impact finding from the V1.1 UX audit. Covers all four required
// states: Food only, General only, both open, both closed.
//
// Runs as part of the "admin" Playwright project purely for its
// .env.test/service-role access to seed real org/event/settings rows - the
// page itself needs no authentication, same convention as
// public-booking-routing.spec.mjs.
import { test, expect } from '@playwright/test';
import { service } from '../tests/helpers.mjs';

const orgSlug = `e2e-cta-${Date.now()}`;
const eventSlug = `e2e-cta-event-${Date.now()}`;
const orgId = `org_${orgSlug.replace(/-/g, '_')}`;
const eventId = `event_${eventSlug.replace(/-/g, '_')}`;
const bookingPrefix = `ECTA${Date.now().toString().slice(-3)}`;

test.describe('Public event page booking CTAs (Phase V1.1-S1 Issue 1)', () => {
  test.beforeAll(async () => {
    await service.from('organisations').insert({ id: orgId, name: 'E2E CTA Org', slug: orgSlug });
    await service.from('events').insert({
      id: eventId, org_id: orgId, name: 'E2E CTA Event', slug: eventSlug,
      booking_prefix: bookingPrefix, is_active: true, status: 'open',
    });
  });

  test.afterAll(async () => {
    await service.from('settings').delete().eq('org_id', orgId);
    await service.from('events').delete().eq('id', eventId);
    await service.from('organisations').delete().eq('id', orgId);
  });

  test.afterEach(async () => {
    await service.from('settings').delete().eq('org_id', orgId).in('key', ['food_bookings_open', 'general_bookings_open']);
  });

  test('both toggles unset (default open) shows both CTAs', async ({ page }) => {
    await page.goto(`/${orgSlug}/${eventSlug}`);
    await expect(page.getByRole('link', { name: 'Apply for a Food Stall' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Apply as a General Trader' })).toBeVisible();
  });

  test('food open, general closed shows only the Food CTA', async ({ page }) => {
    await service.from('settings').insert([
      { org_id: orgId, key: 'food_bookings_open', value: 'true' },
      { org_id: orgId, key: 'general_bookings_open', value: 'false' },
    ]);
    await page.goto(`/${orgSlug}/${eventSlug}`);
    await expect(page.getByRole('link', { name: 'Apply for a Food Stall' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Apply as a General Trader' })).toHaveCount(0);
  });

  test('general open, food closed shows only the General CTA', async ({ page }) => {
    await service.from('settings').insert([
      { org_id: orgId, key: 'food_bookings_open', value: 'false' },
      { org_id: orgId, key: 'general_bookings_open', value: 'true' },
    ]);
    await page.goto(`/${orgSlug}/${eventSlug}`);
    await expect(page.getByRole('link', { name: 'Apply as a General Trader' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Apply for a Food Stall' })).toHaveCount(0);
  });

  test('both closed shows an explanatory message and no CTA buttons', async ({ page }) => {
    await service.from('settings').insert([
      { org_id: orgId, key: 'food_bookings_open', value: 'false' },
      { org_id: orgId, key: 'general_bookings_open', value: 'false' },
    ]);
    await page.goto(`/${orgSlug}/${eventSlug}`);
    await expect(page.getByRole('link', { name: 'Apply for a Food Stall' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Apply as a General Trader' })).toHaveCount(0);
    await expect(page.getByText('Applications are currently closed')).toBeVisible();
  });

  test('CTA links resolve to this organisation\'s own booking form, not the legacy default', async ({ page }) => {
    await page.goto(`/${orgSlug}/${eventSlug}`);
    const href = await page.getByRole('link', { name: 'Apply for a Food Stall' }).getAttribute('href');
    expect(href).toBe(`Food_Stall_booking.html?org=${orgSlug}&event=${eventSlug}`);
  });

  test('a not-yet-open event shows no CTA at all, even if the form toggles are on', async ({ page }) => {
    const readySlug = `${eventSlug}-ready`;
    const readyId = `${eventId}_ready`;
    await service.from('events').insert({
      id: readyId, org_id: orgId, name: 'E2E CTA Ready Event', slug: readySlug,
      booking_prefix: `${bookingPrefix}R`, is_active: true, status: 'ready',
    });

    await page.goto(`/${orgSlug}/${readySlug}`);
    await expect(page.getByRole('link', { name: 'Apply for a Food Stall' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Apply as a General Trader' })).toHaveCount(0);

    await service.from('events').delete().eq('id', readyId);
  });
});
