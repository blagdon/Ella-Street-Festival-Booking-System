// Phase 2 tenant-scope DEFAULT audit — removal-readiness regression coverage.
//
// 13 columns across 10 tables currently carry a transitional column default
// (`org_id DEFAULT 'org_default'` on 9, `event_id DEFAULT 'event_default'`
// on 4 — see each column's own comment and CHANGELOG/HANDOVER for the full
// audit). Every live insert path in the app already supplies these values
// explicitly; the defaults are inert scaffolding left over from the
// original Phase 1 -> Phase 2 migration strategy
// (20260801004_add_tenant_columns_to_domain_tables.sql), not something any
// current code path relies on.
//
// Phase 2B (20260821081226_drop_tenant_scope_defaults.sql) has now applied
// `DROP DEFAULT` to all 13 columns below on the test project. These tests
// were pre-written against exactly this end-state and are now ACTIVE (no
// longer skipped) — each proves its column's default is genuinely gone by
// asserting that omitting it on INSERT now raises a NOT NULL violation.
// Not yet applied to production — see the migration's own header.
//
// Setup required first: node scripts/seed-test-project.mjs
// Run: npm run test:integration
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { service } from './helpers.mjs';

const PREFIX = 'ESF26-TESTDEFAULTREADY-';

// One entry per DEFAULT instance (13 total: 9 org_id + 4 event_id). `insert`
// builds a minimal, otherwise-valid row for that table with the target
// column OMITTED - exactly the shape that currently falls through to the
// default, and that must instead raise a NOT NULL violation once the
// default is dropped.
const CASES = [
  {
    table: 'bookings', column: 'org_id',
    insert: (id) => ({
      id, event_id: 'event_default', status: 'Pending', business_name: 'x', owner_name: 'y',
      email: 'z@example.test', instance_prefix: 'ESF26-DEV-', stall_type: 'Food',
    }),
  },
  {
    table: 'bookings', column: 'event_id',
    insert: (id) => ({
      id, org_id: 'org_default', status: 'Pending', business_name: 'x', owner_name: 'y',
      email: 'z@example.test', instance_prefix: 'ESF26-DEV-', stall_type: 'Food',
    }),
  },
  {
    table: 'locations', column: 'org_id',
    insert: (id) => ({ id, dataset: 'LIVE', lat: 0, lng: 0, event_id: 'event_default' }),
  },
  {
    table: 'locations', column: 'event_id',
    insert: (id) => ({ id, dataset: 'LIVE', lat: 0, lng: 0, org_id: 'org_default' }),
  },
  {
    table: 'payments', column: 'org_id',
    // payments.booking_id is its PK and has no default of its own, so this
    // case needs a real, pre-existing booking to attach to rather than a
    // synthetic id - reuses the same fixture booking every case's own id
    // pattern would otherwise collide with, seeded in before() below.
    insert: () => ({ booking_id: `${PREFIX}PAYMENTS-FIXTURE`, paid: false }),
  },
  {
    table: 'audit_logs', column: 'org_id',
    insert: () => ({ action: 'defaults_readiness_probe', target_id: 'x', details: {}, event_id: 'event_default' }),
  },
  {
    table: 'audit_logs', column: 'event_id',
    insert: () => ({ action: 'defaults_readiness_probe', target_id: 'x', details: {}, org_id: 'org_default' }),
  },
  {
    table: 'email_queue', column: 'org_id',
    insert: () => ({ recipient: 'x@example.test', subject: 'x', body: 'x', status: 'Error' }),
  },
  {
    table: 'sms_queue', column: 'org_id',
    insert: () => ({ recipient: '+447000000000', body: 'x', status: 'Error' }),
  },
  {
    table: 'email_templates', column: 'org_id',
    insert: (id) => ({ id, subject: 'x', body_html: 'x' }),
  },
  {
    table: 'sms_templates', column: 'org_id',
    insert: (id) => ({ id, body: 'x' }),
  },
  {
    table: 'settings', column: 'org_id',
    insert: () => ({ key: 'defaults_readiness_probe_key', value: 'x' }),
  },
  {
    table: 'event_settings', column: 'event_id',
    insert: () => ({ key: 'defaults_readiness_probe_key', value: 'x' }),
  },
];

test.before(async () => {
  // Only the payments case needs a pre-existing row to attach to (its PK
  // IS booking_id, so there's no synthetic-id path the way every other
  // case has). Harmless no-op for every other case in CASES.
  await service.from('bookings').insert({
    id: `${PREFIX}PAYMENTS-FIXTURE`, org_id: 'org_default', event_id: 'event_default',
    status: 'Pending', business_name: 'x', owner_name: 'y', email: 'z@example.test',
    instance_prefix: 'ESF26-DEV-', stall_type: 'Food',
  });
});

test.after(async () => {
  await service.from('payments').delete().eq('booking_id', `${PREFIX}PAYMENTS-FIXTURE`);
  await service.from('bookings').delete().eq('id', `${PREFIX}PAYMENTS-FIXTURE`);
});

describe('tenant-scope DEFAULT removal readiness (Phase 2B/2C, not yet applied)', () => {
  test('CASES covers exactly the 13 known tenant-scope DEFAULT instances (9 org_id + 4 event_id)', () => {
    assert.equal(CASES.length, 13);
  });

  for (const { table, column, insert } of CASES) {
    test(
      `omitting ${table}.${column} on INSERT fails once its DEFAULT is removed`,
      async () => {
        const id = `${PREFIX}${table.toUpperCase()}-${column.toUpperCase()}`;
        const { error } = await service.from(table).insert(insert(id));
        assert.ok(error, `expected omitting ${table}.${column} to violate NOT NULL once its DEFAULT is dropped`);
        assert.match(error.message, /null value in column|violates not-null constraint/i);
      }
    );
  }
});
