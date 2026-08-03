// @ts-check
import { CONFIG, getActiveBookingPrefix } from './config.js';

// ===================================================================
// === SECURITY: HTML Escaping Utilities ===
// ===================================================================
export function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#x27;');
}

// ===================================================================
// === SHARED: Booking List Sorting (Kanban, Summary, Location Manager) ===
// ===================================================================
/**
 * Returns a new array of bookings sorted by id or business name.
 * @param {Array} list
 * @param {'id'|'business'} field
 * @param {'asc'|'desc'} direction
 */
export function sortBookings(list, field, direction) {
    const getValue = field === 'business'
        ? (b) => (b.business_name || b.business || '').toString()
        : (b) => (b.id || '').toString();

    const sorted = [...list].sort((a, b) =>
        getValue(a).localeCompare(getValue(b), undefined, { numeric: true, sensitivity: 'base' })
    );
    return direction === 'desc' ? sorted.reverse() : sorted;
}

export function sanitizeUrl(url) {
    if (!url || typeof url !== 'string') return '';
    const trimmed = url.trim();
    if (trimmed.startsWith('https://') || trimmed.startsWith('http://') || trimmed.startsWith('mailto:')) {
        return escapeHtml(trimmed);
    }
    return '';
}

// ===================================================================
// === SECURITY: Input Validation ===
// ===================================================================
// Keep max lengths consistent for basic protection
export const MAX_FIELD_LENGTHS = {
    business: 128, owner: 64, email: 254, phone: 30, category: 64,
    description: 500, house: 256, other: 500, note: 2000, bank_ref: 64,
    editor: 32, subject: 200, body: 10000, website: 256
};

export function validateString(val, maxLen) {
    if (val === null || val === undefined) return '';
    const s = String(val);
    if (s.length > maxLen) throw new Error(`Input exceeds maximum length of ${maxLen} characters.`);
    return s;
}

export function validateEmail(val) {
    const s = validateString(val, MAX_FIELD_LENGTHS.email);
    if (s && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) throw new Error('Invalid email format.');
    return s;
}

export function validateBookingId(id) {
    if (!id || typeof id !== 'string') throw new Error('Missing booking ID.');
    // Must match the same event-aware prefix resolution CONFIG.INSTANCE_MAP
    // uses to actually generate/filter booking IDs (js/config.js), not the
    // raw settings-table value. The settings.booking_prefix row and the
    // active event's own booking_prefix are two independently-editable
    // values that can drift apart (reported live: settings had 'ESF28'
    // while the event's real bookings were 'ESF26-...', rejecting every
    // genuinely valid ID) — the event's value is the one real booking IDs
    // are actually built from, so it's the one this must trust.
    const prefix = getActiveBookingPrefix();
    const regex = new RegExp(`^${prefix}-(FOOD|NONFOOD|DEV|MISC)-\\d{4}$`);
    if (!regex.test(id)) throw new Error('Invalid booking ID format.');
    return id;
}

export function validateStatus(s) {
    if (!CONFIG.UI.STATUS_LIST.includes(s)) throw new Error(`Invalid status: ${s}`);
    return s;
}

// ===================================================================
// === SECURITY: Safe Error Messages ===
// ===================================================================
export function safeError(err) {
    if (err && err.message) {
        const msg = err.message.toLowerCase();
        if (msg.includes('violates') || msg.includes('duplicate') || msg.includes('constraint')) {
            return 'A database conflict occurred. Please refresh and try again.';
        }
        if (msg.includes('jwt') || msg.includes('token') || msg.includes('auth')) {
            return 'Authentication error. Please refresh the page.';
        }
        if (msg.includes('row-level security') || msg.includes('policy') || msg.includes('recursion')) {
            return 'Access denied: Security policy violation. Please contact an administrator.';
        }
        if (msg.includes('relation') || msg.includes('column') || msg.includes('syntax') || msg.includes('supabase') || msg.includes('postgres') || msg.includes('pgrst')) {
            return 'A system error occurred. Please contact an administrator.';
        }
        // Fallback: only show the message if it looks user-safe
        return err.message;
    }
    return String(err) || 'An unexpected error occurred.';
}

export async function parseEdgeFunctionError(error, defaultMsg = "Request failed") {
    let errMsg = error?.message || defaultMsg;
    if (error && error.context && typeof error.context.text === 'function') {
        try {
            const text = await error.context.text();
            const json = JSON.parse(text);
            if (json.error) {
                errMsg = json.error;
            } else if (json.message) {
                errMsg = json.message;
            }
        } catch (e) {
            // Body wasn't JSON (or had no .error/.message field) - errMsg
            // already has the generic fallback set above.
        }
    }
    return errMsg;
}

// GSM-7 character set. Anything outside it forces the whole message to UCS-2,
// which drops the per-part limit from 160 to 70 — a single £, curly quote or
// emoji can therefore double the cost of a text.
const GSM7_RE = /^[A-Za-z0-9 \r\n@£$¥èéùìòÇØøÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ!"#¤%&'()*+,\-./:;<=>?¡ÄÖÑÜ§¿äöñüà^{}\\[~\]|€]*$/;

/**
 * Billed-SMS-segment estimate for a message body.
 *
 * MUST stay in step with countSegments() in
 * supabase/functions/_shared/sms.ts, which is what actually gets recorded
 * against the send — if the two drift, the figure shown to the admin before
 * sending stops matching what they are charged for. Duplicated rather than
 * imported because that file is Deno/TypeScript running server-side and this
 * one is a browser ES module; there is no shared module boundary between them.
 *
 * @param {string} text
 * @returns {{len: number, parts: number, encoding: string}}
 */
export function countSmsSegments(text) {
    const body = text || '';
    const unicode = !GSM7_RE.test(body);
    const len = body.length;
    let parts;
    if (unicode) parts = len === 0 ? 1 : (len <= 70 ? 1 : Math.ceil(len / 67));
    else parts = len <= 160 ? 1 : Math.ceil(len / 153);
    return { len, parts, encoding: unicode ? 'Unicode (70/part)' : 'GSM-7 (160/part)' };
}

// ===================================================================
// === SHARED: Unsaved-form navigation guard (public booking forms) ===
// ===================================================================
/**
 * Warns before an accidental tab close, back-navigation, or nav-link click
 * loses an un-submitted form's input, via beforeunload — the browser's own
 * generic prompt, since returnValue's text is never actually shown by modern
 * browsers regardless of what it's set to.
 *
 * The booking forms this is for don't navigate away on success (they swap
 * in an inline success view and stay on the page), so nothing else would
 * ever clear the dirty flag — call the returned markSubmitted() right after
 * a successful submit, or a legitimate post-success reload (the "Start a
 * new booking" button) would trigger a false warning.
 * @param {HTMLFormElement} form
 * @returns {{ markSubmitted: () => void }}
 */
export function guardUnsavedForm(form) {
    let dirty = false;
    let submitted = false;

    form.addEventListener('input', () => { dirty = true; });

    window.addEventListener('beforeunload', (e) => {
        if (!dirty || submitted) return;
        e.preventDefault();
        e.returnValue = '';
    });

    return {
        markSubmitted() { submitted = true; }
    };
}
