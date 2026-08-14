// tests/phase4a-public-identity.test.mjs
// Phase 4A — Public Identity & Event Resolution acceptance tests.
//
// Verifies deliverables from Phase 4A:
// 1. validateSlug format/reserved-word/length rules (js/utils.js).
// 2. public_organisations_info / public_events_info anon-readable views
//    (draft exclusion, non-sensitive column allow-list, base-table denial).
// 3. Branding settings keys are anon-readable via the existing settings policy.
//
// Runs against the disposable test Supabase project only (enforced in helpers.mjs).

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '@supabase/supabase-js';
import { service, url, anonKey, ensureFoundationRows } from './helpers.mjs';
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

// ── 3. Branding settings readability ────────────────────────────────────────
describe('anon-readable branding settings', () => {
    const brandingKeys = ['brand_primary_color', 'brand_accent_color', 'logo_url', 'logo_light_url', 'org_support_email', 'email_footer_text'];
    const scratchOrg = `org_4a_brand_${Date.now()}`;

    before(async () => {
        await service.from('organisations').insert({ id: scratchOrg, name: 'Phase 4A Branding Org', slug: scratchOrg.replace(/_/g, '-') });
        await service.from('settings').insert(brandingKeys.map((key) => ({ org_id: scratchOrg, key, value: 'test-value' })));
    });

    after(async () => {
        await service.from('settings').delete().eq('org_id', scratchOrg);
        await service.from('organisations').delete().eq('id', scratchOrg);
    });

    it('anon can read every branding key for an organisation', async () => {
        const { data, error } = await anon
            .from('settings')
            .select('key, value')
            .eq('org_id', scratchOrg)
            .in('key', brandingKeys);
        assert.ifError(error);
        const foundKeys = new Set((data || []).map((r) => r.key));
        for (const key of brandingKeys) {
            assert.ok(foundKeys.has(key), `${key} should be anon-readable`);
        }
    });

    it('anon cannot read an arbitrary non-allow-listed settings key', async () => {
        const sentinelKey = `phase4a_private_${Date.now()}`;
        await service.from('settings').insert({ org_id: scratchOrg, key: sentinelKey, value: 'secret' });

        const { data, error } = await anon
            .from('settings')
            .select('value')
            .eq('org_id', scratchOrg)
            .eq('key', sentinelKey)
            .maybeSingle();
        assert.ifError(error);
        assert.equal(data, null, 'a key outside the anon allow-list should not be readable');

        await service.from('settings').delete().eq('org_id', scratchOrg).eq('key', sentinelKey);
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
