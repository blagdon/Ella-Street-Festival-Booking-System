-- The freeform 'bank_details' setting (Settings page: "BANK DETAILS FOR
-- CONFIRMATIONS") duplicated the same information already captured by the
-- structured bank_account_name/bank_sort_code/bank_account_number settings
-- added for manual bank-transfer payments. All code that read 'bank_details'
-- (js/shared.js's getEmailFromTemplate, stripe-webhook's confirmation email)
-- now builds the {{bank_details}} template placeholder from those three
-- structured fields instead, so this row is no longer read anywhere.
DELETE FROM "public"."settings" WHERE "key" = 'bank_details';
