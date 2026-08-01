import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

/**
 * _shared/context.ts — Edge Function Platform Context Module
 *
 * Server-side trusted context resolution for Supabase Edge Functions.
 * Resolves org_id and event_id from:
 *  1. Request JWT claims (request.jwt.claims -> 'org_id')
 *  2. organisation_members lookup for authenticated user (auth.uid())
 *  3. Fallback defaults ('org_default' / 'event_default')
 *
 * Invariant 1: Browser code NEVER decides organisation context directly.
 * Invariant 7: RLS and server-side context resolution are the final security authority.
 */

export interface EdgePlatformContext {
  orgId: string
  eventId: string
  userId: string | null
  userRole: string | null
}

export async function resolvePlatformContext(
  req: Request,
  supabaseClient?: ReturnType<typeof createClient>
): Promise<EdgePlatformContext> {
  let orgId = 'org_default'
  let eventId = 'event_default'
  let userId: string | null = null
  let userRole: string | null = null

  // 1. Inspect Authorization JWT header if present
  const authHeader = req.headers.get('Authorization')
  if (authHeader && supabaseClient) {
    try {
      const { data: { user }, error: userError } = await supabaseClient.auth.getUser()
      if (user && !userError) {
        userId = user.id

        // Query organisation_members for the user's assigned org & role
        const { data: member } = await supabaseClient
          .from('organisation_members')
          .select('org_id, role')
          .eq('user_id', user.id)
          .limit(1)
          .maybeSingle()

        if (member?.org_id) {
          orgId = member.org_id
        }
        if (member?.role) {
          userRole = member.role
        }
      }
    } catch (_e) {
      // Fall through to defaults on parsing errors
    }
  }

  // 2. Inspect custom request headers if present (e.g. x-event-id)
  const headerEventId = req.headers.get('x-event-id')
  if (headerEventId && headerEventId.trim()) {
    eventId = headerEventId.trim()
  }

  return {
    orgId,
    eventId,
    userId,
    userRole
  }
}
