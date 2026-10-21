# History API

`GET /api/state` still returns the latest 1000 backups, 500 jobs, 500 restores and 250 audit events for the current interface, with the same fields as before. Rows with identical timestamps are now ordered by id, descending, the same way as the endpoints below. For older entries, or to load history a page at a time, use these endpoints. They need the same signed-in session as `/api/state`:

| Endpoint | Ordered by (newest first) |
| --- | --- |
| `GET /api/backups` | `captured_at`, then `id` |
| `GET /api/jobs` | `created_at`, then `id` |
| `GET /api/restores` | `created_at`, then `id` |
| `GET /api/audit` | `created_at`, then `id` |

Query parameters:

* `limit`: 1 to 200, default 50.
* `cursor`: the `nextCursor` value from the previous page. Leave it out for the first page.

The response is `{ "items": [...], "nextCursor": "..." }`. On the last page, `nextCursor` is `null`. Items have the same shape as the matching `/api/state` lists. Backups include their `verification` evidence but never their storage path. An invalid `limit` or `cursor` returns `400`.

The cursor holds the timestamp and id of the last item on the page, and the next page starts strictly after it. Entries added while you page through history therefore do not repeat or shift items you have already loaded. Each request is a single range scan on a `(timestamp, id)` index. Verification evidence for a whole page of backups is read in one query.
