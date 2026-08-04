// Phase 2 of the automated accessibility regression suite (see
// accessibility.spec.mjs's header for phase 1 and why this is separate):
// the 17 admin pages that sit behind a real signed-in session. Reuses the
// storage state admin.setup.mjs produces rather than logging in per test.
//
// Needs the disposable test Supabase project (.env.test) - see
// admin.setup.mjs, which hard-fails if it's missing rather than skipping
// silently. Run via `npm run test:a11y:admin`, not `npm run test:a11y`
// (which only runs the no-auth phase 1 suite, safe for any contributor to
// run with no secrets configured).
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const PAGES = [
  'index.html',
  'add_misc.html',
  'audit_log.html',
  'booking_forms.html',
  'comms_admin.html',
  'event_settings.html',
  'hcc_dashboard.html',
  'kanban_m.html',
  'location_admin.html',
  'manage_users.html',
  'message_queue.html',
  'more.html',
  'payments.html',
  'settings.html',
  'stats.html',
  'steward.html',
  'summary.html',
  'update_details.html',
  'admin.html',
];

function formatViolations(violations) {
  return violations
    .map((v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(',')).join('; ')}`)
    .join('\n');
}

for (const pagePath of PAGES) {
  test(`${pagePath} has no detectable accessibility violations`, async ({ page }) => {
    await page.goto(`/${pagePath}`);
    // Nav bar injection, instance-scoped data fetches, and (on stats.html)
    // chart rendering are all async after load - networkidle is a more
    // reliable "the page has actually hydrated" signal than a fixed sleep.
    // Confirmed no admin page holds a live connection the way
    // pay.html/cancel_booking.html's Turnstile widget does (that failure
    // mode is real - see accessibility.spec.mjs's own comment - just not
    // here: grepped every admin page for cf-turnstile/turnstile first).
    await page.waitForLoadState('networkidle');

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();

    expect(results.violations, formatViolations(results.violations)).toEqual([]);
  });
}
