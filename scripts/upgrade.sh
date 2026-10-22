#!/bin/sh
# DockNest upgrade/rollback for a git-clone + Docker Compose installation. POSIX sh; needs git and docker compose.
# Usage: scripts/upgrade.sh [--version vX.Y.Z] [--non-interactive] [--force] [--allow-data-rollback]
#                           [--status-file PATH] [--timeout SECONDS] [--wait SECONDS] [--dry-run] [--no-prune]
# --dry-run is read-only (no fetch, status file or hold) and lists what retention would remove; --no-prune keeps it all.
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
# Format of the result marker in every upgrade backup; bumped only when the meaning of that file changes.
MARKER_FORMAT=1
while [ $# -gt 0 ]; do
  case "$1" in
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
    -h|--help) sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $1 (see --help)" >&2; exit 1 ;;
  esac
  shift
done
case "$TIMEOUT$WAIT" in *[!0-9]*) echo '--timeout and --wait take whole seconds' >&2; exit 1 ;; esac
case "$CLEANUP_TIMEOUT" in ''|*[!0-9]*) echo '--cleanup-timeout takes whole seconds' >&2; exit 1 ;; esac
[ -t 0 ] || INTERACTIVE=0
# git's ownership check is relaxed for this one checkout only, per command, so a root run of a user-owned checkout works.
git_() { git -c "safe.directory=$ROOT" "$@"; }
PHASE=init LAST_PHASE=init FROM='' TO='' STARTED=$(date -u +%Y-%m-%dT%H:%M:%SZ) HINT=''
FINISHED=0 HOLD=0 CHECKED_OUT=0 STOPPED=0 SNAPSHOT='' STATUS_TMP='' DB_SCHEMA='' IMAGE_MODE=0 PREV_IMAGE='' PREV_ID='' NEW_IMAGE=''
SAVE='' NEW_ID='' IMAGES_BEFORE='' IMAGES_LISTED=0 LOCAL_IMAGE='' COMPAT_AFTER='' CLEANUP=0 CLEANUP_PID='' WATCHDOG_PID='' WARN_FILE='' WARNING=''
[ "$DRY_RUN" = 1 ] && STATUS_FILE=''
json() { printf '%s' "$1" | tr '\n\r\t' '   ' | tr -d '\000-\010\013\014\016-\037\177' | sed 's/\\/\\\\/g; s/"/\\"/g'; }
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
  if ( set -C; umask 022; printf '{"phase":"%s","from":"%s","to":"%s","startedAt":"%s","updatedAt":"%s","ok":%s,"error":%s,"rollbackHint":%s,"warning":%s}\n' \
    "$PHASE" "$(json "$FROM")" "$(json "$TO")" "$STARTED" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$ok" \
    "$( [ -n "${2:-}" ] && printf '"%s"' "$(json "$2")" || printf null)" "$( [ -n "$HINT" ] && printf '"%s"' "$(json "$HINT")" || printf null)" \
    "$( [ -n "$WARNING" ] && printf '"%s"' "$(json "$WARNING" | tr -d '\\"' | cut -c1-1024)" || printf null)" > "$STATUS_TMP" ) 2>/dev/null \
    && mv -f "$STATUS_TMP" "$STATUS_FILE" 2>/dev/null; then STATUS_TMP=''; else echo "WARNING: could not write $STATUS_FILE" >&2; rm -f "$STATUS_TMP"; STATUS_TMP=''; fi
  return 0
}
phase() { PHASE=$1 LAST_PHASE=$1; echo "==> $2"; status; }
cleanup_files() { [ -z "$STATUS_TMP" ] || rm -f "$STATUS_TMP"; [ -z "$WARN_FILE" ] || rm -f "$WARN_FILE"; case "$COPY" in */docknest-upgrade.*) rm -f "$COPY" ;; esac; }
# The exit code of this run, appended to its upgrade backup's result marker: retention never removes the backup of a
# run that ended 5 or 6, or of one that has no recorded exit code (interrupted).
record_result() { if [ -n "$SAVE" ] && [ -d "$SAVE" ] && [ ! -L "$SAVE" ] && [ ! -L "$SAVE/result" ]; then printf 'exit=%s\n' "$1" >> "$SAVE/result" 2>/dev/null || true; fi; }
fail() { # fail CODE MESSAGE
  FINISHED=1 PHASE=failed; echo "ERROR: $2" >&2
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
    if docker compose exec -T api node -e 'const [want]=process.argv.slice(1);(want==="legacy"?fetch("http://127.0.0.1:3000/healthz").then(r=>{if(!r.ok)process.exit(1)}):fetch("http://127.0.0.1:3000/api/version").then(r=>r.json()).then(j=>{if(j.version!==want)process.exit(1)})).catch(()=>process.exit(1))' "$1" >/dev/null 2>&1 \
      && docker compose ps --status running --services 2>/dev/null | grep -qx worker; then return 0; fi
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
  if [ "$STOPPED" = 1 ]; then after=$(db_schema 2>/dev/null) || return 1; [ "$after" = "$DB_SCHEMA" ] || { [ -n "$COMPAT_AFTER" ] && [ "$after" = "$COMPAT_AFTER" ]; } || return 1; fi
  if [ "$CHECKED_OUT" = 1 ]; then git_ checkout --quiet "$FROM_REF" || return 1; CHECKED_OUT=0; fi
  if [ "$STOPPED" = 1 ]; then start_previous && healthy "$(expect HEAD)" "$TIMEOUT" || return 1; STOPPED=0; fi
  [ "$HOLD" != 1 ] || { release_hold || echo 'WARNING: could not release the deployment hold; run: docker compose exec api node scripts/deployment-preflight.js release' >&2; HOLD=0; }
  return 0
}
build_and_start() { # image mode pulls the target image, source mode builds this checkout
  if [ "$IMAGE_MODE" = 1 ]; then DOCKNEST_IMAGE=$NEW_IMAGE docker compose pull api worker; else docker compose build api worker; fi
}
start_target() { if [ "$IMAGE_MODE" = 1 ]; then DOCKNEST_IMAGE=$NEW_IMAGE docker compose up -d api worker; else docker compose up -d api worker; fi; }
# Back to the exact previous release: the image ID recorded before anything was switched (never the tag from .env or
# docknest:local, which may have moved), already present locally, so this works offline and never pulls. Source mode
# points the local tag back at that ID and starts without building; it rebuilds only when the ID is unknown.
start_previous() {
  if [ "$IMAGE_MODE" = 1 ]; then DOCKNEST_IMAGE=${PREV_ID:-$PREV_IMAGE} docker compose up -d --pull never api worker
  elif [ -n "$PREV_ID" ] && [ -n "$LOCAL_IMAGE" ] && docker tag "$PREV_ID" "$LOCAL_IMAGE"; then docker compose up -d --no-build api worker
  else docker compose build api worker && docker compose up -d api worker; fi
}
restart_previous_cmd() {
  if [ "$IMAGE_MODE" = 1 ]; then echo "git checkout $FROM_REF && DOCKNEST_IMAGE=${PREV_ID:-$PREV_IMAGE} docker compose up -d --pull never   # and keep DOCKNEST_IMAGE=$PREV_IMAGE in .env"
  elif [ -n "$PREV_ID" ] && [ -n "$LOCAL_IMAGE" ]; then echo "git checkout $FROM_REF && docker tag $PREV_ID $LOCAL_IMAGE && docker compose up -d --no-build"
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
# Image mode: DOCKNEST_IMAGE (environment or .env) names the image; the script switches only the tag, per command.
image_setup() {
  PREV_IMAGE=${DOCKNEST_IMAGE:-$(sed -n 's/^DOCKNEST_IMAGE=//p' .env 2>/dev/null | tail -n 1 | tr -d "\"'")}
  [ -n "$PREV_IMAGE" ] || fail 2 'Image mode needs DOCKNEST_IMAGE=<registry/name>:<tag> in .env (see compose.override.example.yaml).'
  case "$PREV_IMAGE" in *@*) fail 2 'DOCKNEST_IMAGE is pinned by digest; edit it in .env yourself, or use a tag so the script can switch versions.' ;; esac
  case "${PREV_IMAGE##*/}" in *:*) IMAGE_NAME=${PREV_IMAGE%:*} ;; *) IMAGE_NAME=$PREV_IMAGE ;; esac
  NEW_IMAGE="$IMAGE_NAME:$TO"
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
# own_image ID: every tag and digest of the image belongs to this install's repository (image mode: the name in
# DOCKNEST_IMAGE; source mode: the local image name, or untagged). Exit 2 when the image no longer exists.
own_image() {
  refs=$(docker image inspect --format '{{range .RepoTags}}{{println .}}{{end}}{{range .RepoDigests}}{{println .}}{{end}}' -- "$1" 2>/dev/null) || return 2
  [ -n "$refs" ] || [ "$IMAGE_MODE" != 1 ] || return 1
  for ref in $refs; do
    if [ "$IMAGE_MODE" = 1 ]; then
      case "$ref" in *@*) repo=${ref%%@*} ;; *) case "${ref##*/}" in *:*) repo=${ref%:*} ;; *) repo=$ref ;; esac ;; esac
      [ "$repo" = "$IMAGE_NAME" ] || return 1
    else [ "$ref" = "$LOCAL_IMAGE" ] || return 1; fi
  done
}
# Removes only image IDs this install recorded itself (imageId in its previous-release files) that belong to its
# repository, minus the images api and worker run, the previous one and those recorded by runs that are kept for manual
# action. Skipped entirely when any of those IDs is unknown. docker image rm without --force; never any prune command.
prune_images() {
  parent="$ROOT/data/upgrade-backups"
  if [ -L "$parent" ] || [ ! -d "$parent" ]; then return 0; fi
  api=$(running_id api) worker=$(running_id worker)
  if [ -z "$api" ] || [ -z "$worker" ] || [ -z "$PREV_ID" ]; then echo 'Image cleanup skipped: the running or the previous DockNest image ID is unknown.'; return 0; fi
  if [ "$IMAGE_MODE" != 1 ] && [ -z "$LOCAL_IMAGE" ]; then echo 'Image cleanup skipped: the local image name is unknown.'; return 0; fi
  keep=" $api $worker $PREV_ID " recorded='' untracked=0
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
  for id in $(printf '%s\n' $recorded | sort -u); do
    case "$keep" in *" $id "*) continue ;; esac
    own_image "$id"; owned=$?
    [ "$owned" != 2 ] || continue
    if [ "$owned" != 0 ]; then echo "Keeping image $id: it is also tagged outside this installation's repository."; continue; fi
    if [ "$DRY_RUN" = 1 ]; then echo "Would remove image $id"; continue; fi
    if docker image rm "$id" >/dev/null 2>&1; then echo "Removed image $id"; else warn "Could not remove image $id (still used by a container or tagged more than once)."; fi
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
# Runs retention in a guarded background subshell with its own time limit; nothing in it can change the outcome.
run_cleanup() {
  WARN_FILE=$(mktemp "${TMPDIR:-/tmp}/docknest-warnings.XXXXXX" 2>/dev/null) || WARN_FILE=''
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
  return 0
}

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

