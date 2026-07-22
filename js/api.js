import { getSupabaseClient } from './supabase.js';
import { CONFIG } from './config.js';
import { validateString, validateEmail, validateBookingId, validateStatus, escapeHtml, parseEdgeFunctionError, MAX_FIELD_LENGTHS } from './utils.js';

const TBL_BOOKINGS = 'bookings';
const TBL_PAYMENTS = 'payments';
const TBL_LOCATIONS = 'locations';
const TBL_BOOKING_LOCATIONS = 'booking_locations';
const TBL_EMAIL_QUEUE = 'email_queue';
const TBL_AUDIT_LOGS = 'audit_logs';
const VIEW_PUBLIC_BOOKINGS_INFO = 'public_bookings_info';

/**
 * locations.id may be a numeric Postgres column, while booking_locations.location_id
 * (and every ID assigned/compared client-side) is always a string. Normalize to
 * string here, once, so no caller has to worry about the mismatch.
 */
function normalizeLocationIds(locs) {
    return (locs || []).map(l => ({ ...l, id: String(l.id) }));
}

// Generous caps for admin list queries that previously had none at all —
// insurance against unbounded growth, not a response to an actual problem:
// at current data volumes (~184 bookings total) none of these are remotely
// close to firing. One shared number for board/table views, kept separate
// from stats' higher ceiling below. Exported so page modules can reference
// the same value in their "showing first N" notice rather than hardcoding it.
export const LIST_CAP = 1000;
// Stats aggregates the WHOLE fetched set into totals/percentages. A
// truncated board view is visibly incomplete (a missing card); a truncated
// stats dataset produces a wrong-but-plausible-looking number — a worse
// failure mode for the same truncation, so it gets a higher ceiling.
export const STATS_CAP = 5000;

/**
 * Runs a partially-built Supabase query with a cap, and detects whether the
 * cap actually truncated the result rather than assuming it did.
 *
 * Requests cap+1 rows and slices back to cap if more came back: checking
 * `data.length === cap` alone would be a false positive on an exact match
 * (e.g. precisely 1000 real bookings would wrongly show a "truncated"
 * notice forever). One extra row is a negligible cost for an accurate signal.
 *
 * The `truncated` flag is attached as a non-enumerable property on the
 * returned array rather than changing the return shape to {data, truncated}
 * — every existing caller's `.length`/`.map`/`.filter`/iteration/
 * `JSON.stringify` keeps working completely unchanged, and only call sites
 * that explicitly check `.truncated` need to know this exists. This is
 * deliberate: several call sites (e.g. details.js's loadBookings) consume
 * fetchKanbanData's result without knowing or caring about this cap, and
 * forcing every one of them to destructure a new shape for a condition that
 * won't fire in practice at current data volumes would be a lot of blast
 * radius for very little benefit.
 * @param {import('@supabase/supabase-js').PostgrestFilterBuilder} queryBuilder
 * @param {number} cap
 */
async function fetchCapped(queryBuilder, cap) {
    const { data, error } = await queryBuilder.limit(cap + 1);
    if (error) throw error;
    const rows = data || [];
    const truncated = rows.length > cap;
    const result = truncated ? rows.slice(0, cap) : rows;
    Object.defineProperty(result, 'truncated', { value: truncated, enumerable: false });
    return result;
}



/**
 * Fetches Kanban board data.
 * @param {string} currentInstance 
 * @returns {Promise<Array>}
 */
export async function fetchKanbanData(currentInstance) {
    const sb = getSupabaseClient();
    const prefix = CONFIG.INSTANCE_MAP[currentInstance] || CONFIG.INSTANCE_MAP['DEV'];

    const bookings = await fetchCapped(
        sb.from(TBL_BOOKINGS).select('*').eq('instance_prefix', prefix).order('created_at', { ascending: false }),
        LIST_CAP
    );
    await attachLocationIds(sb, bookings);
    return bookings; // Raw data, adaptation can happen in UI if needed
}

/**
 * Attaches `location_ids` (array) and `location_display` (joined string) to
 * each booking by querying booking_locations, replacing the old raw
 * comma-separated bookings.location_id column.
 */
