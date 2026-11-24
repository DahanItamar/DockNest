# Client reports

If you run sites for clients, a client report is the monthly proof page: what was backed up, whether a restore was tested
and how fast an app would be back. DockNest makes it as a PDF per client, on demand or by email on day 1 of each month.
This page describes the backend of the feature (data, API, PDF, email). The Clients page comes with a later change.

## What a report holds

For a calendar month, or any range of up to 92 days:

- **Summary:** the client name, the period, and one line per app: backups taken and due, the last restore test, the
  recovery time ("Back in about 12 min, proven 3 days ago") and an overall state: Good, Needs attention or Not protected.
- **Per app:** backups (taken, failed, missed, newest, what is kept now), extra copies (verified and not completed, named
  by kind only: "SFTP server" or "S3-compatible storage"), restore tests in the period, the certificate, the hardening
  grade and the domain checks. The certificate, hardening and domain lines say "as of" the day the report was made, as
  DockNest keeps no history for them.
- **Branding, text only:** your agency name ("Prepared by ..."), one line of contact text and an accent choice. A small
  "Made with DockNest" credit stays in the footer.
- English labels. App, client and agency names in Hebrew or any right-to-left script render correctly.

Backup counts come from the job history, which is never pruned, so a backup that retention has since removed still counts.

## What is never in a report

Server addresses and host names, IP addresses, SSH users, ports, keys, passwords, tokens, storage endpoints, bucket names,
storage paths, container names, environment values, file paths, and DockNest user names and emails. A client report is
meant to be forwarded, so there is no option to add any of these.

Two opt-in ticks exist, both off by default: **Server names** (the names you typed, never addresses) and **Hardening
finding titles**. A test renders a fixture full of hosts, addresses, users, paths and secrets and checks that none of
them appears in the PDF.

## Clients

A client has a name, a list of apps (an app can belong to more than one client), the branding above and the report
settings. Administrators create and change clients (`/api/clients`). Other roles can open a client and download its
report, but never see recipients or the schedule.

## Email

Per client, off by default. When on, the report for the previous month is made on day 1 at 08:00 in the client's time
zone and sent through an existing email Connection to up to 3 recipients. The email body is fixed text with the client and
period; the PDF is the only attachment (at most 8 MB; a bigger report is refused with "Report too large to email,
download it instead"). A failed send retries after 1, 2 and 3 hours, then raises the alert **Client report failed**
(`report.failed`) on your normal alert lines. A success is recorded, never alerted. "Send test" sends last month's
report to the recipients right away.

Sending is at-least-once: if DockNest stops right after the mail server accepted a report but before it records the send, the same report can go out a second time. If the schedule is turned off while a report is waiting to retry, it is not sent.

Recipients are sealed with the master key, shown only masked (`c***@example.com`), and changing them needs you to confirm
your sign-in again. The audit log records the change with the addresses hashed. The PDF itself is never stored; DockNest
keeps only its size and SHA-256 so you can match a sent file.

## Upgrading and downgrading

The release adds three tables (`clients`, `client_apps`, `client_reports`), migration 27, and nothing else changes in
existing data, PDFs, alerts or email Connections. Migration 27 is compatible: 2.16 code ignores the tables, so a
downgrade keeps them untouched and does not refuse to start, and upgrading again picks up the clients and schedules
where they were.
