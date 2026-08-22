// Mechanical regression guard: the atomic refund_amount IS NULL claim guard
// on rpc_record_refund's UPDATE was silently dropped once already, when
// 20260801102_migrate_security_rpcs_to_organisation_members.sql re-pasted
// the function body while migrating its authorisation check, and the
// dropped guard was then carried forward unnoticed through two further
// consolidations. See 20260822131723_restore_refund_atomic_claim_guard.sql
// for the restoration and the full history.
//
// This is a pure source check, not a DB test: it reads the migrations
// directory directly, so it catches the exact failure mode that caused the
// original regression - a future migration redefining this function without
// carrying the guard forward - at review/CI time, before it ever reaches a
// live database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'supabase', 'migrations');

test('rpc_record_refund: the most recent definition still contains the atomic refund_amount IS NULL claim guard', () => {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort(); // filenames are timestamp-prefixed, so a lexical sort is chronological

  let lastDefiningFile = null;
  let lastDefiningSql = null;
  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    if (/CREATE\s+OR\s+REPLACE\s+FUNCTION\s+"?public"?\."?rpc_record_refund"?/i.test(sql)) {
      lastDefiningFile = file;
      lastDefiningSql = sql;
    }
  }

  assert.ok(lastDefiningFile, 'expected at least one migration defining rpc_record_refund');
  assert.match(
    lastDefiningSql,
    /refund_amount\s+IS\s+NULL/i,
    `the most recent definition of rpc_record_refund (${lastDefiningFile}) no longer contains the ` +
    'atomic claim guard ("AND refund_amount IS NULL" on the claiming UPDATE) - this guard was ' +
    'silently dropped once already, reopening a concurrent double-refund race. If this function\'s ' +
    'body is being re-pasted or consolidated again, make sure the guard survives the rewrite.'
  );
});
