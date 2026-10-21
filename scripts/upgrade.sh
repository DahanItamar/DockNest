#!/bin/sh
# DockNest upgrade/rollback for a git-clone + Docker Compose installation. POSIX sh; needs git and docker compose.
# Usage: scripts/upgrade.sh [--version vX.Y.Z] [--non-interactive] [--force] [--allow-data-rollback]
#                           [--status-file PATH] [--timeout SECONDS] [--wait SECONDS] [--dry-run]
# Exit codes: 0 done or already current; 1 usage; 2 precondition refused, nothing changed; 3 work still running;
# 4 failed before the database changed, previous release restored; 5 failed after the database migrated, manual
# rollback needed (commands printed); 6 automatic rollback failed. See docs/upgrading.md.
set -eu
umask 077
# Locate the checkout: DOCKNEST_DIR, this script's checkout, or the current directory (for a copy run from /tmp).
if [ -z "${DOCKNEST_DIR:-}" ]; then
  DOCKNEST_DIR=$(cd "$(dirname "$0")/.." && pwd)
  [ -f "$DOCKNEST_DIR/compose.yaml" ] || DOCKNEST_DIR=$(pwd)
fi
[ -f "$DOCKNEST_DIR/compose.yaml" ] || { echo 'Run this from the DockNest checkout or set DOCKNEST_DIR.' >&2; exit 1; }
# git checkout replaces this file while sh is still reading it, so run from a private copy.
if [ -z "${DOCKNEST_UPGRADE_COPY:-}" ]; then
  copy=$(mktemp "${TMPDIR:-/tmp}/docknest-upgrade.XXXXXX") && cp "$0" "$copy" || exit 1
  DOCKNEST_UPGRADE_COPY=$copy DOCKNEST_DIR=$DOCKNEST_DIR exec sh "$copy" "$@"
fi
trap 'rm -f "$DOCKNEST_UPGRADE_COPY"' EXIT
cd "$DOCKNEST_DIR"
ROOT=$(pwd)
TARGET='' INTERACTIVE=1 FORCE=0 DATA_ROLLBACK=0 STATUS_FILE='' TIMEOUT=300 WAIT=600 DRY_RUN=0
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
    -h|--help) sed -n '2,7p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $1 (see --help)" >&2; exit 1 ;;
  esac
  shift
