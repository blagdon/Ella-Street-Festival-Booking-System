// @ts-check
import { getSupabaseClient } from './supabase.js';
import { getCurrentOrgId, getCurrentEventId } from './config.js';

const TBL_AUDIT_LOGS = 'audit_logs';

/**
 * Writes to the audit log.
 * @param {string} action
 * @param {string} targetId
 * @param {object} details
 * @param {string} [orgId]
 * @param {string} [eventId]
 */
export async function auditLog(action, targetId, details = {}, orgId = getCurrentOrgId(), eventId = getCurrentEventId()) {
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
            instance: currentInstance,
            org_id: orgId,
            event_id: eventId
        });
    } catch (e) {
        console.warn('Audit log failed:', e.message);
    }
}
