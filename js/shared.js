import { getSupabaseClient } from './supabase.js';
import { updateBookingStatus, finalizeConfirmation, sendEmail, sendBookingSms, auditLog, getSignedBookingDocuments } from './api.js';
import { showToast } from './ui.js';
import { escapeHtml, sanitizeUrl, countSmsSegments } from './utils.js';
import { getStallCost, CONFIG } from './config.js';
import { populateFsaSection } from './fsa-ratings.js';
import { populateGoogleMapsReviews } from './google-reviews.js';

// ---------------------------------------------------------------------------
// Optional "also send a text" controls on the Compose Email and Bulk Email
// modals. Both the Kanban and Summary pages carry identical copies of those
// modals, so the wiring lives here rather than being duplicated in both page
// modules (and then drifting).
//
// The two cases are deliberately NOT the same:
//  - Compose: the email body is a plain <textarea>, so the SMS field is
//    prefilled from it as a convenience, then edited down.
//  - Bulk: the email body is Quill HTML. Reusing it would put literal markup
//    on the handset, so the bulk SMS has its own field with no prefill, and
//    shows a cost estimate because every part is billed per recipient.
// ---------------------------------------------------------------------------
const MAX_SMS_LEN = 1600; // matches send-sms / queue-bulk-sms's own cap

function updateSmsCount(bodyEl, countEl) {
    const { len, parts } = countSmsSegments(bodyEl.value);
    countEl.textContent = `${len} character${len !== 1 ? 's' : ''} · ${parts} SMS part${parts !== 1 ? 's' : ''}`;
    countEl.className = parts > 1 ? 'text-xs text-amber-600 font-medium' : 'text-xs text-gray-500';
}

/**
 * Wires the Compose Email modal's "Also send as a text message" tickbox.
 * Safe to call on a page without those elements (returns silently).
 */
export function initComposeSmsToggle() {
    const cb = document.getElementById('emailAlsoSms');
    const wrap = document.getElementById('emailSmsWrap');
    const body = document.getElementById('emailSmsBody');
    const count = document.getElementById('emailSmsCount');
    if (!cb || !wrap || !body || !count) return;

    cb.addEventListener('change', () => {
        wrap.classList.toggle('hidden', !cb.checked);
        if (cb.checked && !body.value.trim()) {
            // Prefill from the email body, trimmed to the hard cap so the
            // field never opens already over-length.
            const emailBody = document.getElementById('emailBody');
            body.value = (emailBody ? emailBody.value : '').slice(0, MAX_SMS_LEN);
        }
        updateSmsCount(body, count);
    });
    body.addEventListener('input', () => updateSmsCount(body, count));
}

/**
 * Wires the Bulk Email modal's "Also send a text message" tickbox.
 * @param {() => number} getRecipientCount how many bookings will be texted
 */
export function initBulkSmsToggle(getRecipientCount) {
    const cb = document.getElementById('bulkAlsoSms');
    const wrap = document.getElementById('bulkSmsWrap');
    const body = document.getElementById('bulkSmsBody');
    const cost = document.getElementById('bulkSmsCost');
    if (!cb || !wrap || !body || !cost) return;

    const render = () => {
        const { len, parts } = countSmsSegments(body.value);
        const recipients = getRecipientCount() || 0;
        const total = recipients * parts;
        cost.textContent =
            `${len} character${len !== 1 ? 's' : ''} · ${parts} part${parts !== 1 ? 's' : ''} × ` +
            `${recipients} recipient${recipients !== 1 ? 's' : ''} = about ${total} billed text${total !== 1 ? 's' : ''}`;
        cost.className = parts > 1 ? 'text-xs text-amber-700 font-medium mt-1' : 'text-xs text-gray-600 mt-1';
    };

    cb.addEventListener('change', () => {
        wrap.classList.toggle('hidden', !cb.checked);
        render();
    });
    body.addEventListener('input', render);
}

/**
 * Reads a modal's optional SMS body. Returns null when the tickbox is off
 * (nothing to send), or throws with a user-facing message when it's on but
 * the text is unusable — so callers can treat "ticked but empty" as the
 * mistake it is rather than silently sending nothing.
 * @param {'compose'|'bulk'} which
 * @returns {string|null}
 */
