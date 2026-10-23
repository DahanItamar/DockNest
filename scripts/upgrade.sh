#!/bin/sh
# DockNest upgrade/rollback for a git-clone + Docker Compose installation. POSIX sh; needs git and docker compose.
# Usage: scripts/upgrade.sh [--version vX.Y.Z] [--non-interactive] [--force] [--allow-data-rollback]
#                           [--status-file PATH] [--timeout SECONDS] [--wait SECONDS] [--dry-run] [--no-prune] [--no-verify]
# --dry-run is read-only (no fetch, status file or hold) and lists what retention would remove; --no-prune keeps it all.
# The target tag must be on origin/main and, when cosign is installed, a 2.2.0+ target's signed release manifest must
# verify; --no-verify skips both (forks, air-gapped mirrors). Host updater only: --no-fetch, --expect-commit SHA,
# --expect-image-digest sha256:..., --upgrade-only, --request-id ID; --capabilities lists the supported flags.
# Exit codes: 0 done or already current; 1 usage; 2 precondition refused, nothing changed; 3 work still running;
# 4 failed, previous release restored (metadata unchanged or only compatibly migrated); 5 failed after an incompatible
# migration or unexpectedly, manual rollback needed (commands printed); 6 automatic rollback failed. See docs/upgrading.md.
set -eu
umask 077
# Locate the checkout: DOCKNEST_DIR, this script's checkout, or the current directory (for a copy run from /tmp).
if [ -z "${DOCKNEST_DIR:-}" ]; then
  DOCKNEST_DIR=$(cd "$(dirname "$0")/.." && pwd)
  [ -f "$DOCKNEST_DIR/compose.yaml" ] || DOCKNEST_DIR=$(pwd)
fi
[ -f "$DOCKNEST_DIR/compose.yaml" ] || { echo 'Run this from the DockNest checkout or set DOCKNEST_DIR.' >&2; exit 1; }
# git checkout replaces this file while sh is still reading it, so run from a private copy. Only the copy this script
# itself made (passed as the first argument, never from the environment) is ever deleted.
COPY=''
if [ "${1:-}" = --internal-copy ]; then COPY=$2; shift 2
else
  copy=$(mktemp "${TMPDIR:-/tmp}/docknest-upgrade.XXXXXX") && cp "$0" "$copy" || exit 1
  DOCKNEST_DIR=$DOCKNEST_DIR exec sh "$copy" --internal-copy "$copy" "$@"
fi
cd "$DOCKNEST_DIR"
ROOT=$(pwd)
TARGET='' INTERACTIVE=1 FORCE=0 DATA_ROLLBACK=0 STATUS_FILE='' TIMEOUT=300 WAIT=600 DRY_RUN=0 PRINT_SCHEMA=0 NO_PRUNE=0 CLEANUP_TIMEOUT=120
NO_FETCH=0 NO_VERIFY=0 UPGRADE_ONLY=0 CAPABILITIES=0 EXPECT_COMMIT='' EXPECT_DIGEST='' REQUEST_ID=''
# Format of the result marker in every upgrade backup; bumped only when the meaning of that file changes.
MARKER_FORMAT=1
# Version of the status file and flag contract the host updater checks with --capabilities.
PROTOCOL=1
need() { [ "$1" -ge 2 ] || { echo "Missing value for $2" >&2; exit 1; }; }
while [ $# -gt 0 ]; do
  case "$1" in
    --no-fetch) NO_FETCH=1 ;;
    --no-verify) NO_VERIFY=1 ;;
    --upgrade-only) UPGRADE_ONLY=1 ;;
    --capabilities) CAPABILITIES=1 ;;
    --expect-commit) need $# "$1"; EXPECT_COMMIT=$2; shift ;;
    --expect-image-digest) need $# "$1"; EXPECT_DIGEST=$2; shift ;;
    --request-id) need $# "$1"; REQUEST_ID=$2; shift ;;
    --version) [ $# -ge 2 ] || { echo 'Missing value for --version' >&2; exit 1; }; TARGET=$2; shift ;;
    --version=*) TARGET=${1#*=} ;;
    --non-interactive) INTERACTIVE=0 ;;
    --force) FORCE=1 ;;
    --allow-data-rollback) DATA_ROLLBACK=1 ;;
    --status-file) [ $# -ge 2 ] || { echo 'Missing value for --status-file' >&2; exit 1; }; STATUS_FILE=$2; shift ;;
    --status-file=*) STATUS_FILE=${1#*=} ;;
    --timeout) [ $# -ge 2 ] || { echo 'Missing value for --timeout' >&2; exit 1; }; TIMEOUT=$2; shift ;;
    --wait) [ $# -ge 2 ] || { echo 'Missing value for --wait' >&2; exit 1; }; WAIT=$2; shift ;;
    --dry-run) DRY_RUN=1 ;;
    --no-prune) NO_PRUNE=1 ;;
    --cleanup-timeout) [ $# -ge 2 ] || { echo 'Missing value for --cleanup-timeout' >&2; exit 1; }; CLEANUP_TIMEOUT=$2; shift ;; # tests: retention time limit
    --print-schema) PRINT_SCHEMA=1 ;; # tests: schema and compatibility floor parsed from src/migrations.js
    -h|--help) sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $1 (see --help)" >&2; exit 1 ;;
  esac
  shift
done
case "$TIMEOUT$WAIT" in *[!0-9]*) echo '--timeout and --wait take whole seconds' >&2; exit 1 ;; esac
case "$CLEANUP_TIMEOUT" in ''|*[!0-9]*) echo '--cleanup-timeout takes whole seconds' >&2; exit 1 ;; esac
matches() { printf '%s\n' "$1" | grep -Eqx "$2"; }
[ -z "$EXPECT_COMMIT" ] || matches "$EXPECT_COMMIT" '[0-9a-f]{40}([0-9a-f]{24})?' || { echo '--expect-commit takes a full lowercase commit SHA' >&2; exit 1; }
[ -z "$EXPECT_DIGEST" ] || matches "$EXPECT_DIGEST" 'sha256:[0-9a-f]{64}' || { echo '--expect-image-digest takes sha256: and 64 lowercase hex digits' >&2; exit 1; }
[ -z "$REQUEST_ID" ] || matches "$REQUEST_ID" '[A-Za-z0-9._-]{1,128}' || { echo '--request-id takes 1 to 128 letters, digits, dots, dashes or underscores' >&2; exit 1; }
if [ "$CAPABILITIES" = 1 ]; then
  printf '{"protocol":%s,"flags":["--version","--non-interactive","--force","--allow-data-rollback","--status-file","--timeout","--wait","--dry-run","--no-prune","--no-fetch","--no-verify","--expect-commit","--expect-image-digest","--upgrade-only","--request-id","--capabilities"],"statusFields":["phase","from","to","startedAt","updatedAt","ok","error","rollbackHint","warning","reason","schemaFrom","schemaTo","requestId","cleanup"]}\n' "$PROTOCOL"
  exit 0
