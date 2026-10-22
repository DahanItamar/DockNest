#!/bin/sh
# DockNest host updater installer (docs/updater-threat-model.md). Run on the DockNest host from the checkout, once:
#   sudo scripts/install-updater.sh               install (refused when an updater is already installed on this host)
#   sudo scripts/install-updater.sh --repair      reinstall the broker, cosign, units and status directory; keeps state
#   sudo scripts/install-updater.sh --ack         lift the needs-host-ack block after checking the host (hold must be off)
#   sudo scripts/install-updater.sh --status      print the broker state and the last result with its rollback hint
#   sudo scripts/install-updater.sh --uninstall   remove units and code; keeps /var/lib/docknest-updater (history, block)
# Rootful Docker on systemd Linux only (Q5): refuses rootless Docker, user-namespace remapping and Docker Desktop.
# Never adds anyone to the docker group, never changes ownership of the checkout, never stores a secret.
set -eu
umask 022
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin; export PATH
# cosign pinned by version and SHA-256 (D14, F6); release.yml signs with the same cosign-release.
COSIGN_VERSION=v3.0.5
COSIGN_SHA256_AMD64=db15cc99e6e4837daabab023742aaddc3841ce57f193d11b7c3e06c8003642b2
COSIGN_SHA256_ARM64=d098f3168ae4b3aa70b4ca78947329b953272b487727d1722cb3cb098a1a20ab
LIB=/usr/local/lib/docknest-updater ETC=/etc/docknest-updater STATE=/var/lib/docknest-updater WORK=/run/docknest-updater-work
UNITS=/etc/systemd/system TMPFILES=/etc/tmpfiles.d/docknest-updater.conf
VOLUME=docknest_updater PROJECT=docknest VERIFY=docknest-verify API_UID=1000 API_GID=1000
# The socket's SocketGroup must name a real group: systemd 259 refuses a bare GID without one (status=216/GROUP).
API_GROUP_NAME=docknest-api API_GROUP_MARK=/var/lib/docknest-updater/api-group-created
die() { echo "ERROR: $*" >&2; exit 2; }
MODE=install
case "${1:-}" in
  '') ;;
  --repair) MODE=repair ;; --ack) MODE=ack ;; --status) MODE=status ;; --uninstall) MODE=uninstall ;;
  -h|--help) sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
  *) echo "Unknown option: $1 (see --help)" >&2; exit 1 ;;
esac
[ $# -le 1 ] || { echo 'Give one option at most (see --help).' >&2; exit 1; }
[ "$(id -u)" = 0 ] || die 'Run this with sudo: the host updater is a root service.'
[ "$(uname -s)" = Linux ] && [ -d /run/systemd/system ] || die 'The host updater needs Linux with systemd.'
ROOT=$(cd "$(dirname "$0")/.." && pwd -P)
[ -f "$ROOT/compose.yaml" ] && [ -f "$ROOT/updater/broker.py" ] || die "Run this from the DockNest checkout ($ROOT has no compose.yaml or updater/)."
broker() { python3 -I -B "$LIB/current/broker.py" "$@"; }
installed() { [ -f "$ETC/config.json" ]; }
config_value() { python3 -I -c 'import json,sys;print(json.load(open(sys.argv[1]))[sys.argv[2]])' "$ETC/config.json" "$1"; }
run_idle() { flock -n "$STATE/lock" true 2>/dev/null || die 'An in-app upgrade is running; wait for it to end (see --status).'; }

# The checkout owner runs Docker and git; root never runs docker compose or parses the checkout's configuration (F15).
OWNER_UID=$(stat -c %u "$ROOT") OWNER_GID=$(stat -c %g "$ROOT")
OWNER=$(getent passwd "$OWNER_UID" | cut -d: -f1) OWNER_HOME=$(getent passwd "$OWNER_UID" | cut -d: -f6)
GROUP=$(getent group "$OWNER_GID" | cut -d: -f1)
as_owner() {
  setpriv --reuid="$OWNER_UID" --regid="$OWNER_GID" --init-groups --inh-caps=-all --reset-env -- \
    env -i PATH="$PATH" HOME="$OWNER_HOME" LANG=C.UTF-8 sh -c 'cd "$1" && shift && exec "$@"' sh "$ROOT" "$@"
}
in_api() { as_owner docker compose exec -T api node --no-addons -e "$1"; }
# The deployment hold, read on its own: deployment-preflight.js check also fails while a self-backup is queued, which is
# not a reason to keep the block. Unreadable counts as on (fail closed).
hold_state() {
  in_api 'const {DatabaseSync}=require("node:sqlite");const d=new DatabaseSync("/data/state.sqlite",{readOnly:true});const r=d.prepare("SELECT value FROM settings WHERE key=?").get("deployment_hold");console.log(r&&r.value==="true"?"hold-on":"hold-off");d.close()' 2>/dev/null | tail -n 1 || true
}
# The dashboard's request that needs manual action ends here once the host was checked (D23, A20): needs_action -> resolved.
close_requests() {
  n=$(in_api 'const {DatabaseSync}=require("node:sqlite");const d=new DatabaseSync("/data/state.sqlite");d.exec("PRAGMA busy_timeout=5000");const t=d.prepare("SELECT 1 FROM sqlite_master WHERE type=? AND name=?").get("table","update_requests");console.log(t?d.prepare("UPDATE update_requests SET state=?,finished_at=COALESCE(finished_at,?) WHERE state=?").run("resolved",new Date().toISOString(),"needs_action").changes:0);d.close()' 2>/dev/null | tail -n 1) || n=''
  case "$n" in ''|*[!0-9]*) echo 'WARNING: could not update the dashboard (is DockNest running?); it shows the result once the API reads the updater state.' >&2 ;; 0) ;; *) echo "Closed $n dashboard request(s) that needed manual action." ;; esac
}

