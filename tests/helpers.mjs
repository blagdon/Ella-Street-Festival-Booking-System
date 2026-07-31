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