fi
[ -t 0 ] || INTERACTIVE=0
# git's ownership check is relaxed for this one checkout only, per command, so a root run of a user-owned checkout works.
# Replace objects are never honoured: they could make a verified commit name different content (F3).
GIT_NO_REPLACE_OBJECTS=1; export GIT_NO_REPLACE_OBJECTS
git_() { git -c "safe.directory=$ROOT" "$@"; }
PHASE=init LAST_PHASE=init FROM='' TO='' STARTED=$(date -u +%Y-%m-%dT%H:%M:%SZ) HINT=''
FINISHED=0 HOLD=0 CHECKED_OUT=0 STOPPED=0 SNAPSHOT='' STATUS_TMP='' DB_SCHEMA='' IMAGE_MODE=0 PREV_IMAGE='' PREV_ID='' NEW_IMAGE=''
SAVE='' NEW_ID='' IMAGES_BEFORE='' IMAGES_LISTED=0 LOCAL_IMAGE='' COMPAT_AFTER='' CLEANUP=0 CLEANUP_PID='' WATCHDOG_PID='' WARN_FILE='' WARNING=''
REASON='' SCHEMA_TO='' START_FAILED=0 HEALTH_FAIL='' FETCH_FAILED=0 PREV_DIGESTS='' VERIFY_DIR='' LOCKED=0 LOCK="$ROOT/data/.upgrade.lock"
# REPO: this install's image repository; PREV_REF: the stable tag that pins the previous release's image (pin_previous).
REPO='' PREV_REF='' OLD_PREV='' CLEAN_FILE='' CLEANED=''
[ "$DRY_RUN" = 1 ] && STATUS_FILE=''
json() { printf '%s' "$1" | tr '\n\r\t' '   ' | tr -d '\000-\010\013\014\016-\037\177' | sed 's/\\/\\\\/g; s/"/\\"/g'; }
# Failure reason codes (docs/update-center.md section 7.1); anything else is written as "unknown".
REASONS=' verify-signature-invalid verify-not-on-main verify-manifest-mismatch state-mismatch low-disk fetch-failed jobs-did-not-finish checkout-failed pull-failed build-failed start-failed migration-failed health-timeout-api health-timeout-worker rollback-failed interrupted runtime-limit unknown '
reason_of() { case "$REASONS" in *" ${1:-none} "*) printf '%s' "$1" ;; *) printf unknown ;; esac; }
int_or_null() { case "$1" in ''|*[!0-9]*) printf null ;; *) printf '%s' "$1" ;; esac; }
# Never aborts the upgrade: a status file that cannot be written is reported and skipped.
status() { # status OK ERROR
  [ -n "$STATUS_FILE" ] || return 0
  ok=null; [ -n "${1:-}" ] && ok=$1
  dir=$(dirname "$STATUS_FILE")
  if [ -L "$STATUS_FILE" ] || [ -L "$dir" ] || [ ! -d "$dir" ] || [ ! -O "$dir" ]; then echo "WARNING: not writing $STATUS_FILE (it or its directory is a link, missing or not owned by this user)" >&2; return 0; fi
  # The temporary name is unpredictable and created exclusively (noclobber = O_EXCL, never follows a planted link)
  # together with its contents, and mode 0644 comes from the umask, so nothing is ever opened by path twice.
  STATUS_TMP="$dir/.status.$$.$(od -An -N6 -tx1 /dev/urandom | tr -d ' \n')"
  # warning: set only by the cleanup phase, from fixed messages plus validated folder names and image IDs.
  # reason: only on a failure, from the fixed list; schemaFrom/schemaTo: integers or null; requestId: validated above.
  # cleanup: the one-line retention summary of a success ("Cleaned up: N old DockNest images"), built from a count.
  if ( set -C; umask 022; printf '{"phase":"%s","from":"%s","to":"%s","startedAt":"%s","updatedAt":"%s","ok":%s,"error":%s,"rollbackHint":%s,"warning":%s,"reason":%s,"schemaFrom":%s,"schemaTo":%s,"requestId":%s,"cleanup":%s}\n' \
    "$PHASE" "$(json "$FROM")" "$(json "$TO")" "$STARTED" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$ok" \
    "$( [ -n "${2:-}" ] && printf '"%s"' "$(json "$2")" || printf null)" "$( [ -n "$HINT" ] && printf '"%s"' "$(json "$HINT")" || printf null)" \
    "$( [ -n "$WARNING" ] && printf '"%s"' "$(json "$WARNING" | tr -d '\\"' | cut -c1-1024)" || printf null)" \
    "$( [ "$ok" = false ] && printf '"%s"' "$(reason_of "$REASON")" || printf null)" "$(int_or_null "$DB_SCHEMA")" "$(int_or_null "$SCHEMA_TO")" \
    "$( [ -n "$REQUEST_ID" ] && printf '"%s"' "$REQUEST_ID" || printf null)" \
    "$( [ -n "$CLEANED" ] && printf '"%s"' "$(json "$CLEANED" | tr -d '\\"' | cut -c1-256)" || printf null)" > "$STATUS_TMP" ) 2>/dev/null \
    && mv -f "$STATUS_TMP" "$STATUS_FILE" 2>/dev/null; then STATUS_TMP=''; else echo "WARNING: could not write $STATUS_FILE" >&2; rm -f "$STATUS_TMP"; STATUS_TMP=''; fi
  return 0
}
phase() { PHASE=$1 LAST_PHASE=$1; echo "==> $2"; status; }
cleanup_files() {
  [ -z "$STATUS_TMP" ] || rm -f "$STATUS_TMP"; [ -z "$WARN_FILE" ] || rm -f "$WARN_FILE"; [ -z "$CLEAN_FILE" ] || rm -f "$CLEAN_FILE"; [ -z "$VERIFY_DIR" ] || rm -rf "$VERIFY_DIR"
  [ "$LOCKED" != 1 ] || rm -rf "$LOCK"
  case "$COPY" in */docknest-upgrade.*) rm -f "$COPY" ;; esac
}
# One run at a time: a lock folder (mkdir is atomic) holding the owner's PID. A lock whose process is gone is taken
# over only while holding a second mkdir mutex, and only after its PID is read again under that mutex: a run that saw
# the same stale lock earlier then finds the new owner's live PID and refuses, so two runs can never both own it.
lock_pid() { _pid=$(cat "$LOCK/pid" 2>/dev/null || true); case "$_pid" in ''|*[!0-9]*) return 1 ;; esac; echo "$_pid"; }
pid_alive() { kill -0 "$1" 2>/dev/null || [ -d "/proc/$1" ]; }
take_lock() {
  [ -d "$ROOT/data" ] && [ ! -L "$ROOT/data" ] || return 0 # nothing to protect yet; preflight refuses without data/
  pid='' mutex="$LOCK.takeover"
  if mkdir "$LOCK" 2>/dev/null; then LOCKED=1; echo "$$" > "$LOCK/pid"; return 0; fi
  if [ ! -L "$LOCK" ] && pid=$(lock_pid) && ! pid_alive "$pid" && mkdir "$mutex" 2>/dev/null; then
    if [ "$(lock_pid || true)" = "$pid" ] && rm -rf "$LOCK" && mkdir "$LOCK" 2>/dev/null; then
      LOCKED=1; echo "$$" > "$LOCK/pid"; rmdir "$mutex"; return 0
    fi
    rmdir "$mutex"
  fi
  STATUS_FILE='' # the status file belongs to the run that holds the lock
  fail 2 "Another upgrade.sh run holds data/.upgrade.lock (PID ${pid:-unknown}). Wait for it to finish; if none is running, remove data/.upgrade.lock and data/.upgrade.lock.takeover."
}
# The exit code of this run, appended to its upgrade backup's result marker: retention never removes the backup of a
# run that ended 5 or 6, or of one that has no recorded exit code (interrupted).
record_result() { if [ -n "$SAVE" ] && [ -d "$SAVE" ] && [ ! -L "$SAVE" ] && [ ! -L "$SAVE/result" ]; then printf 'exit=%s\n' "$1" >> "$SAVE/result" 2>/dev/null || true; fi; }
fail() { # fail CODE MESSAGE [REASON]
  FINISHED=1 PHASE=failed; [ -z "${3:-}" ] || REASON=$3; echo "ERROR: $2" >&2
  [ -n "$HINT" ] && printf '\nRollback:\n%s\n' "$HINT" >&2
  # A refusal or a clean failure must not leave new work blocked; only codes 5 and 6 keep the hold for the operator.
  if [ "$HOLD" = 1 ] && [ "$1" -lt 5 ]; then release_hold || true; HOLD=0; fi
  record_result "$1"; status false "$2"
  [ "$1" != 4 ] || drop_new_image || true
  exit "$1"
}
# Runs for every exit that did not go through fail or a success path (a command aborted under set -e, a signal):
# put the previous release back when the metadata is provably unchanged, always release the hold, never leave ok:null.
# Once success is recorded (cleanup), any end is still a success: exit 0, status done, never a revert.
on_exit() {
  code=$?; trap - EXIT; set +e
  if [ "$CLEANUP" = 1 ]; then
    grep -q '^exit=' "$SAVE/result" 2>/dev/null || record_result 0
    if [ "$code" != 0 ]; then
      for pid in $CLEANUP_PID $WATCHDOG_PID; do kill "$pid" 2>/dev/null; done
      echo "WARNING: removing old upgrade files was interrupted (exit $code). DockNest $TO is running; nothing needs to be done." >&2
      WARNING='Removing old upgrade files was interrupted; some may remain until the next successful upgrade.'
      PHASE=done; status true
    fi
    cleanup_files; exit 0
  fi
  if [ "$FINISHED" != 1 ]; then
    msg="Unexpected failure (exit $code) during phase $LAST_PHASE."; rc=5
    echo "ERROR: $msg" >&2
    if [ "$HOLD" = 1 ] || [ "$CHECKED_OUT" = 1 ]; then
      if try_revert; then HINT='' rc=4; msg="$msg The previous release was restored; $( [ -n "$COMPAT_AFTER" ] && echo 'it runs on the compatibly migrated metadata.' || echo 'no data was changed.')"; else msg="$msg Nothing was rolled back automatically."; fi
    fi
    [ -n "$HINT" ] && printf '\nRollback:\n%s\n' "$HINT" >&2
    record_result "$rc"; PHASE=failed; status false "$msg"
    [ "$rc" != 4 ] || drop_new_image
    cleanup_files; exit "$rc"
  fi
  cleanup_files
}
trap on_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
confirm() {
  [ "$INTERACTIVE" = 1 ] || return 0
  printf '%s [y/N] ' "$1"; read -r answer || answer=''
  case "$answer" in y|Y|yes|YES) ;; *) fail 2 'Cancelled by the operator.' ;; esac
}
# Numeric SemVer comparison of X.Y.Z (pre-release suffixes ignored): succeeds when $1 >= $2.
version_ge() { awk -v a="${1%%-*}" -v b="${2%%-*}" 'BEGIN{split(a,x,".");split(b,y,".");for(i=1;i<=3;i++){if(x[i]+0>y[i]+0)exit 0;if(x[i]+0<y[i]+0)exit 1}exit 0}'; }
# Highest migration number in a git revision; releases before versioned migrations (v2.0.0) report 0.
# Both read one-line `{ version: N, ... }` entries; tests/upgrade-script.test.js checks them against the real file.
schema_of() { sed -n 's/^ *{ *version: *\([0-9][0-9]*\),.*/\1/p' | tail -n 1 | grep . || echo 0; }
# Highest non-`compatible: true` migration: code at or above this schema can run on the database (docs/upgrading.md).
floor_of() { grep -E '^ *\{ *version: *[0-9]+,' | grep -v 'compatible: true' | sed -n 's/^ *{ *version: *\([0-9][0-9]*\),.*/\1/p' | tail -n 1 | grep . || echo 0; }
schema_at() { git_ show "$1:src/migrations.js" 2>/dev/null | schema_of; }
package_field() { git_ show "$1:package.json" | sed -n "s/^ *\"$2\": *\"\([^\"]*\)\".*/\1/p" | head -n 1; }
in_data() { script=$1; shift; docker compose run --rm --no-deps -T --entrypoint /bin/sh worker -ec "$script" sh "$@"; }
db_schema() { docker compose run --rm --no-deps -T --entrypoint node worker -e 'const {DatabaseSync}=require("node:sqlite");const d=new DatabaseSync("/data/state.sqlite",{readOnly:true});console.log(d.prepare("PRAGMA user_version").get().user_version);d.close()' 2>/dev/null | tail -n 1; }
# healthy VERSION SECONDS: the API reports VERSION and the worker runs. VERSION "legacy" means a release without
# /api/version (v2.0.0 answers 401 there), where /healthz is the only signal.
healthy() {
  deadline=$(( $(date +%s) + $2 ))
  while :; do
    # HEALTH_FAIL names the part that failed last, for the reason code (health-timeout-api or -worker).
    if docker compose exec -T api node -e 'const [want]=process.argv.slice(1);(want==="legacy"?fetch("http://127.0.0.1:3000/healthz").then(r=>{if(!r.ok)process.exit(1)}):fetch("http://127.0.0.1:3000/api/version").then(r=>r.json()).then(j=>{if(j.version!==want)process.exit(1)})).catch(()=>process.exit(1))' "$1" >/dev/null 2>&1; then
      if docker compose ps --status running --services 2>/dev/null | grep -qx worker; then return 0; fi; HEALTH_FAIL=worker
    else HEALTH_FAIL=api; fi
    [ "$(date +%s)" -lt "$deadline" ] || return 1
    sleep 5
  done
}
expect() { if [ "$(schema_at "$1")" = 0 ]; then echo legacy; else package_field "$1" version; fi; }
release_hold() { docker compose exec -T api node scripts/deployment-preflight.js release >/dev/null 2>&1; }
[ "$PRINT_SCHEMA" = 1 ] && { echo "$(schema_of < src/migrations.js) $(floor_of < src/migrations.js)"; FINISHED=1; exit 0; }
# Put the previous release back after a failure; only when the metadata is provably untouched. Then lift the hold.
# COMPAT_AFTER is set only by the health check (A10) once the migrated schema was proven compatible with $FROM.
try_revert() {
  [ -z "$SNAPSHOT" ] || return 1
  if [ "$STOPPED" = 1 ]; then after=$(db_schema 2>/dev/null) || return 1; SCHEMA_TO=$after; [ "$after" = "$DB_SCHEMA" ] || { [ -n "$COMPAT_AFTER" ] && [ "$after" = "$COMPAT_AFTER" ]; } || return 1; fi
  if [ "$CHECKED_OUT" = 1 ]; then git_ checkout --quiet "$FROM_REF" || return 1; CHECKED_OUT=0; fi
  if [ "$STOPPED" = 1 ]; then start_previous && healthy "$(expect HEAD)" "$TIMEOUT" || return 1; STOPPED=0; fi
  [ "$HOLD" != 1 ] || { release_hold || echo 'WARNING: could not release the deployment hold; run: docker compose exec api node scripts/deployment-preflight.js release' >&2; HOLD=0; }
  return 0
}
build_and_start() { # image mode pulls the target image, source mode builds this checkout
  if [ "$IMAGE_MODE" = 1 ]; then DOCKNEST_IMAGE=$NEW_IMAGE docker compose pull api worker
  elif [ -n "$EXPECT_COMMIT" ]; then build_archive
  else docker compose build api worker; fi
}
# --expect-commit in source mode (F10): the build context is `git archive` of the verified commit, so files that git
# ignores (keys, databases, overrides) never reach COPY . . in the Dockerfile. api and worker share one image name.
build_archive() {
  archive=$(mktemp "${TMPDIR:-/tmp}/docknest-context.XXXXXX") || return 1
  git_ archive --format=tar -o "$archive" "$EXPECT_COMMIT" && docker build -t "$LOCAL_IMAGE" - < "$archive"; rc=$?
  rm -f "$archive"; return "$rc"
}
# Registry digests (name@sha256:...) of a local image, space-separated; empty for a locally built one.
repo_digests() {
  [ -n "$1" ] || return 0
  docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' -- "$1" 2>/dev/null | grep -Ex '[A-Za-z0-9._/:-]+@sha256:[0-9a-f]{64}' | tr '\n' ' ' | sed 's/ *$//'
}
# Full SemVer precedence (pre-release identifiers included, build metadata ignored): succeeds when $1 > $2.
semver_gt() {
  awk -v a="$1" -v b="$2" 'function cmp(a, b,   pa, pb, n, m, i, na, nb) {
      sub(/\+.*/, "", a); sub(/\+.*/, "", b); pa = index(a, "-"); pb = index(b, "-")
      split(pa ? substr(a, 1, pa - 1) : a, X, "."); split(pb ? substr(b, 1, pb - 1) : b, Y, ".")
      for (i = 1; i <= 3; i++) { if (X[i] + 0 > Y[i] + 0) return 1; if (X[i] + 0 < Y[i] + 0) return -1 }
      if (!pa && !pb) return 0; if (!pa) return 1; if (!pb) return -1
      n = split(substr(a, pa + 1), P, "."); m = split(substr(b, pb + 1), Q, ".")
      for (i = 1; i <= n && i <= m; i++) {
        na = P[i] ~ /^[0-9]+$/; nb = Q[i] ~ /^[0-9]+$/
        if (na && nb) { if (P[i] + 0 > Q[i] + 0) return 1; if (P[i] + 0 < Q[i] + 0) return -1 }
        else if (na) return -1; else if (nb) return 1
        else if ("" P[i] > "" Q[i]) return 1; else if ("" P[i] < "" Q[i]) return -1
      }
      return n > m ? 1 : (n < m ? -1 : 0) }
    BEGIN { exit !(cmp(a, b) > 0) }'
}
# Versions used in folder names and URLs: X.Y.Z with an optional pre-release suffix, nothing else.
SEMVER='[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?'
# Manual runs (AR2-N1): the target tag's commit must be on origin/main and, with cosign present, a 2.2.0-or-later
# target's signed docknest-release.json must verify with the release workflow's identity and name that commit.
# Residual for manual runs: cosign has no flag for the numeric repository and owner ids (F9); only the host updater's
# broker compares them, so a manual run trusts the repository name after a rename.
RELEASE_REPO=DahanItamar/DockNest PINNED_COSIGN=/usr/local/lib/docknest-updater/bin/cosign MANIFEST_IMAGE=''
with_timeout() { if command -v timeout >/dev/null 2>&1; then timeout "$@"; else shift; "$@"; fi; }
fetch_once() { with_timeout 60 curl -sS --proto '=https' --max-filesize 65536 --max-time 60 -o "$2" -w '%{http_code} %{redirect_url}' "$1"; }
# download URL FILE: curl over HTTPS, at most 64 KiB, and at most one redirect, only to GitHub's two asset hosts.
download() {
  command -v curl >/dev/null 2>&1 || return 1
  answer=$(fetch_once "$1" "$2") || return 1
  case "$answer" in
    '200 '*) ;;
    30[1278]' https://release-assets.githubusercontent.com/'*|30[1278]' https://objects.githubusercontent.com/'*)
      answer=$(fetch_once "${answer#* }" "$2") || return 1; case "$answer" in '200 '*) ;; *) return 1 ;; esac ;;
    *) return 1 ;;
  esac
  [ "$(wc -c < "$2")" -le 65536 ]
}
manifest_field() { sed -n "s/^  \"$2\": \"\([^\"]*\)\",\{0,1\}\$/\1/p" "$1" | head -n 1; }
manifest_image() { sed -n "/^  \"image\": {\$/,/^  }/ s/^    \"$2\": \"\([^\"]*\)\",\{0,1\}\$/\1/p" "$1" | head -n 1; }
verify_target() {
  git_ rev-parse -q --verify refs/remotes/origin/main >/dev/null || fail 2 "Cannot verify $TARGET: this checkout has no origin/main. Run git fetch origin, or pass --no-verify for a fork or mirror without main." verify-not-on-main
  git_ merge-base --is-ancestor "$TARGET_REF" refs/remotes/origin/main || fail 2 "$TARGET is not on origin/main, so it is not an official release. Nothing was changed. Pass --no-verify only if you trust this tag (a fork or a mirror)." verify-not-on-main
  echo "$TARGET is on origin/main."
  # Whether a signature is required follows the tag name (already checked to equal v$TO), never package.json alone.
  if semver_gt 2.2.0 "${TARGET#v}"; then return 0; fi # releases before 2.2.0 have no signed manifest
  cosign=$(command -v cosign 2>/dev/null || true); [ -n "$cosign" ] || { [ ! -x "$PINNED_COSIGN" ] || cosign=$PINNED_COSIGN; }
  if [ -z "$cosign" ]; then echo "WARNING: cosign is not installed: the signed release manifest of $TARGET was not checked." >&2; return 0; fi
  VERIFY_DIR=$(mktemp -d "${TMPDIR:-/tmp}/docknest-verify.XXXXXX") || fail 2 'Could not create a temporary folder to verify the release.'
  for file in docknest-release.json docknest-release.json.sigstore.json; do
    download "https://github.com/$RELEASE_REPO/releases/download/$TARGET/$file" "$VERIFY_DIR/$file" \
      || fail 2 "Could not download $file of $TARGET (curl is needed) to verify its signature. Nothing was changed. Offline, --no-verify skips this and the origin/main check." fetch-failed
  done
  ref="refs/tags/$TARGET" manifest="$VERIFY_DIR/docknest-release.json"
  with_timeout 300 "$cosign" verify-blob --certificate-identity "https://github.com/$RELEASE_REPO/.github/workflows/release.yml@$ref" \
    --certificate-oidc-issuer https://token.actions.githubusercontent.com --certificate-github-workflow-repository "$RELEASE_REPO" \
    --certificate-github-workflow-trigger push --certificate-github-workflow-ref "$ref" --certificate-github-workflow-sha "$TARGET_REF" \
    --bundle "$VERIFY_DIR/docknest-release.json.sigstore.json" "$manifest" >/dev/null \
    || fail 2 "The signed release manifest of $TARGET did not verify. Nothing was changed." verify-signature-invalid
  for pair in "commit $TARGET_REF" "tag $TARGET" "version $TO" "repository $RELEASE_REPO"; do
    [ "$(manifest_field "$manifest" "${pair%% *}")" = "${pair#* }" ] \
      || fail 2 "The signed release manifest of $TARGET does not match its ${pair%% *}. Nothing was changed." verify-manifest-mismatch
  done
  grep -qx '  "prerelease": false,\{0,1\}' "$manifest" || fail 2 "The signed release manifest of $TARGET is not a final release. Nothing was changed." verify-manifest-mismatch
  # Image mode pulls the signed digest and pins it in .env (F4), exactly as the updater does with --expect-image-digest.
  if [ "$IMAGE_MODE" = 1 ]; then
    MANIFEST_IMAGE=$(manifest_image "$manifest" name) digest=$(manifest_image "$manifest" digest)
    [ -n "$MANIFEST_IMAGE" ] && matches "$digest" 'sha256:[0-9a-f]{64}' || fail 2 "The signed release manifest of $TARGET names no image digest. Nothing was changed." verify-manifest-mismatch
    [ -z "$EXPECT_DIGEST" ] || [ "$EXPECT_DIGEST" = "$digest" ] || fail 2 "--expect-image-digest differs from the signed digest of $TARGET. Nothing was changed." verify-manifest-mismatch
    EXPECT_DIGEST=$digest
  fi
  echo "Verified the signed release manifest of $TARGET."
}
start_target() {
  if [ "$IMAGE_MODE" = 1 ]; then DOCKNEST_IMAGE=$NEW_IMAGE docker compose up -d api worker
  elif [ -n "$EXPECT_COMMIT" ]; then docker compose up -d --no-build api worker # the image built from the verified archive
  else docker compose up -d api worker; fi
}
# Back to the exact previous release: the image ID recorded before anything was switched (never the tag from .env or
# docknest:local, which may have moved), already present locally, so this works offline and never pulls. Source mode
# points the local tag back at that ID and starts without building; it rebuilds only when the ID is unknown.
start_previous() {
  if [ "$IMAGE_MODE" = 1 ]; then DOCKNEST_IMAGE=${PREV_ID:-$PREV_IMAGE} docker compose up -d --pull never api worker
  elif [ -n "$PREV_ID" ] && [ -n "$LOCAL_IMAGE" ] && docker tag "$PREV_ID" "$LOCAL_IMAGE"; then docker compose up -d --no-build api worker
  else docker compose build api worker && docker compose up -d api worker; fi
}
# The hint names the previous image by the tag that pins it (PREV_REF), not by its ID alone: an image left without
# any name is dangling and may be gone by the time someone runs the hint.
restart_previous_cmd() {
  if [ "$IMAGE_MODE" = 1 ]; then echo "git checkout $FROM_REF && DOCKNEST_IMAGE=${PREV_REF:-${PREV_ID:-$PREV_IMAGE}} docker compose up -d --pull never   # and keep DOCKNEST_IMAGE=$PREV_IMAGE in .env"
  elif [ -n "$PREV_ID" ] && [ -n "$LOCAL_IMAGE" ]; then echo "git checkout $FROM_REF && docker tag ${PREV_REF:-$PREV_ID} $LOCAL_IMAGE && docker compose up -d --no-build"
  else echo "git checkout $FROM_REF && docker compose up -d --build"; fi
}
# Full image IDs only (sha256 plus 64 hex digits): anything else could be read by Docker as a repository name.
valid_id() { case "$1" in sha256:*) ;; *) return 1 ;; esac; case "${1#sha256:}" in *[!0-9a-f]*) return 1 ;; esac; [ "${#1}" -eq 71 ]; }
image_id() { [ -n "$1" ] || return 0; _id=$(docker image inspect --format '{{.Id}}' -- "$1" 2>/dev/null | head -n 1) || return 0; if valid_id "$_id"; then echo "$_id"; fi; }
running_id() { image_id "$(docker compose images --quiet "$1" 2>/dev/null | head -n 1)"; }
# Source mode: the one image name api and worker use (docknest:local unless an override renames it), else empty.
local_image() { _name=$(docker compose config --images api worker 2>/dev/null | sort -u); case "$_name" in ''|-*|*[!A-Za-z0-9._/:-]*) ;; *) echo "$_name" ;; esac; }
# After exit 4: remove the image this run built or pulled, best effort and never with --force (Docker refuses one a
# container still uses). Never the previous image or one a service runs.
drop_new_image() {
  [ -n "$NEW_ID" ] && [ "$NEW_ID" != "$PREV_ID" ] || return 0
  for service in api worker; do [ "$(running_id "$service")" != "$NEW_ID" ] || return 0; done
  ! grep -Fqx "imageId=$NEW_ID" "$ROOT"/data/upgrade-backups/*/previous-release 2>/dev/null || return 0
  if docker image rm "$NEW_ID" >/dev/null 2>&1; then echo "Removed the $TO image $NEW_ID."
  else echo "WARNING: could not remove the $TO image $NEW_ID; when it is unused, run: docker image rm $NEW_ID" >&2; fi
  return 0
}
# The repository part of name[:tag] (a registry port as in host:5000/name stays part of the name).
repo_of() { case "${1##*/}" in *:*) echo "${1%:*}" ;; *) echo "$1" ;; esac; }
# The previous release's image keeps a name of its own in this install's repository, in both modes and on both image
# stores. `docker compose build` moves docknest:local (a pull can move a floating tag such as :latest) and would leave
# the previous image without any name: dangling, and Docker, the containerd image store in particular, may drop it, so
# a rollback by ID alone found "No such image". So it is pinned as REPO:pre-upgrade before the build or pull, and after
# a success that pin becomes REPO:previous. A failed run leaves REPO:previous on the release before, so it keeps both.
pin_previous() {
  [ -n "$PREV_ID" ] && [ -n "$REPO" ] || return 0
  if docker tag "$PREV_ID" "$REPO:pre-upgrade"; then PREV_REF="$REPO:pre-upgrade"
  else echo "WARNING: could not tag the $FROM image $PREV_ID as $REPO:pre-upgrade; a rollback uses its ID." >&2; fi
}
promote_previous() {
  [ -n "$PREV_REF" ] || return 0
  OLD_PREV=$(image_id "$REPO:previous") # loses its name when the tag moves; retention removes it
  if docker tag "$PREV_ID" "$REPO:previous"; then
    PREV_REF="$REPO:previous"; docker image rm "$REPO:pre-upgrade" >/dev/null 2>&1 || true # removes the tag only
  else echo "WARNING: could not tag the $FROM image as $REPO:previous; it stays tagged $PREV_REF." >&2; fi
}
# Image mode: DOCKNEST_IMAGE (environment or .env) names the image; the script switches only the tag, per command.
image_setup() {
  PREV_IMAGE=${DOCKNEST_IMAGE:-$(sed -n 's/^DOCKNEST_IMAGE=//p' .env 2>/dev/null | tail -n 1 | tr -d "\"'")}
  [ -n "$PREV_IMAGE" ] || fail 2 'Image mode needs DOCKNEST_IMAGE=<registry/name>:<tag> in .env (see compose.override.example.yaml).'
  # name:tag@sha256:... (written by --expect-image-digest, F4) is accepted: the digest is cut off before the tag.
  base=${PREV_IMAGE%%@*} PREV_TAG=''
  case "$PREV_IMAGE" in *@*) case "${base##*/}" in *:*) ;; *) fail 2 'DOCKNEST_IMAGE is pinned by digest only; edit it in .env yourself, or use name:tag (optionally name:tag@sha256:...) so the script can switch versions.' ;; esac ;; esac
  case "${base##*/}" in *:*) IMAGE_NAME=${base%:*} PREV_TAG=${base##*:} ;; *) IMAGE_NAME=$base ;; esac
  NEW_IMAGE="$IMAGE_NAME:$TO"; [ -z "$EXPECT_DIGEST" ] || NEW_IMAGE="$NEW_IMAGE@$EXPECT_DIGEST"
}
# --upgrade-only in image mode (F2): the running api image must be the release that HEAD names, by its OCI version
# label or, without a label, by the digest recorded in DOCKNEST_IMAGE; a version tag in DOCKNEST_IMAGE must agree too.
image_state_ok() {
  [ -n "$PREV_ID" ] || return 1
  label=$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.version"}}' -- "$PREV_ID" 2>/dev/null | head -n 1 || true)
  matches "$label" "$SEMVER" || label=''
  if ! matches "$PREV_TAG" "$SEMVER"; then :; elif [ "$PREV_TAG" != "$FROM" ]; then return 1; fi
  if [ -n "$label" ]; then [ "$label" = "$FROM" ]; return; fi
  case "$PREV_IMAGE" in *@sha256:*) case " $PREV_DIGESTS " in *" $IMAGE_NAME@${PREV_IMAGE##*@} "*) [ "$PREV_TAG" = "$FROM" ]; return ;; esac ;; esac
  return 1
}
# Persist the new tag only after the new release is healthy; the previous .env was saved in the upgrade backup.
image_persist() {
  [ -f .env ] || : > .env
  tmp=$(mktemp ".env.XXXXXX") && { grep -v '^DOCKNEST_IMAGE=' .env > "$tmp" || true; printf 'DOCKNEST_IMAGE=%s\n' "$NEW_IMAGE" >> "$tmp"; chmod --reference=.env "$tmp" 2>/dev/null || chmod 600 "$tmp"; mv -f "$tmp" .env; }
}
# A10: after a failed health check the previous release may still run on the migrated database when its own schema is
# at or above the migrated database's compatibility floor (the rule of the compatible-rollback check below). Migrations
# run in one transaction, so the database is either unchanged or at the target's schema.
compatible_after() {
  case "$1" in ''|*[!0-9]*) return 1 ;; esac
  [ "$1" -gt "$DB_SCHEMA" ] && [ "$1" = "$TARGET_SCHEMA" ] || return 1
  target_file=$(git_ show "$TARGET_REF:src/migrations.js" 2>/dev/null) || return 1
  floor=$(printf '%s\n' "$target_file" | floor_of); previous=$(schema_at "$FROM_REF"); [ "$previous" -lt 1 ] && previous=1
  [ "$previous" -ge "$floor" ]
}

