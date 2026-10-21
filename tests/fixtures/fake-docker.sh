#!/bin/sh
# Test double for `docker compose` used by tests/upgrade-script.test.js. State lives in $FAKE_STATE.
# Image mode ("image-mode" file): the running version comes from $DOCKNEST_IMAGE (environment first, then ./.env),
# either name:tag or a recorded image id sha256:fakeid-<version>.
set -eu
S=$FAKE_STATE
echo "$* IMG=${DOCKNEST_IMAGE:-}" >> "$S/calls"
[ "$1" = compose ] || exit 1
shift
read_state() { cat "$S/$1" 2>/dev/null || echo "${2:-}"; }
image_ref() { echo "${DOCKNEST_IMAGE:-$(sed -n 's/^DOCKNEST_IMAGE=//p' .env 2>/dev/null | tail -n 1)}"; }
case "$1" in
  version) echo 'Docker Compose version v2.30.0' ;;
  config)
    case "$*" in *--quiet*) ;; *--images*) image_ref ;; *) [ -e "$S/image-mode" ] || echo '    context: /srv/docknest' ;; esac ;;
  images) echo "sha256:fakeid-$(read_state version)" ;;
  ps) [ "$(read_state running)" = up ] && printf 'api\nworker\n' ;;
  build|pull) [ -e "$S/fail-build" ] && exit 1; [ -e "$S/fail-build-once" ] && { rm "$S/fail-build-once"; exit 1; }; exit 0 ;;
  stop) [ -e "$S/migrate-on-stop" ] && echo 2 > "$S/schema"; [ -e "$S/fail-stop" ] && exit 1; echo down > "$S/running" ;;
  logs) echo 'fake logs' ;;
  up)
    if [ -e "$S/image-mode" ]; then
      ref=$(image_ref)
      case "$ref" in sha256:fakeid-*) version=${ref#sha256:fakeid-} ;; *) version=${ref##*:} ;; esac
    else version=$(sed -n 's/^ *"version": *"\([^"]*\)".*/\1/p' package.json | head -n 1); fi
    echo "$version" > "$S/version"; echo up > "$S/running"
    schema=$(sed -n 's/^ *{ *version: *\([0-9][0-9]*\),.*/\1/p' src/migrations.js 2>/dev/null | tail -n 1)
    [ -n "$schema" ] && [ "$schema" -gt "$(read_state schema 0)" ] && [ ! -e "$S/no-migrate" ] && echo "$schema" > "$S/schema"
    exit 0 ;;
  exec)
    shift; [ "$1" = -T ] && shift; service=$1; shift
    [ "$(read_state running)" = up ] || exit 1
    case "$*" in
      *deployment-preflight.js\ hold*) [ -e "$S/busy" ] && exit 1; echo true > "$S/hold" ;;
      *deployment-preflight.js\ release*) echo false > "$S/hold" ;;
      test\ -f*) exit 1 ;;
      node\ -e*) running=$(read_state version); want=$(eval "printf '%s' \"\${$#}\""); [ "$want" = legacy ] && want=2.0.0; [ "$running" = "$want" ] && [ "$(read_state unhealthy)" != "$running" ] ;;
      *) exit 1 ;;
    esac ;;
  run)
    case "$*" in
      *--entrypoint\ node*) read_state schema 0 ;;
      *ls\ /data/upgrade-snapshots*) read_state snapshots ;;
      *state.sqlite.restoring*) echo "restored ${*##* }" >> "$S/restores" ;;
      *) exit 1 ;;
    esac ;;
  *) exit 1 ;;
esac
