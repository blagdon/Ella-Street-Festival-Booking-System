-- Migration: 20260807080000_complete_platform_defaults_templates.sql
-- Closes Release Candidate Condition 2 (Release Readiness Audit, 2026-08-07):
-- platform_defaults_email_templates/platform_defaults_sms_templates - the
-- seed source rpc_initialise_tenant_defaults clones for every newly
-- provisioned organisation - only ever had 4 of the 9 email templates and
-- 3 of the 6 SMS templates the application actually uses. Live-reproduced
-- during the audit: confirming a free/community booking on a brand-new
-- organisation failed with "Could not find template 'confirmed_free' in
-- database" (the booking itself still confirmed correctly - this is the
-- existing, working #92 resilience fix - but the trader's email silently
-- never sent). The same gap exists for rejected, location_update,
-- payment_reminder, and hcc_batch_check.
--
-- Content for the 5 new email rows and 3 new/fixed SMS rows is adapted from
-- org_default's own real, working templates (the only organisation that has
-- always had the full set), with Ella Street Festival-specific branding and
-- sign-offs neutralised - the same principle already applied to
-- platform_defaults_settings's seed values. Placeholder set confirmed
-- against js/message-templates.js's actual substitution logic
-- (getEmailFromTemplate/getSmsFromTemplate): {{owner_name}}, {{business_name}},
-- {{booking_id}}, {{cancel_link}}, {{cost}}, {{bank_details}}, {{location_id}},
-- {{reason}} for every trigger except hcc_batch_check, which is rendered by
-- js/page-hcc-dashboard.js's own code with a single {{trader_list}} table
-- placeholder, not through getEmailFromTemplate at all.
--
-- Also fixes a real (if currently inert) SMS id mismatch: the existing
-- default row used id 'cancellation_confirmed', but cancel-booking/index.ts
-- looks up 'booking_cancelled' - the row existed but could never actually be
-- matched. Replaced, not just added alongside.

INSERT INTO "public"."platform_defaults_email_templates" (id, subject, body_html, description) VALUES
    ('confirmed_free', 'Booking Confirmed (Free) - {{business_name}}', '<h1>Booking Confirmed</h1><p>Your booking {{booking_id}} for {{business_name}} has been approved as a free stall. Location: {{location_id}}.</p>', 'Sent when a free/community booking is confirmed'),
    ('rejected', 'Application Update - {{booking_id}}', '<h1>Application Update</h1><p>Unfortunately we are unable to offer a pitch for {{business_name}} this time. Reason: {{reason}}</p>', 'Sent when a stall application is rejected'),
    ('location_update', 'Stall Location - {{business_name}}', '<h1>Stall Location</h1><p>Your stall location for {{business_name}} has been assigned: {{location_id}}.</p>', 'Sent when a stall location is assigned or changed'),
    ('payment_reminder', 'Payment Reminder - {{booking_id}}', '<h1>Payment Reminder</h1><p>We have not yet received payment of {{cost}} for {{business_name}} ({{booking_id}}). {{bank_details}}. Cancel: {{cancel_link}}</p>', 'Sent as a reminder for outstanding payment'),
    ('hcc_batch_check', 'Food Safety Approval Request', '<h1>Food Safety Approval Request</h1><p>Please find the trader details below for food hygiene approval.</p>{{trader_list}}', 'Email sent with batch trader details for food safety approval')
ON CONFLICT (id) DO UPDATE SET subject = EXCLUDED.subject, body_html = EXCLUDED.body_html, description = EXCLUDED.description;

-- The wrong-id row never matched anything real - remove it rather than
-- leave stale, unreachable data alongside the corrected one.
DELETE FROM "public"."platform_defaults_sms_templates" WHERE id = 'cancellation_confirmed';

INSERT INTO "public"."platform_defaults_sms_templates" (id, body, description) VALUES
    ('booking_cancelled', 'Dear {{owner_name}}, your booking {{booking_id}} for {{business_name}} has been cancelled.', 'Sent when a booking is cancelled by an admin'),
    ('booking_confirmed', 'Dear {{owner_name}}, your booking {{booking_id}} for {{business_name}} has been confirmed. Cancel: {{cancel_link}}', 'Sent when a booking moves to Confirmed'),
    ('booking_rejected', 'Dear {{owner_name}}, your application {{booking_id}} for {{business_name}} was unsuccessful: {{reason}}', 'Sent when a booking is rejected'),
    ('location_update', 'Dear {{owner_name}}, your pitch for {{business_name}} is now {{location_id}}.', 'Sent when a stall location is assigned or changed')
ON CONFLICT (id) DO UPDATE SET body = EXCLUDED.body, description = EXCLUDED.description;