# ---- Disk retention (docs/update-center.md section 9): after a recorded success only; it never changes the outcome. ----
warn() { echo "WARNING: $1" >&2; [ -z "$WARN_FILE" ] || printf '%s\n' "$1" >> "$WARN_FILE"; }
# Prints "KEY NAME STATE" for each upgrade backup, newest first. Only exact-pattern names of real directories (links are
# skipped, never followed). KEY is the UTC time in the name, or the modification time (capped at now) for a name dated
# in the future. STATE is "keep" for a run that ended 5 or 6, a run with no recorded exit code (interrupted) or an
# unreadable marker, "free" otherwise; folders written before 2.2.0 have no marker and are "free".
backup_list() {
  set +f # retention runs with globbing off; this listing is the one glob (always in a pipeline subshell)
  now=$(date -u +%Y%m%d%H%M%S)
  for path in "$1"/*; do
    name=${path##*/}
    case "$name" in *[!0-9A-Za-z.-]*) continue ;; esac
    printf '%s\n' "$name" | grep -Eqx '[0-9]{8}T[0-9]{6}Z-[0-9A-Za-z.-]+-to-[0-9A-Za-z.-]+' || continue
    if [ -L "$path" ] || [ ! -d "$path" ]; then continue; fi
    key=$(printf '%s' "$name" | cut -c1-8,10-15) state=free
    if [ "$key" -gt "$now" ]; then key=$(date -u -r "$path" +%Y%m%d%H%M%S 2>/dev/null) || key=''; fi
    case "$key" in ''|*[!0-9]*) key=0 state=keep ;; *) [ "$key" -le "$now" ] || key=$now ;; esac
    marker="$path/result"
    if [ -L "$marker" ]; then state=keep
    elif [ -f "$marker" ]; then case "$(sed -n 's/^exit=\([0-9][0-9]*\)$/\1/p' "$marker" 2>/dev/null | tail -n 1)" in ''|5|6) state=keep ;; esac
    elif [ -e "$marker" ]; then state=keep; fi
    echo "$key $name $state"
  done | sort -r
}
# Keeps the newest KEEP upgrade backups, this run's own ($SAVE, by identity, never by its place in the order) and every
# "keep" one; removes the rest with rm -rf -- on the absolute path built from the checked parent.
prune_backups() {
  parent="$ROOT/data/upgrade-backups"
  case "$parent" in /*) ;; *) return 0 ;; esac
  if [ -L "$parent" ]; then warn 'data/upgrade-backups is a symbolic link; old upgrade backups were not removed.'; return 0; fi
  [ -d "$parent" ] || return 0
  backup_list "$parent" | { n=0; while read -r key name state; do
    n=$((n + 1)); path="$parent/$name"
    [ "$n" -gt "$1" ] || continue
    if [ -n "$SAVE" ] && { [ "$name" = "${SAVE##*/}" ] || [ "$path" -ef "$ROOT/$SAVE" ] 2>/dev/null; }; then continue; fi
    if [ "$state" != free ]; then echo "Keeping data/upgrade-backups/$name: its run needs manual action or did not finish."; continue; fi
    if [ "$DRY_RUN" = 1 ]; then echo "Would remove data/upgrade-backups/$name"; continue; fi
    if [ -L "$path" ] || [ ! -d "$path" ]; then continue; fi
    if rm -rf -- "$path"; then echo "Removed data/upgrade-backups/$name"; else warn "Could not remove data/upgrade-backups/$name."; fi
  done; }
}
# own_image ID [UNTAGGED_OK]: every tag and digest of the image is in this install's repository (REPO: image mode the
# name in DOCKNEST_IMAGE, source mode the local image name's, docknest). Containerd-store IDs are manifest digests and a
# local build lists REPO@<its ID> as a digest; that is the same repository. An image without any name counts only in
# source mode or with UNTAGGED_OK (its DockNest label was checked). Exit 2 when the image no longer exists.
own_image() {
  refs=$(docker image inspect --format '{{range .RepoTags}}{{println .}}{{end}}{{range .RepoDigests}}{{println .}}{{end}}' -- "$1" 2>/dev/null) || return 2
  [ -n "$refs" ] || [ "$IMAGE_MODE" != 1 ] || [ -n "${2:-}" ] || return 1
  for ref in $refs; do
    case "$ref" in *@*) repo=${ref%%@*} ;; *) repo=$(repo_of "$ref") ;; esac
    [ "$repo" = "$REPO" ] || return 1
  done
}
# Tags of an image (RepoTags), one per line; <none> entries are skipped.
image_tags() { docker image inspect --format '{{range .RepoTags}}{{println .}}{{end}}' -- "$1" 2>/dev/null | grep -Ex '[A-Za-z0-9._/:-]+' || true; }
# Image IDs any container (running or stopped, of any project) was created from; fails when they cannot be listed.
container_images() {
  ids=$(docker ps -aq --no-trunc) || return 1
  [ -z "$ids" ] || docker inspect --format '{{.Image}}' $ids || return 1
}
# Removes an image by its tags (the last one deletes it) or, untagged, by ID. Never --force: Docker refuses an image a
# container uses. Prints the ID and records one line per removed image for the summary.
remove_image() {
  tags=$(image_tags "$1")
  if [ -n "$tags" ]; then for tag in $tags; do docker image rm "$tag" >/dev/null 2>&1 || { warn "Could not remove image $1 (still used by a container)."; return 0; }; done
  elif ! docker image rm "$1" >/dev/null 2>&1; then warn "Could not remove image $1 (still used by a container or tagged more than once)."; return 0; fi
  echo "Removed image $1"; [ -z "$CLEAN_FILE" ] || echo image >> "$CLEAN_FILE"
}
# Keeps exactly the image api and worker run and the previous release's image (REPO:previous after a success) and
# removes every other image of this install's repository that no container uses: every tag in REPO (also legacy names
# such as docknest:sqlite-online), the untagged images this install recorded (imageId in previous-release files) and
# untagged images carrying the DockNest label (old releases and build stages, DOCKNEST_LABEL in the Dockerfile).
# Images recorded by runs kept for manual action stay. An image also named in another repository is never touched.
# Skipped entirely when the running, the previous ID or the containers' images are unknown. Never any prune command.
DOCKNEST_LABEL=io.github.dahanitamar.docknest
prune_images() {
  parent="$ROOT/data/upgrade-backups"
  if [ -L "$parent" ] || [ ! -d "$parent" ]; then return 0; fi
  api=$(running_id api) worker=$(running_id worker)
  if [ -z "$api" ] || [ -z "$worker" ] || [ -z "$PREV_ID" ]; then echo 'Image cleanup skipped: the running or the previous DockNest image ID is unknown.'; return 0; fi
  if [ -z "$REPO" ]; then echo 'Image cleanup skipped: the image name is unknown.'; return 0; fi
  if ! used=$(container_images); then echo 'Image cleanup skipped: the images that containers use could not be listed.'; return 0; fi
  keep=" $api $worker $PREV_ID $(printf '%s\n' "$used" | tr '\n' ' ')" recorded='' untracked=0
  for entry in $(backup_list "$parent" | sed 's/^[0-9]* //; s/ /:/'); do
    name=${entry%:*}; file="$parent/$name/previous-release"
    if [ -L "$file" ] || [ ! -f "$file" ]; then continue; fi
    id=$(sed -n 's/^imageId=//p' "$file" 2>/dev/null | tail -n 1)
    if ! valid_id "$id"; then
      # A run kept for manual action without a recorded image: its rollback image is unknown, so remove no image at all.
      if [ "${entry##*:}" != free ]; then echo "Image cleanup skipped: data/upgrade-backups/$name needs manual action and recorded no image ID."; return 0; fi
      untracked=$((untracked + 1)); continue
    fi
    if [ "${entry##*:}" = free ]; then recorded="$recorded $id"; else keep="$keep$id "; fi
  done
  # Every tag in the repository, and untagged images that carry the DockNest label (this install's builds and pulls).
  tagged=$(docker image ls --no-trunc --format '{{.ID}}' -- "$REPO" 2>/dev/null) || tagged=''
  labelled=$(docker image ls --no-trunc --quiet --filter dangling=true --filter "label=$DOCKNEST_LABEL" 2>/dev/null) || labelled=''
  # OLD_PREV: the image this run's promotion took REPO:previous from (two releases back now, possibly left untagged).
  for id in $(printf '%s\n' $recorded $tagged $labelled $OLD_PREV | sort -u); do
    valid_id "$id" || continue
    case "$keep" in *" $id "*) continue ;; esac
    untagged=''; case " $(printf '%s\n' "$labelled" | tr '\n' ' ') $OLD_PREV " in *" $id "*) untagged=1 ;; esac
    own_image "$id" "$untagged"; owned=$?
    [ "$owned" != 2 ] || continue
    if [ "$owned" != 0 ]; then echo "Keeping image $id: it is also tagged outside this installation's repository."; continue; fi
    if [ "$DRY_RUN" = 1 ]; then echo "Would remove image $id"; continue; fi
    remove_image "$id"
  done
  [ "$untracked" = 0 ] || echo "$untracked older upgrade backup(s) recorded no image ID; remove unused DockNest images by hand with docker image ls and docker image rm <id>."
}
# Rollback folders in the state volume: pruned by the running release's own script, when it has one.
prune_snapshots() {
  if ! docker compose exec -T api test -f scripts/prune-upgrade-artifacts.js >/dev/null 2>&1; then echo 'Rollback folders in the state volume: the running release has no pruning script; none removed.'; return 0; fi
  if [ "$DRY_RUN" = 1 ]; then set -- --dry-run; else set --; fi
  docker compose exec -T api node scripts/prune-upgrade-artifacts.js "$@" || warn 'Some rollback folders in the state volume (upgrade-snapshots/pre-downgrade-* or pre-rollback-*) could not be removed.'
}
# Images first: they are found through the imageId records of folders that the folder step may remove.
retention() {
  if [ "$NO_PRUNE" = 1 ]; then echo 'Retention skipped (--no-prune): old upgrade files were kept.'; return 0; fi
  prune_images; prune_snapshots; prune_backups "$1"
}
# The Docker build cache cannot be scoped to one project (docker builder prune has no project or label filter that
# covers the cache a Compose build leaves), so the script never trims it: it only names the optional command.
BUILD_CACHE_HINT='docker builder prune --filter until=168h'
# Runs retention in a guarded background subshell with its own time limit; nothing in it can change the outcome.
run_cleanup() {
  WARN_FILE=$(mktemp "${TMPDIR:-/tmp}/docknest-warnings.XXXXXX" 2>/dev/null) || WARN_FILE=''
  CLEAN_FILE=$(mktemp "${TMPDIR:-/tmp}/docknest-cleanup.XXXXXX" 2>/dev/null) || CLEAN_FILE=''
  ( trap - EXIT INT TERM; set +e -f; retention 5 ) &
  CLEANUP_PID=$!
  ( trap 'kill "$sleeper" 2>/dev/null; exit 0' TERM; sleep "$CLEANUP_TIMEOUT" & sleeper=$!; wait "$sleeper" && kill "$CLEANUP_PID" 2>/dev/null ) </dev/null >/dev/null 2>&1 &
  WATCHDOG_PID=$!
  rc=0; wait "$CLEANUP_PID" || rc=$?
  kill "$WATCHDOG_PID" 2>/dev/null || true
  CLEANUP_PID='' WATCHDOG_PID=''
  if [ "$rc" -gt 128 ]; then warn "Removing old upgrade files was stopped after ${CLEANUP_TIMEOUT}s; some may remain until the next successful upgrade."
  elif [ "$rc" != 0 ]; then warn 'Removing old upgrade files ended early; some may remain until the next successful upgrade.'; fi
  if [ -n "$WARN_FILE" ]; then WARNING=$(tr '\n' ' ' < "$WARN_FILE" | sed 's/ *$//'); fi
  # One summary line built from counts only, for the console and the status file (cleanup).
  if [ "$NO_PRUNE" != 1 ] && [ -n "$CLEAN_FILE" ]; then
    count=$(grep -cx image "$CLEAN_FILE" 2>/dev/null) || count=0
    CLEANED="Cleaned up: $count old DockNest image$([ "$count" = 1 ] || echo s)"
    echo "$CLEANED"
    [ "$IMAGE_MODE" = 1 ] || echo "Optional: '$BUILD_CACHE_HINT' frees Docker build cache older than 7 days. It is host-wide (every project's cache, never images, containers or volumes), so DockNest does not run it."
  fi
  return 0
}

