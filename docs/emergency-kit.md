# Kit check and the emergency kit

Two additions to [Self Backup](docknest-self-backup.md), designed in the 3.0.0 "If I'm gone" and "Keys safe" decisions.
Both run in the existing worker. This release adds the server side and its API; the screens come in a later release.

## Kit check

After every completed Self Backup, and when an administrator asks for a check (**Check now**), the worker proves that
the newest recovery kit opens:

1. It reads the newest kit the way a download does: from storage, at most 128 MB, with its SHA-256 checked.
2. It decrypts the kit in memory with the recovery passphrase DockNest keeps (sealed with the master key).
3. It checks the kit's format, its list of files and the SHA-256 of every file in it.
4. It compares the kit's master key with the live master key by their SHA-256 values.
5. It writes the kit's `state.sqlite` into a new `0700` folder in the worker's private kit folder
   (`DATA_DIR/manager-backups/.kit-check-*`), runs SQLite `integrity_check` on it, and removes the folder in every case.
   A folder left by an interrupted worker is removed at the next start, and the interrupted check runs again.

The result goes in `kit_checks`: the time, `passed` or `failed`, and a reason code. Reason codes: `no_kit`,
`unreadable` (storage could not be read, or the bytes did not match the recorded checksum), `size`, `format`,
`passphrase`, `contents`, `hashes`, `key_mismatch`, `integrity`, `no_passphrase` and `error`. Error text is never
stored. A failure raises the alert **Self Backup kit check failed** (`selfbackup.kit_check_failed`) for the alert rules
that select it.

What a pass means: "Opened with the passphrase DockNest keeps." It cannot prove that your own copy of the passphrase is
right.

API (administrators):

| Request | Result |
|---|---|
| `GET /api/self-backup` | adds `kitCheck: { last: { checkedAt, result, reason } or null, active }` |
| `POST /api/self-backup/kit-check` | `202 { id, result: "queued" }`; `409` while a check waits or runs, or before the first Self Backup |

## Emergency kit: an optional split between trusted people

**Off by default.** One recovery kit opened with your recovery passphrase stays the default. An install that never
turns the split on makes no key pair and no emergency kit, and nothing about its Self Backup changes.

Use the split if no single person should be able to open the kit, but some of them together should: K of N trusted
people (2 ≤ K ≤ N ≤ 16) can open it, and fewer than K learn nothing.

### How it works

