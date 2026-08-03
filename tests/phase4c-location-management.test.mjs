// tests/phase4c-location-management.test.mjs
// Phase 4C — Location Management acceptance tests.
//
// js/page-admin-locations.js itself is DOM-coupled (document.getElementById,
// window.confirm, Blob/URL for CSV export) like every other js/page-*.js
// module in this repo, so — consistent with how the rest of tests/*.test.mjs
// verifies DB/RLS/grant behaviour rather than importing page-*.js modules —
// this file verifies the underlying database behaviour Phase 4C depends on:
// 1. the restored authenticated write grant (previously SELECT-only, a real
//    403 discovered live while building the admin UI),
// 2. org_id/event_id scoping of the locations query (the same shape used by
//    both page-admin-locations.js and fetchLocationData in js/api.js),
// 3. the dataset-wide (not org-scoped) uniqueness that makes cross-tenant id
//    collisions real, and the resolveAvailableId auto-rename algorithm that
//    guards against them.
//
// Runs against the disposable test Supabase project only (enforced in helpers.mjs).

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '@supabase/supabase-js';
import { service, url, anonKey, adminEmail, adminPassword, ensureFoundationRows } from './helpers.mjs';

// js/api.js's fetchLocationData isn't imported directly: getSupabaseClient()
// (js/supabase.js) falls through to `window.supabase` when no bundler global
// is present, which throws outside a browser/DOM environment (confirmed —
// none of the existing tests/*.test.mjs files import any js/page-*.js or
// js/api.js module for the same reason). This replicates its locations
// query verbatim (js/api.js:678) against the real DB instead, which is what
// actually needs verifying here: the org_id/event_id scoping added by
// Phase 4C, not the wrapper function itself.
async function fetchLocationsLikeApi(sb, orgId, eventId, dataset) {
    const { data, error } = await sb.from('locations').select('*').eq('org_id', orgId).eq('event_id', eventId).eq('dataset', dataset).limit(2000);
    if (error) throw error;
    return (data || []).map((l) => ({ ...l, id: String(l.id) }));
}

let admin;