[ "$DRY_RUN" = 1 ] || take_lock
phase preflight 'Checking the installation'
command -v git >/dev/null 2>&1 || fail 2 'git is required.'
docker compose version >/dev/null 2>&1 || fail 2 'Docker Compose v2 (docker compose) is required.'
git_ rev-parse --git-dir >/dev/null 2>&1 || fail 2 "$ROOT is not a git checkout. Install DockNest with git clone to use this script."
if [ -n "$(git_ status --porcelain --untracked-files=no)" ]; then
  git_ status --short --untracked-files=no >&2
  fail 2 'Tracked files were edited. Move local settings to .env and Compose changes to compose.override.yaml (both are ignored by git), then run git restore on these files.'
fi
for secret in data/master.key data/setup.token; do [ -s "$secret" ] || fail 2 "$secret is missing or empty. Restore it from your separate key backup before upgrading."; done
docker compose config --quiet || fail 2 'docker compose config failed. Fix .env or compose.override.yaml first.'
IMAGE_MODE=1; docker compose config 2>/dev/null | grep -q '^ *context:' && IMAGE_MODE=0
FROM_REF=$(git_ rev-parse HEAD)
FROM=$(package_field HEAD version)
matches "$FROM" "$SEMVER" || fail 2 "package.json at HEAD has no valid version (${FROM:-none}). Check the checkout."
[ -z "$EXPECT_DIGEST" ] || [ "$IMAGE_MODE" = 1 ] || fail 2 '--expect-image-digest is for installs that run the published image.'
# --upgrade-only (F2): the installed version comes from package.json at HEAD and the exact release tag at HEAD.
if [ "$UPGRADE_ONLY" = 1 ] && ! { matches "$FROM" "$SEMVER" && git_ tag --points-at HEAD | grep -Fqx "v$FROM"; }; then
  fail 2 "The installed version is unclear: package.json says ${FROM:-nothing} but HEAD is not tagged v$FROM. Check the host; nothing was changed." state-mismatch
