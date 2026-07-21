// Behavioural tests for supabase/functions/_shared/errors.ts, as applied to the
// two PUBLIC Edge Functions (submit-booking, cancel-booking). Same approach as
// cors.test.mjs: asserts what the DEPLOYED functions actually return, since the
// thing worth protecting is the response an anonymous caller receives, not the
// helper's internals.
//
// REQUIRES the updated submit-booking/cancel-booking to be deployed to the
// disposable test project first - this suite tests deployed behaviour, so a
// stale deployment fails it. Runs against that project only, same guard as the
// rest of tests/.
//
// WHAT IS AND ISN'T COVERED HERE
//
// The deliberate, user-facing validation messages are directly assertable, and
// are - both that they still arrive verbatim, and that they now carry a 400
// rather than the old blanket 500.
//
// The unexpected-error path (Postgres error, RPC failure, missing server env
// var -> generic message + reference id) is deliberately NOT triggerable from
// outside: every externally reachable input is either validated into a
// PublicError or handled. That is the design working as intended, and it means
// there is no honest black-box way to force one. What IS asserted here is the
// property that actually matters and would catch a regression: no error
// response from these endpoints ever carries database or server internals.
// If a future change starts leaking, it will almost certainly leak one of the
// tell-tale tokens below.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '@supabase/supabase-js';

process.loadEnvFile('.env.test');

const url = process.env.TEST_SUPABASE_URL;
const anonKey = process.env.TEST_SUPABASE_ANON_KEY;

if (!url || !url.includes('qeplpcnrkgpaawfyliap')) {
  throw new Error(`Refusing to run integration tests against a non-test project: ${url}`);
}

// Cloudflare's official always-passes Turnstile test token - see
// integration.test.mjs for why this is sanctioned rather than a bypass.
const TURNSTILE_TEST_TOKEN = 'XXXX.DUMMY.TOKEN.XXXX';

const service = createClient(url, process.env.TEST_SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false }
});

// Substrings that should never appear in a response to an unauthenticated
// caller. Postgres error text, PostgREST codes, and the internals of our own
// schema - the map you'd want if you were probing the app.
const LEAK_MARKERS = [
  'violates', 'constraint', 'duplicate key', 'relation ', 'column ',
  'pgrst', 'postgres', 'supabase.co', 'bookings_pkey', 'service_role',
  'SUPABASE_', 'TURNSTILE_', 'stack', 'at Object.', 'index.ts'
];

function assertNoLeak(body, label) {
  const haystack = JSON.stringify(body).toLowerCase();
  for (const marker of LEAK_MARKERS) {
    assert.equal(haystack.includes(marker.toLowerCase()), false,
      `${label}: response leaked internals (matched "${marker}"): ${JSON.stringify(body)}`);
  }
}

async function callFunction(name, body) {
  const res = await fetch(`${url}/functions/v1/${name}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${anonKey}`,
      apikey: anonKey,
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

function payload(overrides = {}) {
  return {
    token: TURNSTILE_TEST_TOKEN,
    bookingData: {
      instance_prefix: 'ESF26-FOOD-',
      stall_type: 'Food',
      business_name: 'Error Sanitisation Test',
      owner_name: 'Test Owner',
      email: 'error-sanitisation@example.test',
      ...overrides,
    },
  };
}

// The upload-validation cases DO create a booking: submit-booking validates
// tempUuid/fileNames at step 5, AFTER the row is inserted at step 4, so a bad
// filename returns an error with the booking already committed. That is
// pre-existing behaviour, not something this change introduced - it just means
// these tests have rows to clean up. Every fixture here shares one
// business_name so this single delete covers them.
after(async () => {
  await service.from('bookings').delete().eq('business_name', 'Error Sanitisation Test');
});

describe('submit-booking public error handling', () => {
  test('a deliberate validation message still reaches the caller verbatim', async () => {
    const { status, json } = await callFunction('submit-booking', payload({ stall_type: 'Bogus' }));

    assert.equal(json.error, 'Invalid stall_type.');
    assert.equal(status, 400, 'a validation failure is a client error, not a 500');
  });

  test('an invalid instance_prefix is reported specifically, not genericised', async () => {
    // Proves the allow-list is not simply swallowing everything - a PublicError
    // must survive intact, or the endpoint becomes undiagnosable for traders.
    const { status, json } = await callFunction('submit-booking', payload({ instance_prefix: 'NOT-A-PREFIX-' }));

    assert.equal(json.error, 'Invalid instance_prefix.');
    assert.equal(status, 400);
  });

  test('an invalid upload filename is rejected with its own message', async () => {
    // A filename that fails SAFE_FILENAME_PATTERN (space + shell metachars) but
    // is NOT path-traversal-shaped. `../../etc/passwd` would be the obvious
    // choice, but Supabase's edge WAF blocks that string in the body with a
    // 403 before it ever reaches the function - so it can't exercise our own
    // validation. This still proves the filename allow-list rejects and reports.
    const { status, json } = await callFunction('submit-booking', {
      ...payload(),
      tempUuid: 'abcdef123456',
      fileNames: ['bad name;rm.pdf'],
    });

    assert.equal(json.error, 'Invalid file name in upload list.');
    assert.equal(status, 400);
  });

  test('no error response carries database or server internals', async () => {
    const cases = [
      ['bogus stall_type', payload({ stall_type: 'Bogus' })],
      ['bogus prefix', payload({ instance_prefix: 'NOT-A-PREFIX-' })],
      ['missing body', { token: TURNSTILE_TEST_TOKEN }],
      ['bookingData not an object', { token: TURNSTILE_TEST_TOKEN, bookingData: 'a string' }],
      // Oversized fields are truncated rather than rejected, so this pairs the
      // oversize with an invalid stall_type - otherwise the request SUCCEEDS
      // and leaves a booking behind that the cleanup below can't match, since
      // the business_name it would be filed under is the 5000-x string.
      ['oversized field', payload({ business_name: 'x'.repeat(5000), stall_type: 'Bogus' })],
      ['bad upload session', { ...payload(), tempUuid: '!!!', fileNames: ['a.pdf'] }],
    ];

    for (const [label, body] of cases) {
      const { json } = await callFunction('submit-booking', body);
      assertNoLeak(json, label);
    }
  });

  test('an error response exposes only an `error` key', async () => {
    // A stack, cause, or code field appearing alongside the message would
    // re-open the same hole from a different direction.
    const { json } = await callFunction('submit-booking', payload({ stall_type: 'Bogus' }));
    assert.deepEqual(Object.keys(json), ['error']);
  });
});

describe('cancel-booking public error handling', () => {
  test('its own validation messages are unchanged', async () => {
    const { status, json } = await callFunction('cancel-booking', { cancelToken: 'whatever' });
    assert.equal(json.error, 'Please complete the CAPTCHA verification.');
    assert.equal(status, 400);
  });

  test('an unusable cancellation token says so without exposing internals', async () => {
    const { status, json } = await callFunction('cancel-booking', {
      token: TURNSTILE_TEST_TOKEN,
      cancelToken: '00000000-0000-0000-0000-000000000000',
    });

    assert.equal(status, 400);
    assertNoLeak(json, 'unknown cancel token');
  });

  test('no error response carries database or server internals', async () => {
    const cases = [
      ['no token at all', {}],
      ['missing cancelToken', { token: TURNSTILE_TEST_TOKEN }],
      ['non-string cancelToken', { token: TURNSTILE_TEST_TOKEN, cancelToken: { nested: true } }],
    ];

    for (const [label, body] of cases) {
      const { json } = await callFunction('cancel-booking', body);
      assertNoLeak(json, label);
    }
  });
});