if [ "$DRY_RUN" = 1 ]; then echo 'Dry run: using the release tags already in this checkout (no fetch).'
else
  phase fetch 'Fetching release tags'
  # Offline is fine when the tag is already local (rollbacks must work without GitHub).
  git_ fetch --tags --quiet origin || echo 'WARNING: git fetch failed; continuing with the tags already in this checkout.' >&2
fi
if [ -z "$TARGET" ]; then TARGET=$(git_ tag -l 'v*' --sort=-v:refname | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | head -n 1); fi
case "$TARGET" in v*) ;; *) TARGET="v$TARGET" ;; esac
git_ rev-parse -q --verify "refs/tags/$TARGET" >/dev/null || fail 2 "Release tag $TARGET does not exist locally$([ "$DRY_RUN" = 1 ] || echo ' or on origin')."
TO=$(package_field "$TARGET" version)
[ -n "$TO" ] || fail 2 "Could not read the version of $TARGET."
TARGET_REF=$(git_ rev-parse "$TARGET^{commit}")
echo "Current: $FROM ($(git_ describe --tags --always HEAD))   Target: $TO ($TARGET)   Mode: $([ "$IMAGE_MODE" = 1 ] && echo published image || echo build from source)"
if [ "$TARGET_REF" = "$FROM_REF" ] && healthy "$(expect HEAD)" 0; then FINISHED=1 PHASE=done HINT=''; echo "Already running $TO."; status true; exit 0; fi
[ "$IMAGE_MODE" != 1 ] || image_setup
[ "$IMAGE_MODE" = 1 ] || LOCAL_IMAGE=$(local_image)
# The exact image the previous release runs, in both modes: rollback starts it again without pulling or building.
PREV_ID=$(running_id api)
MIN=$(package_field "$TARGET" minUpgradeFrom)
if [ -n "$MIN" ] && ! version_ge "$FROM" "$MIN"; then fail 2 "$TO supports upgrades from $MIN or later. Upgrade to an intermediate release first."; fi