case "$MODE" in
  status)
    installed || { echo 'The DockNest host updater is not installed.'; exit 0; }
    broker status; printf 'Socket: %s\n' "$(systemctl is-active docknest-updater.socket 2>/dev/null || true)"; exit 0 ;;
  ack)
    installed || die 'The host updater is not installed.'
    run_idle
    case "$(hold_state)" in
      hold-off) ;;
      hold-on) die 'The deployment hold is still on. Finish the manual rollback or checks (see --status and docs/upgrading.md#rolling-back), release the hold with: docker compose exec api node scripts/deployment-preflight.js release, then run --ack again.' ;;
      *) die 'Could not read the deployment hold through the api container; start DockNest (docker compose up -d) and run --ack again.' ;;
    esac
    broker ack; close_requests
    echo 'Acknowledged: in-app updates are unblocked.'; exit 0 ;;
  uninstall)
    installed || die 'The host updater is not installed.'
    run_idle
    VOLUME_DIR=$(config_value volume)
    systemctl disable --now docknest-updater.socket docknest-updater.service 2>/dev/null || true
    rm -f "$UNITS/docknest-updater.socket" "$UNITS/docknest-updater.service" "$TMPFILES"
    systemctl daemon-reload
    rm -f "$VOLUME_DIR/status/status.json" "$VOLUME_DIR/status/current.json" "$VOLUME_DIR/status/service.json"
    rmdir "$VOLUME_DIR/status" 2>/dev/null || true
    rm -rf "$LIB" "$ETC" "$WORK"
    # Remove the api group only when this installer created it and it still has the api GID.
    if [ -f "$API_GROUP_MARK" ]; then
      if [ "$(getent group "$API_GROUP_NAME" | cut -d: -f3)" = "$API_GID" ]; then
        groupdel "$API_GROUP_NAME" || echo "WARNING: could not remove the $API_GROUP_NAME group; remove it by hand." >&2
      fi
      rm -f "$API_GROUP_MARK"
    fi
    close_requests
    echo "Uninstalled. Kept $STATE (history, pins and any block); a reinstall continues from it. Remove it and the $VERIFY account by hand to forget them."
    exit 0 ;;
esac

# ------------------------------------------------------------------ install and repair: host checks
if installed; then
  [ "$MODE" = repair ] || die "The host updater is already installed (for $(config_value checkout)). One install per host (D16): use --repair, or --uninstall first."
  [ "$(config_value checkout)" = "$ROOT" ] || die "The host updater is installed for $(config_value checkout); run --repair or --uninstall from that checkout."
fi
for tool in python3 git docker setpriv flock curl sha256sum systemctl systemd-analyze systemd-tmpfiles useradd; do
  command -v "$tool" >/dev/null 2>&1 || die "$tool is required."
