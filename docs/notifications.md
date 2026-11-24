# Notification center

The notification center is DockNest's inbox inside the app. It shows what your alert channels send, and a few things they do not, in one place you can read, filter and archive.

## What you see

- **Bell** in the top bar: the number of unread notifications, your running jobs as one pinned row, the newest four notifications, Mark all read, and a link to the center. It closes when you click outside it or press Escape.
- **Notifications page** (Operations): folders All, Needs action (errors and warnings), Backups & restores, Storage, System and Archived, each with its unread count. Filter by severity or unread. Each row has Mark read, Archive (Unarchive in the Archived folder) and an Open button that goes to the job or page it is about.
- **Toasts**: a new notification appears for a moment in the corner. At most three are shown, newest at the bottom, and "+N more" opens the center. Errors stay until you close them; success clears after 5 seconds, other kinds after 8 seconds. The clock stops while the pointer or keyboard is on the stack. Short "done" messages in the app, such as "Test started", use the same stack.

Severity is a coloured icon and a plain word: error, warning, info or success.

## What creates a notification

The same events as the external alerts (see [alerts](alerts.md)), for every administrator, whatever the alert rules say. Operators and viewers get none. Added for the center only:

| Event | Severity |
| --- | --- |
| Backup or restore finished | success |
| Backup or restore failed | error |
| Restore test passed | success |
| Restore test failed | error |
| Restore test could not run | warning |
| Recovery time proven by a restore test is old | warning |
| Server unreachable | error |
| Disk low | warning |
| Certificate expiring | warning (expired: error) |
| Update available | info |

Titles and bodies are built from the alert messages, so they hold only names you typed (app, server, destination) and a time. Never a host, address, path, token, log or error text. A last pass removes anything that looks like one.

A repeat of the same event (the same kind and source, within 24 hours) becomes one row: the count goes up, the time moves to the latest, and it is unread again, even if you had archived it. An event that names one occurrence (a restore test, a release) is never listed twice.

## Keeping and removing

Notifications are kept for 90 days after their last occurrence. The worker's existing maintenance pass removes older ones; there is no extra timer. Each user has their own list: marking read or archiving changes only your own.

## How the app reads them

The bell, the unread counts and the toasts come from the 5 second state poll the app already makes (`notifications` in `GET /api/state`, administrators only). The page reloads its list when that summary changes. There is no polling loop of its own.

## API

All routes need a signed-in administrator and the CSRF header on writes.

- `GET /api/notifications?tab=all|needs_action|backups|storage|system|archived&severity=&unread=1&limit=25&offset=0`: items, total and per-tab counts.
- `GET /api/notifications/unread-count`
- `POST /api/notifications/read` and `/archive` and `/unarchive` with `{ "ids": [1, 2] }` (at most 100)
- `POST /api/notifications/read-all`

## Upgrading

Migration 28 adds one table, `notifications`. Nothing existing is read or changed, and an older DockNest ignores the table, so a downgrade needs no data discard.

## Not covered yet

No detection exists today for NAS early-access errors or for a server whose recovery time has never been measured, so they raise no notification. Both can be added where that detection is built, without a new background loop.