export function readOptionalSmsBody(which) {
    const ids = which === 'bulk'
        ? { cb: 'bulkAlsoSms', body: 'bulkSmsBody' }
        : { cb: 'emailAlsoSms', body: 'emailSmsBody' };

    const cb = document.getElementById(ids.cb);
    if (!cb || !cb.checked) return null;

    const el = document.getElementById(ids.body);
    const text = el ? el.value.trim() : '';
    if (!text) throw new Error('Text message is ticked but empty — add the message or untick it.');
    if (text.length > MAX_SMS_LEN) throw new Error(`Text message is too long (${text.length}/${MAX_SMS_LEN} characters).`);
    return text;
}

/**
 * Reads a plain status-SMS tickbox (confirm / reject / cancel). These differ
 * from the compose/bulk ones above: there is no textarea, because the wording
 * comes from an sms_templates row, so the control is just a boolean.
 * @param {string} elId
 */
export function readStatusSmsChecked(elId) {
    const el = document.getElementById(elId);
    return !!(el && el.checked);
}

/** Unticks a status-SMS tickbox so it never carries over to the next booking. */
export function resetStatusSmsCheckbox(elId) {
    const el = document.getElementById(elId);
    if (el) el.checked = false;
}

/** Clears both SMS sub-forms so a ticked state never carries to the next open. */
export function resetSmsToggle(which) {
    const ids = which === 'bulk'
        ? { cb: 'bulkAlsoSms', wrap: 'bulkSmsWrap', body: 'bulkSmsBody' }
        : { cb: 'emailAlsoSms', wrap: 'emailSmsWrap', body: 'emailSmsBody' };

    const cb = document.getElementById(ids.cb);
    const wrap = document.getElementById(ids.wrap);
    const body = document.getElementById(ids.body);
    if (cb) cb.checked = false;
    if (wrap) wrap.classList.add('hidden');
    if (body) body.value = '';
}

/**
 * Manually sends a payment reminder.
 */
export async function manualSendPaymentReminder(id) {
    try {
        const sb = getSupabaseClient();
        const { data: booking, error: fetchErr } = await sb
            .from('bookings')
            .select('*')
            .eq('id', id)
            .single();

        if (fetchErr || !booking) throw new Error("Could not find booking data.");

        // 2. Determine template
        const { subject, body } = await getEmailFromTemplate('payment_reminder', booking, id);

        // 3. Queue Email
        await sendEmail(id, subject, body);

        // 4. Audit Log
        await auditLog('send_payment_reminder', id);

        showToast("Payment reminder sent!");
    } catch (err) {
        console.error('Payment reminder failed:', err);
        showToast("Failed to send reminder: " + err.message, 'error');
    }
}

/**
 * Fetches an email template from the database and replaces placeholders.
 */
export async function getEmailFromTemplate(templateId, booking, id, extraVars = {}) {
    const sb = getSupabaseClient();

    const { data, error } = await sb.from('email_templates')
        .select('subject, body_html')
        .eq('id', templateId)
        .single();

    if (error || !data) {
        console.error("Template error:", error);
        throw new Error(`Could not find template '${templateId}' in database.`);
    }

    let subject = data.subject;
    let body = data.body_html;

    const ownerName = escapeHtml(booking.owner_name || booking.owner || 'Trader');
    const bizName = escapeHtml(booking.business_name || booking.business || 'your business');

    // Cost calculation logic safely duplicated or imported
    let costStr = "the agreed fee";
    if (booking.stall_cost !== undefined && booking.stall_cost !== null) {
        costStr = `£${parseFloat(booking.stall_cost).toFixed(2)}`;
    } else {
        const prefix = booking.instance_prefix || CONFIG.INSTANCE_MAP['DEV'];
        costStr = `£${getStallCost(prefix).toFixed(2)}`;
    }

    let cancelToken = booking.cancel_token || '';

    // If token is missing from the in-memory snapshot, fetch it fresh from the DB
    if (!cancelToken && id) {
        try {
            const { data: tokenData } = await sb.from('bookings')
                .select('cancel_token')
                .eq('id', id)
                .single();
            if (tokenData && tokenData.cancel_token) {
                cancelToken = tokenData.cancel_token;
            }
        } catch (e) {
            console.warn('Could not fetch cancel_token:', e);
        }
    }

    const cancelBase = CONFIG.URLS.CANCEL_URL;
    if (!cancelBase) {
        console.warn('CONFIG.URLS.CANCEL_URL is not set — check the cancel_url row in the settings table / supabase-public.js.');
    }
    const cancelLink = (cancelToken && cancelBase)
        ? `${cancelBase}?token=${encodeURIComponent(cancelToken)}`
        : (cancelBase || '');
    // Built from the same structured settings shown on the Bank Transfer
    // Payment Details settings card — no separate freeform "bank details"
    // setting anymore (it duplicated this same information).
    const bankDetails = `Account Name: ${CONFIG.BANK_ACCOUNT_NAME}, Sort Code: ${CONFIG.BANK_SORT_CODE}, Account Number: ${CONFIG.BANK_ACCOUNT_NUMBER}`;
    const locationId = escapeHtml(booking.location_display || 'TBA');
    const reason = escapeHtml(extraVars.reason || 'Oversubscribed / Category Full');

    const replaceVars = (str) => {
        return str
            .replace(/\{\{owner_name\}\}/g, ownerName)
            .replace(/\{\{business_name\}\}/g, bizName)
            .replace(/\{\{booking_id\}\}/g, id)
            .replace(/\{\{cancel_link\}\}/g, cancelLink)
            .replace(/\{\{cost\}\}/g, costStr)
            .replace(/\{\{bank_details\}\}/g, bankDetails)
            .replace(/\{\{location_id\}\}/g, locationId)
            .replace(/\{\{reason\}\}/g, reason);
    };

    return {
        subject: replaceVars(subject),
        body: replaceVars(body)
    };
}

