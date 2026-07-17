// Behavioral check for the shared supabase/functions/_shared/cors.ts
// ALLOWED_ORIGIN constant (see git history: all seven browser-facing Edge
// Functions used to hardcode Access-Control-Allow-Origin: '*', including
// ones gated behind an admin Bearer token). Runs against the disposable
// "test backup" Supabase project only - see integration.test.mjs for the
// same guard/setup.
//
// The response header is a static value the function always emits
// regardless of the request's own Origin header - a browser is what
// actually enforces the restriction, by comparing this value against its
// own origin and refusing to let script read the response on a mismatch.
// So this doesn't need to (and can't, from plain Node fetch) simulate a
// malicious browser origin being blocked - it just asserts the deployed
// functions emit the intended single origin and never regress to a
// wildcard, which is the thing a future accidental
// `'Access-Control-Allow-Origin': '*'` edit would otherwise slip past
// unnoticed.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

process.loadEnvFile('.env.test');

const url = process.env.TEST_SUPABASE_URL;
const anonKey = process.env.TEST_SUPABASE_ANON_KEY;

if (!url || !url.includes('qeplpcnrkgpaawfyliap')) {
  throw new Error(`Refusing to run integration tests against a non-test project: ${url}`);
}

const PRODUCTION_ORIGIN = 'https://app.ellastreet.co.uk';

// Restricted to the functions already deployed to (and exercised against)
// the disposable test project by the rest of this suite - see
// integration.test.mjs's callFunction() call sites. get-reviews,
// get-booking-documents, and send-email aren't otherwise called here, so
// aren't included: a false failure from a function that was simply never
// deployed to this project would be noise, not a real regression signal.
// stripe-webhook is deliberately excluded too - it's called server-to-server
// by Stripe, never from a browser, and never had CORS headers at all.
const FUNCTIONS = ['submit-booking', 'cancel-booking', 'queue-bulk-email', 'create-checkout-session'];

describe('Edge Function CORS header', () => {
  for (const name of FUNCTIONS) {
    test(`${name} emits the production-only Access-Control-Allow-Origin, never a wildcard`, async () => {
      const res = await fetch(`${url}/functions/v1/${name}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${anonKey}`,
          apikey: anonKey,
        },
        body: '{}',
      });
      const allowOrigin = res.headers.get('access-control-allow-origin');
      assert.equal(
        allowOrigin,
        PRODUCTION_ORIGIN,
        `expected ${name} to only allow the production origin, got: ${allowOrigin}`
      );
    });
  }
});
