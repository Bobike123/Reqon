#!/usr/bin/env bash
# Fails when the newest daily backup in R2 is older than BACKUP_MAX_AGE_HOURS (default 48) — Ultraplan
# Phase 4; BAK-08. A failing run emails the repository owners (GitHub's default for failed workflows).
#
#   BACKUP_R2_REMOTE   rclone remote:bucket of the backups bucket
# NOTE: GitHub disables scheduled workflows after 60 days without repository activity, and that takes this
# check down together with the backup. The independent signal is the app itself: Settings → Backups turns
# red when the newest backup it knows is older than 48 hours (src/backups/status.ts).
# shellcheck source=ops/backup/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

REMOTE="${BACKUP_R2_REMOTE:?BACKUP_R2_REMOTE is not set}"
MAX="${BACKUP_MAX_AGE_HOURS:-48}"
need rclone; need node
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
rclone lsjson --files-only "$REMOTE/daily" > "$WORK/list.json" || die "cannot list the backups bucket" 5
AGE="$(node "$BACKUP_DIR/json.mjs" age-hours "$WORK/list.json" "${BACKUP_NOW:-}")"
[ "$AGE" != "none" ] || die "there is no backup in $REMOTE/daily at all" 1
log "newest daily backup is $AGE hours old (limit $MAX)"
node -e 'process.exit(Number(process.argv[1]) > Number(process.argv[2]) ? 1 : 0)' "$AGE" "$MAX" || die "the newest backup is older than $MAX hours" 1