// SMS templates budget for a fixed-length reason (see the segment-budget
// test in tests/sms-send.test.mjs). An admin's free-typed rejection reason
// has no length limit of its own, so it's truncated to this many characters
// before substitution — otherwise a rambling reason would silently push the
// message to 2+ billed parts, exactly the bug the templates were fixed for
// in 20260726100000_sms_templates_single_part.sql.
const MAX_SMS_REASON_LEN = 40;

/**
 * Fetches a plain-text SMS template from sms_templates and substitutes the
 * same placeholder set as getEmailFromTemplate. Deliberately does NOT
 * escapeHtml() the values: an SMS is plain text, so escaping would render
 * "&amp;" / "&#39;" literally on the handset. Returns the resolved body string.
 *
 * @param {object} [extraVars] currently only `reason` (Rejected), mirroring
 *   getEmailFromTemplate's extraVars. Same default as the email template.
 */
export async function getSmsFromTemplate(templateId, booking, id, extraVars = {}) {
    const sb = getSupabaseClient();

    const { data, error } = await sb.from('sms_templates')
        .select('body')
        .eq('id', templateId)
        .single();

    if (error || !data) {
        console.error("SMS template error:", error);
        throw new Error(`Could not find SMS template '${templateId}' in database.`);
    }

    const ownerName = booking.owner_name || booking.owner || 'Trader';
    const bizName = booking.business_name || booking.business || 'your business';

    let costStr = "the agreed fee";
    if (booking.stall_cost !== undefined && booking.stall_cost !== null) {
        costStr = `£${parseFloat(booking.stall_cost).toFixed(2)}`;
    } else {
        const prefix = booking.instance_prefix || CONFIG.INSTANCE_MAP['DEV'];
        costStr = `£${getStallCost(prefix).toFixed(2)}`;
    }

    let reason = extraVars.reason || 'Oversubscribed / Category Full';
    if (reason.length > MAX_SMS_REASON_LEN) {
        // ASCII "...", not the "…" glyph: a single non-GSM-7 character forces
        // the WHOLE message into UCS-2 encoding, dropping the per-part limit
        // from 160 to 70 — far more expensive than the overlong reason this
        // truncation exists to guard against. Caught by the segment-budget
        // test in tests/sms-send.test.mjs.
        reason = reason.slice(0, MAX_SMS_REASON_LEN - 3) + '...';
    }

    // Not truncated, unlike reason: an admin assigning several pitches to one
    // stall is a real, meaningful value, not a rambling free-text field to
    // guard against. The location_update template is sized to stay within a
    // single billed part at a realistic multi-pitch length (see the
    // 20260729090000 migration).
    const locationId = booking.location_display || 'TBA';

    // Same cancel_link derivation as getEmailFromTemplate(): prefer the
    // in-memory booking's cancel_token, falling back to a fresh DB fetch
    // when it's missing from whatever snapshot the caller passed in (e.g.
    // a Kanban row that never selected the column). Deliberately not
    // truncated or made optional — this and bank_details are the whole
    // point of the 20260728100000 migration, so the templates that carry
    // them are allowed to bill as more than one part (see the segment-budget
    // test in tests/sms-send.test.mjs, which now exempts these templates).
    let cancelToken = booking.cancel_token || '';
    if (!cancelToken && id) {
        try {
            const { data: tokenData } = await sb.from('bookings')
                .select('cancel_token')
                .eq('id', id)
                .single();
            if (tokenData && tokenData.cancel_token) {
                cancelToken = tokenData.cancel_token;
            }
        } catch (e) {
            console.warn('Could not fetch cancel_token:', e);
        }
    }
    const cancelBase = CONFIG.URLS.CANCEL_URL;
    const cancelLink = (cancelToken && cancelBase)
        ? `${cancelBase}?token=${encodeURIComponent(cancelToken)}`
        : (cancelBase || '');
    // Built from the same structured settings as getEmailFromTemplate's copy
    // — not escapeHtml()'d, since SMS is plain text.
    const bankDetails = `Account Name: ${CONFIG.BANK_ACCOUNT_NAME}, Sort Code: ${CONFIG.BANK_SORT_CODE}, Account Number: ${CONFIG.BANK_ACCOUNT_NUMBER}`;

    return data.body
        .replace(/\{\{owner_name\}\}/g, ownerName)
        .replace(/\{\{business_name\}\}/g, bizName)
        .replace(/\{\{booking_id\}\}/g, id)
        .replace(/\{\{cost\}\}/g, costStr)
        .replace(/\{\{reason\}\}/g, reason)
        .replace(/\{\{location_id\}\}/g, locationId)
        .replace(/\{\{cancel_link\}\}/g, cancelLink)
        .replace(/\{\{bank_details\}\}/g, bankDetails);
}

