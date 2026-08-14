// Shared setup for every tests/*.test.mjs file: loading .env.test, refusing
// to run against anything but the disposable test project, and the
// service-role client (identical construction in every file that needs
// one). Previously each of the ~17 files in this directory independently
// repeated this same ~15-line block.
//
// Deliberately does NOT wrap the anon-key client or the admin sign-in: those
// vary enough across files (variable names - anon/authed/admin - and
// whether sign-in happens at module scope or inside before()) that forcing
// one shape here would cost more in churn than the duplication it removes.
// Each file still does `const anon = createClient(url, anonKey);` itself,
// just importing url/anonKey from here instead of reading them from
// process.env inline.
import { createClient } from '@supabase/supabase-js';

process.loadEnvFile('.env.test');

export const TEST_PROJECT_REF = 'qeplpcnrkgpaawfyliap';

export const url = process.env.TEST_SUPABASE_URL;
export const anonKey = process.env.TEST_SUPABASE_ANON_KEY;
export const serviceRoleKey = process.env.TEST_SUPABASE_SERVICE_ROLE_KEY;
export const adminEmail = process.env.TEST_ADMIN_EMAIL;
export const adminPassword = process.env.TEST_ADMIN_PASSWORD;

if (!url || !url.includes(TEST_PROJECT_REF)) {
  throw new Error(`Refusing to run integration tests against a non-test project: ${url}`);
}

export const service = createClient(url, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });

// Every tests/*.test.mjs file that calls an Edge Function used to define its
// own near-identical fetch wrapper (callFunction/callRetry/callSend/etc. -
// same headers, same JSON-decode, ~9 copies). Centralising it here does two
// things at once: removes the duplication, and gives every call site the
// same retry-on-transient-gateway-error behaviour, which none of them had
// individually. Confirmed live (2026-07-31, PR #123): a Supabase-wide 502
// outage failed integration-tests across several unrelated Edge Functions in
// the same CI run - a status the gateway returns before the function itself
// ever runs, so it's never a real assertion failure. Only 502/503/504 are
// retried; every other status (including a real 500 from inside the
// function) is returned as-is so a genuine bug still fails on the first try.
const TRANSIENT_STATUSES = new Set([502, 503, 504]);

export async function fetchEdgeFunction(name, init, { retries = 2, backoffMs = 750 } = {}) {
  let res;
  for (let attempt = 0; attempt <= retries; attempt++) {
    res = await fetch(`${url}/functions/v1/${name}`, init);
    if (!TRANSIENT_STATUSES.has(res.status) || attempt === retries) return res;
    await new Promise((resolve) => setTimeout(resolve, backoffMs * (attempt + 1)));
  }
  return res;
}

export async function callEdgeFunction(name, body, token = anonKey) {
  const res = await fetchEdgeFunction(name, {
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

// ---------------------------------------------------------------------------
// Phase 1 — Multi-Tenant Foundation helpers
// ---------------------------------------------------------------------------

/**
 * Ensures the Phase 1 platform foundation rows exist in the test project.
 * Must be called in seed-test-project.mjs (and is, as of Phase 1) and in
 * any test suite that needs to insert bookings or settings rows, because
 * those rows carry org_id/event_id defaults that reference these tables.
 *
 * All upserts are ON CONFLICT / ignoreDuplicates — safe to call multiple times.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} sb  A service-role client.
 */
export async function ensureFoundationRows(sb) {
  const { error: orgErr } = await sb.from('organisations').upsert(
    [
      { id: 'org_default', name: 'Ella Street Festival', slug: 'ella-street' },
      { id: 'org_demo',    name: 'Demo Festival Organisation', slug: 'demo-festival' },
    ],
    { onConflict: 'id', ignoreDuplicates: true }
  );
  if (orgErr) throw new Error(`ensureFoundationRows: organisations upsert failed: ${orgErr.message}`);

  const { error: evtErr } = await sb.from('events').upsert(
    [
      {
        id: 'event_default',
        org_id: 'org_default',
        name: 'Ella Street Festival 2026',
        slug: 'esf-2026',
        booking_prefix: 'ESF26',
        is_active: true,
        is_default: true,
        status: 'open',
      },
      {
        id: 'event_demo',
        org_id: 'org_demo',
        name: 'Demo Festival 2026',
        slug: 'demo-2026',
        booking_prefix: 'DEMO26',
        is_active: true,
        is_default: true,
        status: 'open',
      },
    ],
    { onConflict: 'id', ignoreDuplicates: true }
  );
  if (evtErr) throw new Error(`ensureFoundationRows: events upsert failed: ${evtErr.message}`);
}
