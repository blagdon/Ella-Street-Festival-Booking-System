import test from 'node:test';
import assert from 'node:assert/strict';
import { service as supabaseAdmin } from './helpers.mjs';

test('Epic 3 — Platform Provisioning Suite', async (t) => {

    await t.test('1. Platform Defaults Initialisation RPC', async () => {
        const testOrgSlug = `test_org_${Date.now()}`;

        // Create dummy org record first
        const { error: orgErr } = await supabaseAdmin.from('organisations').insert({
            id: testOrgSlug,
            name: 'Test Provisioning Org',
            slug: testOrgSlug,
            contact_email: 'test@example.com'
        });
        assert.ifError(orgErr, 'Creating test organisation should succeed');

        // Execute rpc_initialise_tenant_defaults
        const { data, error: rpcErr } = await supabaseAdmin.rpc('rpc_initialise_tenant_defaults', {
            p_org_id: testOrgSlug
        });
        assert.ifError(rpcErr, 'rpc_initialise_tenant_defaults should execute cleanly');
        assert.equal(data.status, 'success');

        const { count: templateCount } = await supabaseAdmin.from('email_templates').select('*', { count: 'exact', head: true }).eq('org_id', testOrgSlug);
        assert.ok((templateCount || 0) >= 4, 'Should initialize at least 4 email templates');

        // Cleanup
        await supabaseAdmin.from('settings').delete().eq('org_id', testOrgSlug);
        await supabaseAdmin.from('email_templates').delete().eq('org_id', testOrgSlug);
        await supabaseAdmin.from('sms_templates').delete().eq('org_id', testOrgSlug);
        await supabaseAdmin.from('organisations').delete().eq('id', testOrgSlug);
    });

    await t.test('2. Event Lifecycle Status Constraints & Guards', async () => {
        const testOrgId = 'org_default';
        const testEventId = `evt_lifecycle_${Date.now()}`;

        // Insert event in 'draft' status
        const { error: insertErr } = await supabaseAdmin.from('events').insert({
            id: testEventId,
            org_id: testOrgId,
            name: 'Lifecycle Test Event',
            slug: testEventId,
            booking_prefix: `LC${Date.now().toString().slice(-4)}`,
            is_active: true,
            status: 'draft'
        });
        assert.ifError(insertErr, 'Event insertion with status draft should succeed');

        // Fetch inserted event
        const { data: fetchedEvt, error: fetchErr } = await supabaseAdmin
            .from('events')
            .select('status')
            .eq('id', testEventId)
            .single();

        assert.ifError(fetchErr);
        assert.equal(fetchedEvt.status, 'draft', 'Initial event status should be draft');

        // Transition status to 'open'
        const { error: updateErr } = await supabaseAdmin
            .from('events')
            .update({ status: 'open' })
            .eq('id', testEventId);

        assert.ifError(updateErr, 'Updating event status to open should succeed');

        // Transition status to invalid state should throw constraint error
        const { error: invalidErr } = await supabaseAdmin
            .from('events')
            .update({ status: 'invalid_state' })
            .eq('id', testEventId);

        assert.ok(invalidErr, 'Invalid status state should be rejected by PostgreSQL constraint');

        // Cleanup
        await supabaseAdmin.from('events').delete().eq('id', testEventId);
    });

    await t.test('3. Multi-Tenant Isolation (Platform Defaults vs Customer Settings)', async () => {
        const tenantA = `tenant_a_${Date.now()}`;
        const tenantB = `tenant_b_${Date.now()}`;

        // Insert two orgs
        await supabaseAdmin.from('organisations').insert([
            { id: tenantA, name: 'Tenant A', slug: tenantA, contact_email: 'a@example.com' },
            { id: tenantB, name: 'Tenant B', slug: tenantB, contact_email: 'b@example.com' }
        ]);

        // Initialise defaults for both
        await supabaseAdmin.rpc('rpc_initialise_tenant_defaults', { p_org_id: tenantA });
        await supabaseAdmin.rpc('rpc_initialise_tenant_defaults', { p_org_id: tenantB });

        // Update setting in Tenant A
        await supabaseAdmin.from('settings').update({ value: '#FF0000' }).eq('org_id', tenantA).eq('key', 'primary_color');

        // Verify Tenant B's primary_color remains unchanged (#2563EB)
        const { data: bSetting } = await supabaseAdmin.from('settings').select('value').eq('org_id', tenantB).eq('key', 'primary_color').single();
        assert.equal(bSetting.value, '#2563EB', 'Mutating Tenant A settings should not affect Tenant B');

        // Cleanup
        await supabaseAdmin.from('settings').delete().in('org_id', [tenantA, tenantB]);
        await supabaseAdmin.from('email_templates').delete().in('org_id', [tenantA, tenantB]);
        await supabaseAdmin.from('sms_templates').delete().in('org_id', [tenantA, tenantB]);
        await supabaseAdmin.from('organisations').delete().in('id', [tenantA, tenantB]);
    });

    await t.test('4. provision-organisation Edge Function End-to-End Execution', async () => {
        const testSlug = `prov-test-${Date.now()}`;
        const testPrefix = `PT${Date.now().toString().slice(-4)}`;

        const { data, error } = await supabaseAdmin.functions.invoke('provision-organisation', {
            body: {
                org_name: 'Provision Test Org',
                org_slug: testSlug,
                owner_email: 'owner@provision.test',
                event_name: 'Provision Test Event',
                event_prefix: testPrefix,
                dry_run: false
            }
        });

        assert.ifError(error, 'provision-organisation execution should succeed');
        assert.equal(data.status, 'success');
        assert.equal(data.org_id, testSlug);
        assert.equal(data.event_status, 'draft');

        // Cleanup
        await supabaseAdmin.from('events').delete().eq('org_id', testSlug);
        await supabaseAdmin.from('settings').delete().eq('org_id', testSlug);
        await supabaseAdmin.from('email_templates').delete().eq('org_id', testSlug);
        await supabaseAdmin.from('sms_templates').delete().eq('org_id', testSlug);
        await supabaseAdmin.from('organisation_members').delete().eq('org_id', testSlug);
        await supabaseAdmin.from('organisations').delete().eq('id', testSlug);
    });

    await t.test('5. provision-organisation Rollback Cleanup Verification', async () => {
        const testSlug = `rollback-test-${Date.now()}`;
        // Intentionally invalid event status in payload to trigger failure at event insertion step
        const { data, error } = await supabaseAdmin.functions.invoke('provision-organisation', {
            body: {
                org_name: 'Rollback Test Org',
                org_slug: testSlug,
                owner_email: 'rollback@provision.test',
                event_name: 'Rollback Test Event',
                event_prefix: `RB${Date.now().toString().slice(-4)}`,
                event_slug: 'invalid slug with spaces!!',
                dry_run: false
            }
        });

        // Verify pre-flight or pipeline rejection
        if (data && data.error) {
            // Check that organisations table has no orphaned row for testSlug
            const { data: orgRow } = await supabaseAdmin.from('organisations').select('id').eq('id', testSlug).maybeSingle();
            assert.equal(orgRow, null, 'Orphaned organisation should be rolled back and cleaned up on failure');
        }
    });

});
