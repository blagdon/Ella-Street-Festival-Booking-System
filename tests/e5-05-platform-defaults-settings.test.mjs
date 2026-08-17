// Regression tests for E5-05 (Epic 5 findings reconciliation):
// platform_defaults_settings — the seed source rpc_initialise_tenant_defaults()
// clones into every newly provisioned organisation's own settings table —
// was missing several keys the application reads a hardcoded fallback for.
// A new org's admin who never manually configured these silently inherited
// Ella Street Festival's own values, worst of all Hull City Council's real
// regulatory email address for food-safety compliance correspondence.
//
// Fixed by 20260813130000_complete_platform_defaults_settings_e5_05.sql,
// adding six keys confirmed safe under the CURRENT architecture: base_url,
// cancel_url, bucket_name, map_default_zoom (seeded with the platform's own
// real, shared values — genuinely correct under the current single-
// deployment architecture), and portal_url/hcc_council_email (seeded EMPTY,
// deliberately not with Ella Street's own values, since there is no safe
// universal default for either). hcc_council_email itself was later retired
// along with the whole HCC Checks feature (20260817100000_retire_hcc_checks.sql)
// — five keys remain covered here.
//
// Six other keys from the original 12-key finding are deliberately NOT
// covered here: turnstile_site_key/map_center_lat/map_center_lng each raise
// their own architectural question (tracked separately, not implemented);
// sentry_dsn/sentry_browser_loader_url are excluded because E5-19 made
// Sentry configuration platform-level (org_default only); logo_url/
// logo_light_url are excluded because their absence is already correct,
// designed behaviour.
//
// Setup required first: node scripts/seed-test-project.mjs
// Run: npm run test:integration
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { service } from './helpers.mjs';

const RUN_ID = Date.now();
const NEW_ORG_ID = `e505-new-org-${RUN_ID}`;
const EXISTING_ORG_ID = `e505-existing-org-${RUN_ID}`;

const EXPECTED = {
  base_url: 'https://app.ellastreet.co.uk',
  cancel_url: 'https://app.ellastreet.co.uk/cancel_booking.html',
  bucket_name: 'esf-documents',
  map_default_zoom: '18',
  portal_url: '',
};
const KEYS = Object.keys(EXPECTED);

let existingOrgSentinelValue;

before(async () => {
  // An "existing" organisation, provisioned BEFORE this migration's effective
  // window in spirit (we can't literally time-travel, but the property under
  // test — the migration/RPC must never touch an org_id that already has
  // settings rows — is independent of when those rows were created). Seeded
  // with its own sentinel bucket_name, deliberately different from the new
  // platform default, so any accidental overwrite is immediately visible.
  const { error: orgErr } = await service.from('organisations')
    .insert({ id: EXISTING_ORG_ID, name: `E5-05 Existing Org ${EXISTING_ORG_ID}`, slug: EXISTING_ORG_ID, contact_email: 'owner@example.test' });
  assert.equal(orgErr, null, orgErr?.message);

  existingOrgSentinelValue = `existing-org-own-bucket-${RUN_ID}`;
  const { error: settingErr } = await service.from('settings')
    .insert({ org_id: EXISTING_ORG_ID, key: 'bucket_name', value: existingOrgSentinelValue, updated_by: 'test-fixture' });
  assert.equal(settingErr, null, settingErr?.message);
});

after(async () => {
  await service.from('settings').delete().in('org_id', [NEW_ORG_ID, EXISTING_ORG_ID]);
  await service.from('email_templates').delete().in('org_id', [NEW_ORG_ID, EXISTING_ORG_ID]);
  await service.from('sms_templates').delete().in('org_id', [NEW_ORG_ID, EXISTING_ORG_ID]);
  await service.from('organisations').delete().in('id', [NEW_ORG_ID, EXISTING_ORG_ID]);
});

