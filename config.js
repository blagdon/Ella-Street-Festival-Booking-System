/**
 * config.js
 * Handles direct interaction with Supabase.
 * Unified Handler for: Kanban, Summary, Payments, Locations, Map, Editor, and Email.
 * Version: Cloud Native + Instance Switcher + Docs Checklist Fix + Allowed Types + Global Collision Check
 */

// ===================================================================
// === 1. INSTANCE CONFIGURATION (Dynamic Switcher) ===
// ===================================================================

// Check LocalStorage for user preference (Defaults to 'DEV')
const CURRENT_INSTANCE = (typeof localStorage !== 'undefined' && localStorage.getItem('ESF_INSTANCE'))
    ? localStorage.getItem('ESF_INSTANCE')
    : 'DEV';

// Instance logged at init (avoid leaking config in production console)

// Database Prefixes (Strictly enforces data separation)
const INSTANCE_MAP = {
    'DEV': 'ESF26-DEV-',
    'FOOD': 'ESF26-FOOD-',
    'GENERAL': 'ESF26-NONFOOD-', // 'General' maps to Non-Food data
    'MISC': 'ESF26-MISC-'        // 'MISC' for non-bookable facilities (toilets, first aid, etc.)
};

const HCC_COUNCIL_EMAIL = 'foodand.health&safety@hullcc.gov.uk'; // <--- NEW CONSTANT

// ===================================================================
// === SECURITY: HTML Escaping Utilities ===
// ===================================================================
function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#x27;');
}

function sanitizeUrl(url) {
    if (!url || typeof url !== 'string') return '';
    const trimmed = url.trim();
    if (trimmed.startsWith('https://') || trimmed.startsWith('http://')) {
        return escapeHtml(trimmed);
    }
    return '';
}

// ===================================================================
// === SECURITY: Input Validation ===
// ===================================================================
const VALID_STATUSES = ['Pending', 'Confirmed', 'Rejected', 'Cancelled', 'On Hold', 'HCC Checks'];
const MAX_FIELD_LENGTHS = {
    business: 128, owner: 64, email: 254, phone: 30, category: 64,
    description: 500, house: 256, other: 500, note: 2000, bank_ref: 64,
    editor: 32, subject: 200, body: 10000, locationId: 20
};

function validateString(val, maxLen) {
    if (val === null || val === undefined) return '';
    const s = String(val);
    if (s.length > maxLen) throw new Error(`Input exceeds maximum length of ${maxLen} characters.`);
    return s;
}

function validateEmail(val) {
    const s = validateString(val, MAX_FIELD_LENGTHS.email);
    if (s && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) throw new Error('Invalid email format.');
    return s;
}

function validateBookingId(id) {
    if (!id || typeof id !== 'string') throw new Error('Missing booking ID.');
    if (!/^ESF26-(FOOD|NONFOOD|DEV|MISC)-\d{4}$/.test(id)) throw new Error('Invalid booking ID format.');
    return id;
}

function validateStatus(s) {
    if (!VALID_STATUSES.includes(s)) throw new Error(`Invalid status: ${s}`);
    return s;
}

// ===================================================================
// === SECURITY: Safe Error Messages ===
// ===================================================================
function safeError(err) {
    if (err && err.message) {
        const msg = err.message;
        if (msg.includes('violates') || msg.includes('duplicate') || msg.includes('constraint')) {
            return 'A database conflict occurred. Please refresh and try again.';
        }
        if (msg.includes('JWT') || msg.includes('token') || msg.includes('auth')) {
            return 'Authentication error. Please refresh the page.';
        }
        if (msg.includes('relation') || msg.includes('column') || msg.includes('syntax')) {
            return 'A system error occurred. Please contact an administrator.';
        }
    }
    // Fallback: only show the message if it looks user-safe (no internal details)
    if (err && err.message) {
        const msg = err.message;
        // Block messages that may leak internal details
        if (msg.includes('supabase') || msg.includes('postgres') || msg.includes('pgrst') ||
            msg.includes('schema') || msg.includes('table') || msg.includes('row-level')) {
            return 'A system error occurred. Please contact an administrator.';
        }
        return msg;
    }
    return 'An unexpected error occurred.';
}

