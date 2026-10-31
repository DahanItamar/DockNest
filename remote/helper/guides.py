# helper/guides.py: Independent restore guide texts written into every backup package.
# <build:header>
# Removed when src/helper-bundle.js joins the modules into one helper.py (one namespace).
# These imports exist only so editors and linters can resolve names.
import sys,json,subprocess,os,time,uuid,pathlib,shutil,signal,urllib.request,urllib.error,urllib.parse,tarfile,re,http.client,threading,ssl,socket,shlex,hashlib,stat,tempfile,sqlite3,io,ipaddress,posixpath,errno
# </build:header>
RESTORE_GUIDE="""# Independent restore guide — format v1
Keep the DBM1 encrypted file, its SHA256 checksum, and the separate 32-byte master key.
Use scripts/decrypt-backup.js from this project's repository on Node.js 24. Verify the whole GCM tag and checksum before extraction. Never extract plaintext streamed before authentication.
After successful authenticated decryption, unpack payload.tar.gz into a new root-owned directory with mode 0700. Reject absolute paths, traversal, device nodes, escaping links and writes through symlinks before extraction. Safe relative symlinks and hard links to archived regular files are preserved.
Contents: manifest.json (contains secret Docker environment and settings), images.tar (exact original images and committed writable layers), mount-I-J.tar for each container/mount, config-I.tar for explicit compose/env/config files, and this guide.
Run docker load -i images.tar. Match manifest.containers[I] with manifest.snapshotImages[I]; do not use latest from a registry.
Extract each mount-I-J.tar into a different empty directory, keeping numeric UID/GID, modes, ACLs and xattrs. Recreate mounts at manifest.containers[I].Mounts[J].Destination; use read-only when RW is false. Never overwrite live bind paths or existing volume data.
For the basic isolated one-container restore, use docker create --name NEW_UNIQUE_NAME --network none --restart no --mount type=bind,src=NEW_SOURCE,dst=ORIGINAL_DEST SNAPSHOT_IMAGE_ID for every mount; append readonly when required. Committed image configuration preserves original command, entrypoint, environment and health check. Then docker start NEW_UNIQUE_NAME.
Run docker inspect and docker exec checks to verify database records, uploaded files, login and important workflows. No inbound or outbound networking is available in this mode. Network isolation prevents production emails, payments and integrations. Do not enable networking until secrets, scheduled jobs and external side effects have been reviewed.
The automatic grouped restore creates fresh internal bridge networks with isolated gateway mode (Docker 28+), preserves original network membership and DNS aliases, publishes no ports, disables external DNS forwarding and keeps originally stopped containers stopped. Static IP assignments, shared container network namespaces and overlapping mount paths require a reviewed offline adapter. Saved Compose files require path/port/project-name updates and secret review; do not run them unchanged.
Copy config archives into separate review directories. Configure TLS, reverse proxy, domains and DNS separately. Plan cutover only after application validation succeeds.
Replacement requires a verified backup of the current target before stopping it, explicit confirmation, a rollback plan and separate health verification. Never infer application recoverability from transport checksum alone.
Delete plaintext staging securely according to your storage policy; filesystem deletion alone does not guarantee erasure on every disk.
"""

INCREMENTAL_GUIDE="""
# Incremental backups (format v2)
manifest.backupKind says whether this package is a full backup or an increment. manifest.chain names the chain, this
package's position and, for an increment, the backup ID and ciphertext SHA-256 of the package before it. An increment
holds only the files that changed. With the recovery kit, as root on Linux with GNU tar:
  node decrypt-backup.js --chain <backup_...--ID.tar.gz.enc or a chain download folder> <master.key> <new folder>
  python3 helper.py restore-chain <that folder> <another new folder>
The first step finds and verifies every package of the chain (full backup first) and every link; the second rebuilds
each mount with the same checks as DockNest and lists the images.tar files to load, in order.
By hand: decrypt and verify every package of the chain first and check that each manifest.chain.parentSha256 matches
the package before it. Check every archive for unsafe paths, including the names in GNU.dumpdir records. Then, for each
mount, go into a new empty directory and extract the full backup's mount-I-J.tar, then the same mount of each increment
in order, from inside that directory (not with -C: GNU tar makes the temporary folder of a folder-name swap relative
to the working directory):
  cd NEW_DIRECTORY && tar --listed-incremental=/dev/null --xattrs --acls --numeric-owner -xpf /path/to/mount-I-J.tar
This also applies deletions and renames. Where an earlier archive restored a symlink and a later one has a real folder
at that path, remove the symlink before extracting that later archive (tar would follow it). Run docker load -i
images.tar for every package of the chain, in order. The snapshot-*.snar files are GNU tar snapshot files; a restore
does not need them.
"""