/**
 * Queues a location allocation email using a database template.
 * @param {string} id 
 */
export async function queueLocationEmail(id) {
    const sb = getSupabaseClient();

    // 1. Fetch booking data
    const { data: booking, error: fErr } = await sb
        .from('bookings')
        .select('email, owner_name, business_name, instance_prefix, cancel_token')
        .eq('id', id)
        .single();

    if (fErr || !booking) throw new Error("Could not find booking data: " + (fErr?.message || "Not found"));

    const { data: locRows, error: locErr } = await sb
        .from('booking_locations')
        .select('location_id')
        .eq('booking_id', id);
    if (locErr) throw locErr;

    const locationIds = (locRows || []).map(r => r.location_id);
    if (locationIds.length === 0) throw new Error("No location assigned yet.");
    booking.location_display = locationIds.join(', ');

    // 2. Generate content from template
    const { subject, body } = await getEmailFromTemplate('location_update', booking, id);

    // 3. Queue via API
    await sendEmail(id, subject, body);

    // 4. Audit Log
    await auditLog('location_email_queued', id, { location_ids: locationIds });
}

/**
 * Queues a location allocation SMS using a database template — the optional
 * SMS counterpart to queueLocationEmail(), sent alongside it from Location
 * Manager's "Also send a text message" tickbox (both the individual "Send
 * Location" button and the bulk "Send Bulk Emails" button). Deliberately a
 * self-contained sibling rather than a shared internal helper: it re-fetches
 * the booking/location rows independently, matching queueLocationEmail's own
 * standalone shape, so the two can be called (and can fail) independently of
 * each other — see the callers in js/locations.js for why that matters.
 * @param {string} id
 */
export async function queueLocationSms(id) {
    const sb = getSupabaseClient();

    const { data: booking, error: fErr } = await sb
        .from('bookings')
        .select('phone, owner_name, business_name, instance_prefix, stall_cost, cancel_token')
        .eq('id', id)
        .single();

    if (fErr || !booking) throw new Error("Could not find booking data: " + (fErr?.message || "Not found"));
    if (!booking.phone) throw new Error("This booking has no phone number.");

    const { data: locRows, error: locErr } = await sb
        .from('booking_locations')
        .select('location_id')
        .eq('booking_id', id);
    if (locErr) throw locErr;

    const locationIds = (locRows || []).map(r => r.location_id);
    if (locationIds.length === 0) throw new Error("No location assigned yet.");
    booking.location_display = locationIds.join(', ');

    const smsBody = await getSmsFromTemplate('location_update', booking, id);
    await sendBookingSms(id, smsBody);

    await auditLog('location_sms_queued', id, { location_ids: locationIds });
}