done
python3 -I -c 'import sys; sys.exit(sys.version_info < (3, 9))' || die 'Python 3.9 or later is required.'
# setpriv --reset-env needs util-linux 2.35 or later (AR2-N4, P8).
UTIL=$(setpriv --version | sed -n 's/.*util-linux \([0-9][0-9]*\.[0-9][0-9]*\).*/\1/p')
awk -v v="${UTIL:-0.0}" 'BEGIN{split(v,a,".");exit !(a[1]>2||(a[1]==2&&a[2]>=35))}' || die "util-linux 2.35 or later is required for setpriv --reset-env (found ${UTIL:-unknown})."
SECURITY=$(docker info --format '{{json .SecurityOptions}}' 2>/dev/null) || die 'docker info failed; is the Docker daemon running?'
case "$SECURITY" in *name=rootless*|*name=userns*) die 'Rootless Docker and user-namespace remapping are not supported; update from the command line with scripts/upgrade.sh.' ;; esac
case "$(docker info --format '{{.OperatingSystem}}')" in *'Docker Desktop'*) die 'Docker Desktop is not supported; update from the command line with scripts/upgrade.sh.' ;; esac
DOCKER_ROOT=$(docker info --format '{{.DockerRootDir}}')
case "$DOCKER_ROOT" in /*) ;; *) die 'Could not read the Docker data root.' ;; esac
# Account rule (D2): the checkout owner is root or already in docker; nothing is added to the group.
[ -n "$OWNER" ] && [ -n "$GROUP" ] && [ -n "$OWNER_HOME" ] || die "The checkout owner (uid $OWNER_UID) has no account entry."
if [ "$OWNER_UID" != 0 ]; then
  id -nG "$OWNER" | tr ' ' '\n' | grep -qx docker || die "The checkout owner $OWNER is not in the docker group. Add them yourself if that is intended (it is root-equivalent), or move the checkout to an account that is."
fi
for value in "$ROOT" "$DOCKER_ROOT" "$OWNER_HOME"; do
  case "$value" in *[!A-Za-z0-9._/-]*) die "Unsupported characters in path $value." ;; esac
done
[ "$(as_owner docker ps -q --filter "label=com.docker.compose.project=$PROJECT" --filter label=com.docker.compose.service=api | wc -l)" = 1 ] ||
  die 'Expected exactly one running DockNest api container (one install per host). Start it with: docker compose up -d'
VOLUME_INFO=$(docker volume inspect "$VOLUME" --format '{{.Driver}} {{len .Options}} {{.Mountpoint}}' 2>/dev/null) ||
  die "The $VOLUME volume does not exist. Upgrade to DockNest 2.2.0 or later and run: docker compose up -d"
set -- $VOLUME_INFO
[ "$1" = local ] && [ "$2" = 0 ] && [ $# = 3 ] || die "$VOLUME must use the local driver without options."
VOLUME_DIR=$3
case "$VOLUME_DIR" in "$DOCKER_ROOT"/volumes/"$VOLUME"/_data) ;; *) die "Unexpected mount point for $VOLUME: $VOLUME_DIR" ;; esac
[ "$MODE" = install ] || run_idle

# ------------------------------------------------------------------ accounts, directories, cosign, code
getent passwd "$VERIFY" >/dev/null || useradd --system --user-group --home-dir "$STATE/verify-home" --no-create-home --shell /usr/sbin/nologin "$VERIFY"
id -nG "$VERIFY" | tr ' ' '\n' | grep -qx docker && die "$VERIFY must not be in the docker group."
install -d -m 0755 -o root -g root "$ETC" "$STATE" "$LIB" "$LIB/bin"
install -d -m 0700 -o root -g root "$STATE/history"
# A group for the api container's GID, so the socket unit can name it (an existing group of that GID is used as is).
API_GROUP=$(getent group "$API_GID" | cut -d: -f1)
if [ -z "$API_GROUP" ]; then
  getent group "$API_GROUP_NAME" >/dev/null && die "The group $API_GROUP_NAME exists with a GID other than $API_GID; remove or renumber it, then run this again."
  command -v groupadd >/dev/null 2>&1 || die "No group has GID $API_GID and groupadd is missing; create a group with GID $API_GID, then run this again."
  groupadd --system --gid "$API_GID" "$API_GROUP_NAME" || die "Could not create the system group $API_GROUP_NAME with GID $API_GID (the api container's group); create a group with that GID, then run this again."
  echo "$API_GROUP_NAME" > "$API_GROUP_MARK"
  API_GROUP=$API_GROUP_NAME
fi
case "$API_GROUP" in ''|*[!A-Za-z0-9._-]*) die "Unsupported group name for GID $API_GID: $API_GROUP" ;; esac
install -d -m 0755 -o "$VERIFY" -g "$VERIFY" "$STATE/mirror.git"
install -d -m 0700 -o "$VERIFY" -g "$VERIFY" "$STATE/sigstore" "$STATE/verify-home"
[ -f "$STATE/mirror.git/HEAD" ] || setpriv --reuid="$VERIFY" --regid="$VERIFY" --init-groups --inh-caps=-all --reset-env -- \
  env -i PATH="$PATH" HOME="$STATE/verify-home" GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null git init --quiet --bare "$STATE/mirror.git"
case "$(uname -m)" in x86_64) ARCH=amd64 SUM=$COSIGN_SHA256_AMD64 ;; aarch64) ARCH=arm64 SUM=$COSIGN_SHA256_ARM64 ;; *) die "Unsupported architecture $(uname -m)." ;; esac
if [ "$(sha256sum "$LIB/bin/cosign" 2>/dev/null | cut -d' ' -f1)" != "$SUM" ]; then
  TMP=$(mktemp "$LIB/bin/.cosign.XXXXXX")
  curl -fsSL --proto '=https' --max-time 300 -o "$TMP" "https://github.com/sigstore/cosign/releases/download/$COSIGN_VERSION/cosign-linux-$ARCH" || { rm -f "$TMP"; die 'Could not download cosign.'; }
  [ "$(sha256sum "$TMP" | cut -d' ' -f1)" = "$SUM" ] || { rm -f "$TMP"; die "cosign $COSIGN_VERSION does not match its pinned SHA-256; nothing was installed."; }
  chmod 0755 "$TMP"; mv -f "$TMP" "$LIB/bin/cosign"
fi
VERSION=$(python3 -I -B "$ROOT/updater/broker.py" version)
case "$VERSION" in [0-9]*.[0-9]*.[0-9]*) ;; *) die 'updater/broker.py did not report a version.' ;; esac
install -d -m 0755 -o root -g root "$LIB/$VERSION"
install -m 0644 -o root -g root "$ROOT/updater/broker.py" "$LIB/$VERSION/broker.py"
ln -sfn "$VERSION" "$LIB/.current" && mv -fT "$LIB/.current" "$LIB/current"
python3 -I -c 'import json,sys;k=["checkout","ownerUid","ownerGid","ownerHome","volume","dockerRoot","apiUid"];v=sys.argv[1:];v[1:3]=map(int,v[1:3]);v[6]=int(v[6]);sys.stdout.write(json.dumps(dict(zip(k,v)),indent=2)+"\n")' \
  "$ROOT" "$OWNER_UID" "$OWNER_GID" "$OWNER_HOME" "$VOLUME_DIR" "$DOCKER_ROOT" "$API_UID" > "$ETC/.config.json"
chmod 0644 "$ETC/.config.json"; mv -f "$ETC/.config.json" "$ETC/config.json"

# ------------------------------------------------------------------ units, work directory, status directory
RENDER=$(mktemp -d)
trap 'rm -rf "$RENDER"' EXIT
for unit in socket service tmpfiles; do
  sed -e "s|@VOLUME@|$VOLUME_DIR|g" -e "s|@DOCKER_ROOT@|$DOCKER_ROOT|g" -e "s|@CHECKOUT@|$ROOT|g" -e "s|@OWNER_HOME@|$OWNER_HOME|g" \
      -e "s|@OWNER@|$OWNER|g" -e "s|@GROUP@|$GROUP|g" -e "s|@API_GROUP@|$API_GROUP|g" "$ROOT/updater/docknest-updater.$unit.in" > "$RENDER/docknest-updater.$unit"
done
systemd-analyze verify "$RENDER/docknest-updater.socket" "$RENDER/docknest-updater.service" || die 'The rendered units did not pass systemd-analyze verify.'
install -m 0644 "$RENDER/docknest-updater.tmpfiles" "$TMPFILES"
systemd-tmpfiles --create "$TMPFILES"
install -d -m 0755 -o root -g root "$VOLUME_DIR/status"
as_owner mkdir -p "$OWNER_HOME/.docker" 2>/dev/null || true  # made by the owner, so the sandboxed run step can use it
broker self-test >/dev/null || die 'The broker self-test failed (see above).'
systemctl stop docknest-updater.service 2>/dev/null || true
install -m 0644 "$RENDER/docknest-updater.socket" "$RENDER/docknest-updater.service" "$UNITS/"
systemctl daemon-reload

# ------------------------------------------------------------------ verify the installed release, then start
# First install, and a repair whose installed release has no pin yet: verify it and record its commit (and image digest).
CURRENT=$(as_owner git -c "safe.directory=$ROOT" show HEAD:package.json | sed -n 's/^ *"version": *"\([^"]*\)".*/\1/p' | head -n 1)
if [ "$MODE" = install ] || ! grep -q "\"v$CURRENT\"" "$STATE/pins.json" 2>/dev/null; then
  echo 'Verifying the installed release (signed manifest, tag on main, image digest in image mode)...'
  if ! broker record-current; then
    [ "$MODE" = repair ] || { rm -f "$UNITS/docknest-updater.socket" "$UNITS/docknest-updater.service" "$TMPFILES"; rm -rf "$ETC"; systemctl daemon-reload; die 'The installed release could not be verified; the host updater was not enabled.'; }
    echo "WARNING: v$CURRENT could not be verified; in-app updates are refused (state-mismatch) until --repair verifies it." >&2
  fi
fi
broker publish-service
systemctl enable docknest-updater.socket >/dev/null 2>&1
systemctl restart docknest-updater.socket
if [ "$MODE" = repair ] && broker status | grep -q '^Blocked: no'; then close_requests; fi
echo "DockNest host updater $VERSION is $( [ "$MODE" = repair ] && echo repaired || echo installed ) for $ROOT (run step as $OWNER)."
broker status
