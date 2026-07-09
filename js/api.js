import { getSupabaseClient } from './supabase.js';
import { CONFIG, getStallCost } from './config.js';
import { validateString, validateEmail, validateBookingId, validateStatus, escapeHtml, MAX_FIELD_LENGTHS } from './utils.js';

const TBL_BOOKINGS = 'bookings';
const TBL_PAYMENTS = 'payments';
const TBL_LOCATIONS = 'locations';
const TBL_EMAIL_QUEUE = 'email_queue';
const TBL_AUDIT_LOGS = 'audit_logs';



/**
 * Fetches Kanban board data.
 * @param {string} currentInstance 
 * @returns {Promise<Array>}
 */
export async function fetchKanbanData(currentInstance) {
    const sb = getSupabaseClient();
    const prefix = CONFIG.INSTANCE_MAP[currentInstance] || 'ESF26-DEV-';

    const { data, error } = await sb
        .from(TBL_BOOKINGS)
        .select('*')
        .eq('instance_prefix', prefix)
        .order('created_at', { ascending: false });

    if (error) throw error;
    return data || []; // Raw data, adaptation can happen in UI if needed
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
    if (status !== 'Confirmed') updateFields.location_id = null;
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
 * Directly sends an email via Zoho Mail REST API.
 * Refreshes OAuth2 access token on the fly.
 * 
 * @param {string} recipient 
 * @param {string} subject 
 * @param {string} body 
 * @param {string|null} bcc 
 */
export async function sendEmailViaZoho(recipient, subject, body, bcc = null) {
    const sb = getSupabaseClient();
    
    // Fetch Zoho credentials from database
    const { data: settingsData, error: settingsError } = await sb
        .from('settings')
        .select('key, value')
        .in('key', [
            'zoho_client_id',
            'zoho_client_secret',
            'zoho_refresh_token',
            'zoho_account_id',
            'zoho_from_address',
            'zoho_api_domain',
            'zoho_accounts_domain'
        ]);

    if (settingsError) throw new Error("Failed to load Zoho settings from database: " + settingsError.message);
    
    const settings = {};
    settingsData.forEach(item => {
        settings[item.key] = item.value;
    });

    const clientId = settings['zoho_client_id'];
    const clientSecret = settings['zoho_client_secret'];
    const refreshToken = settings['zoho_refresh_token'];
    const accountId = settings['zoho_account_id'];
    const fromAddress = settings['zoho_from_address'] || 'festival_stalls@elleatreet.co.uk';
    const apiDomain = settings['zoho_api_domain'] || 'https://mail.zoho.eu';
    const accountsDomain = settings['zoho_accounts_domain'] || 'https://accounts.zoho.eu';

    if (!clientId || !clientSecret || !refreshToken || !accountId) {
        throw new Error("Missing required Zoho API configuration settings in database.");
    }

    // Refresh the Access Token
    const tokenUrl = `${accountsDomain}/oauth/v2/token`;
    const params = new URLSearchParams();
    params.append('grant_type', 'refresh_token');
    params.append('refresh_token', refreshToken);
    params.append('client_id', clientId);
    params.append('client_secret', clientSecret);

    const tokenResponse = await fetch(tokenUrl, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: params
    });

    if (!tokenResponse.ok) {
        const errorText = await tokenResponse.text();
        throw new Error(`Failed to refresh Zoho access token: ${tokenResponse.statusText}. Details: ${errorText}`);
    }

    const tokenData = await tokenResponse.json();
    const accessToken = tokenData.access_token;
    if (!accessToken) {
        throw new Error("Zoho token response did not contain an access token.");
    }

    // Send the Email
    const sendUrl = `${apiDomain}/api/accounts/${accountId}/messages`;
    const emailPayload = {
        fromAddress: fromAddress,
        toAddress: recipient,
        subject: subject,
        content: body,
        mailFormat: 'html'
    };
    if (bcc) {
        emailPayload.bccAddress = bcc;
    }

    const sendResponse = await fetch(sendUrl, {
        method: 'POST',
        headers: {
            'Authorization': `Zoho-oauthtoken ${accessToken}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(emailPayload)
    });

    if (!sendResponse.ok) {
        const errorText = await sendResponse.text();
        throw new Error(`Failed to send email via Zoho: ${sendResponse.statusText}. Details: ${errorText}`);
    }

    return await sendResponse.json();
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
        instanceFilter = ['ESF26-DEV-'];
    } else {
        // Show all production instances regardless of which one is selected
        instanceFilter = ['ESF26-FOOD-', 'ESF26-NONFOOD-', 'ESF26-MISC-'];
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

    // Filter bookings to only those that HAVE a payment record (chargeable ones)
    return bookings.filter(b => payMap.has(b.id)).map(b => {
        const p = payMap.get(b.id);
        return {
            ...b,
            paid: p.paid,
            date_paid: p.date_paid,
            bank_ref: p.bank_ref,
            editor: p.editor,
        };
    });
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
 * Fetches location data including bookings, locations, and global occupancy.
 * @param {string} currentInstance 
 */
export async function fetchLocationData(currentInstance) {
    const sb = getSupabaseClient();
    const currentPrefix = (currentInstance === 'FOOD') ? 'ESF26-FOOD-' :
        (currentInstance === 'GENERAL') ? 'ESF26-NONFOOD-' :
            (currentInstance === 'MISC') ? 'ESF26-MISC-' : 'ESF26-DEV-';

    // 1. Fetch bookings to DISPLAY (Current Instance Only)
    const { data: bLocs, error: blErr } = await sb
        .from(TBL_BOOKINGS)
        .select('*')
        .eq('status', 'Confirmed')
        .eq('instance_prefix', currentPrefix);
    if (blErr) throw blErr;

    // 2. Fetch GLOBAL Occupancy
    let occupancyFilter = [];
    if (currentPrefix === 'ESF26-DEV-') {
        occupancyFilter = ['ESF26-DEV-'];
    } else {
        occupancyFilter = ['ESF26-FOOD-', 'ESF26-NONFOOD-', 'ESF26-MISC-'];
    }

    const { data: allOccupants, error: occErr } = await sb
        .from(TBL_BOOKINGS)
        .select('location_id')
        .eq('status', 'Confirmed')
        .in('instance_prefix', occupancyFilter)
        .neq('location_id', null);
    if (occErr) throw occErr;

    // 3. Get Locations Reference
    const dataset = (currentInstance === 'DEV') ? 'DEV' : 'LIVE';

    let locs = [];
    try {
        const { data: lData } = await sb.from(TBL_LOCATIONS).select('*').eq('dataset', dataset);
        if (lData) locs = lData;
    } catch (e) { }

    return {
        bookings: bLocs,
        locations: locs,
        occupied_ids: allOccupants.map(o => o.location_id)
    };
}

/**
 * Updates a booking's location.
 * @param {string} id 
 * @param {string} locationId 
 */
export async function updateLocation(id, locationId) {
    validateBookingId(id);
    const sb = getSupabaseClient();
    const { error } = await sb.from(TBL_BOOKINGS).update({ location_id: locationId }).eq('id', id);
    if (error) throw error;
    await auditLog('allocate_location', id, { location_id: locationId });
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
    const safeMapLocs = mapLocs || [];

    // 2. Get Confirmed Bookings
    let bQuery = sb.from(TBL_BOOKINGS)
        .select('id, business_name, description, stall_type, location_id, category, instance_prefix')
        .eq('status', 'Confirmed');

    if (currentInstance === 'DEV') {
        bQuery = bQuery.eq('instance_prefix', 'ESF26-DEV-');
    } else {
        bQuery = bQuery.in('instance_prefix', ['ESF26-FOOD-', 'ESF26-NONFOOD-', 'ESF26-MISC-']);
    }

    const { data: bData, error: mapBErr } = await bQuery;
    if (mapBErr) throw mapBErr;

    // 3. Join Data
    const bookingMap = new Map();
    (bData || []).forEach(b => {
        if (b.location_id) {
            b.location_id.split(',').forEach(part => {
                const trimmed = part.trim();
                if (trimmed) {
                    bookingMap.set(trimmed, b);
                }
            });
        }
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
 * Bulk-queues HTML confirmation emails for an array of confirmed bookings.
 * @param {Array} bookings - Array of confirmed booking objects (must have `id`).
 * @param {Function} getEmailContent - Async fn(booking) => { subject, body } returning HTML email content.
 * @returns {Promise<{success: number, failed: number}>}
 */
export async function emailAllConfirmedBookings(bookings, getEmailContent) {
    let success = 0;
    let failed = 0;

    for (const booking of bookings) {
        try {
            const { subject, body } = await getEmailContent(booking);
            await sendEmail(booking.id, subject, body);
            success++;
        } catch (e) {
            console.warn(`Failed to queue email for ${booking.id}:`, e.message);
            failed++;
        }
    }

    return { success, failed };
}

/**
 * Automatically generates the next available ESF26-MISC-XXXX ID
 * @param {object} sb - Supabase client
 * @returns {Promise<string>}
 */
export async function generateMiscEntryId(sb) {
    const prefix = 'ESF26-MISC-';

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
        instance_prefix: 'ESF26-MISC-',
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