fi

if [ "$DRY_RUN" = 1 ]; then echo 'Dry run: using the release tags already in this checkout (no fetch).'
elif [ "$NO_FETCH" = 1 ]; then echo 'Not fetching (--no-fetch): using the tags already in this checkout.'
else
  phase fetch 'Fetching release tags'
  # Offline is fine when the tag is already local (rollbacks must work without GitHub).
  git_ fetch --tags --quiet origin || { FETCH_FAILED=1; echo 'WARNING: git fetch failed; continuing with the tags already in this checkout.' >&2; }
fi
if [ -z "$TARGET" ]; then TARGET=$(git_ tag -l 'v*' --sort=-v:refname | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | head -n 1); fi
case "$TARGET" in v*) ;; *) TARGET="v$TARGET" ;; esac
git_ rev-parse -q --verify "refs/tags/$TARGET" >/dev/null || fail 2 "Release tag $TARGET does not exist locally$([ "$DRY_RUN" = 1 ] || echo ' or on origin')." "$([ "$FETCH_FAILED" = 0 ] || echo fetch-failed)"
# Checked after the fetch, so a fetch cannot add what the check refused.
if [ -n "$EXPECT_COMMIT" ]; then
  # A replace ref, a graft or a shallow history could make the verified SHA name other content (F3).
  [ -z "$(git_ for-each-ref refs/replace/)" ] || fail 2 'refs/replace/ exists in this checkout; remove it (git replace -d) before an updater run.' checkout-failed
  [ ! -e "$(git_ rev-parse --git-path info/grafts)" ] || fail 2 'This checkout has .git/info/grafts; remove it before an updater run.' checkout-failed
  [ ! -e "$(git_ rev-parse --git-path shallow)" ] && [ "$(git_ rev-parse --is-shallow-repository)" != true ] || fail 2 'This checkout is a shallow clone; run git fetch --unshallow first.' checkout-failed
