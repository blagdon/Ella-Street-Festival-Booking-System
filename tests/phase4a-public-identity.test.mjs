// tests/phase4a-public-identity.test.mjs
// Phase 4A — Public Identity & Event Resolution acceptance tests.
//
// Verifies deliverables from Phase 4A:
// 1. validateSlug format/reserved-word/length rules (js/utils.js).
// 2. public_organisations_info / public_events_info anon-readable views
//    (draft exclusion, non-sensitive column allow-list, base-table denial).
// 3. Public settings are anon-readable ONLY through rpc_get_public_settings/
//    rpc_get_public_event_settings (Phase 3 WP2, 20260815220000) — the
//    direct-table anon policies these replaced are gone; section 3 below
//    proves both that the RPC path works AND that the base tables are no
//    longer directly readable by anon at all.
//
// Runs against the disposable test Supabase project only (enforced in helpers.mjs).

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '@supabase/supabase-js';
import { service, url, anonKey, adminEmail, adminPassword, ensureFoundationRows } from './helpers.mjs';
import { validateSlug, RESERVED_SLUGS } from '../js/utils.js';

let anon;

before(async () => {
    await ensureFoundationRows(service);
    anon = createClient(url, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
});

// ── 1. validateSlug ──────────────────────────────────────────────────────────
describe('validateSlug', () => {
    it('accepts a well-formed lowercase hyphenated slug', () => {
        assert.equal(validateSlug('hull-summer-fest'), 'hull-summer-fest');
    });

    it('trims and lowercases before validating', () => {
        assert.equal(validateSlug('  Hull-Fest  '), 'hull-fest');
    });

    it('rejects an empty or missing value', () => {
        assert.throws(() => validateSlug(''), /required/i);
        assert.throws(() => validateSlug(undefined), /required/i);
    });

    it('rejects spaces and other invalid characters', () => {
        assert.throws(() => validateSlug('invalid slug with spaces!!'), /can only contain/i);
    });

    it('rejects leading, trailing, or doubled hyphens', () => {
        assert.throws(() => validateSlug('-leading'), /can only contain/i);
        assert.throws(() => validateSlug('trailing-'), /can only contain/i);
        assert.throws(() => validateSlug('double--hyphen'), /can only contain/i);
    });

    it('rejects a value over 63 characters', () => {
        assert.throws(() => validateSlug('a'.repeat(64)), /63 characters or fewer/);
    });

    it('rejects every reserved slug', () => {
        for (const reserved of RESERVED_SLUGS) {
            assert.throws(() => validateSlug(reserved), /reserved word/i, `'${reserved}' should be rejected`);
        }
    });

    it('uses grammatically correct article in the reserved-word message regardless of label casing', () => {
        assert.throws(() => validateSlug('admin', 'Event slug'), /as an event slug/);
        assert.throws(() => validateSlug('admin', 'Organisation slug'), /as an organisation slug/);
        assert.throws(() => validateSlug('admin', 'Slug'), /as a slug/);
    });
});

// ── 2. public_organisations_info / public_events_info ──────────────────────
describe('public identity views', () => {
    it('anon can resolve org_default via public_organisations_info', async () => {
        const { data, error } = await anon
            .from('public_organisations_info')
            .select('id, slug, name, website')
            .eq('slug', 'ella-street')
            .maybeSingle();
        assert.ifError(error);
        assert.ok(data, 'org_default should be resolvable by its slug');
        assert.equal(data.id, 'org_default');
    });

    it('public_organisations_info does not expose contact_email', async () => {
        const { data, error } = await anon
            .from('public_organisations_info')
            .select('*')
            .eq('slug', 'ella-street')
            .maybeSingle();
        assert.ifError(error);
        assert.ok(data);
        assert.equal(data.contact_email, undefined, 'contact_email must not be exposed via the public view');
    });

    it('anon cannot read the base organisations table directly', async () => {
        const { data, error } = await anon.from('organisations').select('id').eq('id', 'org_default').maybeSingle();
        assert.ok(error || data === null, 'base organisations table should stay unreadable to anon');
    });

    it('anon can resolve a non-draft event via public_events_info', async () => {
        const eventId = `evt_4a_pub_${Date.now()}`;
        const slug = `evt-4a-pub-${Date.now()}`;
        const { error: insErr } = await service.from('events').insert({
            id: eventId,
            org_id: 'org_default',
            name: 'Phase 4A Public Event',
            slug,
            booking_prefix: `P4A${Date.now().toString().slice(-4)}`,
            // is_active omitted (Multi-Event Phase 2: unique per org, and
            // org_default already has one) - never read by this test.
            status: 'open'
        });
        assert.ifError(insErr);

        const { data, error } = await anon
            .from('public_events_info')
            .select('id, org_id, slug, name, status, booking_prefix, is_active')
            .eq('slug', slug)
            .maybeSingle();
        assert.ifError(error);
        assert.ok(data, 'a non-draft event should be resolvable by slug');
        assert.equal(data.id, eventId);
        assert.equal(data.status, 'open');

        await service.from('events').delete().eq('id', eventId);
    });

    it('draft events are excluded from public_events_info', async () => {
        const eventId = `evt_4a_draft_${Date.now()}`;
        const slug = `evt-4a-draft-${Date.now()}`;
        const { error: insErr } = await service.from('events').insert({
            id: eventId,
            org_id: 'org_default',
            name: 'Phase 4A Draft Event',
            slug,
            booking_prefix: `P4D${Date.now().toString().slice(-4)}`,
            // is_active omitted (Multi-Event Phase 2: unique per org, and
            // org_default already has one) - never read by this test.
            status: 'draft'
        });
        assert.ifError(insErr);

        const { data, error } = await anon
            .from('public_events_info')
            .select('id')
            .eq('slug', slug)
            .maybeSingle();
        assert.ifError(error);
        assert.equal(data, null, 'a draft event should not be resolvable by an anonymous caller');

        await service.from('events').delete().eq('id', eventId);
    });

    it('anon cannot read the base events table directly', async () => {
        const { data, error } = await anon.from('events').select('id').eq('id', 'event_default').maybeSingle();
        assert.ok(error || data === null, 'base events table should stay unreadable to anon');
    });
});

// ── 3. Public settings RPCs (Phase 3 WP2, 20260815220000) ──────────────────
// rpc_get_public_settings(p_org_id) / rpc_get_public_event_settings(p_event_id)
// replace anon's former direct SELECT on settings/event_settings. A single
// call can never span more than one org/event (the id is a required
// function parameter, not a client-supplied query filter), which is the
// property a plain RLS predicate could not provide (see the migration's own
// header comment for why).
describe('rpc_get_public_settings / rpc_get_public_event_settings', () => {
    const brandingKeys = ['brand_primary_color', 'brand_accent_color', 'logo_url', 'logo_light_url', 'org_support_email', 'email_footer_text'];
    const RUN_ID = Date.now();
    const orgA = `org_wp2_a_${RUN_ID}`;
    const orgB = `org_wp2_b_${RUN_ID}`;
    const eventA = `${orgA}-evt`;
    const eventB = `${orgB}-evt`;
    const sentinelKey = `phase3_wp2_private_${RUN_ID}`;

    before(async () => {
        await service.from('organisations').insert([
            { id: orgA, name: 'WP2 Org A', slug: orgA.replace(/_/g, '-') },
            { id: orgB, name: 'WP2 Org B', slug: orgB.replace(/_/g, '-') },
        ]);
        await service.from('events').insert([
            { id: eventA, org_id: orgA, name: 'WP2 Event A', slug: 'wp2-evt-a', booking_prefix: `WP2A${RUN_ID.toString().slice(-4)}`, status: 'open' },
            { id: eventB, org_id: orgB, name: 'WP2 Event B', slug: 'wp2-evt-b', booking_prefix: `WP2B${RUN_ID.toString().slice(-4)}`, status: 'open' },
        ]);
        await service.from('settings').insert([
            ...brandingKeys.map((key) => ({ org_id: orgA, key, value: `org-a-${key}` })),
            ...brandingKeys.map((key) => ({ org_id: orgB, key, value: `org-b-${key}` })),
            { org_id: orgA, key: sentinelKey, value: 'secret-org-a' },
        ]);
        await service.from('event_settings').insert([
            { event_id: eventA, key: 'brand_primary_color', value: 'event-a-override' },
            { event_id: eventB, key: 'brand_primary_color', value: 'event-b-override' },
        ]);
    });

    after(async () => {
        await service.from('event_settings').delete().in('event_id', [eventA, eventB]);
        await service.from('settings').delete().in('org_id', [orgA, orgB]);
        await service.from('events').delete().in('id', [eventA, eventB]);
        await service.from('organisations').delete().in('id', [orgA, orgB]);
    });

    // A. Legitimate public access succeeds.
    it('rpc_get_public_settings returns every branding key for the requested org', async () => {
        const { data, error } = await anon.rpc('rpc_get_public_settings', { p_org_id: orgA });
        assert.ifError(error);
        const found = new Map((data || []).map((r) => [r.key, r.value]));
        for (const key of brandingKeys) {
            assert.equal(found.get(key), `org-a-${key}`, `${key} should be readable and correctly-valued for org A`);
        }
    });

    // B. Anonymous direct SELECT against settings is no longer possible —
    // reproduces the OLD attack shape and proves it no longer works.
    it('anon can no longer SELECT the settings table directly (old attack shape)', async () => {
        const { data, error } = await anon.from('settings').select('org_id, key, value').in('key', brandingKeys);
        // Either an outright RLS/permission error, or (PostgREST's usual
        // behaviour for "no matching policy") a successful empty result —
        // either is an acceptable proof, but zero rows is the one that
        // actually matters: no cross-org enumeration must be possible.
        assert.ok(error || (data || []).length === 0,
            'anon must not be able to read any settings rows via a direct table SELECT any more');
    });

    // C. Same for event_settings.
    it('anon can no longer SELECT the event_settings table directly (old attack shape)', async () => {
        const { data, error } = await anon.from('event_settings').select('event_id, key, value').in('key', brandingKeys);
        assert.ok(error || (data || []).length === 0,
            'anon must not be able to read any event_settings rows via a direct table SELECT any more');
    });

    // D. rpc_get_public_settings(org_A) cannot return org_B's settings.
    it('rpc_get_public_settings(org A) never returns org B\'s rows', async () => {
        const { data, error } = await anon.rpc('rpc_get_public_settings', { p_org_id: orgA });
        assert.ifError(error);
        const values = (data || []).map((r) => r.value);
        for (const key of brandingKeys) {
            assert.ok(!values.includes(`org-b-${key}`), `org A's call must never contain org B's value for ${key}`);
        }
    });

    // E. rpc_get_public_event_settings(event_A) cannot return event_B's settings.
    it('rpc_get_public_event_settings(event A) never returns event B\'s rows', async () => {
        const { data, error } = await anon.rpc('rpc_get_public_event_settings', { p_event_id: eventA });
        assert.ifError(error);
        const row = (data || []).find((r) => r.key === 'brand_primary_color');
        assert.equal(row?.value, 'event-a-override');
        assert.ok((data || []).every((r) => r.value !== 'event-b-override'), 'event A\'s call must never contain event B\'s override value');
    });

    // F. Non-allow-listed/private settings remain inaccessible through the RPCs.
    it('a key outside the anon allow-list is never returned by rpc_get_public_settings', async () => {
        const { data, error } = await anon.rpc('rpc_get_public_settings', { p_org_id: orgA });
        assert.ifError(error);
        assert.ok(!(data || []).some((r) => r.key === sentinelKey), 'a non-allow-listed key must never be returned');
    });

    // G. Legacy no-slug org_default behaviour still works.
    it('rpc_get_public_settings(org_default) still resolves the legacy default organisation', async () => {
        const { data, error } = await anon.rpc('rpc_get_public_settings', { p_org_id: 'org_default' });
        assert.ifError(error);
        assert.ok(Array.isArray(data), 'org_default must still resolve via the RPC exactly like any other organisation');
    });

    // I. Authenticated admin settings access is unaffected (untouched policies).
    it('an authenticated admin can still read settings directly (admin policies untouched)', async () => {
        const admin = createClient(url, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
        const { error: signInErr } = await admin.auth.signInWithPassword({ email: adminEmail, password: adminPassword });
        assert.equal(signInErr, null, signInErr?.message);
        const { data, error } = await admin.from('settings').select('key, value').eq('org_id', 'org_default').limit(1);
        assert.ifError(error);
        assert.ok(Array.isArray(data), 'an authenticated admin must still be able to read settings directly');
    });
});

// ── 4. resolvePublicContext / readSlugsFromLocation ─────────────────────────
describe('public-context module', () => {
    it('readSlugsFromLocation parses two path segments', async () => {
        const { readSlugsFromLocation } = await import('../js/public-context.js');
        const result = readSlugsFromLocation({ pathname: '/hull-summer/2026-edition', search: '' });
        assert.equal(result.orgSlug, 'hull-summer');
        assert.equal(result.eventSlug, '2026-edition');
    });

    it('readSlugsFromLocation falls back to query params when no path segments', async () => {
        const { readSlugsFromLocation } = await import('../js/public-context.js');
        const result = readSlugsFromLocation({ pathname: '/', search: '?org=hull-summer&event=2026-edition' });
        assert.equal(result.orgSlug, 'hull-summer');
        assert.equal(result.eventSlug, '2026-edition');
    });
});