async function attachLocationIds(sb, bookings) {
    const bookingIds = bookings.map(b => b.id);
    const { data: joinRows, error } = bookingIds.length
        ? await sb.from(TBL_BOOKING_LOCATIONS).select('booking_id, location_id').in('booking_id', bookingIds)
        : { data: [], error: null };
    if (error) throw error;

    const locsByBooking = new Map();
    (joinRows || []).forEach(r => {
        if (!locsByBooking.has(r.booking_id)) locsByBooking.set(r.booking_id, []);
        locsByBooking.get(r.booking_id).push(r.location_id);
    });

    bookings.forEach(b => {
        b.location_ids = locsByBooking.get(b.id) || [];
        b.location_display = b.location_ids.join(', ');
    });
}

/**
 * Updates a booking status.
 * @param {string} id 
 * @param {string} status 
 * @param {string} reason 
 */
export async function updateBookingStatus(id, status, reason = null) {
    validateBookingId(id);
    validateStatus(status);
    const sb = getSupabaseClient();

    const updateFields = { status: status };
    if (reason) updateFields.rejection_reason = reason;

    // Fetch booking details before updating if moving to HCC Checks
    let bookingDetails = null;
    if (status === 'HCC Checks') {
        const { data: bData, error: bErr } = await sb.from(TBL_BOOKINGS).select('business_name, owner_name, registered_business_name').eq('id', id).single();
        if (bErr) throw bErr;
        bookingDetails = bData;
    }

    // Update the booking status
    const { error } = await sb.from(TBL_BOOKINGS).update(updateFields).eq('id', id);
    if (error) throw error;

    // Clear any assigned locations when a booking leaves Confirmed status.
    if (status !== 'Confirmed') {
        const { error: locErr } = await sb.rpc('rpc_set_booking_locations', { p_booking_id: id, p_location_ids: [] });
        if (locErr) console.warn("Failed to clear booking_locations on status change:", locErr);
    }

    // Insert into hcc_checks
    if (status === 'HCC Checks' && bookingDetails) {
        // Prevent duplicates by checking if the record already exists
        const { data: existingHcc } = await sb.from('hcc_checks').select('id').eq('booking_id', id).maybeSingle();
        if (!existingHcc) {
            const { error: hccErr } = await sb.from('hcc_checks').insert({
                booking_id: id,
                council_status: 'Pending'
            });
            if (hccErr) console.warn("Failed to insert into hcc_checks:", hccErr);
        }
    }

    await auditLog('update_status', id, { new_status: status, reason: reason });
    return { status: 'success' };
}

/**
 * Adds an admin note to a booking.
 * @param {string} id 
 * @param {string} note 
 */
export async function addNote(id, note) {
    validateBookingId(id);
    const sb = getSupabaseClient();
    const { error } = await sb.from(TBL_BOOKINGS).update({ admin_notes: note }).eq('id', id);
    if (error) throw error;
    await auditLog('add_admin_note', id, { note_length: note ? note.length : 0 });
    return { status: 'success' };
}

/**
 * Directly sends an email via the Supabase send-email Edge Function.
 * Bypasses CORS by running Zoho OAuth2/REST calls on the server.
 * 
 * @param {string} recipient 
 * @param {string} subject 
 * @param {string} body 
 * @param {string|null} bcc 
 */
export async function sendEmailViaZoho(recipient, subject, body, bcc = null) {
    const sb = getSupabaseClient();
    
    // Call the Edge Function using the Supabase client
    const { data, error } = await sb.functions.invoke('send-email', {
        body: { recipient, subject, body, bcc }
    });

    if (error) {
        const errMsg = await parseEdgeFunctionError(error, "Failed to invoke send-email function");
        throw new Error(errMsg);
    }

    if (data && data.error) {
        throw new Error(data.error);
    }

    return data;
}

/**
 * Sends an email directly, writes log to email_queue, and records audit trail.
 * 
 * @param {string} recipient 
 * @param {string} subject 
 * @param {string} body 
 * @param {string|null} bookingId 
 * @param {string|null} instancePrefix 
 * @param {string|null} bcc 
 */