/**
 * Sends an optional status-change SMS from a template, when the admin ticked
 * the box on the confirm/reject/cancel modal.
 *
 * Never throws. By the time this runs the status write — and any email — has
 * already committed, so a texting failure must degrade to a warning rather
 * than propagate into sharedUpdateStatus's outer catch, which would report
 * "Failed to update" for a change that actually succeeded. Same rule v7.12.0
 * established for the email side.
 *
 * @param {boolean} sendSms whether the tickbox was ticked
 * @param {string} templateId row in sms_templates
 * @param {object} booking
 * @param {string} id
 * @param {string} verb past-tense word for the failure toast ("confirmed")
 * @param {object} [extraVars] forwarded to getSmsFromTemplate (e.g. {reason})
 */
async function maybeSendStatusSms(sendSms, templateId, booking, id, verb, extraVars = {}) {
    if (!sendSms) return;
    try {
        const smsBody = await getSmsFromTemplate(templateId, booking, id, extraVars);
        await sendBookingSms(id, smsBody);
        showToast('Text message sent', 'info');
    } catch (smsErr) {
        console.error(`${templateId} SMS failed for ${id}:`, smsErr);
        showToast(`Booking ${verb}, but the text failed to send: ${smsErr.message}`, 'error');
    }
}

/**
 * Shared logic to update a booking status.
 */
export async function sharedUpdateStatus(id, status, allBookings, options = {}) {
    const { reason = null, sendSms = false, onSuccess, onError } = options;

    try {
        // 1. Update DB Status
        await updateBookingStatus(id, status, reason);

        // 2. Handle Confirmation specific logic
        //
        // The email send is a side effect of a status change that has
        // *already* been committed above - it must never be allowed to
        // throw into the outer catch, which would show "Failed to update"
        // (a lie, the status write already succeeded), skip onSuccess (so
        // the card never moves / UI stays out of sync with the real DB
        // row), and leave the trader silently un-notified with no signal
        // to the admin that anything needs retrying. A missing/misconfigured
        // email template must degrade to a warning, not a rollback illusion.
        if (status === 'Confirmed') {
            // Only reachable for a free confirmation — a chargeable confirm
            // never lands on 'Confirmed' directly, it always goes through
            // Stripe (Payment Requested) or a manually recorded bank
            // transfer instead, each of which sends its own confirmation
            // email (stripe-webhook / js/payments.js's saveBankTransferPayment).
            const booking = allBookings.find(b => b.id === id);
            await finalizeConfirmation(id);

            if (booking) {
                try {
                    const { subject, body } = await getEmailFromTemplate('confirmed_free', booking, id);
                    await sendEmail(id, subject, body);
                    showToast('Booking confirmed and email queued');
                } catch (emailErr) {
                    console.error(`Confirmation email failed for ${id}:`, emailErr);
                    showToast(`Booking confirmed, but the email failed to send: ${emailErr.message}`, 'error');
                }

                await maybeSendStatusSms(sendSms, 'booking_confirmed', booking, id, 'confirmed');
            } else {
                showToast('Booking confirmed');
            }
        } else if (status === 'Rejected') {
            const booking = allBookings.find(b => b.id === id);
            if (booking) {
                try {
                    const { subject, body } = await getEmailFromTemplate('rejected', booking, id, { reason: reason });
                    await sendEmail(id, subject, body);
                    showToast('Booking rejected and email queued', 'info');
                } catch (emailErr) {
                    console.error(`Rejection email failed for ${id}:`, emailErr);
                    showToast(`Booking rejected, but the email failed to send: ${emailErr.message}`, 'error');
                }

                await maybeSendStatusSms(sendSms, 'booking_rejected', booking, id, 'rejected', { reason });
            } else {
                showToast('Booking rejected', 'info');
            }
        } else if (status === 'Cancelled') {
            // Deliberately no email here: admin-side cancellation has never
            // sent one, and adding it would be an unrequested behaviour
            // change. The optional text may therefore be the ONLY notification
            // the stallholder gets — which is exactly why it's opt-in per
            // cancellation rather than automatic.
            const booking = allBookings.find(b => b.id === id);
            showToast('Booking cancelled', 'info');
            if (booking) {
                await maybeSendStatusSms(sendSms, 'booking_cancelled', booking, id, 'cancelled');
            }
        } else {
            showToast(`Booking moved to ${status}`);
        }

        // 3. Update Local Cache
        const b = allBookings.find(i => i.id === id);
        if (b) b.status = status;

        // 4. Update Detail Pane status badge if open uses DOM calls, we can implement updateDetailStatusBadge here or specific UI file
        // For now, assuming dom element update is handled by the caller or we can export a helper
        // We will leave the DOM updates to the page logic or a separate UI helper mostly

        if (onSuccess) onSuccess(status);

    } catch (err) {
        console.error(`Status update to '${status}' failed for ${id}:`, err);
        showToast("Failed to update: " + err.message, 'error');
        if (onError) onError();
    }
}

