import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { ALLOWED_ORIGIN } from '../_shared/cors.ts'
import { validateSlug } from '../_shared/slugs.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

// No org-scoped settings exist yet at owner-invite time (Step D, which
// clones them from platform_defaults_settings, hasn't run) - matches the
// same hardcoded fallback create-checkout-session/index.ts uses once an
// org's own base_url setting does exist.
const DEFAULT_BASE_URL = 'https://app.ellastreet.co.uk'

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  // Declared outside the try block, not inside it: the catch block below
  // needs both to run its rollback. A `let`/`const` declared inside `try {}`
  // is NOT visible in the sibling `catch {}` block - referencing it there
  // throws a fresh ReferenceError instead of running the cleanup, which
  // silently swallows the real error AND leaves a half-provisioned
  // organisation behind (this is exactly how riverside-autumn ended up with
  // an organisations row and owner member but no event, settings, or email
  // templates - see the RC operational certification's Finding 3/4).
  let supabaseAdmin: any = null
  let createdOrgSlug: string | null = null

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL') || ''
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''

    if (!supabaseUrl || !supabaseServiceKey) {
      return new Response(
        JSON.stringify({ error: 'Server misconfiguration: SUPABASE_SERVICE_ROLE_KEY is missing' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const authHeader = req.headers.get('Authorization')
    if (!authHeader) {
      return new Response(
        JSON.stringify({ error: 'Missing Authorization header' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey)

    const token = (authHeader ? authHeader.replace('Bearer ', '') : '').trim()
    const apiKey = (req.headers.get('apikey') || '').trim()

    let isServiceRole = false
    if (supabaseServiceKey && (token === supabaseServiceKey.trim() || apiKey === supabaseServiceKey.trim())) {
      isServiceRole = true
    }

    let callerEmail = 'service_role'

    if (!isServiceRole) {
      const { data: { user }, error: authErr } = await supabaseAdmin.auth.getUser(token)

      if (authErr || !user) {
        // Fallback: check if token payload has role === 'service_role'
        try {
          const payload = JSON.parse(atob(token.split('.')[1]))
          if (payload?.role === 'service_role') {
            isServiceRole = true
          }
        } catch (_) {}

        if (!isServiceRole) {
          return new Response(
            JSON.stringify({ error: 'Unauthorized user token' }),
            { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          )
        }
      }

      if (!isServiceRole && user) {
        const { data: memberRole } = await supabaseAdmin
          .from('organisation_members')
          .select('role')
          .eq('user_id', user.id)
          .eq('role', 'admin')
          .maybeSingle()

        const { data: userRole } = await supabaseAdmin
          .from('user_roles')
          .select('role')
          .eq('id', user.id)
          .single()

        const isAdmin = memberRole?.role === 'admin' || userRole?.role === 'admin'

        if (!isAdmin) {
          return new Response(
            JSON.stringify({ error: 'Forbidden: Admin role required for provisioning' }),
            { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          )
        }
        callerEmail = user.email || user.id
      }
    }

    const body = await req.json()
    const {
      org_name,
      org_slug,
      owner_email,
      event_name,
      event_prefix,
      event_slug,
      website,
      dry_run = false
    } = body

    if (!org_name || !org_slug || !owner_email || !event_name || !event_prefix) {
      return new Response(
        JSON.stringify({ error: 'Missing required parameters: org_name, org_slug, owner_email, event_name, event_prefix' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    let cleanOrgSlug: string
    let cleanEventSlug: string
    const cleanPrefix = String(event_prefix).trim().toUpperCase()
    const cleanEmail = String(owner_email).trim().toLowerCase()

    try {
      cleanOrgSlug = validateSlug(org_slug, 'Organisation slug')
      // Falls back to the booking prefix, matching the previous behaviour —
      // but now validated the same way an explicitly-provided slug is,
      // rather than assumed safe because it's derived from cleanPrefix.
      cleanEventSlug = validateSlug(event_slug || cleanPrefix, 'Event slug')
    } catch (err) {
      return new Response(
        JSON.stringify({ error: err instanceof Error ? err.message : 'Invalid slug.' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // 1. Dry Run / Pre-flight Checks
    const { data: existingOrg } = await supabaseAdmin
      .from('organisations')
      .select('id')
      .eq('slug', cleanOrgSlug)
      .maybeSingle()

    if (existingOrg) {
      return new Response(
        JSON.stringify({ error: `Organisation slug '${cleanOrgSlug}' is already in use.` }),
        { status: 409, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Event slugs are only unique *within* an organisation (events_slug_unique
    // is (org_id, slug)), but this organisation doesn't exist yet at
    // pre-flight time, so there's nothing for a duplicate event slug to
    // collide with here — the DB constraint is the real backstop once the
    // organisation (and therefore an org_id to scope by) exists. Nothing to
    // pre-check for event_slug specifically beyond the format/reserved-word
    // validation already done above.

    const { data: existingPrefix } = await supabaseAdmin
      .from('events')
      .select('id')
      .eq('booking_prefix', cleanPrefix)
      .maybeSingle()

    if (existingPrefix) {
      return new Response(
        JSON.stringify({ error: `Booking prefix '${cleanPrefix}' is already in use by another event.` }),
        { status: 409, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    if (dry_run) {
      return new Response(
        JSON.stringify({
          status: 'success',
          dry_run: true,
          valid: true,
          message: 'Pre-flight validation passed cleanly.'
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // 2. Execution Pipeline
    // (createdOrgSlug is declared above the try block - see the comment there)

    // Step A: Create Organisation
    const { error: createOrgErr } = await supabaseAdmin
      .from('organisations')
      .insert({
        id: cleanOrgSlug,
        name: String(org_name).trim(),
        slug: cleanOrgSlug,
        contact_email: cleanEmail,
        website: website ? String(website).trim() : null
      })

    if (createOrgErr) {
      throw new Error(`Failed to create organisation: ${createOrgErr.message}`)
    }
    createdOrgSlug = cleanOrgSlug

    // Step B: Assign Owner Member
    let ownerUserId: string | null = null
    let ownerInviteSent = false

    const { data: authUsers } = await supabaseAdmin.auth.admin.listUsers()
    const foundUser = authUsers?.users?.find((u: any) => u.email?.toLowerCase() === cleanEmail)

    if (foundUser) {
      ownerUserId = foundUser.id
    } else {
      // Send a real Supabase invite email so the owner can actually sign in
      // as themselves. This used to generate a random placeholder UUID with
      // no email ever sent - the owner had no way to discover they needed
      // to sign up, and no self-service signup page existed even if they
      // did (see the RC operational certification's Finding 1).
      // inviteUserByEmail creates the auth.users row itself and returns its
      // real id, so there's no placeholder/re-linking step needed here.
      const { data: inviteData, error: inviteErr } = await supabaseAdmin.auth.admin.inviteUserByEmail(
        cleanEmail,
        { redirectTo: `${DEFAULT_BASE_URL}/index.html` }
      )

      if (inviteErr || !inviteData?.user) {
        // Fall back to the placeholder mechanism rather than failing the
        // whole provisioning run over a transient email-sending problem -
        // the existing link_pending_user_roles_on_signup trigger still
        // re-links this if they ever do sign up independently.
        console.warn('[provision-organisation] inviteUserByEmail failed, falling back to placeholder:', inviteErr?.message)
        const { data: existingRole } = await supabaseAdmin
          .from('user_roles')
          .select('id')
          .eq('email', cleanEmail)
          .maybeSingle()

        ownerUserId = existingRole?.id || crypto.randomUUID()
      } else {
        ownerUserId = inviteData.user.id
        ownerInviteSent = true
      }
    }

    const { error: userRoleErr } = await supabaseAdmin
      .from('user_roles')
      .upsert(
        { id: ownerUserId, email: cleanEmail, role: 'admin' },
        { onConflict: 'id' }
      )

    if (userRoleErr) {
      throw new Error(`Failed to assign owner user_roles: ${userRoleErr.message}`)
    }

    const { error: memberErr } = await supabaseAdmin
      .from('organisation_members')
      .upsert(
        { org_id: cleanOrgSlug, user_id: ownerUserId, role: 'admin' },
        { onConflict: 'org_id,user_id' }
      )

    if (memberErr) {
      throw new Error(`Failed to assign owner member: ${memberErr.message}`)
    }

    // Step C: Create Default Primary Event (status: draft)
    // cleanEventSlug was already validated (format + reserved words) above,
    // before the organisation was created.
    const newEventId = `evt_${Date.now()}`

    const { error: createEventErr } = await supabaseAdmin
      .from('events')
      .insert({
        id: newEventId,
        org_id: cleanOrgSlug,
        name: String(event_name).trim(),
        slug: cleanEventSlug,
        booking_prefix: cleanPrefix,
        is_active: true,
        status: 'draft'
      })

    if (createEventErr) {
      throw new Error(`Failed to create primary event: ${createEventErr.message}`)
    }

    // Step D: Initialise Tenant Platform Defaults
    // p_display_name overrides the generic 'Festival Event' template value
    // platform_defaults_settings seeds festival_display_name with, so a
    // brand-new organisation shows its own event's name immediately instead
    // of a placeholder (RC Round 2 certification, Finding 3).
    const { data: defaultsData, error: defaultsErr } = await supabaseAdmin.rpc('rpc_initialise_tenant_defaults', {
      p_org_id: cleanOrgSlug,
      p_display_name: String(event_name).trim()
    })

    if (defaultsErr) {
      throw new Error(`Failed to initialise platform defaults: ${defaultsErr.message}`)
    }

    // Step E: Record Audit Log Entry
    await supabaseAdmin
      .from('audit_logs')
      .insert({
        action: 'provision_organisation',
        target_table: 'organisations',
        details: {
          org_id: cleanOrgSlug,
          org_name,
          event_id: newEventId,
          event_name,
          owner_email: cleanEmail,
          provisioned_by: callerEmail
        }
      })

    const report = {
      status: 'success',
      org_id: cleanOrgSlug,
      org_name: String(org_name).trim(),
      owner_email: cleanEmail,
      event_id: newEventId,
      event_name: String(event_name).trim(),
      booking_prefix: cleanPrefix,
      event_status: 'draft',
      owner_invite_sent: ownerInviteSent,
      settings_initialised: defaultsData?.settings_initialised || 0,
      email_templates_initialised: defaultsData?.email_templates_initialised || 0,
      sms_templates_initialised: defaultsData?.sms_templates_initialised || 0,
      created_at: new Date().toISOString()
    }

    return new Response(
      JSON.stringify(report),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )

  } catch (err: any) {
    if (createdOrgSlug && supabaseAdmin) {
      try {
        await supabaseAdmin.from('events').delete().eq('org_id', createdOrgSlug)
        await supabaseAdmin.from('settings').delete().eq('org_id', createdOrgSlug)
        await supabaseAdmin.from('email_templates').delete().eq('org_id', createdOrgSlug)
        await supabaseAdmin.from('sms_templates').delete().eq('org_id', createdOrgSlug)
        await supabaseAdmin.from('organisation_members').delete().eq('org_id', createdOrgSlug)
        await supabaseAdmin.from('organisations').delete().eq('id', createdOrgSlug)
      } catch (cleanupErr: any) {
        console.warn('[Provisioning Cleanup Failed]:', cleanupErr?.message || cleanupErr)
      }
    }

    return new Response(
      JSON.stringify({ error: err.message || 'Provisioning failed' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})