// ===================================================================
// === SECURITY: Bulk Email Rate Limiter ===
// ===================================================================
const _emailRateLog = [];
const EMAIL_RATE_LIMIT = 10;       // max emails per window
const EMAIL_RATE_WINDOW_MS = 60000; // 1 minute

function checkEmailRateLimit() {
    const now = Date.now();
    // Remove entries older than the window
    while (_emailRateLog.length > 0 && _emailRateLog[0] < now - EMAIL_RATE_WINDOW_MS) {
        _emailRateLog.shift();
    }
    if (_emailRateLog.length >= EMAIL_RATE_LIMIT) {
        throw new Error(`Rate limit: max ${EMAIL_RATE_LIMIT} emails per minute. Please wait and try again.`);
    }
    _emailRateLog.push(now);
}

const UI_CONFIG = {
    STALL_COST: {
        FOOD: 50.00,
        GENERAL: 25.00,
        DEV: 90.00
    },
    STATUS_LIST: ['Pending', 'Confirmed', 'Rejected', 'Cancelled', 'On Hold', 'HCC Checks'],
    // DEFINED STALL TYPES FOR DROPDOWNS
    ALLOWED_TYPES: ["Dev", "Food", "Non-Food", "Attraction", "Barrier", "Ramp", "First Aid", "Beach", "Music", "Green", "Police", "Fire Engine", "Toilet", "Spoken Word", "Ice Cream Van"],
    STATUS_COLORS: {
        'Pending': 'bg-yellow-100 text-yellow-700',
        'Confirmed': 'bg-green-100 text-green-700',
        'Rejected': 'bg-red-100 text-red-700',
        'Cancelled': 'bg-gray-100 text-gray-700',
        'On Hold': 'bg-purple-100 text-purple-700',
        'HCC Checks': 'bg-orange-100 text-orange-700'
    }
};

/**
 * Resolves the stall cost for a given instance prefix string or instance key.
 * Accepts: 'ESF26-FOOD-', 'ESF26-NONFOOD-', 'ESF26-DEV-', 'FOOD', 'GENERAL', 'DEV'
 * Falls back to current instance cost, then FOOD cost.
 */
function getStallCost(prefixOrKey) {
    const costs = UI_CONFIG.STALL_COST;
    if (prefixOrKey) {
        const p = prefixOrKey.toUpperCase();
        if (p.includes('FOOD') && !p.includes('NONFOOD')) return costs.FOOD;
        if (p.includes('NONFOOD') || p === 'GENERAL') return costs.GENERAL;
        if (p.includes('DEV')) return costs.DEV;
    }
    // Fallback: use current instance
    return costs[CURRENT_INSTANCE] || costs.FOOD;
}

// ===================================================================
// === 2. SUPABASE SETUP ===
// ===================================================================
const SUPABASE_URL = typeof ESF_PUBLIC_CONFIG !== 'undefined' ? ESF_PUBLIC_CONFIG.SUPABASE_URL : "https://rsnxhuhibglieofikkpo.supabase.co";
const SUPABASE_KEY = typeof ESF_PUBLIC_CONFIG !== 'undefined' ? ESF_PUBLIC_CONFIG.SUPABASE_KEY : "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJzbnhodWhpYmdsaWVvZmlra3BvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njk2Nzg5MjcsImV4cCI6MjA4NTI1NDkyN30.QNrMVCc9FFdIAR4wRv6g4V4p2JA8pbCoaf8zLRuu0fw";

// Table Constants
const TBL_BOOKINGS = "bookings";
const TBL_PAYMENTS = "payments";
const TBL_EMAIL_QUEUE = "email_queue";
const TBL_LOCATIONS = "locations";
const TBL_AUDIT_LOGS = "audit_logs";

// Global variable to hold the client once initialized
let _activeSbClient = null;