before(async () => {
    await ensureFoundationRows(service);
    admin = createClient(url, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
    const { error } = await admin.auth.signInWithPassword({ email: adminEmail, password: adminPassword });
    if (error) throw new Error(`Admin sign-in failed: ${error.message}`);
});

// Mirrors js/page-admin-locations.js's resolveAvailableId() exactly, since
// that function is private (unexported) — this proves the algorithm's
// *behaviour* against the real DB rather than testing an internal detail.
async function resolveAvailableId(sb, dataset, candidateId) {
    let id = candidateId;
    let suffix = 2;
    for (let attempts = 0; attempts < 50; attempts++) {
        const { data, error } = await sb.from('locations').select('id').eq('id', id).eq('dataset', dataset).maybeSingle();
        if (error) throw error;
        if (!data) return { id, renamed: id !== candidateId };
        id = `${candidateId}-${suffix}`;
        suffix += 1;
    }
    throw new Error(`Could not find an available id for '${candidateId}' after 50 attempts.`);
}

// ── 1. authenticated write grant ────────────────────────────────────────────
describe('locations write grant', () => {
    it('an authenticated admin can insert, update, and delete a location', async () => {
        const id = `PH4C-${Date.now()}`;
        const { error: insertErr } = await admin.from('locations').insert({
            id, dataset: 'LIVE', lat: 53.7457, lng: -0.3367, has_power: false,
            org_id: 'org_default', event_id: 'event_default'
        });
        assert.ifError(insertErr, 'admin insert should succeed now that the write grant is restored');

        const { error: updateErr } = await admin.from('locations').update({ has_power: true }).eq('id', id).eq('dataset', 'LIVE');
        assert.ifError(updateErr, 'admin update should succeed');

        const { data: fetched, error: fetchErr } = await admin.from('locations').select('has_power').eq('id', id).eq('dataset', 'LIVE').single();
        assert.ifError(fetchErr);
        assert.equal(fetched.has_power, true);

        const { error: deleteErr } = await admin.from('locations').delete().eq('id', id).eq('dataset', 'LIVE');
        assert.ifError(deleteErr, 'admin delete should succeed');
    });

    it('an anonymous caller cannot write to locations (RLS still gates writes)', async () => {
        const id = `PH4C-ANON-${Date.now()}`;
        const anon = createClient(url, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
        const { error } = await anon.from('locations').insert({
            id, dataset: 'LIVE', org_id: 'org_default', event_id: 'event_default'
        });
        assert.ok(error, 'anon insert should be rejected by RLS despite the table-level grant existing for authenticated only');
    });
});

// ── 2. org_id/event_id scoping ───────────────────────────────────────────────
describe('locations org/event scoping', () => {
    const orgA = `org_4c_a_${Date.now()}`;
    const orgB = `org_4c_b_${Date.now()}`;
    const eventA = `event_4c_a_${Date.now()}`;
    const eventB = `event_4c_b_${Date.now()}`;

    before(async () => {
        await service.from('organisations').insert([
            { id: orgA, name: 'Phase 4C Org A', slug: orgA.replace(/_/g, '-') },
            { id: orgB, name: 'Phase 4C Org B', slug: orgB.replace(/_/g, '-') }
        ]);
        await service.from('events').insert([
            { id: eventA, org_id: orgA, name: 'Event A', slug: eventA.replace(/_/g, '-'), booking_prefix: `A4C${Date.now().toString().slice(-3)}`, is_active: true },
            { id: eventB, org_id: orgB, name: 'Event B', slug: eventB.replace(/_/g, '-'), booking_prefix: `B4C${Date.now().toString().slice(-3)}`, is_active: true }
        ]);
        // Distinct ids per org here deliberately — (id, dataset) is the whole
        // primary key (no org_id in it), so two orgs can never each hold a
        // 'SHARED1' row at once; that exact limitation is what the next
        // describe block (resolveAvailableId) exists to work around.
        await service.from('locations').insert([
            { id: 'ONLY-A', dataset: 'LIVE', org_id: orgA, event_id: eventA },
            { id: 'ONLY-B', dataset: 'LIVE', org_id: orgB, event_id: eventB }
        ]);
    });

    after(async () => {
        // Fixed ids (not timestamped), unlike orgA/orgB/eventA/eventB — must
        // be cleaned up or every subsequent run collides with this run's rows
        // (confirmed live: exactly this happened once during this session).
        await service.from('locations').delete().in('id', ['ONLY-A', 'ONLY-B']).eq('dataset', 'LIVE');
        await service.from('events').delete().in('id', [eventA, eventB]);
        await service.from('organisations').delete().in('id', [orgA, orgB]);
    });

    it('the api.js locations query only returns locations for the requested org+event', async () => {
        const locsA = await fetchLocationsLikeApi(service, orgA, eventA, 'LIVE');
        const idsA = locsA.map((l) => l.id);
        assert.ok(idsA.includes('ONLY-A'), 'org A should see its own ONLY-A row');
        assert.ok(!idsA.includes('ONLY-B'), 'org A must not see org B\'s ONLY-B location');

        const locsB = await fetchLocationsLikeApi(service, orgB, eventB, 'LIVE');
        const idsB = locsB.map((l) => l.id);
        assert.ok(idsB.includes('ONLY-B'), 'org B should see its own ONLY-B row');
        assert.ok(!idsB.includes('ONLY-A'), 'org B must not see org A\'s ONLY-A location');
    });

    it('the composite (id, dataset) primary key has no org_id component, so the same id cannot belong to two organisations at once', async () => {
        const { error } = await service.from('locations').insert({ id: 'ONLY-A', dataset: 'LIVE', org_id: orgB, event_id: eventB });
        assert.ok(error, 'a second organisation should be unable to claim an id already used by another organisation in the same dataset');
        assert.equal(error.code, '23505');
    });
});

// ── 3. dataset-wide collision detection & auto-rename ───────────────────────
describe('resolveAvailableId dataset-wide collision handling', () => {
    const orgX = `org_4c_x_${Date.now()}`;
    const orgY = `org_4c_y_${Date.now()}`;

    before(async () => {
        await service.from('organisations').insert([
            { id: orgX, name: 'Phase 4C Org X', slug: orgX.replace(/_/g, '-') },
            { id: orgY, name: 'Phase 4C Org Y', slug: orgY.replace(/_/g, '-') }
        ]);
        await service.from('locations').insert({ id: 'P1', dataset: 'LIVE', org_id: orgX, event_id: 'event_default' });
    });

    after(async () => {
        // 'P1' is a fixed id shared with the real docstring example in
        // page-admin-locations.js — must not be left behind, same reasoning
        // as the org/event scoping block above.
        await service.from('locations').delete().eq('id', 'P1').eq('dataset', 'LIVE');
        await service.from('organisations').delete().in('id', [orgX, orgY]);
    });

    it('a direct insert of the same (id, dataset) from a different organisation is rejected by the PK constraint', async () => {
        const { error } = await service.from('locations').insert({ id: 'P1', dataset: 'LIVE', org_id: orgY, event_id: 'event_default' });
        assert.ok(error, 'inserting a colliding id in the same dataset should fail even across organisations');
        assert.equal(error.code, '23505');
    });

    it('resolveAvailableId finds a free suffixed id when the base id is already taken dataset-wide', async () => {
        const { id, renamed } = await resolveAvailableId(service, 'LIVE', 'P1');
        assert.equal(renamed, true);
        assert.equal(id, 'P1-2');
    });

    it('resolveAvailableId returns the original id unchanged when there is no collision', async () => {
        const candidate = `P1-UNIQUE-${Date.now()}`;
        const { id, renamed } = await resolveAvailableId(service, 'LIVE', candidate);
        assert.equal(renamed, false);
        assert.equal(id, candidate);
    });

    it('resolveAvailableId skips multiple already-taken suffixes in sequence', async () => {
        await service.from('locations').insert([
            { id: 'P2', dataset: 'LIVE', org_id: orgX, event_id: 'event_default' },
            { id: 'P2-2', dataset: 'LIVE', org_id: orgY, event_id: 'event_default' }
        ]);
        const { id, renamed } = await resolveAvailableId(service, 'LIVE', 'P2');
        assert.equal(renamed, true);
        assert.equal(id, 'P2-3');
        await service.from('locations').delete().eq('dataset', 'LIVE').in('id', ['P2', 'P2-2']);
    });
});