DB_SCHEMA=$(db_schema); case "$DB_SCHEMA" in ''|*[!0-9]*) fail 2 'Could not read the metadata schema version from the state volume.' ;; esac
TARGET_SCHEMA=$(schema_at "$TARGET")
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
    release_hold; HOLD=0
    fail 3 'Jobs are queued, running or need recovery review. Let them finish or resolve them in the dashboard, then retry (or use --force).'
  fi
  echo 'Work in progress; waiting...'; sleep 15
done
if docker compose exec -T worker test -f src/worker-status.js >/dev/null 2>&1; then
  docker compose exec -T worker node src/worker-status.js || { [ "$FORCE" = 1 ] || { release_hold; HOLD=0; fail 3 'The worker reports active work. Retry when it is idle (or use --force).'; }; }
fi
HINT="docker compose exec api node scripts/deployment-preflight.js release   # lifts the hold set by this script"

phase backup 'Saving configuration and secrets for rollback'
mkdir -p data/upgrade-backups && chmod 700 data/upgrade-backups || fail 2 'Could not create data/upgrade-backups; check permissions and free disk space. Nothing was changed.'
# A folder of its own, never an existing one (two runs in one second get -2, -3, ...; the names still match retention's
# pattern), with the result marker written first so even an interrupted run's backup is recognised and kept.
base="data/upgrade-backups/$(date -u +%Y%m%dT%H%M%SZ)-$FROM-to-$TO" try=1
while [ -z "$SAVE" ]; do
  candidate=$base; [ "$try" = 1 ] || candidate="$base-$try"
  if mkdir -m 700 "$candidate" 2>/dev/null; then SAVE=$candidate; break; fi
  { [ -e "$candidate" ] || [ -L "$candidate" ]; } && [ "$try" -lt 50 ] || fail 2 "Could not create $candidate; check permissions and free disk space. Nothing was changed."
  try=$((try + 1))