fi
# The tag, never a branch of the same name; its name must be exactly v plus the version it contains, so the name that
# decides whether a signature is required cannot differ from the release that is built.
TARGET_REF=$(git_ rev-parse "refs/tags/$TARGET^{commit}")
TO=$(package_field "$TARGET_REF" version)
{ matches "$TO" "$SEMVER" && [ "$TARGET" = "v$TO" ]; } || fail 2 "Tag $TARGET contains version ${TO:-none}; a release tag must be v<its package.json version>. Nothing was changed." verify-manifest-mismatch
echo "Current: $FROM ($(git_ describe --tags --always HEAD))   Target: $TO ($TARGET)   Mode: $([ "$IMAGE_MODE" = 1 ] && echo published image || echo build from source)"
if [ -n "$EXPECT_COMMIT" ] && [ "$TARGET_REF" != "$EXPECT_COMMIT" ]; then fail 2 "$TARGET points to $TARGET_REF, not the verified commit $EXPECT_COMMIT. Nothing was changed." verify-manifest-mismatch; fi
if [ "$UPGRADE_ONLY" = 1 ] && ! { matches "$TO" "$SEMVER" && semver_gt "$TO" "$FROM"; }; then fail 2 "--upgrade-only: $TO is not newer than the installed $FROM. Nothing was changed."; fi
if [ "$TARGET_REF" = "$FROM_REF" ] && healthy "$(expect HEAD)" 0; then FINISHED=1 PHASE=done HINT=''; echo "Already running $TO."; status true; exit 0; fi
# The updater verified the commit itself (--expect-commit) and never passes --no-verify.
if [ "$NO_VERIFY" = 1 ]; then echo "WARNING: --no-verify: $TARGET was not checked against origin/main or a release signature." >&2
elif [ -z "$EXPECT_COMMIT" ]; then verify_target; fi
[ "$IMAGE_MODE" != 1 ] || image_setup
[ -z "$MANIFEST_IMAGE" ] || [ "$IMAGE_NAME" = "$MANIFEST_IMAGE" ] || fail 2 "DOCKNEST_IMAGE names $IMAGE_NAME but the signed release is $MANIFEST_IMAGE. Nothing was changed. For a mirror, pass --no-verify." verify-manifest-mismatch
[ "$IMAGE_MODE" != 1 ] || [ -n "$EXPECT_DIGEST" ] || echo "WARNING: image mode without a verified digest: $NEW_IMAGE is pulled by its tag, unverified." >&2
[ "$IMAGE_MODE" = 1 ] || LOCAL_IMAGE=$(local_image)
[ -z "$EXPECT_COMMIT" ] || [ "$IMAGE_MODE" = 1 ] || [ -n "$LOCAL_IMAGE" ] || fail 2 'api and worker must use one image name (check compose.override.yaml) to build the verified commit.'
if [ "$IMAGE_MODE" = 1 ]; then REPO=$IMAGE_NAME; elif [ -n "$LOCAL_IMAGE" ]; then REPO=$(repo_of "$LOCAL_IMAGE"); fi
# The exact image the previous release runs, in both modes: rollback starts it again without pulling or building.
PREV_ID=$(running_id api)
PREV_DIGESTS=$(repo_digests "$PREV_ID")
if [ "$UPGRADE_ONLY" = 1 ] && [ "$IMAGE_MODE" = 1 ] && ! image_state_ok; then
  fail 2 "The running api image does not match the installed version $FROM (image label, digest or the tag in DOCKNEST_IMAGE). Check the host; nothing was changed." state-mismatch
