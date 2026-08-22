// Regression tests for Phase 2D (part 1): payments.org_id, sms_queue.org_id,
// email_queue.org_id, settings.org_id, email_templates.org_id, and
// sms_templates.org_id now have real foreign keys to organisations(id) -
// previously none of the six had any FK at all, and the relationship was
// maintained purely by application discipline. RESTRICT on payments/
// sms_queue/email_queue (operational records - see migration
// 20260822055451's own header for the reasoning); CASCADE on settings/
// email_templates/sms_templates (organisation-owned configuration).
//
// audit_logs.org_id is DELIBERATELY NOT covered here - explicitly deferred
// (production holds two genuine historical audit rows whose organisations
// were later removed; constraining this column requires a design decision
// on audit-history preservation that hasn't been made yet).
//
// Setup required first: node scripts/seed-test-project.mjs
// Run: npm run test:integration
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { service } from './helpers.mjs';

const RUN_ID = Date.now();
const NONEXISTENT_ORG = `org-fk-hardening-nonexistent-${RUN_ID}`;

describe('sms_queue.org_id / email_queue.org_id: RESTRICT, no other FK entanglement', () => {
  const ORG = `org-fk-hardening-queue-${RUN_ID}`;

  before(async () => {
    const { error } = await service.from('organisations').insert({ id: ORG, name: 'FK Hardening Queue Org', slug: ORG });
    assert.equal(error, null, error?.message);
  });

  after(async () => {
    await service.from('sms_queue').delete().eq('org_id', ORG);
    await service.from('email_queue').delete().eq('org_id', ORG);
    await service.from('organisations').delete().eq('id', ORG);
  });

  test('sms_queue: a valid org_id insert succeeds', async () => {
    const { error } = await service.from('sms_queue').insert({ recipient: '+447700900001', body: 'x', status: 'Pending', org_id: ORG });
    assert.equal(error, null, error?.message);
  });

  test('sms_queue: a nonexistent org_id insert fails with the FK', async () => {
    const { error } = await service.from('sms_queue').insert({ recipient: '+447700900002', body: 'x', status: 'Pending', org_id: NONEXISTENT_ORG });
    assert.ok(error, 'a nonexistent org_id must be rejected');
    assert.equal(error.code, '23503');
    assert.match(error.message, /sms_queue_org_id_fkey/);
  });

  test('email_queue: a valid org_id insert succeeds', async () => {
    const { error } = await service.from('email_queue').insert({ recipient: 'fk-hardening@example.test', subject: 'x', body: 'x', status: 'Pending', org_id: ORG });
    assert.equal(error, null, error?.message);
  });

  test('email_queue: a nonexistent org_id insert fails with the FK', async () => {
    const { error } = await service.from('email_queue').insert({ recipient: 'fk-hardening-bad@example.test', subject: 'x', body: 'x', status: 'Pending', org_id: NONEXISTENT_ORG });
    assert.ok(error, 'a nonexistent org_id must be rejected');
    assert.equal(error.code, '23503');
    assert.match(error.message, /email_queue_org_id_fkey/);
  });

  test('the existing valid sms_queue/email_queue rows remain valid and selectable', async () => {
    const { data: sms, error: smsErr } = await service.from('sms_queue').select('id').eq('org_id', ORG);
    assert.equal(smsErr, null, smsErr?.message);
    assert.equal(sms.length, 1);

    const { data: email, error: emailErr } = await service.from('email_queue').select('id').eq('org_id', ORG);
    assert.equal(emailErr, null, emailErr?.message);
    assert.equal(email.length, 1);
  });

  test('organisation deletion is blocked (RESTRICT) while sms_queue/email_queue rows still reference it', async () => {
    const { error } = await service.from('organisations').delete().eq('id', ORG);
    assert.ok(error, 'deleting an organisation with sms_queue/email_queue rows must be blocked');

    const { data: stillExists } = await service.from('organisations').select('id').eq('id', ORG).maybeSingle();
    assert.ok(stillExists, 'the organisation must still exist after the blocked delete attempt');
  });
});

