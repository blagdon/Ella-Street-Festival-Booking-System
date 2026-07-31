// Automated regression guard for the manual axe-core audit done across two
// rounds this project (see CHANGELOG's "Accessibility" entries) - every page
// listed here was brought to zero WCAG 2.0/2.1 A/AA violations by hand, and
// this is what stops that from silently regressing.
//
// Scoped to pages that render fully with no authentication and no live
// Supabase connection: the seven public-facing pages, plus the two admin
// login screens (the only admin pages reachable pre-auth). The other 17
// admin pages sit behind a real signed-in session and are a deliberate
// follow-up - see HANDOVER.md / CHANGELOG for the phased plan; testing them
// needs the same test-project + test-admin pattern tests/*.test.mjs already
// uses, not just a static page load.
//
// Uses AxeBuilder's own injection (page.evaluate, not a <script src>), which
// runs via the browser's debugger protocol rather than the page's normal
// script-loading path - so it works even on pay.html/payment_success.html/
// payment_cancelled.html, whose CSP script-src deliberately does NOT allow
// any CDN (unlike the booking forms). No CSP workaround needed here, unlike
// the manual audit.
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const PAGES = [
  'Food_Stall_booking.html',
  'General_Booking.html',
  'cancel_booking.html',
  'visitor_map.html',
  'pay.html',
  'payment_success.html',
  'payment_cancelled.html',
  'login.html',
  'steward_login.html',
];

function formatViolations(violations) {
  return violations
    .map((v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(',')).join('; ')}`)
    .join('\n');
}

for (const pagePath of PAGES) {
  test(`${pagePath} has no detectable accessibility violations`, async ({ page }) => {
    await page.goto(`/${pagePath}`);
    // Not 'networkidle': pay.html/cancel_booking.html hold a live Turnstile
    // connection open, which networkidle never considers idle - confirmed by
    // hitting exactly that 30s timeout on both when this used networkidle
    // for every page.
    await page.waitForLoadState('load');
    if (pagePath === 'visitor_map.html') {
      // Leaflet's attribution control is added to the DOM by its own JS, but
      // its styling comes from leaflet.css - a real https://unpkg.com/...
      // request, not bundled - so waiting for the element to exist
      // (waitForSelector) is NOT the same guarantee as its stylesheet having
      // actually finished applying. Confirmed on CI specifically (2026-07-31,
      // PR #124): passed 9/9 locally every time with just the selector wait,
      // then failed reproducibly (both the run and Playwright's own retry) in
      // CI on this exact page - CI's network timing to unpkg.com differs
      // enough from local to matter. This page has no Turnstile/live
      // connection (unlike pay.html/cancel_booking.html above), so
      // networkidle is safe here specifically and actually waits for the
      // stylesheet request too.
      await page.waitForLoadState('networkidle');
      await page.waitForSelector('.leaflet-control-attribution a');
    }
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();

    expect(results.violations, formatViolations(results.violations)).toEqual([]);
  });
}

test('index.html#type=recovery (mandatory password-reset gate) has no detectable accessibility violations', async ({ page }) => {
  // No admin session needed - this is the one admin-hub state reachable with
  // no auth at all, since Supabase's password-recovery redirect lands here
  // before any normal sign-in. A found-by-hand gap (see CHANGELOG): this
  // modal was never wired into either the focus-trap or Escape-key work done
  // on every other modal, simply because nothing had enumerated every
  // *Modal-id in the app and cross-checked it until asked "any other gaps?".
  await page.goto('/index.html#access_token=e2e-dummy&refresh_token=e2e-dummy&type=recovery');
  await page.waitForSelector('#passwordResetModal:not(.opacity-0)');

  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();

  expect(results.violations, formatViolations(results.violations)).toEqual([]);
});
