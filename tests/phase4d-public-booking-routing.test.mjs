// tests/phase4d-public-booking-routing.test.mjs
// Phase 4D — Public Booking Routing acceptance tests.
//
// Covers submit-booking's server-side org/event resolution from a trusted
// slug pair (never from client-supplied org_id/event_id — sanitizeBookingInput
// never even reads those off the request body), the event lifecycle guard
// now that it's unconditional instead of the dead code it was before, the
// legacy org_default/event_default fallback when no slug is given, and that
// downstream sends (email/sms templates) resolve against the RIGHT
// organisation once a booking carries a real org_id. cancel-booking/
// stripe-webhook/create-checkout-session's own org_id threading is covered
// indirectly by the full regression suite continuing to pass (they already
// have their own describe blocks in other files); this file is the one place
// that exercises submit-booking's actual resolution logic end to end.
//
// Runs against the disposable test Supabase project only (enforced in helpers.mjs).

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { service, callEdgeFunction, ensureFoundationRows } from './helpers.mjs';

// Cloudflare's official always-passes Turnstile test token — see
// tests/integration.test.mjs's own comment for why this is the sanctioned
// way to test Turnstile-gated flows, not a bypass.
const TURNSTILE_TEST_TOKEN = 'XXXX.DUMMY.TOKEN.XXXX';

function submitPayload(instancePrefix, idSuffix, top = {}) {
    return {
        token: TURNSTILE_TEST_TOKEN,
        bookingData: {
            instance_prefix: instancePrefix,
            stall_type: instancePrefix.includes('FOOD') && !instancePrefix.includes('NONFOOD') ? 'Food' : 'Non-Food',
            business_name: `Phase 4D Test ${idSuffix}`,
            owner_name: `Owner ${idSuffix}`,
            email: `phase4d-${idSuffix}@example.test`,
            phone: '07000000000',
            address: '1 Test Street',
            description: 'Phase 4D routing test booking',
            category: 'Test',
        },
        ...top,
    };
}

const createdBookingIds = [];

before(async () => {
    await ensureFoundationRows(service);
});

after(async () => {
    if (createdBookingIds.length) {
        await service.from('bookings').delete().in('id', createdBookingIds);
    }
});