describe('payments.org_id: RESTRICT', () => {
  const ORG = `org-fk-hardening-pay-${RUN_ID}`;
  const EVENT = `${ORG}-evt`;
  const BOOKING = `FKHARD-PAY-${RUN_ID}`;

  before(async () => {
    const { error: orgErr } = await service.from('organisations').insert({ id: ORG, name: 'FK Hardening Pay Org', slug: ORG });
    assert.equal(orgErr, null, orgErr?.message);
    const { error: evtErr } = await service.from('events').insert({
      id: EVENT, org_id: ORG, name: 'FK Hardening Event', slug: `${ORG}-evt`,
      booking_prefix: `FKP${RUN_ID.toString().slice(-6)}`, status: 'open',
    });
    assert.equal(evtErr, null, evtErr?.message);
    const { error: bErr } = await service.from('bookings').insert({
      id: BOOKING, org_id: ORG, event_id: EVENT, status: 'Confirmed', business_name: 'x', owner_name: 'y',
      email: 'z@example.test', instance_prefix: `${ORG}-`, booking_type: 'general', stall_cost: 10,
    });
    assert.equal(bErr, null, bErr?.message);
  });

  after(async () => {
    await service.from('payments').delete().eq('booking_id', BOOKING);
    await service.from('bookings').delete().eq('id', BOOKING);
    await service.from('events').delete().eq('id', EVENT);
    await service.from('organisations').delete().eq('id', ORG);
  });

  test('a valid org_id insert succeeds', async () => {
    const { error } = await service.from('payments').insert({ booking_id: BOOKING, org_id: ORG, paid: false });
    assert.equal(error, null, error?.message);
  });

  test('a nonexistent org_id insert fails with the FK', async () => {
    // payments' PK is booking_id (one row per booking), so this needs its
    // own second booking rather than reusing BOOKING above.
    const otherBooking = `FKHARD-PAY-BAD-${RUN_ID}`;
    const { error: bErr } = await service.from('bookings').insert({
      id: otherBooking, org_id: ORG, event_id: EVENT, status: 'Confirmed', business_name: 'x', owner_name: 'y',
      email: 'z@example.test', instance_prefix: `${ORG}-`, booking_type: 'general', stall_cost: 10,
    });
    assert.equal(bErr, null, bErr?.message);

    const { error } = await service.from('payments').insert({ booking_id: otherBooking, org_id: NONEXISTENT_ORG, paid: false });
    assert.ok(error, 'a nonexistent org_id must be rejected');
    assert.equal(error.code, '23503');
    assert.match(error.message, /payments_org_id_fkey/);

    await service.from('bookings').delete().eq('id', otherBooking);
  });

  test('the existing valid payment row remains valid and selectable', async () => {
    const { data, error } = await service.from('payments').select('org_id').eq('booking_id', BOOKING).single();
    assert.equal(error, null, error?.message);
    assert.equal(data.org_id, ORG);
  });

  test('organisation deletion is blocked (RESTRICT) while a payment (and its booking/event) still reference it', async () => {
    const { error } = await service.from('organisations').delete().eq('id', ORG);
    assert.ok(error, 'deleting an organisation with a payment referencing it must be blocked');
  });
});

