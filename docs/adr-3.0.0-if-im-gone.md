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

The runbook is generated from the database at request time. Sections, in this order:

1. **Start here:** three short numbered lists:
   - get a new server;
   - install DockNest;
   - connect the backup storage.
2. **Restore everything in this order:** one numbered list across all apps. Linked apps that own a shared database come
   first (from the 2.16.5 links), then the apps that use them, then the rest. Each item has a one-line reason.
3. **Fleet overview:**
   - what this is;
   - who to ask (an owner-written note);
   - servers (name, what runs there, an owner note);
   - apps (server, last good backup, last restore test);
   - where the backups are;
   - the emergency kit (K of N, who holds parts, labels only).
4. **One page per app:** what it is, how to tell it works (its domains and what to expect), numbered steps if it is
   down, numbered steps to restore it from a backup, and the last restore test.

### Rules

- **Writing:** short sentences, one action per step, no filler. Each step starts with a verb ("Open Storage.").
  Expert detail goes behind a link to the expert guide (`restore-guide.md` sections, `docs/independent-recovery.md`).
- **Redacted by default:** the page never shows passwords, tokens, keys, env values or server addresses. The PDF
  includes addresses or login details only when the dialog says so (below).
- **Honest wording:**
  - "Verified" appears only with a passed restore test (`recovery-evidence.js` `TEST_METHOD`), with its date and
    source (main or off-site copy).
  - Otherwise the runbook says "Backed up, not tested yet".
  - A key that is missing from a backup (see Keys safe) is listed as a known gap.

### Export: "Download recovery guide (PDF)"

**Entry point.** There is no button. A documentation-style text link, "Download recovery guide (PDF)", sits under the
runbook title and under each app page's title. On an app page, the dialog opens with only that app ticked. The link
opens a dialog, "Download recovery guide", with these choices:

- **Apps:** every app, all ticked by default, with "Select all" and "Select none".
- **Include:**

  | Option | Default | Rule |
  |---|---|---|
  | Server addresses | off | — |
  | Login details | off | administrators only (hidden for operators); re-verification when ticked; a warning panel: "This PDF will hold logins to your backup storage. Anyone with the file can reach your backups. Keep it like a password. Creating it is recorded in the audit log." |
  | Restore test history | on | — |
  | Schedules | on | — |
  | Your notes | on | — |

- **Actions:** one primary action, "Create PDF", and Cancel.
- **States:** default, login details ticked with the warning, creating (button busy, inputs disabled), and error
  ("The PDF could not be created. Nothing was saved. Try again.").

**What "Login details" holds:**

- the backup storage logins DockNest keeps sealed (SFTP host, user and password or key; S3 endpoint, bucket and keys);
- the owner's own per-app login notes, sealed like other secrets.

**What it never holds:** the master key, the recovery passphrase, SSH private keys for servers, or emergency kit parts.
The emergency kit is how a relative gets those.

**Audit.** The entry records who, when, the app ids and the option flags. It never records the content.

**Output.** `POST /api/runbook/pdf { apps[], include{} }` returns `application/pdf` as a download
(`Content-Disposition: attachment`, `Cache-Control: no-store`). There is no print dialog and no HTML file. The PDF is
built in memory and streamed. It is never written to disk, never cached and never logged; the request log records
only the route and status. Re-verification is enforced on the server when `include.logins` is true, not just in the UI.

### PDF approach: a small in-house writer, no new npm dependency

`src/runbook/pdf.js` is a minimal PDF 1.7 writer (Node 24 ESM, `node:zlib` for FlateDecode). It uses a fixed layout
model:

- headings, paragraphs, numbered lists and simple tables;
- automatic page breaks, a page header and footer with page numbers;
- a title page.

**Fonts.** Text uses embedded TrueType fonts as Type0/CIDFontType2 with Identity-H encoding and a ToUnicode CMap, so
text can be selected and searched. Hebrew and other scripts work: a Noto Sans Hebrew face covers them. Right-to-left
runs are reordered with a small Unicode bidi pass, which is enough because Hebrew needs no glyph shaping. The writer
reads only the `cmap`, `hmtx`, `head`, `hhea` and `maxp` tables from fonts that ship with DockNest. It never reads fonts
or PDFs from users.

**Font files.** Static OFL/Apache TTFs (Roboto Regular and Bold, Noto Sans Hebrew Regular) are vendored under
`assets/fonts/` with their licences, and their SHA-256 is pinned in a test. A font file is not a code dependency. The
fonts are embedded whole (no subsetting), which costs about 0.5 MB per PDF. That is acceptable for a file made rarely.

**Why not a library:**

- pdfkit pulls in fontkit and several transitive packages.
- pdf-lib has had no release since 2021.
- A headless browser is far too large for the image and the attack surface.

Writing PDF with text only is a well-bounded format task, about 400 lines. It is easier to review than a dependency tree.

**Security notes:**

- The writer only writes. It parses no untrusted input.
- Every string from the database goes into content streams through one escaping function for PDF literal strings,
  which handles `\`, `(`, `)` and control characters. Text is encoded as glyph ids, so no raw byte from input ever
  becomes a PDF operator.
- There is no JavaScript, no forms, no embedded files, no launch actions, and no external links except fixed `https`
  links to the project's docs.
- Limits: 200 apps, 2,000 pages and 64 MB of output. A request beyond them is refused.

**Tests:**

- golden-structure tests: xref offsets, object count and trailer;
- an escaping fuzz test, so injected `) Tj` sequences stay text;
- a Hebrew round-trip through the ToUnicode map;
- on the Linux CI image, `qpdf --check` and `pdftotext` checks that the text matches and that no secret appears when
  login details are off.

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

A redacted PDF of the runbook (all apps; no addresses and no login details, whatever the dialog last used) is also
written next to each emergency kit in storage, so a relative can read it before anything is decrypted. That
automatic copy can never include login details, and a test asserts it.

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
| An exported PDF with login details leaks | anyone with the file can reach the backup storage (the backups themselves stay encrypted with the master key) | off by default, administrators only, re-verification enforced on the server, a warning in the dialog, an audit entry, never stored or logged, never in the automatic copy next to the kit |
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
- The recovery guide dialog opens from a documentation-style text link, never from a button.
- Boards: C1-C9 (runbook and export dialog states), D1-D6, and F1-F7 (A4 mock pages of the recovery guide PDF: cover, Start here, restore order, a Verified app, an untested app with a known gap, the same app with secrets marked on every page, and the emergency kit page).

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