fi
MIN=$(package_field "$TARGET_REF" minUpgradeFrom)
if [ -n "$MIN" ] && ! version_ge "$FROM" "$MIN"; then fail 2 "$TO supports upgrades from $MIN or later. Upgrade to an intermediate release first."; fi

DB_SCHEMA=$(db_schema); case "$DB_SCHEMA" in ''|*[!0-9]*) DB_SCHEMA=''; fail 2 'Could not read the metadata schema version from the state volume.' ;; esac
SCHEMA_TO=$DB_SCHEMA
TARGET_SCHEMA=$(schema_at "$TARGET_REF")
# v2.0.0 predates user_version; its schema is identical to migration 1.
COMPATIBLE=$TARGET_SCHEMA; [ "$COMPATIBLE" -lt 1 ] && COMPATIBLE=1
if [ "$DB_SCHEMA" -gt "$COMPATIBLE" ]; then
  FLOOR=0; [ -f src/migrations.js ] && FLOOR=$(floor_of < src/migrations.js)
  if [ "$COMPATIBLE" -ge "$FLOOR" ]; then
    echo "Metadata schema v$DB_SCHEMA only adds compatible objects over v$COMPATIBLE: $TO runs on it as is and no data is discarded."
  else
    # Older code cannot read this schema: only a pre-upgrade snapshot taken when this database moved from that schema
    # (or older) to its current one is acceptable; the target release migrates an older snapshot forward on start.
    SNAPSHOT=$(in_data 'ls /data/upgrade-snapshots 2>/dev/null || true' | awk -v t="$TARGET_SCHEMA" -v d="$DB_SCHEMA" -F'[-v]' '/^state-v[0-9]+-to-v[0-9]+-[0-9]+T[0-9]+Z\.sqlite$/ && $3+0<=t+0 && $6+0==d+0 {print $NF" "$0}' | sort | tail -n 1 | cut -d' ' -f2 || true)
    [ -n "$SNAPSHOT" ] || fail 2 "$TO uses metadata schema v$TARGET_SCHEMA but this database is v$DB_SCHEMA and no matching snapshot state-v$TARGET_SCHEMA-to-v$DB_SCHEMA-*.sqlite exists. Downgrade refused."
    echo "Downgrade needs the metadata snapshot $SNAPSHOT. Every job, backup record and setting changed since that upgrade will be lost (backup files stay on storage)."
    [ "$INTERACTIVE" = 1 ] || [ "$DATA_ROLLBACK" = 1 ] || fail 2 'Restoring an older metadata snapshot requires --allow-data-rollback in non-interactive mode.'
  fi
fi
if [ "$DRY_RUN" = 1 ]; then
  FINISHED=1; echo "Dry run: would upgrade $FROM to $TO. Nothing was fetched, held, written or changed."
  # The plan for after a successful upgrade: this run adds one backup and the running image becomes the previous one.
  echo 'Dry run: after a successful upgrade, retention would do the following (nothing is removed now):'
  ( trap - EXIT INT TERM; set +e -f; retention 4 ) || true
  exit 0
fi
confirm "Upgrade DockNest from $FROM to $TO?"
[ -n "$SNAPSHOT" ] && confirm "Restore $SNAPSHOT and discard newer metadata?"

phase idle 'Holding new work and waiting for running jobs'
deadline=$(( $(date +%s) + WAIT ))
HOLD=1
until docker compose exec -T api node scripts/deployment-preflight.js hold >/dev/null 2>&1; do
  if [ "$(date +%s)" -ge "$deadline" ]; then
    if [ "$FORCE" = 1 ]; then echo 'WARNING: --force: continuing with queued or running work; interrupted jobs will need recovery review.' >&2; break; fi
    release_hold; HOLD=0; REASON=jobs-did-not-finish
    fail 3 'Jobs or a DockNest self-backup are queued, running or need recovery review. Let them finish or resolve them in the dashboard, then retry (or use --force).'
  fi
  echo 'Work in progress; waiting...'; sleep 15
done
if docker compose exec -T worker test -f src/worker-status.js >/dev/null 2>&1; then
  docker compose exec -T worker node src/worker-status.js || { [ "$FORCE" = 1 ] || { release_hold; HOLD=0; fail 3 'The worker reports active work. Retry when it is idle (or use --force).' jobs-did-not-finish; }; }
fi
HINT="docker compose exec api node scripts/deployment-preflight.js release   # lifts the hold set by this script"