export async function sendEmailDirect(recipient, subject, body, bookingId = null, instancePrefix = null, bcc = null) {
    let status = 'Sent';
    let errorMessage = null;

    try {
        await sendEmailViaZoho(recipient, subject, body, bcc);
    } catch (e) {
        status = 'Error';
        errorMessage = e.message;
        console.error("Zoho Send Error:", e);
    }

    // Log to email_queue table
    const sb = getSupabaseClient();
    const { error: insertErr } = await sb.from(TBL_EMAIL_QUEUE).insert({
        recipient: recipient,
        subject: subject,
        body: body,
        bcc: bcc || null,
        status: status,
        error_message: errorMessage,
        instance_prefix: instancePrefix || localStorage.getItem('ESF_INSTANCE') || 'DEV'
    });

    if (insertErr) {
        console.warn("Failed to write to email_queue log:", insertErr.message);
    }

    if (status === 'Error') {
        throw new Error(`Failed to send email: ${errorMessage}`);
    }

    await auditLog('email_sent', bookingId, { subject: subject, recipient: recipient });
    return { status: 'success', message: 'Email sent successfully via Zoho.' };
}

/**
 * Sends a booking email directly using the Zoho API and records audit logs.
 * @param {string} id 
 * @param {string} subject 
 * @param {string} body 
 */
export async function sendEmail(id, subject, body) {
    validateBookingId(id);
    const sb = getSupabaseClient();

    // Fetch email and instance prefix
    const { data: emailData, error: fetchErr } = await sb
        .from(TBL_BOOKINGS)
        .select('email, instance_prefix')
        .eq('id', id)
        .single();

    if (fetchErr || !emailData || !emailData.email) throw new Error("Could not find email address.");

    return await sendEmailDirect(emailData.email, subject, body, id, emailData.instance_prefix);
}

/**
 * Finalizes a free confirmation. Only ever called for a free confirmation
 * (js/shared.js's sharedUpdateStatus) — a chargeable confirm never reaches
 * this function, it goes through Stripe (finalize_stripe_payment) or a
 * manually recorded bank transfer (rpc_record_bank_transfer_payment)
 * instead, each managing its own payments row. Deletes any stale payments
 * row so a free booking never has one.
 * @param {string} id
 */
export async function finalizeConfirmation(id) {
    validateBookingId(id);
    const sb = getSupabaseClient();

    const confirmDate = new Date().toISOString();

    // Ensure status is confirmed (redundant safety)
    await sb.from(TBL_BOOKINGS).update({ status: 'Confirmed', date_confirmed: confirmDate }).eq('id', id);

    await sb.from(TBL_PAYMENTS).delete().eq('booking_id', id);

    await auditLog('finalize_confirmation', id);
    return { status: 'success' };
}

/**
 * Fetches bookings and joins with payment data.
 *
 * Capped, not paginated, deliberately: js/payments.js computes its Paid/
 * Outstanding totals client-side over this entire result. Real page-at-a-time
 * pagination would make those totals silently reflect only whichever page is
 * currently loaded — a wrong-looking-right number is worse than an
 * incomplete table. A cap keeps totals accurate for as long as the cap isn't
 * hit; if it ever is, both the table AND the totals become a same-shaped
 * undercount together, which the "showing first N" notice flags, rather than
 * the totals silently drifting out of sync with what the table shows.
 * @param {string} currentInstance
 */