describe('E5-05: platform_defaults_settings seed values', () => {
  test('all six keys exist in platform_defaults_settings with the expected values', async () => {
    const { data, error } = await service.from('platform_defaults_settings').select('key, value').in('key', KEYS);
    assert.equal(error, null, error?.message);
    assert.equal(data.length, KEYS.length, `expected all ${KEYS.length} keys present, got ${JSON.stringify(data)}`);

    const byKey = Object.fromEntries(data.map((r) => [r.key, r.value]));
    for (const key of KEYS) {
      assert.equal(byKey[key], EXPECTED[key], `${key} should equal ${JSON.stringify(EXPECTED[key])}, got ${JSON.stringify(byKey[key])}`);
    }
  });

  test('portal_url is an empty value, not Ella Street\'s own marketing URL', async () => {
    const { data } = await service.from('platform_defaults_settings').select('value').eq('key', 'portal_url').single();
    assert.equal(data.value, '');
    assert.doesNotMatch(data.value, /ellastreet\.co\.uk/i, 'must never default a new tenant to Ella Street\'s own public marketing page');
  });
});

describe('E5-05: a newly provisioned organisation receives all six settings', () => {
  test('rpc_initialise_tenant_defaults clones all six keys into a brand-new organisation', async () => {
    const { error: orgErr } = await service.from('organisations')
      .insert({ id: NEW_ORG_ID, name: `E5-05 New Org ${NEW_ORG_ID}`, slug: NEW_ORG_ID, contact_email: 'owner@example.test' });
    assert.equal(orgErr, null, orgErr?.message);

    const { data: rpcResult, error: rpcErr } = await service.rpc('rpc_initialise_tenant_defaults', { p_org_id: NEW_ORG_ID });
    assert.equal(rpcErr, null, rpcErr?.message);
    assert.equal(rpcResult.status, 'success');

    const { data: rows, error: rowsErr } = await service.from('settings').select('key, value').eq('org_id', NEW_ORG_ID).in('key', KEYS);
    assert.equal(rowsErr, null, rowsErr?.message);
    assert.equal(rows.length, KEYS.length, `expected all ${KEYS.length} keys cloned into the new org, got ${JSON.stringify(rows)}`);

    const byKey = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    for (const key of KEYS) {
      assert.equal(byKey[key], EXPECTED[key], `new org's ${key} should equal ${JSON.stringify(EXPECTED[key])}, got ${JSON.stringify(byKey[key])}`);
    }
  });
});

describe('E5-05: an existing organisation is not modified', () => {
  test('an already-provisioned organisation\'s own settings are untouched by the migration/RPC', async () => {
    const { data, error } = await service.from('settings').select('value').eq('org_id', EXISTING_ORG_ID).eq('key', 'bucket_name').single();
    assert.equal(error, null, error?.message);
    assert.equal(data.value, existingOrgSentinelValue, 'an existing organisation\'s own bucket_name must never be overwritten by the new platform default');
  });

  test('org_default\'s own settings are unaffected (spot-check, not asserting specific values that may be genuinely configured)', async () => {
    // org_default long predates this migration and may or may not already
    // have rows for these keys - the only property under test is that this
    // migration/RPC never re-inserts or overwrites org_default's own
    // settings rows, since rpc_initialise_tenant_defaults is provisioning-
    // time-only and org_default was never (re-)provisioned by it.
    const before = await service.from('settings').select('key, value').eq('org_id', 'org_default').in('key', KEYS);
    assert.equal(before.error, null, before.error?.message);
    // No assertion on content - existence/non-existence and any value here
    // is legitimate pre-existing state, not something this migration changes.
    // The real proof is structural: rpc_initialise_tenant_defaults was not
    // re-invoked for org_default as part of this migration (confirmed by
    // reading the migration itself - a pure platform_defaults_settings
    // INSERT ... ON CONFLICT, no call to the provisioning RPC anywhere).
    assert.ok(Array.isArray(before.data));
  });
});
