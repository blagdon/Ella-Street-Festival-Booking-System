// @ts-check
/**
 * js/event-service.js
 * Centralized Current Event Service for the Ella Street Platform.
 * Provides runtime active event resolution and dynamic event switching.
 */
import { getSupabaseClient } from './supabase.js';
import { getPlatformContext, CONFIG } from './config.js';

let activeEventState = /** @type {Record<string, any>|null} */ (null);
const eventChangeListeners = /** @type {((evt: Record<string, any>) => void)[]} */ ([]);

/**
 * Returns the currently active runtime event.
 * @returns {Record<string, any>}
 */
export function getCurrentEvent() {
    if (activeEventState) {
        return activeEventState;
    }

    if (typeof localStorage !== 'undefined') {
        try {
            const cached = localStorage.getItem('ESF_ACTIVE_EVENT');
            if (cached) {
                activeEventState = JSON.parse(cached);
                return activeEventState;
            }
        } catch (e) {
            // fallback
        }
    }

    const ctx = getPlatformContext();
    return {
        id: ctx.eventId || 'event_default',
        org_id: ctx.orgId || 'org_default',
        name: CONFIG.FESTIVAL_DISPLAY_NAME || 'Ella Street Festival 2026',
        slug: 'esf-2026',
        booking_prefix: 'ESF26',
        is_active: true
    };
}

/**
 * Sets the active runtime event.
 * @param {Record<string, any>|string} eventOrId
 */
export function setCurrentEvent(eventOrId) {
    let eventId = 'event_default';
    if (typeof eventOrId === 'string') {
        eventId = eventOrId;
        activeEventState = {
            ...getCurrentEvent(),
            id: eventOrId
        };
    } else if (eventOrId && typeof eventOrId === 'object') {
        eventId = eventOrId.id || 'event_default';
        activeEventState = eventOrId;
    }

    if (typeof localStorage !== 'undefined') {
        localStorage.setItem('ESF_EVENT_ID', eventId);
        if (activeEventState) {
            localStorage.setItem('ESF_ACTIVE_EVENT', JSON.stringify(activeEventState));
        }
    }

    eventChangeListeners.forEach(fn => {
        try {
            fn(getCurrentEvent());
        } catch (e) {
            console.error('[EventService] Listener error:', e);
        }
    });
}

/**
 * Clears any cached active event (localStorage + in-memory), so a stale
 * event that no longer exists server-side stops being trusted. Distinct
 * from a fetch failure (network, RLS) - that keeps showing whatever was
 * cached rather than wiping it out over a transient problem unrelated to
 * whether the event itself is real.
 */
function clearCurrentEvent() {
    activeEventState = null;
    if (typeof localStorage !== 'undefined') {
        localStorage.removeItem('ESF_EVENT_ID');
        localStorage.removeItem('ESF_ACTIVE_EVENT');
    }
}

/**
 * Fetches all available events for the active organisation.
 * @returns {Promise<Record<string, any>[]>}
 */
export async function fetchAvailableEvents() {
    const sb = getSupabaseClient();
    const ctx = getPlatformContext();

    try {
        const { data, error } = await sb
            .from('events')
            .select('*')
            .eq('org_id', ctx.orgId)
            .order('created_at', { ascending: false });

        if (error) {
            return [getCurrentEvent()];
        }

        if (!data || data.length === 0) {
            // The organisation genuinely has no events - a previously
            // cached "active event" (if any) does not exist server-side and
            // must stop being trusted, rather than kept rendering across
            // every admin page as if it were real. This is exactly how a
            // phantom event stayed fully rendered - Event Configuration,
            // System Settings, the header itself - throughout the RC
            // operational certification's test organisation, right up until
            // the public booking form (which resolves server-side) quietly
            // returned "not found" (Finding 4).
            clearCurrentEvent();
            return [];
        }

        const matched = data.find(e => e.id === ctx.eventId);
        if (matched) {
            setCurrentEvent(matched);
        } else {
            // Cached event id doesn't match anything real either - same
            // situation as the empty-list case above, just with other real
            // events available to fall back to instead of none.
            const activeEvt = data.find(e => e.is_active) || data[0];
            if (activeEvt) {
                setCurrentEvent(activeEvt);
            }
        }

        return data;
    } catch (e) {
        console.warn('[EventService] Failed to fetch events:', e);
        return [getCurrentEvent()];
    }
}

/**
 * Subscribes to active event changes.
 * @param {(evt: Record<string, any>) => void} listener
 * @returns {() => void} Unsubscribe function
 */
export function onCurrentEventChange(listener) {
    eventChangeListeners.push(listener);
    return () => {
        const idx = eventChangeListeners.indexOf(listener);
        if (idx !== -1) eventChangeListeners.splice(idx, 1);
    };
}
