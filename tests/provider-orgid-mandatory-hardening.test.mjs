// Regression tests for post-Epic-5 hardening item H1: sendViaSms(),
// sendViaZoho(), loadStripeSettings(), and loadSmsSettings() (all in
// supabase/functions/_shared/) used to declare `orgId: string = 'org_default'`
// — an optional parameter silently defaulting if a future caller forgot it.
// That silent default is exactly the shape of bug the org-propagation fix
// (PR #200) had to close across five functions. All four now declare orgId
// as a REQUIRED parameter, so a future omission is a compile-time error
// instead of a silent cross-tenant provider mix-up.
//
// Making loadSmsSettings() required surfaced a genuine, previously-missed
// instance of the same bug class: checkDeliveryStatus() (_shared/sms.ts) had
// NO orgId parameter at all and always loaded org_default's SMS Works
// settings regardless of which organisation's message was being checked.
// check-sms-delivery/index.ts already resolves and org-scopes the queue row
// (row.org_id) before calling it — that value simply wasn't threaded
// through. Fixed by adding a required orgId parameter to
// checkDeliveryStatus() and passing row.org_id at its one call site.
//
// This file has two parts:
//   1. A structural check (source text, no network) that none of the four
//      signatures still declares a default, and that the one genuinely
//      platform-level call site (stripe-webhook) passes 'org_default'
//      explicitly rather than omitting the argument.
//   2. A live behavioural test proving check-sms-delivery's status check now
//      uses the row's OWN organisation's SMS settings, using the same
//      sentinel-provider-name technique as
//      tests/org-propagation-send-paths.test.mjs (a bogus, uniquely-named
//      sms_provider value fails locally in _shared/sms.ts before any network
//      call, so no real SMS Works request is ever made).
//
// Setup required first: node scripts/seed-test-project.mjs
// Run: npm run test:integration
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { url, anonKey, adminEmail, adminPassword, service, callEdgeFunction } from './helpers.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');

function genTestPassword() {
  return randomUUID() + randomUUID().slice(0, 8).toUpperCase() + '!';
}

function readSource(relPath) {
  return readFileSync(join(REPO_ROOT, relPath), 'utf8');
}

// `sig[1]` is everything BETWEEN the function's outer parens (non-greedy,
// so it stops right before the closing `)` — the closing paren itself is
// never part of the captured group), trimmed of surrounding whitespace.
// A required `orgId: string` parameter therefore ends the trimmed capture
// exactly at `orgId: string`; a defaulted one would instead read
// `orgId: string = 'org_default'`.
function endsWithRequiredOrgId(paramsText) {
  return /orgId:\s*string\s*$/.test(paramsText.trim());
}

