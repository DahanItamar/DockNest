# ADR: client reports (PDF)

Status: proposed for 3.0.0. Related: [recovery-time-adr.md](recovery-time-adr.md), [recovery-guide.md](recovery-guide.md),
[alert-channels.md](alert-channels.md).

## Problem

Freelancers and small agencies run sites for clients on their own servers. Clients pay for "backups and care" but never
see proof. Today the owner screenshots DockNest or writes a monthly email by hand.

## Users

- A freelancer with 5 to 40 client sites on 1 to 5 servers who wants a monthly proof page per client.
- An agency that sends the report under its own name.
- A self-hoster who wants one monthly summary of the whole install (one "client" with every app).

## Audit

- PDF: `src/runbook/pdf.js` is a minimal in-house PDF 1.7 writer (headings, paragraphs, tables, page breaks, header and
  footer, Hebrew through `bidi.js` and the embedded Noto Sans Hebrew font, no JavaScript or actions). `renderPdf` takes a
  document model, so a second document type reuses it as is. The footer credit "Made with DockNest" is fixed.
- Data a report needs, all already stored:
  - backups taken: `jobs` (`type` backup, `status`, times). Jobs are never pruned; `backups` is pruned by retention, so
    counts come from `jobs`, sizes from surviving `backups`.
  - extra copies: `backup_copies` (`verified`, `failed`, `gave_up`).
  - restore tests and recovery time: `restore_tests`, `restore_test_steps` and `shared/recovery-time.js`.
  - certificate: `site_certificates` (current state only).
  - hardening grade: `site_hardening` + `gradeHardening` (current state only).
  - domain checks: `domain_checks` (latest per domain only).
- Email: alert email goes through `src/alerts/smtp.js`, which only sends `text/plain` bodies. No attachment support.
  Email Connections (`connections`, provider `email`) hold SMTP settings sealed with the master key.
- No grouping of apps exists besides servers. Compose projects group containers, not apps.

## Decisions

1. **Clients are a small new object.** A client has a name, a list of apps and report settings. An app can belong to
   more than one client (a shared app can be reported to two parties). Grouping by server is not enough: one server
   often hosts several clients. Tags were considered and rejected: a tag has no place for recipients and branding.
2. **Report content, per client and period** (a calendar month, or a custom range up to 92 days for on-demand):
   - Summary page: client name, period, one line per app: backups taken / due, last restore test result, recovery time
     ("Back in about 12 min, proven 3 days ago"), overall state (Good, Needs attention, Not protected).
   - Per app: backups (count, successful, failed, missed; newest; total kept size), extra copies (verified count, failed
     days, provider kind only), restore tests in the period (date, result, recovery time), certificate (valid until,
     renewal result), hardening grade with the number of findings (finding titles optional, see 4), domain checks
     (each domain: points to the right server, HTTPS ok).
   - Current-state facts (certificate, hardening, domains) say "as of <date the report was made>" because history is
     not kept for them. No new history tables in this release.
3. **Branding (text only).** Agency name shown in the header and on the cover ("Prepared by Studio Name"), an optional
   one-line contact text (max 120 characters, for example a website), and an accent choice from the design-system
   accent tokens. No uploaded logo or image in 3.0.0: no image parsing, no size or format risk. The small
   "Made with DockNest" credit stays in the footer.
4. **What is never in a report.** Server addresses, host names, IP addresses, SSH users, ports, keys, passwords, tokens,
   storage endpoints, bucket names, storage paths, container names, environment values, file paths, DockNest user names
   and emails. Storage is named by provider kind only ("Backblaze B2", "SFTP server"). Opt-in ticks, all off by default,
   same pattern as the Recovery Guide: **Server names** (the names the owner typed, never addresses), **Hardening
   finding titles**. There is no tick for addresses or login details: a client report is meant to be forwarded.
5. **Languages.** English labels in 3.0.0. App, client and agency names in Hebrew or any right-to-left script render
   correctly through the existing bidi code. A Hebrew label set (full right-to-left page) is a follow-up (open question).
6. **On demand.** "Make report" on the client page: choose period, preview the summary in the page, download the PDF.
   Built in memory, sent with `Cache-Control: no-store`, never written to disk.
