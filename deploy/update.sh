#!/bin/sh
# Runs on the server every 5 minutes (cron, see aws.yml): pulls the deployed
# branch and switches to the images GitHub Actions built for its latest
# commit. Until they're published the pull fails and the next run retries.
set -eu
cd "$(dirname "$0")/.."
git fetch -q
git merge -q --ff-only '@{u}'
commit=$(git rev-parse HEAD)
[ "$commit" = "$(cat deploy/.deployed 2>/dev/null)" ] && exit 0
export IMAGE_TAG="$commit"
compose="docker compose -f deploy/docker-compose.yml --env-file deploy/.env"
$compose pull --quiet app backend
$compose up -d
echo "$commit" > deploy/.deployed
docker image prune -af --filter until=72h