export async function fetchPayments(currentInstance) {
    const sb = getSupabaseClient();

    // Payments page shows all live instances together (FOOD + NONFOOD + MISC)
    // Only isolate to DEV if the user is explicitly in DEV mode
    let instanceFilter;
    if (currentInstance === 'DEV') {
        instanceFilter = [CONFIG.INSTANCE_MAP['DEV']];
    } else {
        // Show all production instances regardless of which one is selected
        instanceFilter = [CONFIG.INSTANCE_MAP['FOOD'], CONFIG.INSTANCE_MAP['GENERAL'], CONFIG.INSTANCE_MAP['MISC']];
    }

    const bookings = await fetchCapped(
        sb.from(TBL_BOOKINGS).select('*').in('instance_prefix', instanceFilter),
        LIST_CAP
    );

    const bookingIds = bookings.map(b => b.id);
    const { data: payments, error: pErr } = bookingIds.length
        ? await sb.from(TBL_PAYMENTS).select('*').in('booking_id', bookingIds)
        : { data: [], error: null };
    if (pErr) throw pErr;

    const payMap = new Map(payments.map(p => [p.booking_id, p]));

    // Bookings that already have a payments row (chargeable, resolved one
    // way or another) — unchanged from the original behavior.
    const withPaymentRow = bookings.filter(b => payMap.has(b.id)).map(b => {
        const p = payMap.get(b.id);
        const refunded = p.refund_amount != null;
        return {
            ...b,
            paid: p.paid,
            date_paid: p.date_paid,
            bank_ref: p.bank_ref,
            editor: p.editor,
            payment_method: p.payment_method,
            refunded,
            refund_amount: p.refund_amount,
            refunded_at: p.refunded_at,
            refunded_by: p.refunded_by,
            refund_reference: p.refund_reference,
            // A cancelled booking whose payment was taken and never refunded
            // needs a human to decide what happens to the money. Derived
            // rather than stored: it's a function of state that's already
            // recorded, so there's no flag to set, forget to clear, or let
            // drift out of sync with the payment/booking rows it describes.
            // Self-service cancellation deliberately still succeeds for a
            // paid booking (blocking it would strand the trader with no way
            // to cancel at all) — this is how the admin finds out they need
            // to act.
            needsRefundFollowUp: p.paid === true && !refunded && b.status === 'Cancelled',
        };
    });

    // Additive: bookings mid-Stripe-flow (Payment Requested) don't get a
    // payments row until the webhook actually succeeds, so without this
    // they'd be invisible here even though a payment is genuinely in
    // flight. Shown with paid:false and awaitingPayment:true so the UI
    // can render a distinct "Awaiting Payment" badge instead of "UNPAID".
    const awaitingPayment = bookings
        .filter(b => !payMap.has(b.id) && b.status === 'Payment Requested')
        .map(b => ({
            ...b,
            paid: false,
            date_paid: null,
            bank_ref: null,
            editor: null,
            awaitingPayment: true
        }));

    // Spreading into a new array (needed to combine the two groups) drops
    // any non-enumerable property on the source, so re-attach it here rather
    // than losing the truncation signal fetchCapped computed above.
    const combined = [...withPaymentRow, ...awaitingPayment];
    Object.defineProperty(combined, 'truncated', { value: !!bookings.truncated, enumerable: false });
    return combined;
}

/**
 * Updates a payment record.
 * @param {object} payload 
 */
export async function updatePayment(payload) {
    validateBookingId(payload.booking_id);
    const sb = getSupabaseClient();
    const { error } = await sb.from(TBL_PAYMENTS).update({
        paid: payload.paid === true,
        date_paid: payload.date_paid || null,
        bank_ref: payload.bank_ref,
        editor: payload.editor
    }).eq('booking_id', payload.booking_id);

    if (error) throw error;
    await auditLog('update_payment', payload.booking_id, { paid: payload.paid, amount: payload.stall_cost, editor: payload.editor });
    return { status: 'success' };
}

/**
 * Creates a Stripe Checkout Session for a booking and emails the
 * stallholder a payment link (server-side, via the create-checkout-session
 * Edge Function), moving it straight to 'Payment Requested'. `cost` is
 * passed through when the admin is confirming a booking as chargeable for
 * the first time (there's no separate persistence step before this call);
 * omit it to resend using whatever cost is already saved on the booking.
 * @param {string} bookingId
 * @param {number|null} cost
 */
export async function requestPayment(bookingId, cost = null) {
    validateBookingId(bookingId);
    const sb = getSupabaseClient();
    const body = { booking_id: bookingId };
    if (cost !== null && cost !== undefined) body.cost = cost;
    const { data, error } = await sb.functions.invoke('create-checkout-session', { body });
    if (error) {
        const errMsg = await parseEdgeFunctionError(error, 'Failed to create payment request');
        throw new Error(errMsg);
    }
    if (data && data.error) throw new Error(data.error);
    await auditLog('request_payment', bookingId, cost !== null ? { stall_cost: cost } : {});
    return data;
}

/**
 * Alias for requestPayment (no cost override — reuses whatever's already
 * saved on the booking) — kept as a separate export so call sites read
 * clearly ("Resend Payment Request" vs "Request Payment").
 * @param {string} bookingId
 */
export async function resendPaymentRequest(bookingId) {
    const data = await requestPayment(bookingId);
    await auditLog('resend_payment_request', bookingId);
    return data;
}