/**
 * Resolves a booking's documents to clickable links and renders them into
 * docsEl. Entries already stored as full URLs (bookings submitted before
 * esf-documents became a private bucket) are used directly; bare storage
 * paths (current format) are resolved to signed URLs via a single
 * get-booking-documents call.
 */
async function renderDocumentLinks(docsEl, bookingId, docArray) {
    const isLegacyUrls = docArray.every((part) => {
        try { new URL(part); return true; } catch (e) { return false; }
    });

    let urls = docArray;
    if (!isLegacyUrls) {
        try {
            urls = await getSignedBookingDocuments(bookingId);
        } catch (err) {
            console.warn('Failed to load signed document URLs:', err.message);
            urls = [];
        }
    }

    let html = '';
    docArray.forEach((part, index) => {
        const safeUrl = sanitizeUrl(urls[index] || '');

        if (safeUrl) {
            html += `<a href="${safeUrl}" target="_blank" rel="noopener noreferrer" class="flex items-center text-blue-600 hover:text-blue-800 hover:underline mb-1 font-medium bg-blue-50 p-2 rounded border border-blue-100">
                <svg class="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"></path></svg>
                Open Document ${docArray.length > 1 ? index + 1 : ''}
            </a>`;
        } else {
            html += `<div class="mb-1 text-gray-600 text-xs bg-gray-50 p-1 rounded break-words">${escapeHtml(part)}</div>`;
        }
    });
    docsEl.innerHTML = html;
}

/**
 * Populates the detail pane with booking data.
 */
