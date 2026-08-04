// tests/phase4b-event-configuration.test.mjs
// Phase 4B.1 — Event Configuration acceptance tests.
//
// js/settings/event-config.js is DOM-coupled like every other js/page-*.js
// module in this repo, so — consistent with phase4c-location-management's
// approach — this file verifies the underlying database/RLS behaviour the
// page depends on: inheritance, override creation/removal, organisation
// isolation, multiple events under one organisation, and the event_settings
// RLS policies. The interactive save/reset/validation flow itself is covered
// by e2e/event-configuration.spec.mjs, which drives the real page.
//
// Runs against the disposable test Supabase project only (enforced in helpers.mjs).

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '@supabase/supabase-js';
import { service, url, anonKey, adminEmail, adminPassword, ensureFoundationRows } from './helpers.mjs';

let admin;

before(async () => {
    await ensureFoundationRows(service);
    admin = createClient(url, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
    const { error } = await admin.auth.signInWithPassword({ email: adminEmail, password: adminPassword });
    if (error) throw new Error(`Admin sign-in failed: ${error.message}`);
});

// Mirrors js/config.js's loadStallCosts() precedence exactly: org row
// applied first, event row applied second (wins). Not imported directly —
// config.js pulls in supabase-public.js, which touches `window` at module
// scope, so it can't load outside a browser/DOM environment (same reasoning
// tests/phase4c-location-management.test.mjs gives for not importing
// js/api.js).
async function resolveEffective(sb, orgId, eventId, key) {
    const { data: orgRow } = await sb.from('settings').select('value').eq('org_id', orgId).eq('key', key).maybeSingle();
    const { data: eventRow } = await sb.from('event_settings').select('value').eq('event_id', eventId).eq('key', key).maybeSingle();
    return eventRow ? eventRow.value : (orgRow ? orgRow.value : undefined);
}

async function makeOrgAndEvent(sb, { orgId, eventId, bookingPrefix }) {
    await sb.from('organisations').insert({ id: orgId, name: `Phase 4B ${orgId}`, slug: orgId.replace(/_/g, '-') });
    await sb.from('events').insert({ id: eventId, org_id: orgId, name: `Phase 4B Event ${eventId}`, slug: eventId.replace(/_/g, '-'), booking_prefix: bookingPrefix, is_active: true });
}

async function cleanupOrgAndEvents(sb, orgId, eventIds) {
    await sb.from('event_settings').delete().in('event_id', eventIds);
    await sb.from('settings').delete().eq('org_id', orgId);
    await sb.from('events').delete().eq('org_id', orgId);
    await sb.from('organisations').delete().eq('id', orgId);
}

// ── 1. Inheritance, override creation, override removal ────────────────────
describe('event configuration inheritance lifecycle', () => {
    const orgId = `org_4b_life_${Date.now()}`;
    const eventId = `event_4b_life_${Date.now()}`;

    before(async () => {
        await makeOrgAndEvent(service, { orgId, eventId, bookingPrefix: `L4B${Date.now().toString().slice(-3)}` });
        await service.from('settings').insert({ org_id: orgId, key: 'stall_cost_general', value: '5.00' });
    });

    after(async () => { await cleanupOrgAndEvents(service, orgId, [eventId]); });

    it('with no event override, the effective value is the organisation default', async () => {
        const value = await resolveEffective(service, orgId, eventId, 'stall_cost_general');
        assert.equal(value, '5.00');
    });

    it('creating an event_settings row overrides the organisation value for that event only', async () => {
        const { error } = await service.from('event_settings').insert({ event_id: eventId, key: 'stall_cost_general', value: '7.50' });
        assert.ifError(error);

        const effective = await resolveEffective(service, orgId, eventId, 'stall_cost_general');
        assert.equal(effective, '7.50', 'the event override should win');

        const { data: orgRow } = await service.from('settings').select('value').eq('org_id', orgId).eq('key', 'stall_cost_general').single();
        assert.equal(orgRow.value, '5.00', 'the organisation default itself must be untouched by the event override');
    });

    it('removing the override (reset) reverts the effective value to the organisation default, not a copy of it', async () => {
        const { error } = await service.from('event_settings').delete().eq('event_id', eventId).eq('key', 'stall_cost_general');
        assert.ifError(error);

        const { data: remaining } = await service.from('event_settings').select('*').eq('event_id', eventId).eq('key', 'stall_cost_general');
        assert.equal(remaining.length, 0, 'reset must delete the row, not leave a copy of the org value behind');

        const effective = await resolveEffective(service, orgId, eventId, 'stall_cost_general');
        assert.equal(effective, '5.00');
    });
});

// ── 2. Organisation isolation ───────────────────────────────────────────────
describe('event configuration organisation isolation', () => {
    const orgA = `org_4b_a_${Date.now()}`;
    const orgB = `org_4b_b_${Date.now()}`;
    const eventA = `event_4b_a_${Date.now()}`;
    const eventB = `event_4b_b_${Date.now()}`;

    before(async () => {
        await makeOrgAndEvent(service, { orgId: orgA, eventId: eventA, bookingPrefix: `A4B${Date.now().toString().slice(-3)}` });
        await makeOrgAndEvent(service, { orgId: orgB, eventId: eventB, bookingPrefix: `B4B${Date.now().toString().slice(-3)}` });
        await service.from('settings').insert([
            { org_id: orgA, key: 'stall_cost_food', value: '3.00' },
            { org_id: orgB, key: 'stall_cost_food', value: '3.00' },
        ]);
        await service.from('event_settings').insert([
            { event_id: eventA, key: 'stall_cost_food', value: '4.50' },
            { event_id: eventB, key: 'stall_cost_food', value: '9.00' },
        ]);
    });

    after(async () => {
        await cleanupOrgAndEvents(service, orgA, [eventA]);
        await cleanupOrgAndEvents(service, orgB, [eventB]);
    });

    it('each organisation\'s event resolves its own override, unaffected by the other organisation', async () => {
        const effectiveA = await resolveEffective(service, orgA, eventA, 'stall_cost_food');
        const effectiveB = await resolveEffective(service, orgB, eventB, 'stall_cost_food');
        assert.equal(effectiveA, '4.50');
        assert.equal(effectiveB, '9.00');
    });

    it('both organisations\' unrelated defaults remain identical and unchanged', async () => {
        const { data: rows } = await service.from('settings').select('org_id, value').eq('key', 'stall_cost_food').in('org_id', [orgA, orgB]);
        const byOrg = Object.fromEntries(rows.map(r => [r.org_id, r.value]));
        assert.equal(byOrg[orgA], '3.00');
        assert.equal(byOrg[orgB], '3.00');
    });
});

// ── 3. Multiple events under the same organisation ─────────────────────────
describe('event configuration across multiple events in one organisation', () => {
    const orgId = `org_4b_multi_${Date.now()}`;
    const eventX = `event_4b_x_${Date.now()}`;
    const eventY = `event_4b_y_${Date.now()}`;

    before(async () => {
        await service.from('organisations').insert({ id: orgId, name: 'Phase 4B Multi-Event Org', slug: orgId.replace(/_/g, '-') });
        await service.from('events').insert([
            { id: eventX, org_id: orgId, name: 'Event X', slug: eventX.replace(/_/g, '-'), booking_prefix: `X4B${Date.now().toString().slice(-3)}`, is_active: true },
            { id: eventY, org_id: orgId, name: 'Event Y', slug: eventY.replace(/_/g, '-'), booking_prefix: `Y4B${Date.now().toString().slice(-3)}`, is_active: true },
        ]);
        await service.from('settings').insert({ org_id: orgId, key: 'festival_display_name', value: 'Org Festival' });
        await service.from('event_settings').insert({ event_id: eventX, key: 'festival_display_name', value: 'Festival X' });
        // Event Y deliberately gets no override — it must keep inheriting.
    });

    after(async () => { await cleanupOrgAndEvents(service, orgId, [eventX, eventY]); });

    it('Event X uses its own override', async () => {
        assert.equal(await resolveEffective(service, orgId, eventX, 'festival_display_name'), 'Festival X');
    });

    it('Event Y, with no override of its own, still inherits the organisation default', async () => {
        assert.equal(await resolveEffective(service, orgId, eventY, 'festival_display_name'), 'Org Festival');
    });

    it('the organisation default is unchanged by Event X\'s override', async () => {
        const { data } = await service.from('settings').select('value').eq('org_id', orgId).eq('key', 'festival_display_name').single();
        assert.equal(data.value, 'Org Festival');
    });
});

// ── 4. RLS ───────────────────────────────────────────────────────────────────
describe('event_settings RLS', () => {
    const eventId = `event_4b_rls_${Date.now()}`;

    it('an authenticated admin can insert, update, and delete an event_settings row', async () => {
        const { error: insertErr } = await admin.from('event_settings').insert({ event_id: eventId, key: 'stall_cost_dev', value: '1.00' });
        assert.ifError(insertErr, 'admin insert should succeed');

        const { error: updateErr } = await admin.from('event_settings').update({ value: '2.00' }).eq('event_id', eventId).eq('key', 'stall_cost_dev');
        assert.ifError(updateErr, 'admin update should succeed');

        const { data: fetched, error: fetchErr } = await admin.from('event_settings').select('value').eq('event_id', eventId).eq('key', 'stall_cost_dev').single();
        assert.ifError(fetchErr);
        assert.equal(fetched.value, '2.00');

        const { error: deleteErr } = await admin.from('event_settings').delete().eq('event_id', eventId).eq('key', 'stall_cost_dev');
        assert.ifError(deleteErr, 'admin delete should succeed');
    });

    it('an anonymous caller cannot write to event_settings', async () => {
        const anon = createClient(url, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
        const { error } = await anon.from('event_settings').insert({ event_id: eventId, key: 'stall_cost_general', value: '1.00' });
        assert.ok(error, 'anon insert should be rejected by RLS');
    });

    describe('anon read allow-list', () => {
        before(async () => {
            await service.from('event_settings').insert([
                { event_id: eventId, key: 'stall_cost_general', value: '6.00' },       // allow-listed
                { event_id: eventId, key: 'festival_display_name', value: 'Secret' },  // NOT allow-listed
            ]);
        });
        after(async () => {
            await service.from('event_settings').delete().eq('event_id', eventId).in('key', ['stall_cost_general', 'festival_display_name']);
        });

        it('an anonymous caller can read an allow-listed key', async () => {
            const anon = createClient(url, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
            const { data, error } = await anon.from('event_settings').select('value').eq('event_id', eventId).eq('key', 'stall_cost_general');
            assert.ifError(error);
            assert.equal(data.length, 1);
            assert.equal(data[0].value, '6.00');
        });

        it('an anonymous caller cannot read a non-allow-listed key, even though the row exists', async () => {
            const anon = createClient(url, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
            const { data, error } = await anon.from('event_settings').select('value').eq('event_id', eventId).eq('key', 'festival_display_name');
            assert.ifError(error);
            assert.equal(data.length, 0, 'RLS should filter this row out silently, not error');
        });
    });
});