/**
 * Records a manually-verified bank-transfer payment for a booking currently
 * awaiting payment ('Payment Requested', no payments row yet) and atomically
 * confirms it — the manual counterpart to what the Stripe webhook's
 * finalize_stripe_payment RPC does automatically. One RPC call: no separate
 * "mark paid" + "confirm booking" steps, no window where they could
 * disagree.
 * @param {object} payload
 * @param {string} payload.booking_id
 * @param {string} payload.payment_reference
 * @param {string|null} [payload.notes]
 */
export async function recordBankTransferPayment(payload) {
    validateBookingId(payload.booking_id);
    const reference = validateString(payload.payment_reference, MAX_FIELD_LENGTHS.bank_ref);
    if (!reference.trim()) throw new Error('Payment reference is required.');
    const notes = payload.notes ? validateString(payload.notes, MAX_FIELD_LENGTHS.note) : null;

    const sb = getSupabaseClient();
    const { error } = await sb.rpc('rpc_record_bank_transfer_payment', {
        p_booking_id: payload.booking_id,
        p_payment_reference: reference,
        p_notes: notes
    });
    if (error) throw error;

    // Three distinct facts about one admin action, logged separately per the
    // required audit trail — an admin recording a bank transfer *is* the
    // verification, so "recorded" and "verified" happen together but are
    // still two distinct events worth their own entries, plus the knock-on
    // status change.
    await auditLog('bank_transfer_recorded', payload.booking_id, { payment_reference: reference, notes });
    await auditLog('bank_transfer_verified', payload.booking_id, { payment_reference: reference });
    await auditLog('booking_auto_confirmed_bank_transfer', payload.booking_id, { payment_reference: reference });

    return { status: 'success' };
}

/**
 * Records a refund that has ALREADY happened elsewhere — in the Stripe
 * dashboard, or as a manual bank transfer back to the trader. This moves no
 * money itself; it writes the refund into the payments row so the app's
 * record matches reality.
 *
 * The refunded_by identity is deliberately NOT sent from here — the RPC
 * derives it from the caller's JWT, the same way verified_by works for bank
 * transfers, so an admin can't attribute a refund to someone else.
 * @param {{booking_id: string, refund_amount: number|string, refund_reference: string, notes?: string}} payload
 */
export async function recordRefund(payload) {
    validateBookingId(payload.booking_id);

    const reference = validateString(payload.refund_reference, MAX_FIELD_LENGTHS.bank_ref);
    if (!reference.trim()) throw new Error('Refund reference is required.');

    const amount = parseFloat(payload.refund_amount);
    if (!Number.isFinite(amount) || amount <= 0) {
        throw new Error('Refund amount must be a number greater than zero.');
    }

    const notes = payload.notes ? validateString(payload.notes, MAX_FIELD_LENGTHS.note) : null;

    const sb = getSupabaseClient();
    const { error } = await sb.rpc('rpc_record_refund', {
        p_booking_id: payload.booking_id,
        p_refund_amount: amount,
        p_refund_reference: reference,
        p_notes: notes
    });
    if (error) throw error;

    await auditLog('refund_recorded', payload.booking_id, { refund_amount: amount, refund_reference: reference, notes });

    return { status: 'success' };
}

/**
 * Issues a REAL Stripe refund via the refund-payment Edge Function, which
 * records it on success. Unlike recordRefund() above, this moves money.
 *
 * Only valid for payment_method === 'stripe' — a bank transfer has no API to
 * call, so those use recordRefund() after the admin moves the money manually.
 * @param {{booking_id: string, amount?: number, notes?: string}} payload
 */
export async function refundStripePayment(payload) {
    validateBookingId(payload.booking_id);
    const sb = getSupabaseClient();

    const { data, error } = await sb.functions.invoke('refund-payment', {
        body: {
            booking_id: payload.booking_id,
            amount: payload.amount ?? null,
            notes: payload.notes || null
        }
    });

    // A non-2xx surfaces as a FunctionsHttpError whose .message is the generic
    // "non-2xx status code" — the actual reason ("already refunded", "not a
    // Stripe payment") is in the body, and for a money operation the admin
    // needs the real one. Same treatment as retryQueuedEmail().
    if (error) {
        let message = error.message;
        try {
            const body = await error.context?.json();
            if (body?.error) message = body.error;
        } catch { /* keep the generic message if the body isn't readable */ }
        throw new Error(message);
    }
    if (data && data.error) throw new Error(data.error);

    await auditLog('refund_issued_stripe', payload.booking_id, {
        refund_amount: data?.refund_amount,
        refund_id: data?.refund_id,
        mode: data?.mode
    });

    return data;
}

