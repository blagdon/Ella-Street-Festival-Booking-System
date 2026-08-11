// e2e/steward-tenant-isolation.spec.mjs
//
// Regression coverage for the steward-app booking-prefix defect found during
// V1.1 Sprint 2 verification: js/page-steward.js hardcoded 'ESF26-FOOD-'/
// 'ESF26-NONFOOD-'/'ESF26-MISC-', so a steward belonging to any other
// organisation synced zero bookings even though RLS, their membership, and
// the bookings themselves were all correct.
//
// Fix: js/supabase.js's requireAuth('steward') now resolves the steward's
// own organisation via the existing rpc_list_switchable_organisations() (the
// same RPC js/nav.js's admin org-switcher already calls) and caches it via
// the existing setCurrentOrgId(), so loadStallCosts()/CONFIG.INSTANCE_MAP
// resolve the steward's real booking prefix instead of a hardcoded one.
// Deliberately fails CLOSED (redirects to steward_login.html with a visible
// error, no data loads) rather than guessing when a steward has zero or more
// than one organisation_members row - see js/supabase.js's own comment.
//
// Runs as part of the "admin" Playwright project purely for its
// .env.test/service-role access (auth.admin.createUser, organisation_members
// inserts) - each test below signs in as its OWN steward user, never reusing
// the platform-admin storageState the "admin" project applies by default, so
// storageState is cleared for this whole file.
import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { service, anonKey } from '../tests/helpers.mjs';

test.use({ storageState: { cookies: [], origins: [] } });

// Same reasoning as tests/tenant-isolation.test.mjs's genTestPassword(): no
// password-shaped literal in source, well under GoTrue's 72-char limit.
function genTestPassword() {
  return randomUUID() + randomUUID().slice(0, 8).toUpperCase() + '!';
}

const stamp = Date.now();
const secondOrgId = `org_steward_iso_${stamp}`;
const secondOrgSlug = `steward-iso-${stamp}`;
const secondEventId = `event_steward_iso_${stamp}`;
const secondPrefix = 'RVSD27'; // deliberately not ESF26-shaped

const defaultBookingId = `STWISO-DEFAULT-${stamp}`;

const stewards = {
  default: { email: `steward-iso-default-${stamp}@example.test`, password: genTestPassword(), userId: null },
  second: { email: `steward-iso-second-${stamp}@example.test`, password: genTestPassword(), userId: null },
  zeroOrg: { email: `steward-iso-zeroorg-${stamp}@example.test`, password: genTestPassword(), userId: null },
  multiOrg: { email: `steward-iso-multiorg-${stamp}@example.test`, password: genTestPassword(), userId: null },
};

const secondOrgBookingIds = {
  food: `RVSD27-FOOD-0001-${stamp}`,
  general: `RVSD27-NONFOOD-0001-${stamp}`,
  misc: `RVSD27-MISC-0001-${stamp}`,
  dev: `RVSD27-DEV-0001-${stamp}`,
};

async function createSteward(key) {
  const s = stewards[key];
  const { data, error } = await service.auth.admin.createUser({
    email: s.email, password: s.password, email_confirm: true,
  });
  if (error) throw error;
  s.userId = data.user.id;
  await service.from('user_roles').upsert({ id: s.userId, email: s.email, role: 'steward' }, { onConflict: 'id' });
  return s.userId;
}

test.beforeAll(async () => {
  await service.from('organisations').insert({ id: secondOrgId, name: 'Riverside Steward Test Org', slug: secondOrgSlug });
  await service.from('events').insert({
    id: secondEventId, org_id: secondOrgId, name: 'Riverside Steward Test Event', slug: `${secondOrgSlug}-event`,
    booking_prefix: secondPrefix, is_active: true, status: 'open',
  });
  await service.from('settings').insert({ org_id: secondOrgId, key: 'booking_prefix', value: secondPrefix });

  await service.from('bookings').insert([
    { id: secondOrgBookingIds.food, org_id: secondOrgId, event_id: secondEventId, status: 'Confirmed', business_name: 'Riverside Food Trader', owner_name: 'Owner', email: 'food@example.test', instance_prefix: `${secondPrefix}-FOOD-`, booking_type: 'food', payment_link_code: `${secondOrgBookingIds.food}-code` },
    { id: secondOrgBookingIds.general, org_id: secondOrgId, event_id: secondEventId, status: 'Confirmed', business_name: 'Riverside General Trader', owner_name: 'Owner', email: 'general@example.test', instance_prefix: `${secondPrefix}-NONFOOD-`, booking_type: 'general', payment_link_code: `${secondOrgBookingIds.general}-code` },
    { id: secondOrgBookingIds.misc, org_id: secondOrgId, event_id: secondEventId, status: 'Confirmed', business_name: 'Riverside Misc Entry', owner_name: 'Owner', email: 'misc@example.test', instance_prefix: `${secondPrefix}-MISC-`, booking_type: 'misc', payment_link_code: `${secondOrgBookingIds.misc}-code` },
    { id: secondOrgBookingIds.dev, org_id: secondOrgId, event_id: secondEventId, status: 'Confirmed', business_name: 'Riverside DEV Entry (must never appear)', owner_name: 'Owner', email: 'dev@example.test', instance_prefix: `${secondPrefix}-DEV-`, booking_type: 'food', payment_link_code: `${secondOrgBookingIds.dev}-code` },
  ]);

  // A distinctly-named org_default booking, so the cross-tenant-isolation
  // test can assert it specifically rather than depending on whatever real
  // seeded org_default bookings do or don't exist.
  await service.from('bookings').insert({
    id: defaultBookingId, org_id: 'org_default', event_id: 'event_default', status: 'Confirmed',
    business_name: 'STEWARD-ISO-TEST Default Org Trader', owner_name: 'Owner',
    email: 'default@example.test', instance_prefix: 'ESF26-FOOD-', booking_type: 'food', payment_link_code: `${defaultBookingId}-code`,
  });

  await createSteward('default');
  await service.from('organisation_members').insert({ org_id: 'org_default', user_id: stewards.default.userId, role: 'steward' });

  await createSteward('second');
  await service.from('organisation_members').insert({ org_id: secondOrgId, user_id: stewards.second.userId, role: 'steward' });

  await createSteward('zeroOrg'); // no organisation_members row at all

  await createSteward('multiOrg');
  await service.from('organisation_members').insert([
    { org_id: 'org_default', user_id: stewards.multiOrg.userId, role: 'steward' },
    { org_id: secondOrgId, user_id: stewards.multiOrg.userId, role: 'steward' },
  ]);
});