// ===================================================================
// === 3. DATA ADAPTER (Converts DB Rows to App Objects) ===
// ===================================================================
function adaptRow(row) {
    const rawCost = (row.stall_cost !== undefined && row.stall_cost !== null) ? row.stall_cost : 0;

    // CRITICAL FIX: Preserve text values for is_charity and power_required
    // is_charity values: "Charity", "Not for profit", "Commercial"  
    // power_required values: "No power", "Electricity supplied...", etc.
    const charityValue = row.is_charity || 'Commercial';
    const powerValue = row.power_required || 'No power';

    return {
        id: row.id || row.booking_id,
        booking_id: row.id || row.booking_id,
        business: escapeHtml(row.business_name || row.business || "Unknown"),
        business_name: escapeHtml(row.business_name || row.business || "Unknown"),
        registered_business_name: escapeHtml(row.registered_business_name || ""),  // NEW FIELD
        owner: escapeHtml(row.owner_name || row.owner || ""),
        owner_name: escapeHtml(row.owner_name || row.owner || ""),
        status: escapeHtml(row.status || "Pending"),

        // --- FIXED: Strictly check for the specific string for boolean, keep text for editor ---
        power: row.power_required === 'Electricity supplied by fest organisors',
        power_required: powerValue,

        category: escapeHtml(row.category),
        email: escapeHtml(row.email),
        phone: escapeHtml(row.phone),
        house: escapeHtml(row.address || row.house),
        description: escapeHtml(row.description),
        other: escapeHtml(row.requirements || row.other || row.other_requirements),
        documents: row.documents,
        docs_checklist: escapeHtml(row.docs_checklist),
        notes: row.admin_notes || row.notes,
        location_id: escapeHtml(row.location_id || ""),
        stall_type: escapeHtml(row.stall_type || ""),
        amount: rawCost,
        stall_cost: "£" + parseFloat(rawCost).toLocaleString('en-GB', { minimumFractionDigits: 2 }),
        paid: row.paid === true,
        date_paid: row.date_paid,
        bank_ref: escapeHtml(row.bank_ref),
        editor: escapeHtml(row.editor),
        date_confirmed: row.date_confirmed,
        instance_prefix: row.instance_prefix,
        is_resident: row.is_resident === true || row.is_resident === 'true' || row.is_resident === 'Yes',
        is_charity: charityValue,  // FIXED: Return text value not boolean
        // RAW (unescaped) values for form input values and API payloads
        _raw: {
            business: row.business_name || row.business || "",
            owner: row.owner_name || row.owner || "",
            email: row.email || "",
            phone: row.phone || "",
            category: row.category || "",
            description: row.description || "",
            house: row.address || row.house || "",
            other: row.requirements || row.other || row.other_requirements || "",
            notes: row.admin_notes || row.notes || "",
            stall_type: row.stall_type || "",
            location_id: row.location_id || "",
            bank_ref: row.bank_ref || "",
            editor: row.editor || ""
        }
    };
}

// ===================================================================
// === 4. HELPER: LAZY CLIENT INITIALIZATION ===
// ===================================================================
function getSbClient() {
    if (_activeSbClient) return _activeSbClient;

    if (typeof supabase === 'undefined') {
        console.error("Supabase SDK not loaded! Check your HTML <script> tags.");
        throw new Error("Supabase SDK not loaded");
    }

    const { createClient } = supabase;
    _activeSbClient = createClient(SUPABASE_URL, SUPABASE_KEY);
    return _activeSbClient;
}

// Alias for login page compatibility
const getSupabaseClient = getSbClient;

// ===================================================================
// === AUTH GUARD ===
// ===================================================================

/**
 * Checks if the user is authenticated. If not, redirects to login.html.
 * Call this at the top of every admin page.
 * If auth check fails for any reason, redirects to login as a safety fallback.
 */
/**
 * Checks if the user is authenticated and has the required role.
 * @param {string} requiredRole - 'admin' (default) or 'steward'
 */