phase backup 'Saving configuration and secrets for rollback'
mkdir -p data/upgrade-backups && chmod 700 data/upgrade-backups || fail 2 'Could not create data/upgrade-backups; check permissions and free disk space. Nothing was changed.' low-disk
# A folder of its own, never an existing one (two runs in one second get -2, -3, ...; the names still match retention's
# pattern), with the result marker written first so even an interrupted run's backup is recognised and kept.
base="data/upgrade-backups/$(date -u +%Y%m%dT%H%M%SZ)-$FROM-to-$TO" try=1
while [ -z "$SAVE" ]; do
  candidate=$base; [ "$try" = 1 ] || candidate="$base-$try"
  if mkdir -m 700 "$candidate" 2>/dev/null; then SAVE=$candidate; break; fi
  { [ -e "$candidate" ] || [ -L "$candidate" ]; } && [ "$try" -lt 50 ] || fail 2 "Could not create $candidate; check permissions and free disk space. Nothing was changed." low-disk
  try=$((try + 1))
done
printf 'format=%s\n' "$MARKER_FORMAT" > "$SAVE/result" || fail 2 "Could not write $SAVE/result. Nothing was changed." low-disk
for file in .env compose.override.yaml data/master.key data/setup.token; do
  # Mode and timestamps only: keeping the owner needs CAP_CHOWN, which the host updater's run step does not hold when the
  # checkout belongs to root (the copies stay 0600 inside the 0700 folder).
  if [ -e "$file" ]; then cp --preserve=mode,timestamps "$file" "$SAVE/$(basename "$file")" || fail 2 "Could not copy $file to $SAVE; check free disk space and permissions. Nothing was changed." low-disk; fi
done
printf 'commit=%s\nversion=%s\nschema=%s\nimage=%s\nimageId=%s\nrepoDigests=%s\n' "$FROM_REF" "$FROM" "$DB_SCHEMA" "${PREV_IMAGE:-}" "${PREV_ID:-}" "$PREV_DIGESTS" > "$SAVE/previous-release" || fail 2 "Could not write $SAVE/previous-release. Nothing was changed." low-disk
echo "Saved to $SAVE (later successful upgrades keep the newest 5 backups and every backup of a run that needs manual action)."

phase checkout "Checking out $TARGET"
# The verified commit is checked out detached, so a local branch named like the tag cannot win (F3).
WANT=${EXPECT_COMMIT:-$TARGET_REF}
git_ -c advice.detachedHead=false checkout --quiet --detach "$WANT" || { release_hold; HOLD=0; fail 2 "git checkout $TARGET failed; nothing else changed." checkout-failed; }
CHECKED_OUT=1
if [ "$(git_ rev-parse HEAD)" != "$WANT" ]; then
  git_ checkout --quiet "$FROM_REF" || fail 5 "HEAD is not $WANT after the checkout, and returning to $FROM_REF failed." checkout-failed
  CHECKED_OUT=0; release_hold; HOLD=0; fail 2 "HEAD was not $WANT after the checkout; the previous checkout was restored." checkout-failed
fi
HINT="$(restart_previous_cmd) && docker compose exec api node scripts/deployment-preflight.js release"

phase build "Preparing the $TO image"
# Every image present before the build or pull: exit 4 removes only an image that was not among them.
if IMAGES_BEFORE=$(docker image ls -aq --no-trunc 2>/dev/null); then IMAGES_LISTED=1; fi
pin_previous
HINT="$(restart_previous_cmd) && docker compose exec api node scripts/deployment-preflight.js release"
if ! build_and_start; then
  git_ checkout --quiet "$FROM_REF" && CHECKED_OUT=0; release_hold; HOLD=0
  # A partial source build may have moved the local tag: point it back at the image the services still run.
  if [ "$IMAGE_MODE" != 1 ] && [ -n "$PREV_ID" ] && [ -n "$LOCAL_IMAGE" ]; then docker tag "$PREV_ID" "$LOCAL_IMAGE" || true; fi
  HINT=''; fail 4 "Building or pulling $TO failed. The previous release kept running and the checkout was restored." "$([ "$IMAGE_MODE" = 1 ] && echo pull-failed || echo build-failed)"
fi
# The image this run built or pulled; exit 4 removes it again. Unknown when the earlier list could not be read.
if [ -n "$EXPECT_DIGEST" ]; then NEW_ID=$(image_id "$IMAGE_NAME@$EXPECT_DIGEST"); elif [ "$IMAGE_MODE" = 1 ]; then NEW_ID=$(image_id "$NEW_IMAGE"); else NEW_ID=$(image_id "$LOCAL_IMAGE"); fi
if [ "$IMAGES_LISTED" != 1 ] || printf '%s\n' "$IMAGES_BEFORE" | grep -Fqx -- "$NEW_ID"; then NEW_ID=''; fi

phase stop 'Stopping the worker (it finishes in-flight work first)'
STOPPED=1
docker compose stop worker
if [ -n "$SNAPSHOT" ]; then
  phase restore-snapshot "Restoring metadata snapshot $SNAPSHOT"
  docker compose stop api
  in_data 'cd /data; keep="upgrade-snapshots/pre-downgrade-$1"; mkdir -m 700 "$keep"; for f in state.sqlite state.sqlite-wal state.sqlite-shm; do if [ -e "$f" ]; then mv "$f" "$keep/"; fi; done; cp "upgrade-snapshots/$2" state.sqlite.restoring; chmod 600 state.sqlite.restoring; mv state.sqlite.restoring state.sqlite; echo "Previous metadata kept in /data/$keep"' "$(date -u +%Y%m%dT%H%M%SZ)" "$SNAPSHOT" \
    || fail 5 'Restoring the snapshot failed; the services are stopped. Inspect /data/upgrade-snapshots before starting anything.'
fi

phase start "Starting $TO"
SCHEMA_TO='' # unknown until read again: the target migrates on start
start_target || START_FAILED=1
phase health "Waiting up to ${TIMEOUT}s for $TO to report healthy"
if ! healthy "$(expect HEAD)" "$TIMEOUT"; then
  docker compose logs --tail=60 api worker >&2 || true
  AFTER=$(db_schema || true); SCHEMA_TO=$AFTER
  # The reason is read from container state and the schema, never from log text.
  if [ "$START_FAILED" = 1 ]; then REASON=start-failed
  elif ! docker compose ps --status running --services 2>/dev/null | grep -qx api && case "$AFTER" in ''|*[!0-9]*) false ;; *) [ "$AFTER" -lt "$TARGET_SCHEMA" ] ;; esac; then REASON=migration-failed
  elif [ "$HEALTH_FAIL" = worker ]; then REASON=health-timeout-worker
  else REASON=health-timeout-api; fi
  if [ -z "$SNAPSHOT" ] && [ "$AFTER" = "$DB_SCHEMA" ]; then
    phase rollback "Metadata unchanged (schema v$AFTER); restoring $FROM"
    if try_revert; then
      HINT=''; fail 4 "$TO did not become healthy. $FROM was restored automatically; no data was changed."
    fi
    fail 6 "$TO did not become healthy and the automatic return to $FROM also failed." rollback-failed
  fi
  if [ -z "$SNAPSHOT" ] && compatible_after "$AFTER"; then
    COMPAT_AFTER=$AFTER
    phase rollback "Metadata schema v$AFTER only adds compatible objects that $FROM ignores; restoring $FROM"
    if try_revert; then
      HINT=''; fail 4 "$TO did not become healthy. $FROM was restored automatically and runs on the migrated metadata (schema v$AFTER only adds compatible objects); no data was discarded."
    fi
    fail 6 "$TO did not become healthy and the automatic return to $FROM also failed." rollback-failed
  fi
  HINT="docker compose stop api worker
# restore metadata (schema v$DB_SCHEMA) from the newest /data/upgrade-snapshots/state-v$DB_SCHEMA-to-v${AFTER:-?}-*.sqlite, see docs/upgrading.md#rolling-back
$(restart_previous_cmd)
docker compose exec api node scripts/deployment-preflight.js release"
  fail 5 "$TO did not become healthy after migrating metadata to schema v${AFTER:-unknown}. Nothing was rolled back automatically."
fi

phase release 'Releasing the deployment hold'
release_hold || echo 'WARNING: could not release the deployment hold; run: docker compose exec api node scripts/deployment-preflight.js release' >&2
[ "$IMAGE_MODE" != 1 ] || image_persist || echo "WARNING: could not update DOCKNEST_IMAGE in .env; set it to $NEW_IMAGE so later restarts keep this release." >&2
promote_previous
HINT="$(restart_previous_cmd)   # previous release; see docs/upgrading.md#rolling-back"
# Success is recorded before anything is removed. From here on every end, even an abort or a signal, is exit 0 with
# status done and ok:true (on_exit), so retention can never revert a good upgrade.
SCHEMA_TO=$(db_schema 2>/dev/null || true)
HOLD=0 CHECKED_OUT=0 STOPPED=0 FINISHED=1 CLEANUP=1 PHASE=cleanup LAST_PHASE=cleanup
record_result 0
echo '==> Removing old upgrade files'
status true
run_cleanup
PHASE=done; status true
echo "DockNest $TO is running. Configuration backup: $SAVE"
echo 'If boot recovery is installed on any site, reinstall it from that site so hosts get the new helper (sites report bootRecoveryOutdated).'