7. **Scheduled email (optional).** Per client: off by default. When on, the report for the previous month is made on
   day 1 at 08:00 in the client's time zone and sent through an existing **email Connection** to up to 3 recipient
   addresses stored on the client. The worker's existing scheduler tick picks due reports (`next_due_at`), no new timer
   or loop. Sending needs `smtp.js` to send `multipart/mixed` with one `application/pdf` attachment (base64, max 8 MB;
   bigger reports are refused with "Report too large to email, download it instead"). Failure retries 3 times over
   6 hours, then raises a new alert event `report.failed` to the owner's normal alert lines. Success is recorded, never
   alerted.
8. **Recipients are sensitive.** Adding or changing recipient addresses needs a fresh re-verification (the same
   `REAUTH_REQUIRED` rule as logins in the Recovery Guide), and the audit log records the change with addresses hashed.
   The report email body is fixed text with the client and period names only; the PDF is the only attachment.

## Data model

Migration **27** `client-reports` (additive, `compatible: true`):

```sql
CREATE TABLE IF NOT EXISTS clients (id TEXT PRIMARY KEY, name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  agency TEXT CHECK (agency IS NULL OR length(agency) <= 80), contact TEXT CHECK (contact IS NULL OR length(contact) <= 120),
  accent TEXT CHECK (accent IS NULL OR length(accent) <= 32), include TEXT NOT NULL DEFAULT '{}' CHECK (length(include) <= 512),
  schedule_enabled INTEGER NOT NULL DEFAULT 0 CHECK (schedule_enabled IN (0,1)), timezone TEXT NOT NULL DEFAULT 'UTC',
  connection_id TEXT REFERENCES connections(id) ON DELETE SET NULL, recipients TEXT NOT NULL DEFAULT '[]' CHECK (length(recipients) <= 1024),
  next_due_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS client_apps (client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE, PRIMARY KEY (client_id, site_id));
CREATE TABLE IF NOT EXISTS client_reports (id TEXT PRIMARY KEY, client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  period_start TEXT NOT NULL, period_end TEXT NOT NULL, trigger TEXT NOT NULL CHECK (trigger IN ('manual','schedule')),
  status TEXT NOT NULL CHECK (status IN ('made','sending','sent','failed')), attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT, size INTEGER, sha256 TEXT, error TEXT CHECK (error IS NULL OR length(error) <= 200),
  created_at TEXT NOT NULL, sent_at TEXT);
```

`recipients` is sealed with the master key (`seal`), like Connection secrets. The PDF itself is never stored; `sha256`
lets the owner match a sent file. Archived or deleted apps drop out of `client_apps` by cascade or are listed as
"Removed during this period".

## API

- `GET/POST /api/clients`, `GET/PUT/DELETE /api/clients/:id` (admin; recipients change needs re-verification).
- `GET /api/clients/:id/report?from&to`: the summary as JSON for the in-page preview.
- `POST /api/clients/:id/report.pdf { from, to }`: the PDF download. Audit `client.report` with client id and period.
- `POST /api/clients/:id/report/send-test`: sends last month's report to the recipients now.

## Helper changes

None. Reports read only what DockNest already stores.

## Security and privacy

- One document builder `src/reports/client.js` produces the model from an allow-list of fields. A unit test renders a
  fixture full of hosts, IPs, users, paths and secrets and asserts none of them is in the PDF text (extracted from the
  content streams). This test is the guard for decision 4.
- Recipients sealed at rest, never returned in full by the API (`a***@example.com`), never in logs or job text.
- Viewer role: may download reports, may not see or change recipients or schedules.

## Upgrade safety

Three new tables only. 2.16.x code ignores them. A downgrade keeps the tables untouched; re-upgrading resumes schedules.
No change to existing PDFs, alerts or email Connections; `smtp.js` keeps its text-only path and adds a second function
for attachments.

## Test plan

- Unit: period counting from `jobs` (missed, failed, retention-pruned backups still counted), multi-client apps,
  removed apps, privacy allow-list test (decision 4), Hebrew names (bidi output and ActualText), MIME builder (boundary,
  base64 line length, header injection in client name), size limit.
- Browser: clients page, report preview, phone layout, both themes.
- Linux Docker CI: none needed beyond the existing suites; the report reads stored rows only.
- Live check: send one scheduled report to the owner's own mailbox through the dev copy's email Connection, open the PDF
  in two viewers (browser, a phone mail app). Pending live check.

## PR split

1. Migration 27 + `src/reports/` model + PDF document + API + privacy test (backend).
2. `smtp.js` attachment support + scheduled sending + `report.failed` alert event (backend).
3. Clients page, report preview, client picker on the app page (UI, after board approval).