done
printf 'format=%s\n' "$MARKER_FORMAT" > "$SAVE/result" || fail 2 "Could not write $SAVE/result. Nothing was changed."
for file in .env compose.override.yaml data/master.key data/setup.token; do
  if [ -e "$file" ]; then cp -p "$file" "$SAVE/$(basename "$file")" || fail 2 "Could not copy $file to $SAVE; check free disk space. Nothing was changed."; fi
done
printf 'commit=%s\nversion=%s\nschema=%s\nimage=%s\nimageId=%s\n' "$FROM_REF" "$FROM" "$DB_SCHEMA" "${PREV_IMAGE:-}" "${PREV_ID:-}" > "$SAVE/previous-release" || fail 2 "Could not write $SAVE/previous-release. Nothing was changed."
echo "Saved to $SAVE (later successful upgrades keep the newest 5 backups and every backup of a run that needs manual action)."

phase checkout "Checking out $TARGET"
git_ -c advice.detachedHead=false checkout --quiet "$TARGET" || { release_hold; HOLD=0; fail 2 "git checkout $TARGET failed; nothing else changed."; }
CHECKED_OUT=1
HINT="$(restart_previous_cmd) && docker compose exec api node scripts/deployment-preflight.js release"

phase build "Preparing the $TO image"
# Every image present before the build or pull: exit 4 removes only an image that was not among them.
if IMAGES_BEFORE=$(docker image ls -aq --no-trunc 2>/dev/null); then IMAGES_LISTED=1; fi
if ! build_and_start; then
  git_ checkout --quiet "$FROM_REF" && CHECKED_OUT=0; release_hold; HOLD=0
  # A partial source build may have moved the local tag: point it back at the image the services still run.
  if [ "$IMAGE_MODE" != 1 ] && [ -n "$PREV_ID" ] && [ -n "$LOCAL_IMAGE" ]; then docker tag "$PREV_ID" "$LOCAL_IMAGE" || true; fi
  HINT=''; fail 4 "Building or pulling $TO failed. The previous release kept running and the checkout was restored."
