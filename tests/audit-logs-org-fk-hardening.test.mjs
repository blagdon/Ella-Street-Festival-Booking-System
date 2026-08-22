// Regression tests for Phase 2D (part 2): audit_logs.org_id now has a real
// foreign key to organisations(id), ON DELETE RESTRICT - previously it had
// no FK at all. The two genuine historical production rows that once
// referenced deleted organisations were deliberately deleted before this
// migration (audit history that needs to be retained is already archived
// elsewhere - see migration 20260822074159's own header).
//
// audit_logs.event_id remains deliberately unconstrained - a separate,
// still-open design question, out of scope here.
//
// Setup required first: node scripts/seed-test-project.mjs
// Run: npm run test:integration
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { service } from './helpers.mjs';

const RUN_ID = Date.now();
const NONEXISTENT_ORG = `org-audit-fk-nonexistent-${RUN_ID}`;

describe('audit_logs.org_id: RESTRICT', () => {
  const ORG = `org-audit-fk-${RUN_ID}`;
  let insertedId;

  before(async () => {
    const { error } = await service.from('organisations').insert({ id: ORG, name: 'Audit FK Hardening Org', slug: ORG });
    assert.equal(error, null, error?.message);
  });

  after(async () => {
    await service.from('audit_logs').delete().eq('org_id', ORG);
    await service.from('organisations').delete().eq('id', ORG);
  });

  test('a valid org_id insert succeeds', async () => {
    const { data, error } = await service.from('audit_logs').insert({
      action: 'audit_fk_hardening_probe', target_id: 'x', details: {}, org_id: ORG, event_id: 'event_default',
    }).select('id').single();
    assert.equal(error, null, error?.message);
    insertedId = data.id;
  });

  test('a nonexistent org_id insert fails with the FK', async () => {
    const { error } = await service.from('audit_logs').insert({
      action: 'audit_fk_hardening_probe', target_id: 'x', details: {}, org_id: NONEXISTENT_ORG, event_id: 'event_default',
    });
    assert.ok(error, 'a nonexistent org_id must be rejected');
    assert.equal(error.code, '23503');
    assert.match(error.message, /audit_logs_org_id_fkey/);
  });

  test('the existing valid audit_logs row remains valid and selectable', async () => {
    const { data, error } = await service.from('audit_logs').select('org_id').eq('id', insertedId).single();
    assert.equal(error, null, error?.message);
    assert.equal(data.org_id, ORG);
  });

  test('organisation deletion is blocked (RESTRICT) while an audit_logs row still references it', async () => {
    const { error } = await service.from('organisations').delete().eq('id', ORG);
    assert.ok(error, 'deleting an organisation with an audit_logs row referencing it must be blocked');

    const { data: stillExists } = await service.from('organisations').select('id').eq('id', ORG).maybeSingle();
    assert.ok(stillExists, 'the organisation must still exist after the blocked delete attempt');
  });
});
