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

# pg_dump wraps a CREATE POLICY statement's body (its actual USING/WITH CHECK
# expression, almost always) onto continuation lines that don't themselves
# start with CREATE POLICY/GRANT/REVOKE. A plain `grep -E "^(...)"` — what
# this used to be — only ever captured each statement's FIRST line, so two
# policies with identical names/tables/TO/FOR clauses but a materially
# different WHERE expression showed as unchanged. Hit live 2026-07-20: six
# policies rewritten to cast against a different type produced a snapshot
# diff of three unrelated GRANT lines, none of the actual policy-body
# changes — see HANDOVER.md's Gotchas entry on this.
#
# Fix: accumulate every matching statement across lines until the one that
# actually ends it (a line ending in `;`), then emit the whole thing joined
# onto a single line. None of CREATE POLICY/GRANT/REVOKE's bodies in this
# schema contain an embedded semicolon (verified against a live dump before
# writing this — unlike CREATE FUNCTION bodies elsewhere in the same dump,
# which this pattern was never meant to match anyway), so ending on a
# trailing `;` is an unambiguous terminator here.
NEW_SNAPSHOT=$(awk '
  /^(CREATE POLICY|GRANT|REVOKE)/ {
    if (buf != "") print buf   # defensive: flush an unterminated previous match rather than silently merging statements
    buf = $0
    if (buf ~ /;[ \t]*$/) { print buf; buf = ""; }
    next
  }
  buf != "" {
    line = $0
    gsub(/^[ \t]+/, "", line)
    buf = buf " " line
    if (buf ~ /;[ \t]*$/) { print buf; buf = ""; }
  }
  END { if (buf != "") print buf }
' "$TMPFILE" | sort)

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