describe('H1 structural check: no default orgId remains on the four shared provider functions', () => {
  test('sendViaSms() declares orgId as required, not defaulted', () => {
    const src = readSource('supabase/functions/_shared/sms.ts');
    const sig = src.match(/export async function sendViaSms\(([\s\S]*?)\): Promise<SmsSendResult>/);
    assert.ok(sig, 'expected to find sendViaSms\'s signature');
    assert.ok(endsWithRequiredOrgId(sig[1]), `expected a plain required orgId: string parameter, got: ${JSON.stringify(sig[1])}`);
  });

  test('sendViaZoho() declares orgId as required, not defaulted', () => {
    const src = readSource('supabase/functions/_shared/zoho.ts');
    const sig = src.match(/export async function sendViaZoho\(([\s\S]*?)\): Promise<\{ success: true; data: any \}>/);
    assert.ok(sig, 'expected to find sendViaZoho\'s signature');
    assert.ok(endsWithRequiredOrgId(sig[1]), `expected a plain required orgId: string parameter, got: ${JSON.stringify(sig[1])}`);
  });

  test('loadStripeSettings() declares orgId as required, not defaulted', () => {
    const src = readSource('supabase/functions/_shared/stripe.ts');
    const sig = src.match(/export async function loadStripeSettings\(([\s\S]*?)\): Promise<StripeSettings>/);
    assert.ok(sig, 'expected to find loadStripeSettings\'s signature');
    assert.ok(endsWithRequiredOrgId(sig[1]), `expected a plain required orgId: string parameter, got: ${JSON.stringify(sig[1])}`);
  });

  test('loadSmsSettings() declares orgId as required, not defaulted', () => {
    const src = readSource('supabase/functions/_shared/sms.ts');
    const sig = src.match(/async function loadSmsSettings\(([\s\S]*?)\): Promise<SmsSettings>/);
    assert.ok(sig, 'expected to find loadSmsSettings\'s signature');
    assert.ok(endsWithRequiredOrgId(sig[1]), `expected a plain required orgId: string parameter, got: ${JSON.stringify(sig[1])}`);
  });

  test('checkDeliveryStatus() gained a required orgId parameter (previously had none at all)', () => {
    const src = readSource('supabase/functions/_shared/sms.ts');
    const sig = src.match(/export async function checkDeliveryStatus\(([\s\S]*?)\): Promise<DeliveryStatusResult>/);
    assert.ok(sig, 'expected to find checkDeliveryStatus\'s signature');
    assert.match(sig[1], /orgId:\s*string/, 'checkDeliveryStatus must now accept an orgId');
  });

  test('the one genuinely platform-level loadStripeSettings call site (stripe-webhook, pre-signature-verification) passes \'org_default\' explicitly', () => {
    const src = readSource('supabase/functions/stripe-webhook/index.ts');
    assert.match(src, /loadStripeSettings\(supabaseAdmin,\s*'org_default'\)/,
      'stripe-webhook must explicitly pass org_default now that the parameter is required - not omit it');
  });

  test('check-sms-delivery threads the authorised row\'s own org_id into checkDeliveryStatus', () => {
    const src = readSource('supabase/functions/check-sms-delivery/index.ts');
    assert.match(src, /checkDeliveryStatus\(supabaseAdmin,\s*row\.provider_message_id,\s*row\.org_id\)/,
      'check-sms-delivery must pass the already-authorised row\'s own org_id, not omit it');
  });
});

