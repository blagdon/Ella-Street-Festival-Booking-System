// Regression tests for the Stripe credentials save on settings.html, which
// used to overwrite stored credentials with empty strings whenever a field
// was blank - see js/stripe-credentials.js for the full write-up of the two
// ways that fired.
//
// UNLIKE every other file in tests/, this one is a pure unit test: no
// database, no .env.test, no seeded fixtures, no network. It therefore does
// NOT need the test project's credentials and runs anywhere `node --test`
// does, including a fresh clone with no secrets configured. Don't add a
// Supabase client to it - the logic under test deliberately lives in a module
// with no imports precisely so it stays testable without one.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildStripeCredentialUpdates, STRIPE_CREDENTIAL_KEYS } from '../js/stripe-credentials.js';

const META = { updatedAt: '2026-07-21T12:00:00.000Z', updatedBy: 'admin@example.test' };

/** The keys a save would actually write, in order. */
const keysWritten = (values) => buildStripeCredentialUpdates(values, META).map(row => row.key);

describe('buildStripeCredentialUpdates', () => {
  test('THE REGRESSION: a blank field is omitted, not written as an empty string', () => {
    // The exact shape of the documented "save the Test pair now, add Live
    // later" workflow. Before the fix this returned all four rows, the two
    // Live ones carrying '' - silently destroying the Live credentials.
    const updates = buildStripeCredentialUpdates({
      stripe_secret_key_test: 'sk_test_abc123',
      stripe_secret_key_live: '',
      stripe_webhook_secret_test: 'whsec_test_abc123',
      stripe_webhook_secret_live: ''
    }, META);

    assert.deepEqual(updates.map(row => row.key), [
      'stripe_secret_key_test',
      'stripe_webhook_secret_test'
    ]);
    assert.equal(updates.some(row => row.value === ''), false,
      'no row may carry an empty value - that is the wipe this guards against');
  });

  test('every field blank writes nothing at all (the failed-load state)', () => {
    // What the inputs look like when the initial credentials load failed. The
    // caller refuses to save in that case anyway, but this is the backstop:
    // even if it gets here, there is nothing to overwrite anything with.
    const updates = buildStripeCredentialUpdates({
      stripe_secret_key_test: '',
      stripe_secret_key_live: '',
      stripe_webhook_secret_test: '',
      stripe_webhook_secret_live: ''
    }, META);

    assert.deepEqual(updates, []);
  });

  test('a whitespace-only field counts as blank', () => {
    assert.deepEqual(keysWritten({ stripe_secret_key_live: '   \t\n  ' }), []);
  });

  test('a missing key is treated as blank rather than throwing', () => {
    // Guards against a future field rename in page-settings.js silently
    // turning into `undefined` and being written as the string "undefined".
    assert.deepEqual(keysWritten({ stripe_secret_key_test: 'sk_test_abc123' }),
      ['stripe_secret_key_test']);
    assert.deepEqual(keysWritten({}), []);
    assert.deepEqual(keysWritten(undefined), []);
  });

  test('populated fields are written with trimmed values and the audit metadata', () => {
    const updates = buildStripeCredentialUpdates({
      stripe_secret_key_live: '  sk_live_xyz789  '
    }, META);

    assert.deepEqual(updates, [{
      key: 'stripe_secret_key_live',
      value: 'sk_live_xyz789',
      updated_at: META.updatedAt,
      updated_by: META.updatedBy
    }]);
  });

  test('all four populated writes all four', () => {
    const values = Object.fromEntries(STRIPE_CREDENTIAL_KEYS.map(key => [key, `value-for-${key}`]));
    assert.deepEqual(keysWritten(values), STRIPE_CREDENTIAL_KEYS);
  });

  test('the four keys are exactly the settings rows this card owns', () => {
    // A fifth credential added to the UI without being added here would be
    // silently dropped by every save, which looks identical to "the save
    // didn't work" - pin the list so that change has to be deliberate.
    assert.deepEqual(STRIPE_CREDENTIAL_KEYS, [
      'stripe_secret_key_test',
      'stripe_secret_key_live',
      'stripe_webhook_secret_test',
      'stripe_webhook_secret_live'
    ]);
  });
});