/**
 * Fetches location data including bookings, locations, and global occupancy.
 * @param {string} currentInstance 
 */
export async function fetchLocationData(currentInstance) {
    const sb = getSupabaseClient();
    const currentPrefix = CONFIG.INSTANCE_MAP[currentInstance] || CONFIG.INSTANCE_MAP['DEV'];

    // 1. Fetch bookings to DISPLAY (Current Instance Only)
    const bLocs = await fetchCapped(
        sb.from(TBL_BOOKINGS).select('*').eq('status', 'Confirmed').eq('instance_prefix', currentPrefix),
        LIST_CAP
    );

    await attachLocationIds(sb, bLocs);

    // 2. Fetch GLOBAL Occupancy
    let occupancyFilter = [];
    if (currentPrefix === CONFIG.INSTANCE_MAP['DEV']) {
        occupancyFilter = [CONFIG.INSTANCE_MAP['DEV']];
    } else {
        occupancyFilter = [CONFIG.INSTANCE_MAP['FOOD'], CONFIG.INSTANCE_MAP['GENERAL'], CONFIG.INSTANCE_MAP['MISC']];
    }

    // Capped like the display query above, with the same reasoning, plus one
    // more: this feeds which pitches LOOK occupied client-side, not whether an
    // assignment actually succeeds. booking_locations_check_conflict (a DB
    // trigger) is the real, authoritative backstop against double-booking a
    // pitch regardless of what this list contains — see HANDOVER. So a
    // truncated occupancy set risks a confusing UX (a pitch shown as free,
    // then the trigger rejects the assignment) rather than an actual
    // double-booking.
    const occupantBookings = await fetchCapped(
        sb.from(TBL_BOOKINGS).select('id').eq('status', 'Confirmed').in('instance_prefix', occupancyFilter),
        LIST_CAP
    );

    const occupantIds = occupantBookings.map(b => b.id);
    const { data: allOccupants, error: occErr } = occupantIds.length
        ? await sb.from(TBL_BOOKING_LOCATIONS).select('location_id').in('booking_id', occupantIds)
        : { data: [], error: null };
    if (occErr) throw occErr;

    // 3. Get Locations Reference
    const dataset = (currentInstance === 'DEV') ? 'DEV' : 'LIVE';

    let locs = [];
    try {
        const { data: lData } = await sb.from(TBL_LOCATIONS).select('*').eq('dataset', dataset).limit(LIST_CAP);
        if (lData) locs = normalizeLocationIds(lData);
    } catch (e) { }

    return {
        bookings: bLocs,
        locations: locs,
        occupied_ids: (allOccupants || []).map(o => o.location_id),
        // Physical pitches are a small, admin-curated set that will not
        // realistically approach LIST_CAP — not worth its own truncation
        // signal, so only the two booking queries are tracked here.
        truncated: !!bLocs.truncated || !!occupantBookings.truncated
    };
}

/**
 * Replaces all of a booking's assigned locations.
 * @param {string} id
 * @param {string[]} locationIds - full desired set of location ids (empty array clears all)
 */
export async function updateLocation(id, locationIds) {
    validateBookingId(id);
    const sb = getSupabaseClient();
    const { error } = await sb.rpc('rpc_set_booking_locations', { p_booking_id: id, p_location_ids: locationIds });
    if (error) throw error;
    await auditLog('allocate_location', id, { location_ids: locationIds });
    return { status: 'success' };
}


/**
 * Fetches all bookings for statistics.
 * @returns {Promise<Array>}
 */
export async function fetchStatsData() {
    const sb = getSupabaseClient();
    return await fetchCapped(
        sb.from(TBL_BOOKINGS).select('*').order('created_at', { ascending: false }),
        STATS_CAP
    );
}

/**
 * Fetches map data with joined booking info.
 * @param {string} currentInstance 
 * @returns {Promise<Array>}
 */