done
case "$TIMEOUT$WAIT" in *[!0-9]*) echo '--timeout and --wait take whole seconds' >&2; exit 1 ;; esac
[ -t 0 ] || INTERACTIVE=0
# A root-run updater (systemd) must still be able to use a checkout owned by the installing user.
GIT="git -c safe.directory=$ROOT"
PHASE=init FROM='' TO='' STARTED=$(date -u +%Y-%m-%dT%H:%M:%SZ) HINT=''
json() { printf '%s' "$1" | tr '\n\r\t' '   ' | sed 's/\\/\\\\/g; s/"/\\"/g'; }
status() { # status OK ERROR
  [ -n "$STATUS_FILE" ] || return 0
  ok=null; [ -n "${1:-}" ] && ok=$1
  tmp="$STATUS_FILE.tmp.$$"
  printf '{"phase":"%s","from":"%s","to":"%s","startedAt":"%s","updatedAt":"%s","ok":%s,"error":%s,"rollbackHint":%s}\n' \
    "$PHASE" "$(json "$FROM")" "$(json "$TO")" "$STARTED" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$ok" \
    "$( [ -n "${2:-}" ] && printf '"%s"' "$(json "$2")" || printf null)" "$( [ -n "$HINT" ] && printf '"%s"' "$(json "$HINT")" || printf null)" > "$tmp"
  mv -f "$tmp" "$STATUS_FILE"
}
phase() { PHASE=$1; echo "==> $2"; status; }
fail() { # fail CODE MESSAGE
  PHASE=failed; echo "ERROR: $2" >&2
  [ -n "$HINT" ] && printf '\nRollback:\n%s\n' "$HINT" >&2
  status false "$2"; exit "$1"
}
confirm() {
  [ "$INTERACTIVE" = 1 ] || return 0
  printf '%s [y/N] ' "$1"; read -r answer || answer=''
  case "$answer" in y|Y|yes|YES) ;; *) fail 2 'Cancelled by the operator.' ;; esac
}
# Numeric SemVer comparison of X.Y.Z (pre-release suffixes ignored): succeeds when $1 >= $2.
version_ge() { awk -v a="${1%%-*}" -v b="${2%%-*}" 'BEGIN{split(a,x,".");split(b,y,".");for(i=1;i<=3;i++){if(x[i]+0>y[i]+0)exit 0;if(x[i]+0<y[i]+0)exit 1}exit 0}'; }
# Highest migration number in a git revision; releases before versioned migrations (v2.0.0) report 0.
schema_at() { $GIT show "$1:src/migrations.js" 2>/dev/null | sed -n 's/^ *{ *version: *\([0-9][0-9]*\),.*/\1/p' | tail -n 1 | grep . || echo 0; }
package_field() { $GIT show "$1:package.json" | sed -n "s/^ *\"$2\": *\"\([^\"]*\)\".*/\1/p" | head -n 1; }
in_data() { script=$1; shift; docker compose run --rm --no-deps -T --entrypoint /bin/sh worker -ec "$script" sh "$@"; }
db_schema() { docker compose run --rm --no-deps -T --entrypoint node worker -e 'const {DatabaseSync}=require("node:sqlite");const d=new DatabaseSync("/data/state.sqlite");console.log(d.prepare("PRAGMA user_version").get().user_version);d.close()' 2>/dev/null | tail -n 1; }
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
build_and_start() { # build_and_start: image mode pulls the pinned image, source mode builds this checkout
  if [ "$IMAGE_MODE" = 1 ]; then docker compose pull api worker; else docker compose build api worker; fi
}

phase preflight 'Checking the installation'
command -v git >/dev/null 2>&1 || fail 2 'git is required.'
docker compose version >/dev/null 2>&1 || fail 2 'Docker Compose v2 (docker compose) is required.'
$GIT rev-parse --git-dir >/dev/null 2>&1 || fail 2 "$ROOT is not a git checkout. Install DockNest with git clone to use this script."
if [ -n "$($GIT status --porcelain --untracked-files=no)" ]; then
  $GIT status --short --untracked-files=no >&2
  fail 2 'Tracked files were edited. Move local settings to .env and Compose changes to compose.override.yaml (both are ignored by git), then run git restore on these files.'
fi
for secret in data/master.key data/setup.token; do [ -s "$secret" ] || fail 2 "$secret is missing or empty. Restore it from your separate key backup before upgrading."; done
docker compose config --quiet || fail 2 'docker compose config failed. Fix .env or compose.override.yaml first.'
IMAGE_MODE=1; docker compose config 2>/dev/null | grep -q '^ *context:' && IMAGE_MODE=0
FROM_REF=$($GIT rev-parse HEAD)
FROM=$(package_field HEAD version)

phase fetch 'Fetching release tags'
$GIT fetch --tags --quiet origin || fail 2 'git fetch failed. Check network access to the repository.'
if [ -z "$TARGET" ]; then TARGET=$($GIT tag -l 'v*' --sort=-v:refname | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | head -n 1); fi
case "$TARGET" in v*) ;; *) TARGET="v$TARGET" ;; esac
$GIT rev-parse -q --verify "refs/tags/$TARGET" >/dev/null || fail 2 "Release tag $TARGET does not exist."
TO=$(package_field "$TARGET" version)
[ -n "$TO" ] || fail 2 "Could not read the version of $TARGET."
TARGET_REF=$($GIT rev-parse "$TARGET^{commit}")
echo "Current: $FROM ($($GIT describe --tags --always HEAD))   Target: $TO ($TARGET)   Mode: $([ "$IMAGE_MODE" = 1 ] && echo published image || echo build from source)"
if [ "$TARGET_REF" = "$FROM_REF" ] && healthy "$(expect HEAD)" 0; then PHASE=done; HINT=''; echo "Already running $TO."; status true; exit 0; fi
if [ "$IMAGE_MODE" = 1 ] && ! docker compose config --images | grep -q ":$TO\$"; then
  fail 2 "Image mode: set the api and worker image tag in compose.override.yaml to $TO first (see docs/upgrading.md)."
