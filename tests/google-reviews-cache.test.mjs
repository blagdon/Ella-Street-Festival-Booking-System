// Integration tests for the get-reviews Edge Function's SerpApi cache
// (google_reviews_cache table), against the disposable test project.
//
// The test project deliberately has NO SerpApi key configured (settings row
// or env var — and before() removes any settings row defensively). That makes
// the live-fetch path fail fast with "SerpApi API Key not configured", which
// these tests use as proof that a request did NOT come from the cache —
// without ever making a real, metered SerpApi call.
//
// Setup required first: node scripts/seed-test-project.mjs
// Run: npm run test:integration
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '@supabase/supabase-js';

process.loadEnvFile('.env.test');

const url = process.env.TEST_SUPABASE_URL;
const anonKey = process.env.TEST_SUPABASE_ANON_KEY;
const serviceRoleKey = process.env.TEST_SUPABASE_SERVICE_ROLE_KEY;
const adminEmail = process.env.TEST_ADMIN_EMAIL;
const adminPassword = process.env.TEST_ADMIN_PASSWORD;

if (!url || !url.includes('qeplpcnrkgpaawfyliap')) {
  throw new Error(`Refusing to run integration tests against a non-test project: ${url}`);
}

const anon = createClient(url, anonKey);
const service = createClient(url, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });

let adminToken;
// All keys this file seeds — normalized (lowercased/trimmed) form, matching
// what get-reviews derives from business_name.
const SEEDED_KEYS = ['cached test cafe', 'stale test cafe'];

before(async () => {
  const { data, error } = await anon.auth.signInWithPassword({ email: adminEmail, password: adminPassword });
  if (error) throw new Error(`Failed to sign in as test admin (run scripts/seed-test-project.mjs first): ${error.message}`);
  adminToken = data.session.access_token;

  // The "not configured" failure mode is this file's cache-miss detector —
  // make sure a leftover key can't silently turn misses into real SerpApi calls.
  await service.from('settings').delete().eq('key', 'serpapi_api_key');
  await service.from('google_reviews_cache').delete().in('business_key', SEEDED_KEYS);
});

after(async () => {
  await service.from('google_reviews_cache').delete().in('business_key', SEEDED_KEYS);
});

async function callGetReviews(body, token = anonKey) {
  const res = await fetch(`${url}/functions/v1/get-reviews`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      apikey: anonKey,
    },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

const FRESH_PAYLOAD = {
  found: true,
  title: 'Cached Test Cafe',
  place_id: 'test-place-id',
  rating: 4.5,
  reviewsCount: 12,
  thumbnail: null,
  location: 'Hull, UK',
  reviews: [],
};

describe('get-reviews SerpApi cache', () => {
  test('rejects an unauthenticated caller before touching cache or SerpApi', async () => {
    const { status } = await callGetReviews({ business_name: 'Cached Test Cafe' }, anonKey);
    assert.equal(status, 401);
  });

  test('serves a fresh cache entry without needing a SerpApi key, case-insensitively', async () => {
    const { error: seedErr } = await service.from('google_reviews_cache').upsert({
      business_key: 'cached test cafe',
      payload: FRESH_PAYLOAD,
      fetched_at: new Date().toISOString(),
    });
    assert.equal(seedErr, null, seedErr?.message);

    // Different casing/whitespace than the seeded key — must still hit.
    const { status, json } = await callGetReviews({ business_name: '  Cached TEST Cafe ' }, adminToken);
    assert.equal(status, 200, JSON.stringify(json));
    assert.equal(json.cached, true, 'expected the response to be flagged as cached');
    assert.ok(json.cached_at, 'expected cached_at to be set');
    assert.equal(json.title, 'Cached Test Cafe');
    assert.equal(json.found, true);
  });

  test('force:true bypasses a fresh cache entry and attempts a live fetch', async () => {
    // Same seeded entry as above is still fresh; force must ignore it. With
    // no SerpApi key configured, the live path fails with "not configured" —
    // which is exactly the proof the cache was bypassed.
    const { status, json } = await callGetReviews({ business_name: 'Cached Test Cafe', force: true }, adminToken);
    assert.equal(status, 400, JSON.stringify(json));
    assert.match(json.error || '', /not configured/i);
  });

  test('an expired cache entry is ignored', async () => {
    const { error: seedErr } = await service.from('google_reviews_cache').upsert({
      business_key: 'stale test cafe',
      payload: { found: false, message: 'stale' },
      // Default TTL is 7 days; 30 days ago is safely expired.
      fetched_at: new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString(),
    });
    assert.equal(seedErr, null, seedErr?.message);

    const { status, json } = await callGetReviews({ business_name: 'Stale Test Cafe' }, adminToken);
    assert.equal(status, 400, JSON.stringify(json));
    assert.match(json.error || '', /not configured/i);
  });

  test('anon cannot read or write the cache table directly', async () => {
    const { error: readErr } = await anon.from('google_reviews_cache').select('business_key').limit(1);
    assert.ok(readErr, 'expected anon SELECT on google_reviews_cache to be rejected');
    const { error: writeErr } = await anon.from('google_reviews_cache').insert({
      business_key: 'anon should not write this',
      payload: {},
    });
    assert.ok(writeErr, 'expected anon INSERT on google_reviews_cache to be rejected');
  });
});
