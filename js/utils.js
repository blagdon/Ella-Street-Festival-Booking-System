import { ESF_PUBLIC_CONFIG } from '../supabase-public.js';
import { CONFIG } from './config.js';

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
    editor: 32, subject: 200, body: 10000, locationId: 20
};

const VALID_STATUSES = ['Pending', 'Confirmed', 'Rejected', 'Cancelled', 'On Hold', 'HCC Checks'];

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
    const prefix = (typeof ESF_PUBLIC_CONFIG !== 'undefined' && ESF_PUBLIC_CONFIG.BOOKING_PREFIX) || "ESF26";
    const regex = new RegExp(`^${prefix}-(FOOD|NONFOOD|DEV|MISC)-\\d{4}$`);
    if (!regex.test(id)) throw new Error('Invalid booking ID format.');
    return id;
}

export function validateStatus(s) {
    if (!VALID_STATUSES.includes(s)) throw new Error(`Invalid status: ${s}`);
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
        } catch (e) {}
    }
    return errMsg;
}

// ===================================================================
// === SECURITY: Bulk Email Rate Limiter ===
// ===================================================================
const _emailRateLog = [];

export function checkEmailRateLimit() {
    const now = Date.now();
    const limit = (CONFIG && CONFIG.EMAIL_RATE_LIMIT) || 10;
    const windowMs = (CONFIG && CONFIG.EMAIL_RATE_WINDOW_MS) || 60000;

    // Remove entries older than the window
    while (_emailRateLog.length > 0 && _emailRateLog[0] < now - windowMs) {
        _emailRateLog.shift();
    }
    if (_emailRateLog.length >= limit) {
        const minutes = windowMs / 60000;
        const timeStr = minutes === 1 ? 'minute' : `${minutes} minutes`;
        throw new Error(`Rate limit: max ${limit} emails per ${timeStr}. Please wait and try again.`);
    }
    _emailRateLog.push(now);
}
