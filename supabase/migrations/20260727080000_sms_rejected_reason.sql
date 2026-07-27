-- Add the missing {{reason}} placeholder to the booking_rejected SMS
-- template, and thread it through from the admin's typed rejection reason.
--
-- Reported live: rejecting a booking with "also text the stallholder"
-- ticked sent a text, but it never contained the reason the admin wrote in
-- the Reject dialog. Root cause was two-fold, both now fixed:
--   1. getSmsFromTemplate() (js/shared.js) had no `reason` substitution at
--      all, and the Rejected call site never passed one through — unlike
--      getEmailFromTemplate(), which has supported {{reason}} since the
--      rejection email existed.
--   2. Even with substitution wired up, this template's body had no
--      {{reason}} token to substitute into.
--
-- The new body budgets 42 characters for the reason (worst-case owner name
-- filled in, still under GSM-7's 160-char single-part limit) — the app-side
-- fix truncates any longer admin-typed reason to fit, so this can never
-- silently regress back to 2 billed parts the way the pre-20260726100000
-- wording did.
--
-- Same guarded UPDATE pattern as that migration: only replaces the row if it
-- still holds the exact text the previous migration seeded, so an admin's
-- own rewording in the SMS Template Manager is never overwritten.

UPDATE "public"."sms_templates"
SET "body" = 'Hi {{owner_name}}, your Ella Street Festival application was unsuccessful: {{reason}}. festival.stalls@ellastreet.co.uk',
    "description" = 'Sent when a booking is Rejected, alongside the rejection email. Placeholders: {{owner_name}}, {{business_name}}, {{booking_id}}, {{reason}} (admin''s typed reason, or "Oversubscribed / Category Full" if blank; truncated to 40 chars to protect the single-part budget).',
    "updated_at" = now()
WHERE "id" = 'booking_rejected'
  AND "body" = 'Hi {{owner_name}}, sorry - no stall available at Ella Street Festival this year. Replies not monitored: festival.stalls@ellastreet.co.uk';