export async function fetchMapData(currentInstance) {
    const sb = getSupabaseClient();
    const mapDataset = (currentInstance === 'DEV') ? 'DEV' : 'LIVE';

    // 1. Get Locations
    const { data: mapLocs } = await sb.from(TBL_LOCATIONS).select('*').eq('dataset', mapDataset);
    const safeMapLocs = normalizeLocationIds(mapLocs);

    // 2. Get Confirmed bookings and their assigned location(s) via the
    // public_bookings_info view — anon has no direct access to the
    // bookings table at all (2026-07-15 security fix: PII columns like
    // owner_name/email/phone/address/documents/cancel_token must never be
    // reachable by an unauthenticated visitor). The view already joins
    // booking_locations internally, so each row here is one
    // (booking, location) pair — a booking with multiple locations simply
    // produces multiple rows, one per location_id.
    let bQuery = sb.from(VIEW_PUBLIC_BOOKINGS_INFO)
        .select('business_name, description, stall_type, category, instance_prefix, location_id');

    if (currentInstance === 'DEV') {
        bQuery = bQuery.eq('instance_prefix', CONFIG.INSTANCE_MAP['DEV']);
    } else {
        bQuery = bQuery.in('instance_prefix', [CONFIG.INSTANCE_MAP['FOOD'], CONFIG.INSTANCE_MAP['GENERAL'], CONFIG.INSTANCE_MAP['MISC']]);
    }

    const { data: bData, error: mapBErr } = await bQuery;
    if (mapBErr) throw mapBErr;

    const bookingByLocation = new Map((bData || []).map(b => [b.location_id, b]));

    return safeMapLocs.map(l => {
        const booking = bookingByLocation.get(l.id);
        if (!booking) return null;
        return {
            location_id: l.id,
            lat: l.lat,
            lng: l.lng,
            business: booking.business_name,
            description: booking.description,
            stall_type: booking.stall_type,
            category: booking.category,
            is_active: true
        };
    }).filter(item => item !== null);
}

/**
 * Updates booking details.
 * @param {object} payload 
 */
export async function updateBookingDetails(payload) {
    validateBookingId(payload.id);
    const sb = getSupabaseClient();

    const { error } = await sb.from(TBL_BOOKINGS).update({
        business_name: validateString(payload.business, MAX_FIELD_LENGTHS.business),
        owner_name: validateString(payload.owner, MAX_FIELD_LENGTHS.owner),
        email: payload.email ? validateEmail(payload.email) : null,
        phone: validateString(payload.phone, MAX_FIELD_LENGTHS.phone),
        category: validateString(payload.category, MAX_FIELD_LENGTHS.category),
        description: validateString(payload.description, MAX_FIELD_LENGTHS.description),
        stall_type: payload.type,
        power_required: payload.power || 'No power',
        address: validateString(payload.house, MAX_FIELD_LENGTHS.house),
        website: validateString(payload.website, MAX_FIELD_LENGTHS.website),
        other_requirements: validateString(payload.other, MAX_FIELD_LENGTHS.other),
        is_resident: payload.is_resident === true,
        is_charity: payload.is_charity || 'Commercial'
    }).eq('id', payload.id);

    if (error) throw error;
    await auditLog('update_details', payload.id, { business: payload.business, owner: payload.owner });
    return { status: 'success' };
}

/**
 * Writes to the audit log.
 * @param {string} action 
 * @param {string} targetId 
 * @param {object} details 
 */
export async function auditLog(action, targetId, details = {}) {
    try {
        const sb = getSupabaseClient();
        const { data: { session } } = await sb.auth.getSession();
        const userEmail = session?.user?.email || 'anonymous';

        // Get current instance from local storage if possible, or default
        const currentInstance = (typeof localStorage !== 'undefined' && localStorage.getItem('ESF_INSTANCE')) || 'UNKNOWN';

        await sb.from(TBL_AUDIT_LOGS).insert({
            action: action,
            target_id: targetId || null,
            user_email: userEmail,
            details: details,
            instance: currentInstance
        });
    } catch (e) {
        console.warn('Audit log failed:', e.message);
    }
}

