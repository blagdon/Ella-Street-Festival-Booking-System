import { ESF_PUBLIC_CONFIG } from './supabase-public.js';

const EmailConfig = {
    BANK_DETAILS: ESF_PUBLIC_CONFIG.BANK_DETAILS,
    CANCEL_URL: ESF_PUBLIC_CONFIG.CANCEL_URL,
    PORTAL_URL: ESF_PUBLIC_CONFIG.PORTAL_URL
};

export const ESF_EMAIL_TEMPLATES = {

    // --- HELPER: Escape for safe HTML email content ---
    _esc: function (val) {
        return typeof escapeHtml === 'function' ? escapeHtml(val) : (val || '');
    },

    // --- HELPER: Generate Cancel Link ---
    _getCancelLink: function (token) {
        // Use current origin if running in browser (supports localhost/dev)
        const baseUrl = (typeof window !== 'undefined' && window.location.origin && !window.location.origin.includes('ellastreet.co.uk'))
            ? window.location.origin + "/cancel_booking.html"
            : EmailConfig.CANCEL_URL;

        if (!token) return baseUrl;
        return `${baseUrl}?token=${encodeURIComponent(token)}`;
    },

    // 1. APPLICATION RECEIVED (Auto-responder)
    received: function (b) {
        const cancelLink = this._getCancelLink(b.cancel_token);
        return {
            subject: `Application Received (ID: ${b.id})`,
            body: `
                Dear ${this._esc(b.owner_name || b.owner)},<br><br>
                Thank you for applying to trade at the festival.<br><br>
                We’ve successfully received your application for <strong>${this._esc(b.business_name || b.business)}</strong>. Please keep the reference below for your records:<br>
                Booking ID: <strong>${this._esc(b.id)}</strong><br><br>
                Our team is currently reviewing applications and we will be in touch soon.<br><br>
                If you need to cancel your application, you can do so using the link below:<br>
                <a href="${cancelLink}">Cancel Application</a><br><br>
                Kind regards,<br>
                The Fest Stalls Team
            `
        };
    },

    // 2. APPROVED (Payment Request - Legacy, kept for safety)
    approved: function (b) {
        return {
            subject: `Application Approved: ${this._esc(b.business_name || b.business)}`,
            body: `
                Dear ${this._esc(b.owner_name || b.owner)},<br><br>
                Great news! Your application for <b>${this._esc(b.business_name || b.business)}</b> has been approved.<br><br>
                Regards,<br>
                The Fest Stalls Team
            `
        };
    },

    // 3. CONFIRMED (CHARGEABLE) - MISSING FUNCTION RESTORED
    confirmed_chargeable: function (b) {
        const cancelLink = this._getCancelLink(b.cancel_token);
        // Uses 'amount' if available, otherwise defaults to generic message
        const cost = b.amount ? `£${parseFloat(b.amount).toFixed(2)}` : "the agreed fee";

        return {
            subject: `Booking Confirmed - Payment Required (ID: ${b.id})`,
            body: `
                Dear ${this._esc(b.owner_name || b.owner)},<br><br>
                Good news — your booking has been <b>confirmed</b> 🎉<br><br>
                Your application for <b>${this._esc(b.business_name || b.business)}</b> has been approved, and a stall has been provisionally allocated to you.<br><br>
                <b>Next Steps: Payment Required</b><br>
                To secure your pitch, please arrange payment of <b>${cost}</b> to the account below:<br><br>
                <b>${EmailConfig.BANK_DETAILS}</b><br>
                Reference: <b>${this._esc(b.id)}</b><br><br>
                Please make this payment within 7 days. Once we receive your payment, your pitch will be fully secured.<br><br>
                If you no longer wish to trade, please cancel immediately so we can offer the space to someone else:<br>
                <a href="${cancelLink}">Cancel Link</a><br><br>
                Kind regards,<br>
                The Fest Stalls Team
            `
        };
    },

    // 4. CONFIRMED (FREE / CHARITY) - MISSING FUNCTION RESTORED
    confirmed_free: function (b) {
        const cancelLink = this._getCancelLink(b.cancel_token);
        return {
            subject: `Booking Confirmed (ID: ${b.id})`,
            body: `
                Dear ${this._esc(b.owner_name || b.owner)},<br><br>
                Good news — your booking has been <b>confirmed</b> 🎉<br><br>
                Your application for <b>${this._esc(b.business_name || b.business)}</b> has been approved and allocated a <b>Free Stall</b> at the festival.<br><br>
                Booking reference: <b>${this._esc(b.id)}</b><br>
                Stall type: <b>Free stall</b><br>
                Location: <b>${this._esc(b.location_id || 'TBA')}</b><br><br>
                There is <b>no charge</b> for this booking.<br><br>
                If you no longer require this stall, please let us know by cancelling your booking using the link below:<br>
                <a href="${cancelLink}">Cancel Link</a><br><br>
                We're looking forward to having you at the festival!<br><br>
                Kind regards,<br>
                The Fest Stalls Team
            `
        };
    },

    // 5. REJECTED
    rejected: function (b) {
        return {
            subject: `Update regarding your application (ID: ${b.id})`,
            body: `
                Dear ${this._esc(b.owner_name || b.owner)},<br><br>
                Thank you for your interest in the Ella Street Festival.<br><br>
                Unfortunately, we are unable to offer you a pitch for <b>${this._esc(b.business_name || b.business)}</b> this year.<br>
                Reason: ${this._esc(b.reason || 'Oversubscribed / Category Full')}<br><br>
                We wish you all the best.<br><br>
                Regards,<br>
                The Fest Stalls Team
            `
        };
    },

    // 6. CANCELLATION ACKNOWLEDGED (User Initiated)
    cancelled: function (b) {
        return {
            subject: `Cancellation Confirmed (ID: ${b.id})`,
            body: `
                Dear ${this._esc(b.owner_name || b.owner)},<br><br>
                Your booking ${b.id} has been cancelled as requested.<br><br>
                Regards,<br>
                The Fest Stalls Team
            `
        };
    },

    // 7. CANCELLATION PROCESSED (By Admin)
    cancellation_confirmed: function (b) {
        return {
            subject: `Cancellation Processed (ID: ${b.id})`,
            body: `
                Dear ${this._esc(b.owner_name || b.owner)},<br><br>
                We have processed the cancellation of your booking for <b>${this._esc(b.business_name || b.business)}</b>.<br><br>
                If this was a mistake, please reply to this email immediately.<br><br>
                Regards,<br>
                The Fest Stalls Team
            `
        };
    },

    // 8. LOCATION UPDATE (Map Allocation)
    location_update: function (b) {
        return {
            subject: `Stall Location Allocation: ${this._esc(b.business_name || b.business)}`,
            body: `
                Dear ${this._esc(b.owner_name || b.owner)},<br><br>
                We are pleased to confirm your stall location for the festival.<br><br>
                Business: <b>${this._esc(b.business_name || b.business)}</b><br>
                Assigned Location: <b>${this._esc(b.location_id)}</b><br><br>
                Please refer to the festival map for exact positioning.<br><br>
                Regards,<br>
                The Festival Team
            `
        };
    },

    // 9. HCC BATCH CHECK (To Council)
    hcc_batch_check: function (records) {
        // Generate Unique Batch Reference
        const now = new Date();
        const batchRef = `HCC-${now.toISOString().slice(2, 10).replace(/-/g, '')}-${now.getHours()}${now.getMinutes()}`;

        const rows = records.map(r => {
            const email = r.bookings?.email || r.email || 'N/A';
            const phone = r.bookings?.phone || r.phone || 'N/A';

            return `<tr>
<td style="padding:8px; border:1px solid #ddd;">${this._esc(r.business_name)}</td>
<td style="padding:8px; border:1px solid #ddd;">${this._esc(r.registered_business_name || r.business_name)}</td>
<td style="padding:8px; border:1px solid #ddd;">${this._esc(r.owner_name)}</td>
<td style="padding:8px; border:1px solid #ddd;">${this._esc(email)}</td>
<td style="padding:8px; border:1px solid #ddd;">${this._esc(phone)}</td>
<td style="padding:8px; border:1px solid #ddd;">${this._esc(r.booking_id)}</td>
</tr>`;
        }).join('');

        return {
            subject: `ESF26 Food Safety Checks - Batch (${records.length}) [Ref: ${batchRef}]`,
            body: `<p>Dear Food Safety Team,</p>
<p>Please verify the following trader applications for Ella Street Festival 2026:</p>
<p><b>Batch Reference: ${batchRef}</b></p>
<table style="width:100%; border-collapse: collapse; font-family: sans-serif; font-size: 14px; margin-top: 10px;">
<thead>
<tr style="background-color:#f2f2f2;">
<th style="padding:8px; border:1px solid #ddd; text-align:left;">Trading Name</th>
<th style="padding:8px; border:1px solid #ddd; text-align:left;">Registered Name</th>
<th style="padding:8px; border:1px solid #ddd; text-align:left;">Owner</th>
<th style="padding:8px; border:1px solid #ddd; text-align:left;">Email</th>
<th style="padding:8px; border:1px solid #ddd; text-align:left;">Phone</th>
<th style="padding:8px; border:1px solid #ddd; text-align:left;">Ref ID</th>
</tr>
</thead>
<tbody>${rows}</tbody>
</table>
<p>Please confirm approval status at your earliest convenience, quoting the reference number above.</p>
<p>Regards,<br>ESF Management</p>`
        };
    },

    // 10. PAYMENT REMINDER
    payment_reminder: function (b) {
        const cancelLink = this._getCancelLink(b.cancel_token);
        // Fallback to stall_cost if amount is missing
        const amount = b.amount || b.stall_cost || 0;
        const cost = amount ? `£${parseFloat(amount).toFixed(2)}` : "the agreed fee";

        return {
            subject: `Payment Reminder: Booking (ID: ${b.id})`,
            body: `
                Dear ${this._esc(b.owner_name || b.owner)},<br><br>
                This is a friendly reminder regarding your stall booking for <b>${this._esc(b.business_name || b.business)}</b>.<br><br>
                We have not yet received your payment of <b>${cost}</b>.<br><br>
                <b>Account Details:</b><br>
                <b>${EmailConfig.BANK_DETAILS}</b><br>
                Reference: <b>${this._esc(b.id)}</b><br><br>
                Please arrange payment as soon as possible to secure your pitch. If you have already made the payment, please disregard this message.<br><br>
                If you no longer wish to trade, please cancel your booking here:<br>
                <a href="${cancelLink}">Cancel Link</a><br><br>
                Kind regards,<br>
                The Fest Stalls Team
            `
    }
};

if (typeof window !== 'undefined') {
    window.ESF_EMAIL_TEMPLATES = ESF_EMAIL_TEMPLATES;
}