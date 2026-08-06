import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

/**
 * Shared helper for service-role Edge Functions that need to know which
 * organisation(s) an authenticated caller may act on. Service-role clients
 * bypass RLS entirely, so a function using one must re-implement the same
 * scoping check the database would otherwise enforce - this mirrors the
 * is_platform_admin() OR organisation_members-membership pattern used
 * throughout this codebase's RLS policies (see
 * 20260805000000_membership_scope_org_visibility.sql and
 * 20260805040000_tenant_scope_bookings_locations_events_templates.sql),
 * rather than inventing a new one.
 *
 * Deliberately does NOT check the legacy global user_roles table for
 * anything beyond what is_platform_admin() itself already means as of
 * 20260805050000: that table gets a row for every organisation's owner
 * (kept for a handful of legacy RPCs that still read it directly), so
 * treating "has a user_roles admin row" as "may act on any organisation"
 * is exactly the bug this helper exists to avoid repeating.
 */
export interface CallerAdminScope {
  isPlatformAdmin: boolean
  orgIds: string[]
}

export async function resolveCallerAdminScope(
  supabaseAdmin: ReturnType<typeof createClient>,
  userId: string
): Promise<CallerAdminScope> {
  const { data: memberRows } = await supabaseAdmin
    .from('organisation_members')
    .select('org_id')
    .eq('user_id', userId)
    .eq('role', 'admin')

  const orgIds = (memberRows || []).map((r: any) => r.org_id)
  const isPlatformAdmin = orgIds.includes('org_default')

  return { isPlatformAdmin, orgIds }
}

export function isAuthorizedForOrg(scope: CallerAdminScope, orgId: string | null | undefined): boolean {
  if (!orgId) return false
  return scope.isPlatformAdmin || scope.orgIds.includes(orgId)
}
