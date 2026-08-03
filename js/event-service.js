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

        if (error || !data || data.length === 0) {
            return [getCurrentEvent()];
        }

        const matched = data.find(e => e.id === ctx.eventId);
        if (matched) {
            setCurrentEvent(matched);
        } else {
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