describe('submit-booking resolves org/event from a trusted slug pair', () => {
    const orgId = `org_4d_${Date.now()}`;
    const eventId = `event_4d_${Date.now()}`;
    const draftEventId = `event_4d_draft_${Date.now()}`;
    const orgSlug = `org-4d-${Date.now()}`;
    const eventSlug = `event-4d-${Date.now()}`;
    const draftEventSlug = `event-4d-draft-${Date.now()}`;
    const bookingPrefix = `D4D${Date.now().toString().slice(-3)}`;
    const draftBookingPrefix = `D4E${Date.now().toString().slice(-3)}`;

    before(async () => {
        await service.from('organisations').insert({ id: orgId, name: 'Phase 4D Org', slug: orgSlug });
        // is_active is now unique per org (Multi-Event Phase 2) - only
        // eventId keeps it; draftEventId doesn't need it for anything this
        // describe block actually tests (slug resolution and status
        // rejection, never is_active).
        const { error: eventsErr } = await service.from('events').insert([
            { id: eventId, org_id: orgId, name: 'Phase 4D Event', slug: eventSlug, booking_prefix: bookingPrefix, is_active: true, status: 'open' },
            { id: draftEventId, org_id: orgId, name: 'Phase 4D Draft Event', slug: draftEventSlug, booking_prefix: draftBookingPrefix, is_active: false, status: 'draft' },
        ]);
        assert.ifError(eventsErr);
    });

    after(async () => {
        await service.from('events').delete().in('id', [eventId, draftEventId]);
        await service.from('organisations').delete().eq('id', orgId);
    });

    it('persists the resolved org_id/event_id (not org_default/event_default), validated against the event\'s own booking_prefix', async () => {
        const { status, json } = await callEdgeFunction('submit-booking', submitPayload(`${bookingPrefix}-FOOD-`, 'A', { orgSlug, eventSlug }));
        assert.equal(status, 200, JSON.stringify(json));
        const booking = json.data[0];
        createdBookingIds.push(booking.id);

        assert.equal(booking.org_id, orgId);
        assert.equal(booking.event_id, eventId);
        assert.ok(booking.id.startsWith(`${bookingPrefix}-FOOD-`), `booking id ${booking.id} should use the event's own booking_prefix`);
    });

    it('rejects a valid slug pair whose resolved event is not open, with a friendly message naming the status', async () => {
        const { status, json } = await callEdgeFunction('submit-booking', submitPayload(`${draftBookingPrefix}-FOOD-`, 'B', { orgSlug, eventSlug: draftEventSlug }));
        assert.notEqual(status, 200);
        assert.match(json.error, /DRAFT/i);
        assert.match(json.error, /closed for public submissions/i);
    });

    it('rejects a slug pair that does not resolve to a real organisation/event, without leaking which part failed to an attacker beyond "not found"', async () => {
        const { status, json } = await callEdgeFunction('submit-booking', submitPayload('ESF26-FOOD-', 'C', { orgSlug: 'no-such-org-xyz', eventSlug: 'no-such-event-xyz' }));
        assert.notEqual(status, 200);
        assert.match(json.error, /no longer valid/i);
    });

    it('client-supplied org_id/event_id in bookingData are ignored entirely — only the resolved slug context is ever used', async () => {
        const payload = submitPayload(`${bookingPrefix}-FOOD-`, 'D', { orgSlug, eventSlug });
        // Attempt to smuggle a different tenant in directly - sanitizeBookingInput
        // never reads these off bookingData, so this must have zero effect.
        payload.bookingData.org_id = 'org_default';
        payload.bookingData.event_id = 'event_default';

        const { status, json } = await callEdgeFunction('submit-booking', payload);
        assert.equal(status, 200, JSON.stringify(json));
        const booking = json.data[0];
        createdBookingIds.push(booking.id);

        assert.equal(booking.org_id, orgId, 'the resolved org from the slug must win, not the smuggled bookingData.org_id');
        assert.equal(booking.event_id, eventId);
    });

    it('falls back to org_default\'s is_default event when no slug is given at all', async () => {
        // Multi-Event Phase 2: resolves via events.is_default now, not a
        // hardcoded event_default literal - ensureFoundationRows() sets
        // event_default as org_default's is_default event, so the outcome
        // is unchanged for this specific org, but via the new mechanism.
        // This is also the backwards-compatibility case the migration's
        // own data-driven promotion UPDATE exists for (see
        // e5-multi-event-phase1.test.mjs section 24): in production, this
        // exact outcome (event_default remaining org_default's default)
        // comes from that UPDATE, not from a test-only fixture helper -
        // js/public-context.js's own comment documents this no-slug path
        // as "the legacy single-tenant case every booking form supported
        // before Phase 4D", a genuinely live entry point this test proves
        // keeps working.
        const { status, json } = await callEdgeFunction('submit-booking', submitPayload('ESF26-FOOD-', 'E'));
        assert.equal(status, 200, JSON.stringify(json));
        const booking = json.data[0];
        createdBookingIds.push(booking.id);

        assert.equal(booking.org_id, 'org_default');
        assert.equal(booking.event_id, 'event_default');
    });
});