fi
MIN=$(package_field "$TARGET" minUpgradeFrom)
if [ -n "$MIN" ] && ! version_ge "$FROM" "$MIN"; then fail 2 "$TO supports upgrades from $MIN or later. Upgrade to an intermediate release first."; fi

DB_SCHEMA=$(db_schema); case "$DB_SCHEMA" in ''|*[!0-9]*) fail 2 'Could not read the metadata schema version from the state volume.' ;; esac
TARGET_SCHEMA=$(schema_at "$TARGET")
# v2.0.0 predates user_version; its schema is identical to migration 1.
COMPATIBLE=$TARGET_SCHEMA; [ "$COMPATIBLE" -lt 1 ] && COMPATIBLE=1
SNAPSHOT=''
if [ "$DB_SCHEMA" -gt "$COMPATIBLE" ]; then
  # Older schema target: only a pre-upgrade snapshot taken when this database moved from that schema (or older) to its
  # current one is acceptable; the target release migrates an older snapshot forward on start.
  SNAPSHOT=$(in_data 'ls /data/upgrade-snapshots 2>/dev/null || true' | awk -v t="$TARGET_SCHEMA" -v d="$DB_SCHEMA" -F'[-v]' '/^state-v[0-9]+-to-v[0-9]+-[0-9]+T[0-9]+Z\.sqlite$/ && $3+0<=t+0 && $6+0==d+0 {print $NF" "$0}' | sort | tail -n 1 | cut -d' ' -f2 || true)
  [ -n "$SNAPSHOT" ] || fail 2 "$TO uses metadata schema v$TARGET_SCHEMA but this database is v$DB_SCHEMA and no matching snapshot state-v$TARGET_SCHEMA-to-v$DB_SCHEMA-*.sqlite exists. Downgrade refused."
  echo "Downgrade needs the metadata snapshot $SNAPSHOT. Every job, backup record and setting changed since that upgrade will be lost (backup files stay on storage)."
  [ "$INTERACTIVE" = 1 ] || [ "$DATA_ROLLBACK" = 1 ] || fail 2 'Restoring an older metadata snapshot requires --allow-data-rollback in non-interactive mode.'
fi
[ "$DRY_RUN" = 1 ] && { PHASE=done; echo 'Dry run: no changes made.'; status true; exit 0; }
confirm "Upgrade DockNest from $FROM to $TO?"
[ -n "$SNAPSHOT" ] && confirm "Restore $SNAPSHOT and discard newer metadata?"

phase idle 'Holding new work and waiting for running jobs'
deadline=$(( $(date +%s) + WAIT ))
until docker compose exec -T api node scripts/deployment-preflight.js hold >/dev/null 2>&1; do
  if [ "$(date +%s)" -ge "$deadline" ]; then
    if [ "$FORCE" = 1 ]; then echo 'WARNING: --force: continuing with queued or running work; interrupted jobs will need recovery review.' >&2; break; fi
    fail 3 'Jobs are queued, running or need recovery review. Let them finish or resolve them in the dashboard, then retry (or use --force).'
  fi
  echo 'Work in progress; waiting...'; sleep 15
done
if docker compose exec -T worker test -f src/worker-status.js >/dev/null 2>&1; then
  docker compose exec -T worker node src/worker-status.js || { [ "$FORCE" = 1 ] || { release_hold; fail 3 'The worker reports active work. Retry when it is idle (or use --force).'; }; }
fi
HINT="docker compose exec api node scripts/deployment-preflight.js release   # lifts the hold set by this script"

