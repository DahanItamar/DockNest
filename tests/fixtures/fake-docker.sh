#!/bin/sh
# Test double for `docker compose` (plus `docker image inspect|rm` and `docker tag`) used by tests/upgrade-script.test.js.
# State lives in $FAKE_STATE. Images: "store" lists "<id> <version>" with id = sha256 of the version (fake_id), "tags"
# lists "<ref> <id>" and "digests" "<name@sha256:...> <id>". Source mode runs the version docknest:local points to (or
# package.json before anything was built); image mode ("image-mode" file) runs $DOCKNEST_IMAGE (environment first, then
# ./.env), either name:tag[@sha256:...] or an image id. `docker build -t NAME -` (the --expect-commit source build) reads
# the tar context from stdin, lists it in "context" and tags the package.json version it contains. "label" overrides the
# org.opencontainers.image.version label, which is otherwise the image's version. "labelled" lists the IDs that carry the
# DockNest label; "in-use" lists image IDs that other (stopped) containers use, as `docker ps -a` and `docker inspect`
# report them (api and worker, while up, run the running version). `docker image rm REF` removes only that tag and
# deletes the image with its last one.
set -eu
S=$FAKE_STATE
echo "$* IMG=${DOCKNEST_IMAGE:-}" >> "$S/calls"
read_state() { cat "$S/$1" 2>/dev/null || echo "${2:-}"; }
image_ref() { echo "${DOCKNEST_IMAGE:-$(sed -n 's/^DOCKNEST_IMAGE=//p' .env 2>/dev/null | tail -n 1)}"; }
fake_id() { printf 'sha256:%s' "$(printf '%s' "$1" | sha256sum | cut -c1-64)"; }
ensure() { id=$(fake_id "$1"); awk -v i="$id" '$1==i{f=1}END{exit !f}' "$S/store" 2>/dev/null || echo "$id $1" >> "$S/store"; echo "$id"; }
version_of() { awk -v i="$1" '$1==i{print $2; exit}' "$S/store" 2>/dev/null; }
resolve() { case "$1" in sha256:*) awk -v i="$1" '$1==i{print $1; exit}' "$S/store" 2>/dev/null ;; *) cat "$S/tags" "$S/digests" 2>/dev/null | awk -v r="$1" '$1==r{print $2}' | tail -n 1 ;; esac; }
retag() { { awk -v r="$1" '$1!=r' "$S/tags" 2>/dev/null || true; echo "$1 $2"; } > "$S/tags.new"; mv "$S/tags.new" "$S/tags"; }
pkg_version() { sed -n 's/^ *"version": *"\([^"]*\)".*/\1/p' package.json | head -n 1; }
running_version() { read_state version; }
case "$1" in
  image)
    shift; op=$1; shift
    case "$op" in
      ls)
        [ -e "$S/fail-ls" ] && exit 1
        case "$*" in
          *dangling=true*) for id in $(awk '{print $1}' "$S/store" 2>/dev/null); do
              awk -v i="$id" '$2==i{f=1}END{exit f}' "$S/tags" 2>/dev/null && grep -qx "$id" "$S/labelled" 2>/dev/null && echo "$id"; done; true ;;
          *--format*) repo=$(eval "printf '%s' \"\${$#}\""); awk -v r="$repo" '{ref=$1; sub(/:[^:\/]*$/, "", ref); if (ref==r) print $2}' "$S/tags" 2>/dev/null || true ;;
          *) awk '{print $1}' "$S/store" 2>/dev/null || true ;;
        esac ;;
      inspect)
        format=$2; shift 2; [ "${1:-}" = -- ] && shift
        id=$(resolve "$1"); [ -n "$id" ] || exit 1
        case "$format" in
          *RepoTags*) awk -v i="$id" '$2==i{print $1}' "$S/tags" "$S/digests" 2>/dev/null || true ;;
          *RepoDigests*) awk -v i="$id" '$2==i{print $1}' "$S/digests" 2>/dev/null || true ;;
          *Labels*) read_state label "$(version_of "$id")" ;;
          *) echo "$id" ;;
        esac ;;
      rm)
        case "$*" in *-f*|*--force*) echo "forced removal $*" >> "$S/forced"; exit 1 ;; esac
        id=$1
        [ -e "$S/fail-rm" ] && exit 1
        [ -n "$(resolve "$id")" ] || exit 1
        case "$id" in sha256:*) ;; *)
          ref=$id id=$(resolve "$ref")
          if [ "$(awk -v i="$id" '$2==i' "$S/tags" 2>/dev/null | wc -l)" -gt 1 ]; then
            awk -v r="$ref" '$1!=r' "$S/tags" > "$S/tags.new"; mv "$S/tags.new" "$S/tags"; echo "$ref" >> "$S/untagged"; exit 0
          fi ;;
        esac
        [ "$(read_state running)" = up ] && [ "$id" = "$(fake_id "$(running_version)")" ] && exit 1
        [ -e "$S/in-use" ] && grep -qx "$id" "$S/in-use" && exit 1
        [ "$(awk -v i="$id" '$2==i' "$S/tags" "$S/digests" 2>/dev/null | wc -l)" -gt 1 ] && exit 1
        awk -v i="$id" '$1!=i' "$S/store" > "$S/store.new"; mv "$S/store.new" "$S/store"
        { awk -v i="$id" '$2!=i' "$S/tags" 2>/dev/null || true; } > "$S/tags.new"; mv "$S/tags.new" "$S/tags"
        echo "$id" >> "$S/removed" ;;
      *) exit 1 ;;
    esac
    exit 0 ;;
  tag) id=$(resolve "$2"); [ -n "$id" ] || exit 1; retag "$3" "$id"; exit 0 ;;
  ps) [ -e "$S/fail-ps" ] && exit 1; [ "$(read_state running)" = up ] && printf 'c-api\nc-worker\n'; sed 's/^/u-/' "$S/in-use" 2>/dev/null || true; exit 0 ;;
  inspect)
    shift 3
    for c in "$@"; do case "$c" in c-api|c-worker) fake_id "$(running_version)"; echo ;; u-*) echo "${c#u-}" ;; *) exit 1 ;; esac; done
    exit 0 ;;
  build)
    [ -e "$S/fail-build" ] && exit 1
    rm -rf "$S/ctx"; mkdir "$S/ctx"; (cd "$S/ctx" && tar -xf -); ls -A "$S/ctx" > "$S/context"
    retag "$3" "$(ensure "$(sed -n 's/^ *"version": *"\([^"]*\)".*/\1/p' "$S/ctx/package.json" | head -n 1)")"; exit 0 ;;
  compose) shift ;;
  *) exit 1 ;;
