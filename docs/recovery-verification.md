# What backup verification proves

The existing `verified` flag means package integrity, not application recovery. The API also returns four independent `verification` dimensions, each with status, method, scope, job and timestamp. An append-only attempt history preserves previous checks; a failed later attempt is visible as the current result.

* **Integrity:** full AES-256-GCM authentication and stored SHA256, at publication, restoration or an authenticated `POST /api/backups/:id/scrub` job. A failed scrub disables verified downloads/restores. It does not erase the package or earlier evidence.
* **Consistency:** native cold-shutdown proof for selected database services, or explicit declared quiescence for generic writers. Stable static capture has separate source/extraction digest evidence. Operator declarations are labelled `declared`.
* **Isolated restore:** successful reconstruction into fresh paths with no published ports and none/internal isolated networks, expected source running states and container health. The helper validates the inventory of every image, mount and configuration archive before Docker loading or mount extraction. Legacy packages without that inventory retain their narrower evidence.
* **Application:** configured native read-only row-count checks match the values collected after application writers stop, before their database stops. Add `{ "name": "Orders", "table": "orders" }` to a database service's `checks`; MySQL/MariaDB also needs its local `database` name. Only named checks/hashes are retained in evidence. Static restores compare complete file contents and metadata. These checks do not prove login, payments or every application workflow.

An isolated restore with healthy processes but no configured data checks remains `not-tested` for application data. A mixed application/database site with only database checks remains `partial`. A database-only site with checks on every engine can pass its configured database scope. Generic executable hooks are intentionally unavailable. Use a separate reviewed adapter for meaningful application workflows.

Scrubs authenticate existing packages without stopping source services. Corrupt packages remain available for operator investigation; they cannot pass an integrity or isolated recovery gate. Retention and durable publication reconciliation are handled separately in M4.