function populateBasicFields(item) {
    const setTxt = (eid, val) => {
        const el = document.getElementById(eid);
        if (el) el.innerText = val || "--";
    };

    setTxt('d-id', item.id);
    setTxt('d-business', item.business || item.business_name);

    const auditLogLink = document.getElementById('btn-open-audit-log');
    if (auditLogLink) {
        auditLogLink.href = `audit_log.html?target=${encodeURIComponent(item.id)}`;
    }

    const regBusinessEl = document.getElementById('d-registered-business');
    const regBusinessContainer = document.getElementById('registered-business-container');
    if (regBusinessEl && regBusinessContainer) {
        const regName = item.registered_business_name || '';
        if (regName && regName !== '--' && regName.trim() !== '') {
            regBusinessEl.innerText = regName;
            regBusinessContainer.classList.remove('hidden');
        } else {
            regBusinessEl.innerText = '--';
            regBusinessContainer.classList.add('hidden');
        }
    }

    setTxt('d-owner', item.owner || item.owner_name);
    setTxt('d-email', item.email);
    setTxt('d-phone', item.phone || "Not provided");
    setTxt('d-address', item.house || item.address || "N/A");

    const websiteEl = document.getElementById('d-website');
    if (websiteEl) {
        const website = (item.website || '').trim();
        if (!website) {
            websiteEl.innerText = 'Not provided';
        } else {
            // Same fallback shape as the document-link rendering below:
            // sanitizeUrl() only returns a value for http(s)/mailto - anything
            // else (bare text, a stray "javascript:" attempt) still shows the
            // trader's input, just as plain escaped text rather than a clickable
            // href, since the raw value must never be trusted as one.
            const safeUrl = sanitizeUrl(website);
            websiteEl.innerHTML = safeUrl
                ? `<a href="${safeUrl}" target="_blank" rel="noopener noreferrer" class="text-blue-600 hover:text-blue-800 hover:underline">${escapeHtml(website)}</a>`
                : escapeHtml(website);
        }
    }

    setTxt('d-category', item.category);
    setTxt('d-stalltype', item.stall_type);

    const powerEl = document.getElementById('d-power');
    if (powerEl) {
        const power = item.power_required || item.power || 'No power';
        powerEl.innerText = power;
    }

    setTxt('d-desc', item.description || "No description provided.");

    const resEl = document.getElementById('d-resident');
    if (resEl) {
        const isRes = item.is_resident === true;
        resEl.innerText = isRes ? 'Yes' : 'No';
        resEl.className = isRes
            ? "inline-block text-xs font-bold px-2 py-1 rounded bg-blue-100 text-blue-700"
            : "inline-block text-xs font-bold px-2 py-1 rounded bg-gray-100 text-gray-500";
    }

    const charEl = document.getElementById('d-charity');
    if (charEl) {
        const charityStatus = item.is_charity || 'Commercial';
        charEl.innerText = charityStatus;

        if (charityStatus === 'Charity') {
            charEl.className = "inline-block text-xs font-bold px-2 py-1 rounded bg-green-100 text-green-700";
        } else if (charityStatus === 'Not for profit') {
            charEl.className = "inline-block text-xs font-bold px-2 py-1 rounded bg-blue-100 text-blue-700";
        } else {
            charEl.className = "inline-block text-xs font-bold px-2 py-1 rounded bg-gray-100 text-gray-500";
        }
    }

    const locEl = document.getElementById('d-location');
    if (locEl) {
        locEl.innerText = item.location_display || "Unassigned";
        locEl.className = item.location_display
            ? "text-sm font-mono bg-blue-100 px-1 rounded text-blue-800"
            : "text-sm font-mono bg-yellow-100 px-1 rounded text-yellow-800";
    }

    const statusBadge = document.getElementById('d-status-badge');
    if (statusBadge) {
        statusBadge.innerText = item.status;
        let sClass = "bg-gray-100 text-gray-800";
        if (item.status === 'Confirmed') sClass = "bg-green-100 text-green-800";
        else if (item.status === 'Rejected') sClass = "bg-red-100 text-red-800";
        else if (item.status === 'Pending') sClass = "bg-yellow-100 text-yellow-800";

        statusBadge.className = `inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${sClass}`;
    }

    const toggle = (eid, show) => {
        const el = document.getElementById(eid);
        if (el) el.classList.toggle('hidden', !show);
    };
    const canResend = item.status === 'Payment Requested';
    toggle('btn-resend-payment-request', canResend);
    // Reset every open so a ticked state never carries over to the next
    // booking, matching every other opt-in SMS tickbox in this app.
    toggle('resend-sms-wrap', canResend);
    resetStatusSmsCheckbox('resendSendSms');

    const rejContainer = document.getElementById('d-rejection-container');
    const rejReason = document.getElementById('d-rejection-reason');
    if (rejContainer && rejReason) {
        if (item.status === 'Rejected' && item.rejection_reason) {
            rejReason.innerText = item.rejection_reason;
            rejContainer.classList.remove('hidden');
        } else {
            rejContainer.classList.add('hidden');
            rejReason.innerText = '';
        }
    }

    const docsEl = document.getElementById('d-docs');
    if (docsEl) {
        docsEl.innerHTML = '';
        const rawDocs = item.documents;

        if (!rawDocs || rawDocs === "None") {
            docsEl.innerText = "None";
        } else {
            let docArray = [];
            if (Array.isArray(rawDocs)) {
                docArray = rawDocs;
            } else if (typeof rawDocs === 'string') {
                docArray = rawDocs.split(/[\n,]+/).map(p => p.trim()).filter(p => p);
            }

            if (docArray.length === 0) {
                docsEl.innerText = "None";
            } else {
                docsEl.innerText = "Loading documents...";
                renderDocumentLinks(docsEl, item.id, docArray);
            }
        }
    }

    const checkEl = document.getElementById('d-checklist');
    if (checkEl) {
        checkEl.innerText = item.docs_checklist || "No checklist data";
    }

    const otherEl = document.getElementById('d-other');
    if (otherEl) {
        otherEl.innerText = item.other_requirements || item.other || "None";
    }

    const notesEl = document.getElementById('d-notes');
    if (notesEl) {
        notesEl.value = item.admin_notes || item.notes || "";
    }
}

export function populateDetailPane(item) {
    populateBasicFields(item);
    populateFsaSection(item);
    populateGoogleMapsReviews(item);
}

