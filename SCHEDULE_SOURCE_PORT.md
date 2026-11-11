# TO:NEST schedule - MAROOWELL source port

## Source of truth

- Repository: `nuclearwarp/maroowell.com`
- Commit: `5d127cf124f0149113380393c74b1328c0065d29`
- Frontend: `public/maroowell_schedule`
- Backend: `workers/schedule-api/worker.js`
- Generated page: `/tonest_schedule`
- API: `https://route-info.tonest-admin.workers.dev/schedule-api`

This is the original schedule page and upload workflow, not the earlier independently written basic schedule grid. Function-level regression fingerprints are recorded in `tests/fixtures/schedule-source-parity.json`.

## Tenant-specific adapters

1. Login configuration comes from TO:NEST `/auth-config`; the existing sessionStorage login is reused.
2. Server authorization reads TO:NEST `profiles` by authenticated user ID. Only active super_admin/admin/team_leader profiles can read or write schedules. The MAROOWELL email bypass and membership lookups are not used.
3. Data comes from `tonest_schedule`, `tonest_info`, `tonest_route_info`, and `tonest_schedule_update_status`.
4. Route metadata is converted to the original parent/sub-subroute model. Only registered TO:NEST routes appear. The local route catalogue currently contains four Daegu3 parent routes; other camps need route registration before assignment.
5. Camp list is derived from local active driver/route records. Both daytime and nighttime can be selected when available. META camp-code lookup uses the existing `CAMP_DIRECTORY` service binding.
6. Business number `1658803281` and vendor label `주식회사 투네스트` are based on the existing MAROOWELL vendor directory entry for TO:NEST. They replace MAROOWELL export defaults.
7. Cookie updates use a compare-and-swap condition on the loaded bundle/session generation and preserve the scoped OAuth cookies. No collector state, pause flag, cron, or realtime source was changed.
8. The schedule module is mounted below `/schedule-api` on the existing route-info Worker, reusing its existing Supabase secrets. The dedicated route-info paths are preserved.

## Preserved workflow

- Original Sunday-Saturday week picker, parent/sub-subroute assignment, off-duty row, autocomplete, account matching, colors, daily copy/paste and week copy.
- Save and clear using `schedule_date,camp,wave,route_label`.
- Manual Excel generation, image copy, META date-selection dialog.
- Night shift: META work date is schedule date + one day; rounds are `D1,D2,F3`.
- Upload: inspect current registrations -> explicit user confirmation -> off-duty reset -> workflow continuation -> verify reset -> apply new assignment -> workflow continuation -> verify actual registrations -> update completion date.

## Validation and operational limit

- Node syntax, route-info regression tests and schedule/API tests.
- Original function fingerprints: 184/187 frontend functions and 69/79 backend functions unchanged after declared branding normalization. Adapted functions are listed in the JSON report.
- Browser test in an isolated Chrome profile: week rendering, seven-day parent/child/off-duty cells, save, full reset/apply workflow, generated XLSX columns and numeric business number, night +1-day date, mobile/desktop rendering.
- Browser upload tests use mocked upstream responses. No live META reset or upload has been performed as part of implementation. A real date must be deliberately selected and confirmed by an operator.
- Existing schedules and realtime history have not been deleted. Only the schedule-update-status table was added with RLS enabled.

## Commands

```
node --test tests/route-info-auth.test.mjs tests/schedule-port.test.mjs
```

Deployment runs through the existing route-info and login-worker Actions workflows. No extra Cloudflare token or separate schedule Worker service is needed.
