# ADR: measured recovery time per app

Status: proposed for 3.0.0. Related: [restore-tests.md](restore-tests.md), [recovery-guide.md](recovery-guide.md).

## Problem

A restore test already proves that a backup comes back. It does not tell the owner the number that matters on a bad day:
how long the app is down while it comes back. Owners guess, and guesses are usually low.

## Users

- Self-hosters who want to know "if this server dies tonight, how long until Shop is back".
- Freelancers and agencies who promise a recovery time to a client (the [client report](client-reports-adr.md) shows it).

## Audit

- `restore_test_steps` already records `started_at` and `finished_at` for every step (`check_space`, `copy_backup`,
  `restore_copy`, `start_containers`, `check_health`, `clean_up`). Rows are never pruned.
- `restore_tests.restore_seconds` is the sum of `copy_backup + restore_copy + start_containers`, set when the test ends
  (`src/restore-tests/engine.js`, `conclude`). It leaves out `check_health`, so it is the time until containers start,
  not until the app answers. `total_seconds` includes queueing and clean-up, so it is too long.
- `restoreSeconds` is returned by `GET /api/sites/:id/restore-tests` (`views.js`) but no screen shows it. Moves read a
  `timings.restoreSeconds` fact in preflight for the downtime estimate.
- `check_health` finishes on the poll that passed, so it can overstate by up to one poll interval.
- Static sites skip `start_containers` and `check_health`.

## Decisions

1. **No new measurement and no migration.** Recovery time is computed on read from the step rows that already exist.
   Every test since restore tests shipped (2.9.0) gets a value, so upgraded installs show a number on day one.
2. **Definition.** Recovery time = `copy_backup + restore_copy + start_containers + check_health` of one **passed** test.
   `check_space` and `clean_up` are left out: a real restore has neither the space precheck wait nor the clean-up.
   Phases are shown as three parts the owner understands: **Get the backup** (copy), **Restore data** (restore),
   **Start and check** (start + health).
3. **Which test.** The newest passed test of the app. Failed, cancelled and couldn't-run tests never produce a time.
4. **Rounding.** Under 2 minutes: "under 2 min". Otherwise whole minutes, rounded up. Above 90 minutes: hours with one
   decimal. Always prefixed with "about" (UI: "Back in about 12 min").
5. **Freshness.** "Proven 3 days ago" uses the test's `finished_at`. The number is marked **not recent** (muted, warning
   icon) when the test is older than two of its cadence periods or older than 35 days, whichever is shorter.
   It is marked **may be low** when the newest backup is more than 50% larger than the backup the test restored
   (size from `backups`); the hint says "Backups grew since the last test. Run a test for a fresh number."
6. **Shared module.** `shared/recovery-time.js` (pure): `recoveryTime(steps, test, latestBackup, cadence, now)` returns
   `{ seconds, phases: { copy, restore, start }, provenAt, stale, mayBeLow }` or `null`. Used by the API, the Map, the
   Recovery Guide and the client report, so every surface shows the same number.
7. **Where it shows.**
   - App card (Dashboard and Sites list): one quiet line under the restore test status, clock icon, "Back in about
     12 min · proven 3 days ago". No line when there is no passed test; instead the existing "Not tested yet" state.
   - Map app panel: the same line, plus the three phases as a stacked bar with token colors and text values.
   - Restore test card: phase breakdown for the last passed test, and a small history row with recovery time per test.
   - Recovery Guide page and PDF: per app, "Expected time to recover: about 12 min (proven on 20 Nov 2026)".
     Without a passed test: "Not measured yet. Run a restore test to measure it."
   - Move preflight: uses the same `seconds` instead of `restore_seconds` when present (more honest downtime estimate).
8. **Honest wording.** The time is measured on the test server. The help text says so: "Measured on Server 2. A
   different server or a slower link to storage changes it."

## API

- `GET /api/sites/:id/restore-tests`: `last` gains `recovery` (the object above); `items[]` gain `recoverySeconds`.
- `GET /api/state` site summaries gain `recovery: { seconds, provenAt, stale, mayBeLow } | null`, so cards need no
  extra request. Computed with one grouped query over `restore_test_steps` for the newest passed test per site.
- `GET /api/runbook` and the PDF builder read the same field.

## Helper changes

None. The helper already reports every phase; the worker already timestamps steps.

## Security and privacy

No new data. The test server name appears only where it already does (restore test card). The Recovery Guide PDF does
not name the test server unless "Server addresses" is ticked, same rule as today.

## Upgrade safety

Read-only feature over existing rows: nothing to migrate, nothing to roll back. A downgrade to 2.16.x simply stops
showing the line. `restore_seconds` keeps its meaning for older readers.

## Test plan

- Unit (`tests/recovery-time.test.js`): definition, static sites, failed tests ignored, rounding edges (119 s, 120 s,
  5400 s), stale by cadence and by 35 days, may-be-low at exactly 50%, missing step rows, clock skew (finish before
  start counts as 0, never negative).
- API test: `/api/state` adds one query, not one per site (count statements).
- Browser (`scripts/restore-tests-browser.js`, `map-browser.js`, `recovery-guide-browser.js`): card line, Map panel,
  phone layout, both themes.
- Linux Docker CI: the existing restore test scenario asserts `recovery.seconds > 0` and the phase sum.
- Live check on the owner's dev copy: one real app, compare the shown time with a stopwatch restore. Pending live check.

## PR split

1. `shared/recovery-time.js` + API fields + unit tests (backend, no UI).
2. UI: card line, Map panel, restore test card breakdown (after board approval).
3. Recovery Guide page + PDF line; Move preflight switch.
