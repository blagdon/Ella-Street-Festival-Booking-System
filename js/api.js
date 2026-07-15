import { getSupabaseClient } from './supabase.js';
import { CONFIG, getStallCost } from './config.js';
import { validateString, validateEmail, validateBookingId, validateStatus, escapeHtml, parseEdgeFunctionError, MAX_FIELD_LENGTHS } from './utils.js';

const TBL_BOOKINGS = 'bookings';
const TBL_PAYMENTS = 'payments';
const TBL_LOCATIONS = 'locations';
const TBL_BOOKING_LOCATIONS = 'booking_locations';
const TBL_EMAIL_QUEUE = 'email_queue';
const TBL_AUDIT_LOGS = 'audit_logs';

/**
 * locations.id may be a numeric Postgres column, while booking_locations.location_id
 * (and every ID assigned/compared client-side) is always a string. Normalize to
 * string here, once, so no caller has to worry about the mismatch.
 */
function normalizeLocationIds(locs) {
    return (locs || []).map(l => ({ ...l, id: String(l.id) }));
}



/**
 * Fetches Kanban board data.
 * @param {string} currentInstance 
 * @returns {Promise<Array>}
 */
export async function fetchKanbanData(currentInstance) {
    const sb = getSupabaseClient();
    const prefix = CONFIG.INSTANCE_MAP[currentInstance] || CONFIG.INSTANCE_MAP['DEV'];

    const { data, error } = await sb
        .from(TBL_BOOKINGS)
        .select('*')
        .eq('instance_prefix', prefix)
        .order('created_at', { ascending: false });

    if (error) throw error;
    const bookings = data || [];
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
 * Moves a chargeable booking to Pre-Confirmed and saves the agreed cost,
 * without touching payments or sending any email — those only happen once
 * the admin explicitly clicks "Request Payment" (chargeable, via Stripe) or
 * the booking turns out to be free/£0 (handled separately by
 * finalizeConfirmation, unchanged).
 * @param {string} id
 * @param {number} cost
 */
export async function preConfirmBooking(id, cost) {
    validateBookingId(id);
    const sb = getSupabaseClient();
    const { error } = await sb.from(TBL_BOOKINGS).update({ status: 'Pre-Confirmed', stall_cost: cost }).eq('id', id);
    if (error) throw error;
    await auditLog('pre_confirm_booking', id, { stall_cost: cost });
    return { status: 'success' };
}

/**
 * Finalizes a confirmation (handles payments logic).
 * @param {string} id
 * @param {boolean} isChargeable
 * @param {object|null} providedSnapshot - Optional booking snapshot to avoid redundant DB call
 * @param {number|null} overrideCost - Optional admin-specified cost override
 */
export async function finalizeConfirmation(id, isChargeable, providedSnapshot = null, overrideCost = null) {
    validateBookingId(id);
    const sb = getSupabaseClient();

    let bSnapshot = providedSnapshot;

    if (!bSnapshot) {
        const { data, error: snapError } = await sb
            .from(TBL_BOOKINGS)
            .select('instance_prefix, business_name, owner_name, email, phone, stall_type, stall_cost')
            .eq('id', id)
            .single();

        if (snapError || !data) {
            throw new Error(`Failed to fetch booking snapshot for ID ${id}: ${snapError ? snapError.message : 'Record not found'}`);
        }
        bSnapshot = data;
    }

    const prefix = bSnapshot.instance_prefix || "GENERAL";
    const confirmDate = new Date().toISOString();

    // Ensure status is confirmed (redundant safety)
    await sb.from(TBL_BOOKINGS).update({ status: 'Confirmed', date_confirmed: confirmDate }).eq('id', id);

    if (isChargeable) {
        // Priority: 1. Admin override, 2. Booking's stored cost, 3. Config default
        let cost = 0;
        if (overrideCost !== null && !isNaN(overrideCost)) {
            cost = overrideCost;
        } else if (bSnapshot.stall_cost !== undefined && bSnapshot.stall_cost !== null) {
            cost = parseFloat(bSnapshot.stall_cost);
        } else {
            cost = getStallCost(prefix);
        }

        // Save the final cost back to the booking record
        await sb.from(TBL_BOOKINGS).update({ stall_cost: cost }).eq('id', id);

        await sb.from(TBL_PAYMENTS).upsert({
            booking_id: id,
            paid: false
        }, { onConflict: 'booking_id', ignoreDuplicates: false });
    } else {
        await sb.from(TBL_PAYMENTS).delete().eq('booking_id', id);
    }

    await auditLog('finalize_confirmation', id, { is_chargeable: isChargeable });
    return { status: 'success' };
}

/**
 * Fetches bookings and joins with payment data.
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

    const { data: bookings, error: bErr } = await sb
        .from(TBL_BOOKINGS)
        .select('*')
        .in('instance_prefix', instanceFilter);
    if (bErr) throw bErr;

    const { data: payments, error: pErr } = await sb
        .from(TBL_PAYMENTS)
        .select('*');
    if (pErr) throw pErr;

    const payMap = new Map(payments.map(p => [p.booking_id, p]));

    // Bookings that already have a payments row (chargeable, resolved one
    // way or another) — unchanged from the original behavior.
    const withPaymentRow = bookings.filter(b => payMap.has(b.id)).map(b => {
        const p = payMap.get(b.id);
        return {
            ...b,
            paid: p.paid,
            date_paid: p.date_paid,
            bank_ref: p.bank_ref,
            editor: p.editor,
        };
    });

    // Additive: bookings mid-Stripe-flow (Payment Requested / Paid) don't
    // get a payments row until the webhook actually succeeds, so without
    // this they'd be invisible here even though a payment is genuinely
    // in flight. Shown with paid:false and awaitingPayment:true so the UI
    // can render a distinct "Awaiting Payment" badge instead of "UNPAID".
    const awaitingPayment = bookings
        .filter(b => !payMap.has(b.id) && ['Payment Requested', 'Paid'].includes(b.status))
        .map(b => ({
            ...b,
            paid: false,
            date_paid: null,
            bank_ref: null,
            editor: null,
            awaitingPayment: true
        }));

    return [...withPaymentRow, ...awaitingPayment];
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
 * Creates a Stripe Checkout Session for a Pre-Confirmed booking and emails
 * the stallholder a payment link (server-side, via the create-checkout-session
 * Edge Function). Also used for "Resend Payment Request" — same function,
 * called again from a Payment Requested booking, which just generates a
 * fresh session (Stripe Checkout Sessions expire after 24h) and re-sends.
 * @param {string} bookingId
 */
export async function requestPayment(bookingId) {
    validateBookingId(bookingId);
    const sb = getSupabaseClient();
    const { data, error } = await sb.functions.invoke('create-checkout-session', {
        body: { booking_id: bookingId }
    });
    if (error) {
        const errMsg = await parseEdgeFunctionError(error, 'Failed to create payment request');
        throw new Error(errMsg);
    }
    if (data && data.error) throw new Error(data.error);
    await auditLog('request_payment', bookingId);
    return data;
}

/**
 * Alias for requestPayment — kept as a separate export so call sites read
 * clearly ("Resend Payment Request" vs "Request Payment"), even though the
 * underlying Edge Function call is identical.
 * @param {string} bookingId
 */
export async function resendPaymentRequest(bookingId) {
    const data = await requestPayment(bookingId);
    await auditLog('resend_payment_request', bookingId);
    return data;
}

/**
 * Manual recovery action for a booking stuck at 'Paid' (the Stripe webhook
 * completed mark_stripe_payment_received but died before
 * finalize_stripe_confirmation). Deliberately a PLAIN status-only update —
 * never calls finalizeConfirmation, which would re-upsert payments with
 * paid:false and clobber the real Stripe payment that already succeeded.
 * No-ops (via the WHERE clause) if the booking isn't actually still 'Paid'.
 * @param {string} id
 */
export async function recoverStuckPaidBooking(id) {
    validateBookingId(id);
    const sb = getSupabaseClient();
    const { error } = await sb.from(TBL_BOOKINGS)
        .update({ status: 'Confirmed', date_confirmed: new Date().toISOString() })
        .eq('id', id)
        .eq('status', 'Paid');
    if (error) throw error;
    await auditLog('recover_stuck_paid_booking', id);
    return { status: 'success' };
}

/**
 * Fetches location data including bookings, locations, and global occupancy.
 * @param {string} currentInstance 
 */
export async function fetchLocationData(currentInstance) {
    const sb = getSupabaseClient();
    const currentPrefix = CONFIG.INSTANCE_MAP[currentInstance] || CONFIG.INSTANCE_MAP['DEV'];

    // 1. Fetch bookings to DISPLAY (Current Instance Only)
    const { data: bLocs, error: blErr } = await sb
        .from(TBL_BOOKINGS)
        .select('*')
        .eq('status', 'Confirmed')
        .eq('instance_prefix', currentPrefix);
    if (blErr) throw blErr;

    await attachLocationIds(sb, bLocs);

    // 2. Fetch GLOBAL Occupancy
    let occupancyFilter = [];
    if (currentPrefix === CONFIG.INSTANCE_MAP['DEV']) {
        occupancyFilter = [CONFIG.INSTANCE_MAP['DEV']];
    } else {
        occupancyFilter = [CONFIG.INSTANCE_MAP['FOOD'], CONFIG.INSTANCE_MAP['GENERAL'], CONFIG.INSTANCE_MAP['MISC']];
    }

    const { data: occupantBookings, error: occBErr } = await sb
        .from(TBL_BOOKINGS)
        .select('id')
        .eq('status', 'Confirmed')
        .in('instance_prefix', occupancyFilter);
    if (occBErr) throw occBErr;

    const occupantIds = (occupantBookings || []).map(b => b.id);
    const { data: allOccupants, error: occErr } = occupantIds.length
        ? await sb.from(TBL_BOOKING_LOCATIONS).select('location_id').in('booking_id', occupantIds)
        : { data: [], error: null };
    if (occErr) throw occErr;

    // 3. Get Locations Reference
    const dataset = (currentInstance === 'DEV') ? 'DEV' : 'LIVE';

    let locs = [];
    try {
        const { data: lData } = await sb.from(TBL_LOCATIONS).select('*').eq('dataset', dataset);
        if (lData) locs = normalizeLocationIds(lData);
    } catch (e) { }

    return {
        bookings: bLocs,
        locations: locs,
        occupied_ids: (allOccupants || []).map(o => o.location_id)
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
    const { data, error } = await sb
        .from(TBL_BOOKINGS)
        .select('*')
        .order('created_at', { ascending: false });

    if (error) throw error;
    return data || [];
}

/**
 * Fetches map data with joined booking info.
 * @param {string} currentInstance 
 * @returns {Promise<Array>}
 */
export async function fetchMapData(currentInstance) {
    const sb = getSupabaseClient();
    const mapDataset = (currentInstance === 'DEV') ? 'DEV' : 'LIVE';

    // Try Edge Function fallback for unauthenticated users on the LIVE dataset
    const { data: { session } } = await sb.auth.getSession();
    if (!session && mapDataset === 'LIVE') {
        try {
            const response = await fetch(`${CONFIG.SUPABASE.URL}/functions/v1/visitor-map`, {
                headers: {
                    "apikey": CONFIG.SUPABASE.KEY,
                    "Authorization": `Bearer ${CONFIG.SUPABASE.KEY}`
                }
            });
            if (response.ok) {
                const html = await response.text();
                const match = html.match(/window\.SERVER_DATA\s*=\s*(\[[\s\S]*?\])\s*;/);
                if (match) {
                    const data = JSON.parse(match[1]);
                    return data.map(item => ({
                        location_id: item.id,
                        lat: item.lat,
                        lng: item.lng,
                        business: item.biz,
                        description: "",
                        stall_type: item.type,
                        category: item.cat,
                        is_active: true
                    }));
                }
            }
        } catch (e) {
            console.warn("Failed to fetch map data from Edge Function, falling back to direct DB queries:", e);
        }
    }

    // 1. Get Locations
    const { data: mapLocs } = await sb.from(TBL_LOCATIONS).select('*').eq('dataset', mapDataset);
    const safeMapLocs = normalizeLocationIds(mapLocs);

    // 2. Get Confirmed Bookings
    let bQuery = sb.from(TBL_BOOKINGS)
        .select('id, business_name, description, stall_type, category, instance_prefix')
        .eq('status', 'Confirmed');

    if (currentInstance === 'DEV') {
        bQuery = bQuery.eq('instance_prefix', CONFIG.INSTANCE_MAP['DEV']);
    } else {
        bQuery = bQuery.in('instance_prefix', [CONFIG.INSTANCE_MAP['FOOD'], CONFIG.INSTANCE_MAP['GENERAL'], CONFIG.INSTANCE_MAP['MISC']]);
    }

    const { data: bData, error: mapBErr } = await bQuery;
    if (mapBErr) throw mapBErr;

    // 3. Join Data via booking_locations
    const bookingIds = (bData || []).map(b => b.id);
    const { data: joinRows, error: joinErr } = bookingIds.length
        ? await sb.from(TBL_BOOKING_LOCATIONS).select('booking_id, location_id').in('booking_id', bookingIds)
        : { data: [], error: null };
    if (joinErr) throw joinErr;

    const bookingsById = new Map((bData || []).map(b => [b.id, b]));
    const bookingMap = new Map();
    (joinRows || []).forEach(r => {
        const b = bookingsById.get(r.booking_id);
        if (b) bookingMap.set(r.location_id, b);
    });

    return safeMapLocs.map(l => {
        const booking = bookingMap.get(l.id);
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
        email: validateEmail(payload.email),
        phone: validateString(payload.phone, MAX_FIELD_LENGTHS.phone),
        category: validateString(payload.category, MAX_FIELD_LENGTHS.category),
        description: validateString(payload.description, MAX_FIELD_LENGTHS.description),
        stall_type: payload.type,
        power_required: payload.power || 'No power',
        address: validateString(payload.house, MAX_FIELD_LENGTHS.house),
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
 * Automatically generates the next available ESF26-MISC-XXXX ID
 * @param {object} sb - Supabase client
 * @returns {Promise<string>}
 */
export async function generateMiscEntryId(sb) {
    const prefix = CONFIG.INSTANCE_MAP['MISC'];

    // Fetch the single highest ID matching the prefix
    const { data, error } = await sb
        .from(TBL_BOOKINGS)
        .select('id')
        .like('id', `${prefix}%`)
        .order('id', { ascending: false })
        .limit(1);

    if (error) {
        throw new Error(`Failed to query existing Misc IDs: ${error.message}`);
    }

    if (!data || data.length === 0) {
        return `${prefix}0001`; // First entry
    }

    // data[0].id is expected to be like "ESF26-MISC-0042"
    const lastId = data[0].id;
    const parts = lastId.split('-');

    // Safety check just in case the format is strange
    if (parts.length < 3) {
        return `${prefix}0001`;
    }

    const lastNumStr = parts[parts.length - 1];
    const lastNum = parseInt(lastNumStr, 10);

    if (isNaN(lastNum)) {
        return `${prefix}0001`;
    }

    const nextNum = lastNum + 1;
    // Pad to 4 digits (e.g., 0043)
    const nextNumPadded = String(nextNum).padStart(4, '0');

    return `${prefix}${nextNumPadded}`;
}

/**
 * Inserts a new Misc booking.
 * @param {object} payload 
 */
export async function insertMiscBooking(payload) {
    const sb = getSupabaseClient();

    // Auto-generate the correct ID
    const newId = await generateMiscEntryId(sb);

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
        power_required: 'No power',
        is_resident: false,
        is_charity: 'Commercial'
    });

    if (error) throw error;
    await auditLog('insert_misc_booking', newId, { business: payload.business, owner: payload.owner });
    return { status: 'success', id: newId };
}


