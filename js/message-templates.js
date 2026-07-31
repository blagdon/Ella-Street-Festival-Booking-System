// @ts-check
import { getSupabaseClient } from './supabase.js';
import { escapeHtml } from './utils.js';
import { getStallCost, CONFIG } from './config.js';

/**
 * Fetches an email template from the database and replaces placeholders.
 * @param {{ reason?: string }} [extraVars]
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
    let costStr;
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
 * @param {{ reason?: string }} [extraVars] currently only `reason` (Rejected), mirroring
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

    let costStr;
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
