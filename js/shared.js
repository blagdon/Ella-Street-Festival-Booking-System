import { getSupabaseClient } from './supabase.js';
import { updateBookingStatus, finalizeConfirmation, sendEmail, auditLog, getSignedBookingDocuments } from './api.js';
import { showToast } from './ui.js';
import { escapeHtml, sanitizeUrl } from './utils.js';
import { getStallCost, CONFIG } from './config.js';
import { populateFsaSection } from './fsa-ratings.js';
import { populateGoogleMapsReviews } from './google-reviews.js';

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
 * Shared logic to update a booking status.
 */
export async function sharedUpdateStatus(id, status, allBookings, options = {}) {
    const { reason = null, onSuccess, onError } = options;

    try {
        // 1. Update DB Status
        await updateBookingStatus(id, status, reason);

        // 2. Handle Confirmation specific logic
        if (status === 'Confirmed') {
            // Only reachable for a free confirmation — a chargeable confirm
            // never lands on 'Confirmed' directly, it always goes through
            // Stripe (Payment Requested) or a manually recorded bank
            // transfer instead, each of which sends its own confirmation
            // email (stripe-webhook / js/payments.js's saveBankTransferPayment).
            const booking = allBookings.find(b => b.id === id);
            await finalizeConfirmation(id);

            if (booking) {
                const { subject, body } = await getEmailFromTemplate('confirmed_free', booking, id);
                await sendEmail(id, subject, body);
                showToast('Booking confirmed and email queued');
            } else {
                showToast('Booking confirmed');
            }
        } else if (status === 'Rejected') {
            const booking = allBookings.find(b => b.id === id);
            if (booking) {
                const { subject, body } = await getEmailFromTemplate('rejected', booking, id, { reason: reason });
                await sendEmail(id, subject, body);
                showToast('Booking rejected and email queued', 'info');
            } else {
                showToast('Booking rejected', 'info');
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
    toggle('btn-resend-payment-request', item.status === 'Payment Requested');

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

