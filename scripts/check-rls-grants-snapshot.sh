#!/usr/bin/env bash
# RLS/grants snapshot test. Regenerates a snapshot of every CREATE POLICY and
# GRANT/REVOKE statement across the public and storage schemas from the live
# database, and diffs it against the checked-in baseline
# (rls_grants_snapshot.txt). Run manually — this hits the live Supabase
# project over the network, so it's not wired into the pre-commit hook.
#
# Why this exists: nearly every third-party review comment during the
# 2026-07-14 session was either confirming or *incorrectly* flagging an
# RLS/grant issue (see HANDOVER.md's bookings/performers column-grant
# Gotcha), each time requiring a fresh live schema dump to check. This
# resolves "did anything about our access-control posture actually change"
# in seconds instead.
#
# Usage:
#   npm run check:rls-grants
# On first run (no baseline yet) it creates rls_grants_snapshot.txt and
# exits 0. On later runs, a diff means something about RLS policies or
# grants changed since the snapshot was last committed — review it, and if
# it's expected, commit the updated snapshot.
set -eu

cd "$(dirname "$0")/.."

TMPFILE=$(mktemp)
trap 'rm -f "$TMPFILE"' EXIT

# The dump's ephemeral CLI login role intermittently fails pooler auth in CI
# ("password authentication failed for user cli_login_postgres"), so retry the
# dump itself a few times. Only the dump is retried — a real snapshot diff is
# handled below and still fails immediately.
DUMP_ATTEMPTS=3
for attempt in $(seq 1 "$DUMP_ATTEMPTS"); do
  if supabase db dump --schema public,storage --linked -f "$TMPFILE" >/dev/null; then
    break
  fi
  if [ "$attempt" -eq "$DUMP_ATTEMPTS" ]; then
    echo "supabase db dump failed after $DUMP_ATTEMPTS attempts." >&2
    exit 1
  fi
  echo "supabase db dump failed (attempt $attempt/$DUMP_ATTEMPTS), retrying in $((attempt * 5))s..." >&2
  sleep $((attempt * 5))
done

NEW_SNAPSHOT=$(grep -E "^(CREATE POLICY|GRANT|REVOKE)" "$TMPFILE" | sort)

if [ ! -f rls_grants_snapshot.txt ] || [ "${1:-}" = "--update" ]; then
  echo "$NEW_SNAPSHOT" > rls_grants_snapshot.txt
  echo "Wrote rls_grants_snapshot.txt — review with 'git diff' and commit it."
  exit 0
fi

if diff -u rls_grants_snapshot.txt <(echo "$NEW_SNAPSHOT"); then
  echo "OK: RLS policies and grants match the checked-in snapshot."
  exit 0
else
  echo ""
  echo "RLS policies/grants differ from the checked-in snapshot (diff above)."
  echo "If this change is expected, update the snapshot and commit it:"
  echo "  npm run check:rls-grants -- --update"
  exit 1
fi
