#!/usr/bin/env bash
# Pushes the (already encrypted) backup to a PRIVATE GitHub repository (Ultraplan Phase 4; BAK-03, D-04).
#
#   BACKUP_OUT_DIR       where backup.sh wrote (default ./backup-out)
#   BACKUP_GIT_URL       e.g. git@github.com:Bobike123/Reqon-backups.git (a file:// path works for tests)
#   BACKUP_GIT_SSH_KEY   path to the repository's deploy key (write access to THAT repository only)
#   BACKUP_GIT_KEEP      how many weekly files to keep (default 26)
#   BACKUP_GIT_KNOWN_HOSTS  path to a known_hosts file (the workflow builds it from api.github.com/meta)
#
# Only ciphertext is ever committed. The history is not rewritten: a pruned file leaves older commits,
# which is acceptable for ciphertext and keeps the push a plain fast-forward.
# shellcheck source=ops/backup/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

OUT="${BACKUP_OUT_DIR:-./backup-out}"
URL="${BACKUP_GIT_URL:?BACKUP_GIT_URL is not set}"
KEEP="${BACKUP_GIT_KEEP:-26}"
need git
shopt -s nullglob
files=("$OUT"/reqon-backup-*.tar.age)
[ "${#files[@]}" -eq 1 ] || die "expected exactly one backup file in $OUT, found ${#files[@]}" 2
FILE="${files[0]}"; NAME="$(basename "$FILE")"; META="${FILE%.tar.age}.meta.json"

if [ -n "${BACKUP_GIT_SSH_KEY:-}" ]; then
  [ -n "${BACKUP_GIT_KNOWN_HOSTS:-}" ] || die "BACKUP_GIT_KNOWN_HOSTS is needed with a deploy key (no blind host trust)" 2
  export GIT_SSH_COMMAND="ssh -i $BACKUP_GIT_SSH_KEY -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=$BACKUP_GIT_KNOWN_HOSTS"
fi

WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
git clone --quiet "$URL" "$WORK/repo" 2>/dev/null || die "cannot clone the backup repository" 5
cd "$WORK/repo"
# Continue the existing history; only the very first push starts a new branch.
if git ls-remote --exit-code --heads origin main >/dev/null 2>&1; then
  git checkout --quiet -B main origin/main
else
  git checkout --quiet -B main
fi
mkdir -p weekly
cp "$FILE" "weekly/$NAME"; cp "$META" "weekly/${NAME%.tar.age}.meta.json"

# Keep the newest $KEEP weekly files (names sort by time).
mapfile -t ALL < <(ls weekly/reqon-backup-*.tar.age | sort)
if [ "${#ALL[@]}" -gt "$KEEP" ]; then
  for old in "${ALL[@]:0:${#ALL[@]}-KEEP}"; do git rm --quiet -f -- "$old" "${old%.tar.age}.meta.json"; done
fi

git add weekly
git -c user.name="reqon-backup" -c user.email="backup@users.noreply.github.com" commit --quiet -m "weekly backup ${NAME%.tar.age}" || die "nothing to commit" 5
git push --quiet origin main || die "push to the backup repository failed" 5
log "pushed weekly/$NAME ($(ls weekly/reqon-backup-*.tar.age | wc -l) weekly file(s) kept)"
