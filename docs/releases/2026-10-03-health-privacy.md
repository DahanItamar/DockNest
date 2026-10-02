# Site compatibility, system health and repository privacy

## M1 — Site compatibility

Native static nginx sites now appear in discovery and support verified encrypted capture, Full ZIP and private file restores without changing live hosting. Docker discovery fills detected health URLs, domains and reviewed Compose/environment paths; saved public probe paths are preserved. In-project environment links resolve to their regular-file targets.

Real isolated Linux Docker 29.1.3 integration passed. A native static production capture/private restore verified 33 files and all 45 ZIP entries; an application backup completed after its configuration was corrected. All four configured sites passed required readiness checks. A CDN-blocked static public probe is explicitly informational, while file/configuration and storage checks remain required. Private operational identifiers are excluded from this document.

## M2 — Interface and health

Backup site rows fit the measured viewport instead of a fixed count, with denser spacing, lower controls and stable partial-page navigation. Resizing keeps the first visible site within the new page. Expanded recovery histories retain their existing actions and normal document flow.

The duplicate footer and sidebar name badge are removed. System health sits above storage: a wide heartbeat with text in the expanded sidebar and a compact pulse when collapsed. Blue means fresh API data, an online worker and no latest job needing attention; purple explains interrupted connections, an unavailable worker or work needing review. Stale connections stop the sweep; reduced motion uses a static symbol.

## M3 — Privacy and documentation

The repository remains private. Publishable history was sanitized while preserving section commits: private operations/design evidence were removed, infrastructure examples were replaced with reserved addresses and author metadata was anonymized. Known private identity/address/workstation markers were absent in the final blob and commit-metadata audit. Gitleaks found no live credential matches; the only original match was the published RFC 6238 test vector, now excluded by exact value.

GitHub evidence review covered 53 downloaded archives and offline OCR of 204 screenshots. Thirteen screenshot artifacts containing private infrastructure examples were removed individually. Clean integration artifacts and workflow logs were preserved; their text/secret scans found no private matches. The README uses the current logo and two high-resolution screenshots generated entirely from synthetic API responses. Current logo assets remain available in a sanitized pack.

CI now checks tracked privacy markers and Git history for secrets. Arbitrary browser screenshot uploads were removed. See [repository privacy](../repository-privacy.md) for scope and history-rewrite limitations.

## Verification and rollout

`npm run check` passed the build and 49 Node tests, including the Python helper suite. Local smoke, site setup, responsive pagination and system health browser checks passed. The final health/pagination/setup suites also passed against public HTTPS with synthetic API fixtures. All 37 public static hashes and all 24 runtime hashes matched the release in both containers; health returned 200 and anonymous metadata access returned 401.

Release `release-d35a299` was applied with protected metadata, an idle-worker guard, graceful worker shutdown and rollback handling. Existing state, accounts, storage credentials, backups and hosting were preserved. Exactly identified unused image tags, obsolete source files and superseded release artifacts were removed after verification. Layers required by the current image remain.

Selected agency roles and skills are documented in [reference roles](../agents/README.md). This release does not claim universal database, external-dependency or live-replacement recovery support.