phase backup 'Saving configuration and secrets for rollback'
SAVE="data/upgrade-backups/$(date -u +%Y%m%dT%H%M%SZ)-$FROM-to-$TO"
mkdir -p "$SAVE"; chmod 700 data/upgrade-backups "$SAVE"
for file in .env compose.override.yaml data/master.key data/setup.token; do [ -e "$file" ] && cp -p "$file" "$SAVE/$(basename "$file")"; done
printf 'commit=%s\nversion=%s\nschema=%s\n' "$FROM_REF" "$FROM" "$DB_SCHEMA" > "$SAVE/previous-release"
echo "Saved to $SAVE (never deleted automatically)."

phase checkout "Checking out $TARGET"
$GIT -c advice.detachedHead=false checkout --quiet "$TARGET" || { release_hold; fail 2 "git checkout $TARGET failed; nothing else changed."; }
HINT="git checkout $FROM_REF && docker compose up -d --build && docker compose exec api node scripts/deployment-preflight.js release"

phase build "Preparing the $TO image"
if ! build_and_start; then
  $GIT checkout --quiet "$FROM_REF"; release_hold
  HINT=''; fail 4 "Building or pulling $TO failed. The previous release kept running and the checkout was restored."
fi

phase stop 'Stopping the worker (it finishes in-flight work first)'
docker compose stop worker
if [ -n "$SNAPSHOT" ]; then
  phase restore-snapshot "Restoring metadata snapshot $SNAPSHOT"
  docker compose stop api
  in_data 'cd /data; keep="upgrade-snapshots/pre-downgrade-$1"; mkdir -m 700 "$keep"; for f in state.sqlite state.sqlite-wal state.sqlite-shm; do if [ -e "$f" ]; then mv "$f" "$keep/"; fi; done; cp "upgrade-snapshots/$2" state.sqlite.restoring; chmod 600 state.sqlite.restoring; mv state.sqlite.restoring state.sqlite; echo "Previous metadata kept in /data/$keep"' "$(date -u +%Y%m%dT%H%M%SZ)" "$SNAPSHOT" \
    || fail 5 'Restoring the snapshot failed; the services are stopped. Inspect /data/upgrade-snapshots before starting anything.'
fi

phase start "Starting $TO"
docker compose up -d api worker || true
phase health "Waiting up to ${TIMEOUT}s for $TO to report healthy"
if ! healthy "$(expect HEAD)" "$TIMEOUT"; then
  docker compose logs --tail=60 api worker >&2 || true
  AFTER=$(db_schema || true)
  if [ -z "$SNAPSHOT" ] && [ "$AFTER" = "$DB_SCHEMA" ]; then
    phase rollback "Metadata unchanged (schema v$AFTER); restoring $FROM"
    $GIT checkout --quiet "$FROM_REF"
    if build_and_start && docker compose up -d api worker && healthy "$(expect HEAD)" "$TIMEOUT"; then
      release_hold; HINT=''; fail 4 "$TO did not become healthy. $FROM was restored automatically; no data was changed."
    fi
    fail 6 "$TO did not become healthy and the automatic return to $FROM also failed."
  fi
  HINT="docker compose stop api worker
# restore metadata (schema v$DB_SCHEMA) from the newest /data/upgrade-snapshots/state-v$DB_SCHEMA-to-v${AFTER:-?}-*.sqlite, see docs/upgrading.md#rolling-back
git checkout $FROM_REF && docker compose up -d --build
docker compose exec api node scripts/deployment-preflight.js release"
  fail 5 "$TO did not become healthy after migrating metadata to schema v${AFTER:-unknown}. Nothing was rolled back automatically."
fi

phase release 'Releasing the deployment hold'
release_hold || echo 'WARNING: could not release the deployment hold; run: docker compose exec api node scripts/deployment-preflight.js release' >&2
PHASE=done HINT="git checkout $FROM_REF   # previous release; see docs/upgrading.md#rolling-back"
status true
echo "DockNest $TO is running. Configuration backup: $SAVE"
echo 'If boot recovery is installed on any site, reinstall it from that site so hosts get the new helper (sites report bootRecoveryOutdated).'