describe('settings.org_id / email_templates.org_id / sms_templates.org_id: CASCADE', () => {
  test('settings: valid insert succeeds, nonexistent org_id fails, organisation deletion cascades', async () => {
    const ORG = `org-fk-hardening-settings-${RUN_ID}`;
    const { error: orgErr } = await service.from('organisations').insert({ id: ORG, name: 'FK Hardening Settings Org', slug: ORG });
    assert.equal(orgErr, null, orgErr?.message);

    const { error: validErr } = await service.from('settings').insert({ org_id: ORG, key: 'fk_hardening_probe', value: 'x' });
    assert.equal(validErr, null, validErr?.message);

    const { error: invalidErr } = await service.from('settings').insert({ org_id: NONEXISTENT_ORG, key: 'fk_hardening_probe', value: 'x' });
    assert.ok(invalidErr, 'a nonexistent org_id must be rejected');
    assert.equal(invalidErr.code, '23503');
    assert.match(invalidErr.message, /settings_org_id_fkey/);

    const { data: beforeDelete } = await service.from('settings').select('key').eq('org_id', ORG);
    assert.equal(beforeDelete.length, 1, 'the valid row must still be present before organisation deletion');

    const { error: deleteErr } = await service.from('organisations').delete().eq('id', ORG);
    assert.equal(deleteErr, null, deleteErr?.message);

    const { data: afterDelete } = await service.from('settings').select('key').eq('org_id', ORG);
    assert.equal(afterDelete.length, 0, 'settings rows must be cascade-deleted along with their organisation');
  });

  test('email_templates: valid insert succeeds, nonexistent org_id fails, organisation deletion cascades', async () => {
    const ORG = `org-fk-hardening-emailtpl-${RUN_ID}`;
    const { error: orgErr } = await service.from('organisations').insert({ id: ORG, name: 'FK Hardening Email Template Org', slug: ORG });
    assert.equal(orgErr, null, orgErr?.message);

    const { error: validErr } = await service.from('email_templates').insert({ org_id: ORG, id: 'fk_hardening_probe', subject: 'x', body_html: 'x' });
    assert.equal(validErr, null, validErr?.message);

    const { error: invalidErr } = await service.from('email_templates').insert({ org_id: NONEXISTENT_ORG, id: 'fk_hardening_probe', subject: 'x', body_html: 'x' });
    assert.ok(invalidErr, 'a nonexistent org_id must be rejected');
    assert.equal(invalidErr.code, '23503');
    assert.match(invalidErr.message, /email_templates_org_id_fkey/);

    const { data: beforeDelete } = await service.from('email_templates').select('id').eq('org_id', ORG);
    assert.equal(beforeDelete.length, 1, 'the valid row must still be present before organisation deletion');

    const { error: deleteErr } = await service.from('organisations').delete().eq('id', ORG);
    assert.equal(deleteErr, null, deleteErr?.message);

    const { data: afterDelete } = await service.from('email_templates').select('id').eq('org_id', ORG);
    assert.equal(afterDelete.length, 0, 'email_templates rows must be cascade-deleted along with their organisation');
  });

  test('sms_templates: valid insert succeeds, nonexistent org_id fails, organisation deletion cascades', async () => {
    const ORG = `org-fk-hardening-smstpl-${RUN_ID}`;
    const { error: orgErr } = await service.from('organisations').insert({ id: ORG, name: 'FK Hardening SMS Template Org', slug: ORG });
    assert.equal(orgErr, null, orgErr?.message);

    const { error: validErr } = await service.from('sms_templates').insert({ org_id: ORG, id: 'fk_hardening_probe', body: 'x' });
    assert.equal(validErr, null, validErr?.message);

    const { error: invalidErr } = await service.from('sms_templates').insert({ org_id: NONEXISTENT_ORG, id: 'fk_hardening_probe', body: 'x' });
    assert.ok(invalidErr, 'a nonexistent org_id must be rejected');
    assert.equal(invalidErr.code, '23503');
    assert.match(invalidErr.message, /sms_templates_org_id_fkey/);

    const { data: beforeDelete } = await service.from('sms_templates').select('id').eq('org_id', ORG);
    assert.equal(beforeDelete.length, 1, 'the valid row must still be present before organisation deletion');

    const { error: deleteErr } = await service.from('organisations').delete().eq('id', ORG);
    assert.equal(deleteErr, null, deleteErr?.message);

    const { data: afterDelete } = await service.from('sms_templates').select('id').eq('org_id', ORG);
    assert.equal(afterDelete.length, 0, 'sms_templates rows must be cascade-deleted along with their organisation');
  });
});