/**
 * Queues a bulk HTML email to a set of confirmed bookings via the
 * queue-bulk-email Edge Function. The function inserts every recipient
 * into email_queue as 'Pending' in one atomic server-side write and then
 * drains it in the background (EdgeRuntime.waitUntil) — independent of
 * this browser tab staying open, unlike the old client-driven send loop.
 * @param {string[]} bookingIds
 * @param {string} subject
 * @param {string} body
 * @returns {Promise<{queued: number}>}
 */
export async function queueBulkEmail(bookingIds, subject, body) {
    const sb = getSupabaseClient();
    const { data, error } = await sb.functions.invoke('queue-bulk-email', {
        body: { bookingIds, subject, body }
    });
    if (error) throw new Error(error.message);
    if (data && data.error) throw new Error(data.error);
    return data;
}

/**
 * Retries a single failed email_queue send via the retry-queued-email Edge
 * Function. Only rows currently in 'Error' are retryable — the function
 * claims the row server-side before sending, so a double-click can't deliver
 * the same email twice. Runs server-side because `authenticated` has no
 * UPDATE on email_queue by design (status transitions are service-role only).
 * @param {number} id email_queue row id
 * @returns {Promise<{success: boolean, status: string, error_message: string|null, retry_count: number}>}
 */
export async function retryQueuedEmail(id) {
    const sb = getSupabaseClient();
    const { data, error } = await sb.functions.invoke('retry-queued-email', {
        body: { id }
    });

    // A non-2xx response surfaces as a FunctionsHttpError whose .message is
    // the generic "Edge Function returned a non-2xx status code" — the actual
    // reason ("this entry is currently Sent", "not found") is in the response
    // body. Those specific messages are the whole point of this action, so
    // dig the body out rather than showing the admin the generic one.
    if (error) {
        let message = error.message;
        try {
            const body = await error.context?.json();
            if (body?.error) message = body.error;
        } catch { /* keep the generic message if the body isn't readable */ }
        throw new Error(message);
    }
    if (data && data.error) throw new Error(data.error);

    await auditLog('retry_queued_email', String(id), {
        result: data?.status,
        retry_count: data?.retry_count
    });

    return data;
}

/**
 * Resolves a booking's stored document storage paths to time-limited
 * signed URLs via the get-booking-documents Edge Function (esf-documents
 * is a private bucket, so paths aren't directly resolvable without this).
 * @param {string} bookingId
 * @returns {Promise<(string|null)[]>} signed URLs in the same order as bookings.documents
 */
export async function getSignedBookingDocuments(bookingId) {
    const sb = getSupabaseClient();
    const { data, error } = await sb.functions.invoke('get-booking-documents', {
        body: { bookingId }
    });
    if (error) throw new Error(error.message);
    if (data && data.error) throw new Error(data.error);
    return data.documents || [];
}

/**
 * Inserts a new Misc booking.
 * @param {object} payload 
 */
export async function insertMiscBooking(payload) {
    const sb = getSupabaseClient();

    // Fetch the correct next ID atomically via RPC
    const { data: newId, error: idErr } = await sb.rpc('rpc_get_next_misc_id');
    if (idErr) throw idErr;

    const { error } = await sb.from(TBL_BOOKINGS).insert({
        id: newId,
        instance_prefix: CONFIG.INSTANCE_MAP['MISC'],
        status: 'Confirmed',
        date_confirmed: new Date().toISOString(),
        business_name: validateString(payload.business, MAX_FIELD_LENGTHS.business),
        owner_name: validateString(payload.owner, MAX_FIELD_LENGTHS.owner),
        email: payload.email ? validateEmail(payload.email) : null,
        phone: validateString(payload.phone, MAX_FIELD_LENGTHS.phone),
        category: validateString(payload.category, MAX_FIELD_LENGTHS.category),
        description: validateString(payload.description, MAX_FIELD_LENGTHS.description),
        stall_type: payload.type || null,
        address: validateString(payload.house, MAX_FIELD_LENGTHS.house),
        website: validateString(payload.website, MAX_FIELD_LENGTHS.website),
        power_required: 'No power',
        is_resident: false,
        is_charity: 'Commercial'
    });

    if (error) throw error;
    await auditLog('insert_misc_booking', newId, { business: payload.business, owner: payload.owner });
    return { status: 'success', id: newId };
}


