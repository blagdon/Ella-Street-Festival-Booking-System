import { getSupabaseClient } from './supabase.js';

const TBL_AUDIT_LOGS = 'audit_logs';

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
