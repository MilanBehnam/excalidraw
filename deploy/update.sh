#!/bin/sh
# Runs on the server every 5 minutes (cron, see aws.yml): pulls the deployed
# branch and rebuilds until its latest commit is up (a failed build is retried).
set -eu
cd "$(dirname "$0")/.."
git fetch -q
git merge -q --ff-only '@{u}'
[ "$(git rev-parse HEAD)" = "$(cat deploy/.deployed 2>/dev/null)" ] && exit 0
docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d --build
git rev-parse HEAD > deploy/.deployed
docker image prune -f