esac
case "$1" in
  version) echo 'Docker Compose version v2.30.0' ;;
  config)
    case "$*" in
      *--quiet*) ;;
      *--images*) if [ -e "$S/image-mode" ]; then image_ref; image_ref; else printf 'docknest:local\ndocknest:local\n'; fi ;;
      *) [ -e "$S/image-mode" ] || echo '    context: /srv/docknest' ;;
    esac ;;
  images) [ -e "$S/no-images" ] || ensure "$(running_version)" ;;
  ps) [ "$(read_state running)" = up ] && printf 'api\nworker\n' ;;
  build|pull)
    [ -e "$S/fail-build" ] && exit 1; [ -e "$S/fail-build-once" ] && { rm "$S/fail-build-once"; exit 1; }
    if [ "$1" = build ]; then retag docknest:local "$(ensure "$(pkg_version)")"; else ref=$DOCKNEST_IMAGE base=${DOCKNEST_IMAGE%%@*}; id=$(ensure "${base##*:}"); retag "$ref" "$id"; case "$ref" in *@*) echo "${base%:*}@${ref#*@} $id" >> "$S/digests" ;; esac; fi
    exit 0 ;;
  stop) [ -e "$S/migrate-on-stop" ] && echo 2 > "$S/schema"; [ -e "$S/fail-stop" ] && exit 1; echo down > "$S/running" ;;
  logs) echo 'fake logs' ;;
  up)
    if [ -e "$S/image-mode" ]; then
      ref=$(image_ref)
      case "$ref" in sha256:*) version=$(version_of "$ref") ;; *) ref=${ref%%@*}; version=${ref##*:} ;; esac
    else
      tagged=$(resolve docknest:local)
      if [ -n "$tagged" ]; then version=$(version_of "$tagged"); else version=$(pkg_version); fi
    fi
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
      test\ -f\ scripts/prune-upgrade-artifacts.js) [ -e "$S/has-prune" ] ;;
      *prune-upgrade-artifacts.js*)
        : > "$S/in-cleanup"
        [ -e "$S/hang-prune" ] && sleep "$(read_state hang-prune)" </dev/null >/dev/null 2>&1
        [ -e "$S/fail-prune" ] && { echo 'Could not remove upgrade-snapshots/pre-rollback-1' >&2; exit 1; }
        echo 'Removed upgrade-snapshots/pre-rollback-1' ;;
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