test.afterAll(async () => {
  await service.from('bookings').delete().eq('id', defaultBookingId);
  await service.from('bookings').delete().in('id', Object.values(secondOrgBookingIds));
  await service.from('organisation_members').delete().eq('org_id', secondOrgId);
  await service.from('organisation_members').delete().eq('org_id', 'org_default').in(
    'user_id', [stewards.default.userId, stewards.multiOrg.userId].filter(Boolean)
  );
  await service.from('events').delete().eq('id', secondEventId);
  await service.from('settings').delete().eq('org_id', secondOrgId);
  await service.from('organisations').delete().eq('id', secondOrgId);

  for (const key of Object.keys(stewards)) {
    const userId = stewards[key].userId;
    if (!userId) continue;
    await service.from('user_roles').delete().eq('id', userId);
    await service.auth.admin.deleteUser(userId);
  }
});

async function loginAsSteward(page, email, password) {
  await page.goto('/steward_login.html');
  await page.evaluate((key) => window.esfUseTestProject(key, 'steward-iso'), anonKey);
  await page.reload();
  await page.fill('#email', email);
  await page.fill('#password', password);
  await page.click('#loginBtn');
}

// .serial: fullyParallel workers each independently running beforeAll/
// afterAll for this describe block produced real, reproducible
// cross-worker fixture duplication (multiple simultaneous copies of the
// Riverside org/bookings existing at once) - the same class of issue
// e2e/tenant-identity.spec.mjs and e2e/settings-secrets.spec.mjs already
// document and guard against the same way.
test.describe.serial('Steward booking-prefix tenant isolation', () => {
  test('Test 1 — default organisation steward still sees Food/General/Misc bookings (regression)', async ({ page }) => {
    await loginAsSteward(page, stewards.default.email, stewards.default.password);
    await page.waitForURL('**/steward.html');
    await expect(page.locator('#resultsList')).toContainText('STEWARD-ISO-TEST Default Org Trader', { timeout: 10000 });
  });

  test('Test 2 — second organisation steward retrieves its own Food/General/Misc bookings, not DEV', async ({ page }) => {
    await loginAsSteward(page, stewards.second.email, stewards.second.password);
    await page.waitForURL('**/steward.html');
    const list = page.locator('#resultsList');
    await expect(list).toContainText('Riverside Food Trader', { timeout: 10000 });
    await expect(list).toContainText('Riverside General Trader');
    await expect(list).toContainText('Riverside Misc Entry');
    // Test 6 (DEV exclusion)
    await expect(list).not.toContainText('Riverside DEV Entry');
  });

  test('Test 3 — cross-tenant isolation: the second org\'s steward never sees the default org\'s bookings', async ({ page }) => {
    await loginAsSteward(page, stewards.second.email, stewards.second.password);
    await page.waitForURL('**/steward.html');
    await expect(page.locator('#resultsList')).toContainText('Riverside Food Trader', { timeout: 10000 });
    await expect(page.locator('#resultsList')).not.toContainText('STEWARD-ISO-TEST Default Org Trader');
  });

  test('Test 3 (reverse) — the default org\'s steward never sees the second org\'s bookings', async ({ page }) => {
    await loginAsSteward(page, stewards.default.email, stewards.default.password);
    await page.waitForURL('**/steward.html');
    await expect(page.locator('#resultsList')).toContainText('STEWARD-ISO-TEST Default Org Trader', { timeout: 10000 });
    await expect(page.locator('#resultsList')).not.toContainText('Riverside');
  });

  test('zero-organisation steward fails closed: no data loads, clear error shown', async ({ page }) => {
    await loginAsSteward(page, stewards.zeroOrg.email, stewards.zeroOrg.password);
    await page.waitForURL(/steward_login\.html\?error=no_organisation/, { timeout: 10000 });
    await expect(page.locator('#errorMsg')).toBeVisible();
    await expect(page.locator('#errorMsg')).toContainText("isn't linked to an organisation");
  });

  test('multiple-organisation steward fails closed: no data loads, clear error shown, no org guessed', async ({ page }) => {
    await loginAsSteward(page, stewards.multiOrg.email, stewards.multiOrg.password);
    await page.waitForURL(/steward_login\.html\?error=multiple_organisations/, { timeout: 10000 });
    await expect(page.locator('#errorMsg')).toBeVisible();
    await expect(page.locator('#errorMsg')).toContainText('more than one organisation');
  });
});