async function requireAuth(requiredRole = 'admin') {
    try {
        const sb = getSbClient();
        const { data: { session } } = await sb.auth.getSession();

        if (!session) {
            window.location.href = (requiredRole === 'steward') ? 'steward_login.html' : 'login.html';
            throw new Error('Not authenticated');
        }

        // Fetch User Role
        const { data: roleData, error: roleError } = await sb
            .from('user_roles')
            .select('role')
            .eq('id', session.user.id)
            .single();

        const userRole = (roleData && roleData.role) ? roleData.role : null;

        // Authorization logic:
        // 1. Admins can access everything
        // 2. Stewards can only access steward pages (or if role matches)
        if (userRole === 'admin' || userRole === requiredRole) {
            await loadStallCosts(sb);
            return session;
        }

        // Failure: Unauthorized role
        const loginPage = (requiredRole === 'steward') ? 'steward_login.html' : 'login.html';
        window.location.href = loginPage + '?error=unauthorized';
        throw new Error('Unauthorized');

    } catch (e) {
        if (e.message !== 'Not authenticated' && e.message !== 'Unauthorized') {
            const loginPage = (requiredRole === 'steward') ? 'steward_login.html' : 'login.html';
            window.location.href = loginPage;
        }
        throw e;
    }
}

/**
 * Signs the user out and redirects to login page.
 */
async function signOut() {
    const sb = getSbClient();
    await sb.auth.signOut();
    _currentUserEmail = null;
    window.location.href = 'login.html';
}

// ===================================================================
// === AUDIT LOGGING ===
// ===================================================================
let _currentUserEmail = null;

/**
 * Gets the current authenticated user's email. Caches after first call.
 */
async function getCurrentUserEmail() {
    if (_currentUserEmail) return _currentUserEmail;
    try {
        const sb = getSbClient();
        const { data: { session } } = await sb.auth.getSession();
        if (session && session.user) {
            _currentUserEmail = session.user.email;
            return _currentUserEmail;
        }
    } catch (e) { /* not logged in */ }
    return 'anonymous';
}

/**
 * Writes an entry to the audit_logs table.
 * Fails silently — audit logging should never break the main operation.
 *
 * @param {string} action   - The action performed (e.g. 'update_status', 'send_email')
 * @param {string} targetId - The booking/entity ID affected
 * @param {object} details  - Freeform object with action-specific details
 */
async function auditLog(action, targetId, details = {}) {
    try {
        const sb = getSbClient();
        const userEmail = await getCurrentUserEmail();
        await sb.from(TBL_AUDIT_LOGS).insert({
            action: action,
            target_id: targetId || null,
            user_email: userEmail,
            details: details, // CORRECTED: Pass object directly, do not stringify!
            instance: CURRENT_INSTANCE || 'UNKNOWN'
        });
    } catch (e) {
        console.warn('Audit log failed (non-blocking):', e.message);
    }
}

// ===================================================================
// === 5. UNIFIED API HANDLER (The "Brain") ===
// ===================================================================
// ===================================================================
// === 5. LEGACY API HANDLER (DEPRECATED) ===
// ===================================================================
// appApiCall has been removed. 
// Admin pages now use modular ES6 imports from 'js/api.js'.
// Booking forms use 'supabase-public.js'.

/**
 * Asynchronously loads stall costs from Supabase settings table and overrides local UI_CONFIG values.
 * Uses default configurations as fallback in case of errors.
 * @param {object} sb - The active Supabase client instance
 */
async function loadStallCosts(sb) {
    try {
        const { data, error } = await sb.from('settings').select('key, value');
        if (error) throw error;
        if (data) {
            data.forEach(item => {
                const num = parseFloat(item.value);
                if (!isNaN(num)) {
                    if (item.key === 'stall_cost_food') {
                        UI_CONFIG.STALL_COST.FOOD = num;
                    } else if (item.key === 'stall_cost_general') {
                        UI_CONFIG.STALL_COST.GENERAL = num;
                    } else if (item.key === 'stall_cost_dev') {
                        UI_CONFIG.STALL_COST.DEV = num;
                    }
                }
            });
        }
    } catch (e) {
        console.warn("Failed to load stall costs from database settings, using defaults:", e);
    }
}