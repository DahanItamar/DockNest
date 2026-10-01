#!/bin/sh
set -eu
ssh-keygen -A >/dev/null 2>&1
dockerd-entrypoint.sh >/tmp/dockerd.log 2>&1 &
exec /usr/sbin/sshd -D -e