describe('H1 behavioural check: check-sms-delivery now uses the row\'s own organisation\'s SMS settings', () => {
  const RUN_ID = Date.now();
  const ORG_A = `h1-sms-a-${RUN_ID}`;
  const ORG_B = `h1-sms-b-${RUN_ID}`;
  const OWNER_A_EMAIL = `h1-sms-owner-a-${RUN_ID}@example.test`;
  const OWNER_A_PASSWORD = genTestPassword();

  // _shared/sms.ts validates the configured provider name against its
  // adapter table BEFORE any network call, so a bogus, uniquely-named
  // sms_provider value fails locally and deterministically - no real SMS
  // Works request is ever attempted, matching the technique already
  // established in tests/org-propagation-send-paths.test.mjs.
  const SMS_PROVIDER_SENTINEL_A = `sentinel-unknown-h1-a-${RUN_ID}`;
  const SMS_PROVIDER_SENTINEL_B = `sentinel-unknown-h1-b-${RUN_ID}`;

  let ownerAId;
  let ownerA, platformAdmin;

  async function tokenFor(client) {
    const { data } = await client.auth.getSession();
    return data.session.access_token;
  }

  before(async () => {
    const { error: orgAErr } = await service.from('organisations')
      .insert({ id: ORG_A, name: `H1 Test ${ORG_A}`, slug: ORG_A, contact_email: 'owner@example.test' });
    assert.equal(orgAErr, null, orgAErr?.message);
    const { error: orgBErr } = await service.from('organisations')
      .insert({ id: ORG_B, name: `H1 Test ${ORG_B}`, slug: ORG_B, contact_email: 'owner@example.test' });
    assert.equal(orgBErr, null, orgBErr?.message);

    const { error: settingsAErr } = await service.from('settings')
      .upsert({ org_id: ORG_A, key: 'sms_provider', value: SMS_PROVIDER_SENTINEL_A }, { onConflict: 'org_id,key' });
    assert.equal(settingsAErr, null, settingsAErr?.message);
    const { error: settingsBErr } = await service.from('settings')
      .upsert({ org_id: ORG_B, key: 'sms_provider', value: SMS_PROVIDER_SENTINEL_B }, { onConflict: 'org_id,key' });
    assert.equal(settingsBErr, null, settingsBErr?.message);

    const { data: ownerACreated, error: ownerAErr } = await service.auth.admin.createUser({
      email: OWNER_A_EMAIL, password: OWNER_A_PASSWORD, email_confirm: true,
    });
    assert.equal(ownerAErr, null, ownerAErr?.message);
    ownerAId = ownerACreated.user.id;
    const { error: memberAErr } = await service.from('organisation_members')
      .insert({ org_id: ORG_A, user_id: ownerAId, role: 'admin' });
    assert.equal(memberAErr, null, memberAErr?.message);

    ownerA = createClient(url, anonKey);
    const { error: signInAErr } = await ownerA.auth.signInWithPassword({ email: OWNER_A_EMAIL, password: OWNER_A_PASSWORD });
    assert.equal(signInAErr, null, signInAErr?.message);

    platformAdmin = createClient(url, anonKey);
    const { error: platformSignInErr } = await platformAdmin.auth.signInWithPassword({ email: adminEmail, password: adminPassword });
    assert.equal(platformSignInErr, null, platformSignInErr?.message);
  });

  after(async () => {
    await service.from('sms_queue').delete().in('org_id', [ORG_A, ORG_B]);
    await service.from('settings').delete().in('org_id', [ORG_A, ORG_B]);
    await service.from('organisation_members').delete().eq('org_id', ORG_A);
    await service.from('organisations').delete().in('id', [ORG_A, ORG_B]);
    if (ownerAId) await service.auth.admin.deleteUser(ownerAId);
  });

  test('Org A\'s own admin checking Org A\'s own message uses Org A\'s own sms_provider, not org_default\'s', async () => {
    const { data: row, error } = await service.from('sms_queue').insert({
      recipient: '+447700900460', body: 'h1 delivery check test A', status: 'Sent',
      provider_message_id: `real-looking-id-${RUN_ID}-a`, org_id: ORG_A,
    }).select().single();
    assert.equal(error, null, error?.message);

    const { status, json } = await callEdgeFunction('check-sms-delivery', { id: row.id }, await tokenFor(ownerA));
    assert.equal(status, 500, JSON.stringify(json));
    assert.match(json.error || '', new RegExp(SMS_PROVIDER_SENTINEL_A),
      'the check must load Org A\'s own sms_provider setting, proving row.org_id reached checkDeliveryStatus() and then loadSmsSettings()');
  });

  test('a platform admin checking an Org B message uses Org B\'s own sms_provider, not org_default\'s', async () => {
    const { data: row, error } = await service.from('sms_queue').insert({
      recipient: '+447700900461', body: 'h1 delivery check test B', status: 'Sent',
      provider_message_id: `real-looking-id-${RUN_ID}-b`, org_id: ORG_B,
    }).select().single();
    assert.equal(error, null, error?.message);

    const { status, json } = await callEdgeFunction('check-sms-delivery', { id: row.id }, await tokenFor(platformAdmin));
    assert.equal(status, 500, JSON.stringify(json));
    assert.match(json.error || '', new RegExp(SMS_PROVIDER_SENTINEL_B),
      'a platform admin\'s check must still resolve Org B\'s own settings, not org_default\'s, proving the platform-admin bypass acts on the RESOURCE\'s org, never a substitute');
  });
});