1. When an administrator splits the kit, DockNest makes a random X25519 key pair. The private key (32 bytes) is split
   with [SLIP-0039](https://github.com/satoshilabs/slips/blob/master/slip-0039.md): Shamir's secret sharing over
   GF(256), one group, member threshold K of N, the standard RS1024 checksum and word list, and an empty SLIP-0039
   passphrase. Each part is 33 words.
2. DockNest stores only the public key, `digest = SHA-256("docknest emergency v1" || public key)`, the SLIP-0039
   identifier, K, N and the holder names (`emergency_keys`). The digest is printed on every part, so holders can check
   that they joined the right split.
3. The private key and the parts exist only in the API's memory during the split request. They are returned once, with
   `Cache-Control: no-store`, and are never written to the database, a log, the audit trail or job details.
4. After every completed Self Backup, the worker seals the same recovery kit, together with the recovery passphrase it
   opens with, to the public key, and stores it as
   `<storage root>/BACKUP/docknest-recovery/emergency/emergency_<digest prefix>_<UTC time>Z--<backup id>.dkem`,
   next to the one-file offline tool `emergency-open.js`. That happens on the Self Backup destination and on every
   copy destination that gets the recovery kit. Each file is uploaded as a `.partial` file, read back, renamed and
   read back again. A newer kit of the same split replaces the older one on that destination once it is verified. A
   failure is audited per destination and never fails the Self Backup.
5. To open it, K holders type their parts into the offline tool (below). It joins the parts, rebuilds the private key,
   checks it against the kit's digest before any decryption, and writes the newest matching kit as a recovery kit file
   with its passphrase file. From there, the [independent recovery](independent-recovery.md) steps apply.

DockNest never holds the private key, so it can make emergency kits but never open one.

### Split again, and Go back to one passphrase

**Split again** makes a new key pair. New kits use the new key. Old parts still open kits made before the re-split:
"Old parts stop opening new kits. Delete the old kits so old parts open nothing."

**Go back to one passphrase** retires the key pair: new Self Backups stop making emergency kits. The kits already in
storage stay until you delete them.

Every split and re-split is audited with the public digest, and raises **Emergency kit key changed**
(`emergency.key_changed`) on every alert channel, whatever the alert rules say. An administrator session that someone
else took over could otherwise seal your future kits to their own key without you noticing.

API (administrators; split, off and delete need a re-verification in the last 5 minutes, checked on the server):

| Request | Result |
|---|---|
| `GET /api/self-backup` | adds `emergency: { split: false, oldKits }`, or with the split on `{ split: true, digest, identifier, k, n, labels, createdAt, latestKitAt, oldKits }` |
| `POST /api/self-backup/emergency/split` `{ k, n, labels }` | `{ digest, identifier, k, n, createdAt, parts: [{ number, label, words }] }`, once, `Cache-Control: no-store` |
| `POST /api/self-backup/emergency/off` | `{ split: false }`; `409` when the kit is not split |
| `POST /api/self-backup/emergency/delete-old-kits` | `{ deleted, failed }`: removes every emergency kit the current split does not open |

### Opening an emergency kit without DockNest

Copy the `docknest-recovery/emergency/` folder from your backup storage: the tool is in it, as `emergency-open.js`.
It needs only Node 24 and no network. The same tool is `scripts/emergency-open.js` in the repository, and a kit made
while the split is on also carries it as `recovery/emergency-open.js`. A default kit (no split) keeps exactly the file
set of 2.16.4, so earlier releases still restore it.

```sh
cd ./emergency
node emergency-open.js list .
node emergency-open.js open . /secure/opened
```

`list` shows every kit, newest first, with its time, the DockNest release that made it and its key digest. `open`
asks for one part at a time (or reads one part per line from a pipe). A typo is caught by the part's checksum. The
parts are joined, the key is checked against the digest, and the newest kit made for that key is written to the new
folder as `docknest-recovery.dkit` and `recovery-passphrase.txt` (both `0600`). Then, from a copy of DockNest:

```sh
node scripts/recovery-kit.js restore /secure/opened/docknest-recovery.dkit /secure/new-manager-data /secure/opened/recovery-passphrase.txt
```

Keep the opened folder private and delete it once DockNest runs again: it holds the recovery passphrase. Words and keys
are never printed or saved by the tool.

### File format

```
"DKE1" | header length (2 bytes) | header JSON | nonce (12) | AES-256-GCM ciphertext | tag (16)
header = { format: 1, digest, ephemeralPublicKey, createdAt, release }
key    = HKDF-SHA256(X25519(ephemeral private, public key), salt = ephemeral public || public key,
                     info = "docknest emergency kit v1", 32 bytes)
sealed = "DKP1" | passphrase length (4 bytes) | recovery passphrase | recovery kit file
```

The header and nonce are authenticated as additional data. Each kit has its own ephemeral key and nonce. The header's
creation time and release let the tool list kits newest first, so an older kit cannot pass for the current one.

## Threat model

This applies only when the owner turns the split on. With the default single passphrase, the existing recovery kit
model holds unchanged.

| Threat | Mitigation |
|---|---|
| One holder, or up to K-1 holders together | Shamir's scheme reveals nothing below the threshold |
| K holders together | full access, by design: the owner chooses K and the people |
| Stolen storage | only ciphertext sealed to a key DockNest does not hold; storage and K parts are both needed |
| Leaked DockNest database | public key, digest and names only |
| A taken-over administrator session replaces the key | re-verification to split, audit entry, alert on every channel, digest on the parts |
| A wrong or damaged part | the RS1024 checksum per part, then the digest check before any decryption |
| An old kit put back in storage | each header has its creation time and release; the tool lists kits newest first |
| Timing side channels | a split or a join is one short local operation; table-based GF(256) is acceptable here |

## Verification

- `tests/emergency-crypto.test.js`: the official SLIP-0039 `vectors.json` (all 45 valid and invalid cases), the
  RFC 7748 X25519 vectors, fixed envelope vectors (fixed ephemeral key and nonce, in the tests only) checked by an
  independent decryption, the property that every K-subset rebuilds the key and no (K-1)-subset matches its digest,
  and the one-file offline tool.
- `tests/emergency-kit.test.js`: the API rules, emergency kits after each Self Backup, re-split, off, deleting old
  kits, the tool's output accepted by restore, the kit check passing and failing with each reason code, and a search
  of the database file, the audit trail, alerts, jobs, settings and the logs for every part, the private key and any
  four consecutive part words.
- `scripts/integration-emergency.js` (Linux integration suite): the same on a real SFTP storage host, including
  `recovery-kit.js restore` of the opened kit and the kit check on a corrupted kit.

Vendored test data: `tests/fixtures/slip39-vectors.json` from
[python-shamir-mnemonic](https://github.com/trezor/python-shamir-mnemonic) (MIT) and the word list in
`src/emergency/wordlist.js` from [SLIP-0039](https://github.com/satoshilabs/slips) (CC BY-SA 4.0). See NOTICE.

Roles used, from [agency-agents](https://github.com/msitarzewski/agency-agents):
[Security Architect](https://github.com/msitarzewski/agency-agents/blob/main/security/security-architect.md) for the
threat model and the cryptography;
[Secrets and Credential Engineer](https://github.com/msitarzewski/agency-agents/blob/main/security/security-secrets-credential-engineer.md)
for keeping parts and keys out of every store and log;
[Reality Checker](https://github.com/msitarzewski/agency-agents/blob/main/testing/testing-reality-checker.md) for the
honest kit check wording.
