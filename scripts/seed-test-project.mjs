// One-time (idempotent) fixture setup for integration tests, run against the
// disposable "test backup" Supabase project — never the real project. Creates
// the admin test user + role, and the settings/email_templates rows the
// deployed submit-booking/cancel-booking/queue-bulk-email functions need to
// run at all. Deliberately does NOT set any zoho_* settings: email sends are
// meant to fail predictably during tests (logged as email_queue Error), never
// actually reach Zoho.
import { createClient } from '@supabase/supabase-js';

process.loadEnvFile('.env.test');

const url = process.env.TEST_SUPABASE_URL;
const serviceRoleKey = process.env.TEST_SUPABASE_SERVICE_ROLE_KEY;
const adminEmail = process.env.TEST_ADMIN_EMAIL;
const adminPassword = process.env.TEST_ADMIN_PASSWORD;

if (!url || !serviceRoleKey || !adminEmail || !adminPassword) {
  throw new Error('Missing required env vars — check .env.test');
}

if (!url.includes('qeplpcnrkgpaawfyliap')) {
  throw new Error(`Refusing to seed a project that isn't the test-backup project: ${url}`);
}

const admin = createClient(url, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });

async function ensureAdminUser() {
  const { data: existing } = await admin.auth.admin.listUsers();
  let user = existing?.users?.find((u) => u.email === adminEmail);

  if (!user) {
    const { data, error } = await admin.auth.admin.createUser({
      email: adminEmail,
      password: adminPassword,
      email_confirm: true,
    });
    if (error) throw new Error(`Failed to create test admin user: ${error.message}`);
    user = data.user;
    console.log('Created test admin auth user:', user.id);
  } else {
    console.log('Test admin auth user already exists:', user.id);
  }

  const { error: roleErr } = await admin.from('user_roles').upsert({ id: user.id, role: 'admin' });
  if (roleErr) throw new Error(`Failed to upsert user_roles: ${roleErr.message}`);
  console.log('Ensured user_roles admin row for:', user.id);

  return user.id;
}

async function ensureSettings() {
  const rows = [
    { key: 'cancel_url', value: 'https://example.test/cancel_booking.html' },
    { key: 'bucket_name', value: 'esf-documents' },
    { key: 'booking_prefix', value: 'ESF26' },
  ];
  const { error } = await admin.from('settings').upsert(rows, { onConflict: 'key' });
  if (error) throw new Error(`Failed to upsert settings: ${error.message}`);
  console.log('Ensured settings rows:', rows.map((r) => r.key).join(', '));
}

async function ensureEmailTemplates() {
  const rows = [
    {
      id: 'application_received',
      subject: 'Application Received (Ref: {{booking_id}})',
      body_html: 'Dear {{owner_name}}, thanks for applying with {{business_name}}. Ref: {{booking_id}}. Cancel: {{cancel_link}}',
    },
    {
      id: 'cancellation_confirmed',
      subject: 'Cancellation Confirmed (Ref: {{booking_id}})',
      body_html: 'Dear {{owner_name}}, your booking {{booking_id}} for {{business_name}} has been cancelled.',
    },
  ];
  const { error } = await admin.from('email_templates').upsert(rows, { onConflict: 'id' });
  if (error) throw new Error(`Failed to upsert email_templates: ${error.message}`);
  console.log('Ensured email_templates rows:', rows.map((r) => r.id).join(', '));
}

const adminUserId = await ensureAdminUser();
await ensureSettings();
await ensureEmailTemplates();

console.log('\nSeed complete. TEST_ADMIN_USER_ID=' + adminUserId);
