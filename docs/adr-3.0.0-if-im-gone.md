# ADR: "If I'm gone": living runbook and emergency kit (3.0.0)

Status: proposed, security-critical. Index and audit: [3.0.0 design](design-3.0.0.md).

## Context

If the owner is unavailable, a trusted relative must be able to find the backups and bring the apps back, or hand
the job to someone who can. Today the expert pieces exist:

- the restore guide in every package (`guides.py`);
- the recovery kit (`recovery-kit.js`, scrypt and the existing format);
- verification evidence (`recovery-evidence.js`);
- the self-backup;
- restore test history.

Three things are missing: plain steps, a current inventory, and a way to give access to people without giving any one
of them everything.

## Decision 1: the living runbook

### Content

The runbook is generated from the database at request time:

- **Fleet overview:** what this is, who to ask (an owner-written note), servers (name, what runs there, an owner
  note), apps (server, last good backup, last restore test), where the backups are, and the emergency kit (K of N, who
  holds parts, labels only).
- **One page per app:** what it is, how to tell it works (its domains and what to expect), numbered steps if it is
  down, numbered steps to restore it from a backup, and the last restore test.

### Rules

- **Redacted by default:** no passwords, tokens, keys or env values, ever. Server addresses are hidden behind "Show
  addresses", which is off by default, and the printed copy follows that toggle.
- **Plain language:** steps are short and numbered, and each one links to the expert guide (`restore-guide.md`
  sections, `docs/independent-recovery.md`) for the person who will do the technical part.
- **Honest wording:**
  - "Verified" appears only with a passed restore test (`recovery-evidence.js` `TEST_METHOD`), with its date and
    source (main or off-site copy).
  - Otherwise the runbook says "Backed up, not tested yet".
  - A key that is missing from a backup (see Keys safe) is listed as a known gap.
- **Formats:** an HTML page with a print stylesheet (Print or save as PDF), and a download (a single self-contained
  HTML file).

### Out of date, event-driven

An inventory digest is computed as SHA-256 of a canonical JSON over:

- server ids, names and addresses;
- app ids, names, servers and domains;
- storage targets and copies;
- schedules;
- the latest restore test result per app;
- the emergency kit split state;
- the owner notes.

It is stored in `runbook_state.digest` when the runbook is made. Every read compares the stored digest with the
current one. If they differ, the page shows "This runbook is out of date" with the changes as categories (app added,
server address changed, and so on). There is no timer. The same comparison runs after the events that change those
inputs, so the Overview can show one quiet line. With the owner's opt-in, this can also be an alert event
(`runbook.outdated`, sent once per digest).

The redacted runbook is also written next to each emergency kit in storage, so a relative can read it before anything
is decrypted.

## Decision 2: the emergency kit, split K of N

### Construction

The kit stays current without DockNest keeping the secret. It uses Node `crypto` only:

1. When the owner splits the kit, DockNest generates a random X25519 key pair (`crypto.generateKeyPairSync('x25519')`).
2. The private key (32 bytes) is split with SLIP-0039: Shamir over GF(256), one group, member threshold K of N, with
   the standard RS1024 checksum and word list. With the optional SLIP-0039 passphrase empty, each part is 20 words
   for 128-bit secrets and 33 words for 256-bit secrets. This design uses 256-bit, so parts are 33 words.
3. DockNest stores only:
   - the public key;
   - the SLIP-0039 identifier;
   - K, N and the holder labels;
   - a `digest = SHA-256("docknest emergency v1" || public key)` shown on every part card, so holders can check
     they joined the right split.
4. The private key and the parts exist only in API memory during the split request. They are returned once, over the
   authenticated session, with `Cache-Control: no-store`, and are never written to the database, logs, audit trail or
   job details.
5. After every self-backup, the worker makes an emergency kit. This is the existing recovery kit bytes, sealed to the
   public key with an ephemeral X25519 exchange, HKDF-SHA256 (`info = "docknest emergency kit v1"`) and
   AES-256-GCM, with a header that holds the format version, public-key digest and ephemeral public key. It is
   stored under `docknest-recovery/emergency/` with the redacted runbook.
6. **Opening:** K holders type their words into the offline tool shipped in the recovery kit and in the repository
   (`scripts/emergency-open.js`, Node 24, no network). The tool joins the parts, rebuilds the private key, checks it
   against the digest, and decrypts the newest emergency kit into a recovery kit folder. From there, the existing
   recovery steps apply.