describe('submit-booking independent org/event resolution (Multi-Event Phase 2)', () => {
    const orgId = `org_4d_p2_${Date.now()}`;
    const orgSlug = `org-4d-p2-${Date.now()}`;
    const openEventId = `event_4d_p2_open_${Date.now()}`;
    const openEventSlug = `event-4d-p2-open-${Date.now()}`;
    const closedDefaultOrgId = `org_4d_p2_closed_${Date.now()}`;
    const closedDefaultOrgSlug = `org-4d-p2-closed-${Date.now()}`;
    const closedDefaultEventId = `event_4d_p2_closed_${Date.now()}`;
    const noDefaultOrgId = `org_4d_p2_nodef_${Date.now()}`;
    const noDefaultOrgSlug = `org-4d-p2-nodef-${Date.now()}`;
    const noDefaultEventId = `event_4d_p2_nodef_${Date.now()}`;
    const bookingPrefix = `D4P${Date.now().toString().slice(-3)}`;
    const closedPrefix = `D4C${Date.now().toString().slice(-3)}`;
    const noDefPrefix = `D4N${Date.now().toString().slice(-3)}`;

    before(async () => {
        await service.from('organisations').insert({ id: orgId, name: 'Phase 4D Phase2 Org', slug: orgSlug });
        await service.from('events').insert({ id: openEventId, org_id: orgId, name: 'Phase 4D Phase2 Event', slug: openEventSlug, booking_prefix: bookingPrefix, is_active: true, status: 'open' });
        await service.from('events').update({ is_default: true }).eq('id', openEventId);

        // An org whose is_default event exists but is NOT open (closed) -
        // proves the existing status gate still applies to an is_default-
        // resolved event, not just an explicitly-slugged one.
        await service.from('organisations').insert({ id: closedDefaultOrgId, name: 'Phase 4D Phase2 Closed-Default Org', slug: closedDefaultOrgSlug });
        await service.from('events').insert({ id: closedDefaultEventId, org_id: closedDefaultOrgId, name: 'Closed Default Event', slug: 'closed-default-event', booking_prefix: closedPrefix, is_active: false, status: 'closed' });
        await service.from('events').update({ is_default: true }).eq('id', closedDefaultEventId);

        // An org with a real event, but NO is_default set at all.
        await service.from('organisations').insert({ id: noDefaultOrgId, name: 'Phase 4D Phase2 No-Default Org', slug: noDefaultOrgSlug });
        await service.from('events').insert({ id: noDefaultEventId, org_id: noDefaultOrgId, name: 'No Default Event', slug: 'no-default-event', booking_prefix: noDefPrefix, is_active: false, status: 'open' });
    });

    after(async () => {
        await service.from('events').delete().in('id', [openEventId, closedDefaultEventId, noDefaultEventId]);
        await service.from('organisations').delete().in('id', [orgId, closedDefaultOrgId, noDefaultOrgId]);
    });

    it('a valid orgSlug WITHOUT an eventSlug resolves that organisation\'s own is_default event, never silently discarding the orgSlug for org_default', async () => {
        const { status, json } = await callEdgeFunction('submit-booking', submitPayload(`${bookingPrefix}-FOOD-`, 'P2A', { orgSlug }));
        assert.equal(status, 200, JSON.stringify(json));
        const booking = json.data[0];
        createdBookingIds.push(booking.id);

        assert.equal(booking.org_id, orgId, 'the supplied orgSlug must resolve to its own organisation, not org_default');
        assert.equal(booking.event_id, openEventId);
    });

    it('an explicit orgSlug + eventSlug pair is completely unaffected by the independent-resolution change', async () => {
        const { status, json } = await callEdgeFunction('submit-booking', submitPayload(`${bookingPrefix}-FOOD-`, 'P2B', { orgSlug, eventSlug: openEventSlug }));
        assert.equal(status, 200, JSON.stringify(json));
        const booking = json.data[0];
        createdBookingIds.push(booking.id);

        assert.equal(booking.org_id, orgId);
        assert.equal(booking.event_id, openEventId);
    });

    it('an invalid orgSlug alone is rejected clearly, independent of eventSlug', async () => {
        const { status, json } = await callEdgeFunction('submit-booking', submitPayload('ESF26-FOOD-', 'P2C', { orgSlug: 'no-such-org-p2-xyz' }));
        assert.notEqual(status, 200);
        assert.match(json.error, /organisation could not be found/i);
    });

    it('a valid orgSlug with an invalid eventSlug is rejected clearly, distinct from an org-not-found error', async () => {
        const { status, json } = await callEdgeFunction('submit-booking', submitPayload(`${bookingPrefix}-FOOD-`, 'P2D', { orgSlug, eventSlug: 'no-such-event-p2-xyz' }));
        assert.notEqual(status, 200);
        assert.match(json.error, /event could not be found/i);
    });

    it('an organisation with no is_default event configured fails clearly rather than silently guessing one', async () => {
        const { status, json } = await callEdgeFunction('submit-booking', submitPayload(`${noDefPrefix}-FOOD-`, 'P2E', { orgSlug: noDefaultOrgSlug }));
        assert.notEqual(status, 200);
        assert.match(json.error, /not currently available|no default event/i);
    });

    it('an is_default event that is not open (closed) is still gated by the existing status check, naming the real status', async () => {
        const { status, json } = await callEdgeFunction('submit-booking', submitPayload(`${closedPrefix}-FOOD-`, 'P2F', { orgSlug: closedDefaultOrgSlug }));
        assert.notEqual(status, 200);
        assert.match(json.error, /CLOSED/i);
    });
});

