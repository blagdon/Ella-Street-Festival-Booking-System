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
        await service.from('events').insert([
            { id: eventId, org_id: orgId, name: 'Phase 4D Event', slug: eventSlug, booking_prefix: bookingPrefix, is_active: true, status: 'open' },
            { id: draftEventId, org_id: orgId, name: 'Phase 4D Draft Event', slug: draftEventSlug, booking_prefix: draftBookingPrefix, is_active: true, status: 'draft' },
        ]);
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

    it('falls back to the legacy org_default/event_default pair when no slug is given at all', async () => {
        // Relies on 20260804140000_open_default_event.sql having set
        // event_default's status to 'open' - this is the exact regression
        // that migration exists to prevent (see its own header comment).
        const { status, json } = await callEdgeFunction('submit-booking', submitPayload('ESF26-FOOD-', 'E'));
        assert.equal(status, 200, JSON.stringify(json));
        const booking = json.data[0];
        createdBookingIds.push(booking.id);

        assert.equal(booking.org_id, 'org_default');
        assert.equal(booking.event_id, 'event_default');
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