7. **Practice join:** two holders can test their parts in the browser on the Runbook page. The join runs in page
   JavaScript and only the digest is compared. The parts never go to the server. This is the only way to prove the
   parts work without opening a kit, and the UI says so.

### Why these choices

- **SLIP-0039:** a published, reviewed standard with official test vectors and independent open-source
  implementations. A relative is not tied to DockNest to join the parts.
- **An envelope to a public key, not a split passphrase:** kits stay current after every self-backup while DockNest
  holds no secret that opens them. Splitting the owner's passphrase would force DockNest to keep it, or would freeze
  the kit.
- **No home-made cryptography:** GF(256) arithmetic and the SLIP-0039 framing are implemented from the specification
  and checked against its vectors. X25519, HKDF and AES-GCM are Node built-ins.

### Re-split

"Split again" makes a new key pair. New kits use the new key. Old parts still open kits made before the re-split, so
the UI offers to delete those old emergency kits, and the wording is exact: "Old parts stop opening new kits.
Delete the old kits so old parts open nothing."

## Threat model

Assets: the emergency kit contents (`state.sqlite` and `master.key`, which together open every backup), the parts, and
the public key binding.

| Threat | Effect | Mitigation |
|---|---|---|
| One holder, or up to K-1 colluding holders | learn nothing about the key | Shamir is information-theoretically secure below the threshold |
| K colluding holders | full access | inherent. The owner chooses K and the people. The runbook says so |
| A holder loses a part | fewer parts left | N greater than K gives slack. Re-split is one flow |
| Stolen storage | only ciphertext | AES-GCM to a key DockNest does not hold. The recovery kit inside is still passphrase-encrypted, so storage plus K parts are needed |
| Leaked DockNest database | public key, digest and labels only | no secret is stored |
| An attacker with an admin session replaces the public key, so future kits are sealed to them | silent takeover of future kits | re-verification is required to split. Audit entry. Alert `emergency.key_changed` to every channel. The digest is printed on the parts, and the Runbook shows the current digest, so a mismatch is visible |
| A compromised browser during the split | parts exposed at creation | the same trust as the admin session. Shown once, never stored. Guidance to split from a trusted device |
| A malicious practice-join page | parts typed into a compromised page | the join is client-side only. The offline tool is the recommended path for a real recovery |
| A wrong or corrupt part | wrong key | the RS1024 checksum per part, then the digest check before any decrypt |
| Rollback to an old kit | older data | each kit header carries its creation time and release. The tool lists kits newest first |
| Side channels | — | a one-shot local operation. Table-based GF(256) is acceptable here, and the reason is documented |

### Security review checklist (before merge)

- Pass the official SLIP-0039 `vectors.json` (valid and invalid cases) and the RFC 7748 X25519 vectors.
- Add our own fixed vectors for the envelope (fixed ephemeral key, fixed nonce, in tests only).
- Property tests: every K-subset of N rebuilds the secret, and no (K-1)-subset matches the digest.
- Grep tests that no part, private key or word list output reaches logs, the audit trail, job details or the database.
- An Opus security reviewer and a second-opinion read-only review.

## UI

- The DockNest backup page gets a card "Emergency kit for trusted people". The split dialog has three steps (choose
  people, hand out parts one at a time, done) with the existing dialog stepper.
- The Runbook page is new: admin only, in the sidebar below "DockNest backup".
- Boards: C1-C5 and D1-D6.

## Data

Compatible migrations:

- `emergency_keys`: `id`, `public_key`, `digest`, `identifier`, `k`, `n`, `labels` JSON, `created_by`, `created_at`,
  `retired_at`.
- `runbook_state`: `digest`, `made_at`, `made_by`, `notes` (the owner-written text, at most 4000 characters).

## Tests

- Unit: the vectors above, the digest canonicalization, "out of date" categories, and redaction (no address or env
  value in the output with the toggle off).
- Integration: a self-backup produces an emergency kit, `emergency-open.js` with K parts gives a recovery kit that
  `recovery-kit.js restore` accepts, and a full independent recovery on the Linux suite.

## Roles used

[Security Architect](https://github.com/msitarzewski/agency-agents/blob/main/security/security-architect.md)
for the threat model and the cryptography choices.
[Technical Writer](https://github.com/msitarzewski/agency-agents/blob/main/engineering/engineering-technical-writer.md)
for the plain-language runbook.
[Reality Checker](https://github.com/msitarzewski/agency-agents/blob/main/testing/testing-reality-checker.md) for
"Verified" only with evidence.
