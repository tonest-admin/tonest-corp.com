# TO:NEST realtime parity and deployment state

Reference: MAROOWELL `workers/meta-collector/entry.js` and `public/realtime`, fetched on 2026-10-09. TO:NEST identity, schedules, authorization, and data remain separate from MAROOWELL.

## Rules

* Day: WAVE2, 2 rounds, collection starts 07:00 KST. Night: WAVE1, 3 rounds, collection starts 20:00 KST and uses the next day's META work date.
* Round 1/2 completion at night is not final work completion. Cancellation/PDD does not create a first-delivery timestamp. New scans or pending collections reopen completed work.
* Current state is retained if META omits a worker in one poll. Old unfinalized current data is not silently deleted. Current-to-final is transactional and must preserve the final round's fields.
* The frontend reads current/final with a transition fallback, compares the applicable schedule, merges fresh delivery by stable identity, and shows all three night delivery starts.
* Minute cron is configured on the actual existing worker, `meta-direct-poc`. A private `CAMP_DIRECTORY` service binding reuses the already configured camp API without exposing or copying its secret.

## Production database limitation

The connected Supabase account did not authorize access to TO:NEST project `vgwyhdqofjzqfajtolaj`. No production schema changes were made. The old downloaded SQL is only a reference, not evidence of the live schema.

`database/audit-realtime-schema.sql` reports expected columns/types, RLS, policies, indexes, function privileges, triggers, and premature night completions. `database/repair-realtime-schema.sql` is a transactional, repeatable upgrade for the 7 existing/new realtime and schedule tables. It adds missing columns, fails on incompatible types or duplicate keys instead of deleting data, preserves historical records, and enforces the night-round policy.

Review a backup and run audit + repair + audit in the TO:NEST database. The script must not be run on the MAROOWELL database. If an existing schema differs incompatibly, the transaction stops for review.

Until a production schema audit succeeds, collection is deliberately gated by `REALTIME_SCHEMA_READY`. After verification, run **Test TO:NEST realtime parity** with `schema_applied=true`. The first rollout leaves this unset; subsequent deployments preserve an explicitly approved value. The health endpoint reports this deployment gate, not a claim that it has inspected the live schema.

## Tests

`node --test tests/*.test.mjs`

GitHub Actions also creates a synthetic PostgreSQL 17 instance, installs the repair twice, verifies finalization and permissions, removes a third-round column, and verifies that the repair restores it. The CI fixture and regression SQL must never run against production.

This change covers delivery-state and presentation parity. It does not claim that MAROOWELL's separate OAuth silent-renew/session-generation infrastructure has been migrated to TO:NEST.
