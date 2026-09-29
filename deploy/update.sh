#!/bin/sh
# Runs on the server every 5 minutes (cron, see aws.yml): rebuilds and
# restarts when the deployed branch has new commits.
set -eu
cd "$(dirname "$0")/.."
git fetch -q
[ "$(git rev-parse HEAD)" = "$(git rev-parse '@{u}')" ] && exit 0
git merge -q --ff-only '@{u}'
docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d --build
docker image prune -f