describe('a booking resolved to a non-default organisation sends through THAT organisation\'s own templates', () => {
    const orgId = `org_4d_tmpl_${Date.now()}`;
    const eventId = `event_4d_tmpl_${Date.now()}`;
    const orgSlug = `org-4d-tmpl-${Date.now()}`;
    const eventSlug = `event-4d-tmpl-${Date.now()}`;
    const bookingPrefix = `D4T${Date.now().toString().slice(-3)}`;
    const distinctSubject = `PHASE4D-DISTINCT-SUBJECT-${Date.now()}`;

    before(async () => {
        await service.from('organisations').insert({ id: orgId, name: 'Phase 4D Template Org', slug: orgSlug });
        await service.from('events').insert({ id: eventId, org_id: orgId, name: 'Phase 4D Template Event', slug: eventSlug, booking_prefix: bookingPrefix, is_active: true, status: 'open' });
        // A distinctly-worded template for THIS org only - the org_default
        // "application_received" template exists too, with different wording.
        await service.from('email_templates').insert({
            org_id: orgId, id: 'application_received',
            subject: distinctSubject, body_html: 'Hello {{owner_name}}, thanks for applying.'
        });
    });

    after(async () => {
        // email_queue and bookings: submit-booking (called below) creates a
        // real booking and, via sendReceivedEmail(), a real email_queue row -
        // neither is cleaned up anywhere else in this describe block, and
        // (no FK/cascade on email_queue.org_id) the queue row would otherwise
        // orphan permanently once the organisation below is deleted.
        await service.from('email_queue').delete().eq('org_id', orgId);
        await service.from('bookings').delete().eq('org_id', orgId);
        await service.from('email_templates').delete().eq('org_id', orgId).eq('id', 'application_received');
        await service.from('events').delete().eq('id', eventId);
        await service.from('organisations').delete().eq('id', orgId);
    });

    it('the queued "received" email uses this organisation\'s own template subject, not org_default\'s', async () => {
        const { status, json } = await callEdgeFunction('submit-booking', submitPayload(`${bookingPrefix}-FOOD-`, 'TMPL', { orgSlug, eventSlug }));
        assert.equal(status, 200, JSON.stringify(json));
        const booking = json.data[0];
        createdBookingIds.push(booking.id);

        // submit-booking sends the email best-effort and doesn't block the
        // response on it, but it awaits sendReceivedEmail() before returning
        // (see index.ts step 6), so the email_queue row already exists here.
        const { data: queued, error } = await service.from('email_queue').select('subject').eq('recipient', booking.email).order('id', { ascending: false }).limit(1).maybeSingle();
        assert.ifError(error);
        assert.ok(queued, 'expected an email_queue row for this booking\'s recipient');
        assert.equal(queued.subject, distinctSubject);
    });
});
