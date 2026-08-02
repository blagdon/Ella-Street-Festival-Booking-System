-- Migration: 20260802002_add_organisation_contact_fields.sql
-- Epic 2 Platform Administration: Add contact_email and website columns to organisations table.

ALTER TABLE "public"."organisations"
    ADD COLUMN IF NOT EXISTS "contact_email" text,
    ADD COLUMN IF NOT EXISTS "website" text;

UPDATE "public"."organisations"
SET contact_email = COALESCE(contact_email, 'admin@ellastreetfestival.co.uk'),
    website = COALESCE(website, 'https://ellastreetfestival.co.uk')
WHERE id = 'org_default';