fi
# The image this run built or pulled; exit 4 removes it again. Unknown when the earlier list could not be read.
if [ "$IMAGE_MODE" = 1 ]; then NEW_ID=$(image_id "$NEW_IMAGE"); else NEW_ID=$(image_id "$LOCAL_IMAGE"); fi
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
start_target || true
phase health "Waiting up to ${TIMEOUT}s for $TO to report healthy"
if ! healthy "$(expect HEAD)" "$TIMEOUT"; then
  docker compose logs --tail=60 api worker >&2 || true
  AFTER=$(db_schema || true)
  if [ -z "$SNAPSHOT" ] && [ "$AFTER" = "$DB_SCHEMA" ]; then
    phase rollback "Metadata unchanged (schema v$AFTER); restoring $FROM"
    if try_revert; then
      HINT=''; fail 4 "$TO did not become healthy. $FROM was restored automatically; no data was changed."
    fi
    fail 6 "$TO did not become healthy and the automatic return to $FROM also failed."
  fi
  if [ -z "$SNAPSHOT" ] && compatible_after "$AFTER"; then
    COMPAT_AFTER=$AFTER
    phase rollback "Metadata schema v$AFTER only adds compatible objects that $FROM ignores; restoring $FROM"
    if try_revert; then
      HINT=''; fail 4 "$TO did not become healthy. $FROM was restored automatically and runs on the migrated metadata (schema v$AFTER only adds compatible objects); no data was discarded."
    fi
    fail 6 "$TO did not become healthy and the automatic return to $FROM also failed."
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
HINT="$(restart_previous_cmd)   # previous release; see docs/upgrading.md#rolling-back"
# Success is recorded before anything is removed. From here on every end, even an abort or a signal, is exit 0 with
# status done and ok:true (on_exit), so retention can never revert a good upgrade.
HOLD=0 CHECKED_OUT=0 STOPPED=0 FINISHED=1 CLEANUP=1 PHASE=cleanup LAST_PHASE=cleanup
record_result 0
echo '==> Removing old upgrade files'
status true
run_cleanup
PHASE=done; status true
echo "DockNest $TO is running. Configuration backup: $SAVE"
echo 'If boot recovery is installed on any site, reinstall it from that site so hosts get the new helper (sites report bootRecoveryOutdated).'
