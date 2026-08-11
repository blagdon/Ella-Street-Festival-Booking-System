// Regression tests for the shared formatCurrency() helper (V1.1 Sprint 2,
// Issue 8), which replaced ~15 independently-duplicated `£${n.toFixed(2)}` /
// `.toLocaleString('en-GB', ...)` call sites across the admin UI, public
// booking forms, and Edge Function confirmation emails.
//
// UNLIKE most files in tests/, this is a pure unit test: no database, no
// .env.test, no seeded fixtures, no network — same convention as
// stripe-credentials-save.test.mjs. formatCurrency() is GBP-only by design
// (see its own doc comment in js/utils.js); these tests lock in presentation
// consistency, not any multi-currency behaviour, which does not exist.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { formatCurrency } from '../js/utils.js';

describe('formatCurrency', () => {
  test('representative amounts from the Sprint 2 test plan', () => {
    assert.equal(formatCurrency(0), '£0.00');
    assert.equal(formatCurrency(25), '£25.00');
    assert.equal(formatCurrency(25.5), '£25.50');
    assert.equal(formatCurrency(25.55), '£25.55');
    assert.equal(formatCurrency(1000), '£1,000.00');
    assert.equal(formatCurrency(10000.99), '£10,000.99');
  });

  test('always renders exactly two decimal places, never more or fewer', () => {
    // The pre-Sprint-2 payments.js call sites used minimumFractionDigits
    // alone (no maximum), which could render more than two decimals for a
    // value with floating-point noise - this is the regression that guards
    // against.
    assert.equal(formatCurrency(25.999), '£26.00');
    assert.equal(formatCurrency(10), '£10.00');
  });

  test('accepts a numeric string, matching how DB values often arrive', () => {
    assert.equal(formatCurrency('45.5'), '£45.50');
  });

  test('null, undefined, and empty string fall back to the placeholder', () => {
    assert.equal(formatCurrency(null), '—');
    assert.equal(formatCurrency(undefined), '—');
    assert.equal(formatCurrency(''), '—');
  });

  test('a custom placeholder can be supplied', () => {
    assert.equal(formatCurrency(null, { emptyPlaceholder: 'Free' }), 'Free');
  });

  test('unparseable input fails gracefully rather than rendering "£NaN"', () => {
    assert.equal(formatCurrency('not a number'), '—');
  });
});
