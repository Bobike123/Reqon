# shellcheck shell=bash
# Shared helpers for the backup scripts (Ultraplan Phase 4). Sourced, never run.
#
# Rules every script follows (BAK-07):
#   * `set -euo pipefail`, never `set -x` (it would print secrets into a public log);
#   * output is counts, sizes and file names only — never a row, a key or a connection string;
#   * secrets arrive in environment variables and are never put on a command line (visible in `ps`):
#     the database login uses the standard PG* variables, HTTP secrets go through `curl -H @-`.
set -euo pipefail
umask 077

# shellcheck disable=SC2034  # used by the scripts that source this file
BACKUP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

log() { echo "backup: $*"; }
# die <message> [exit code]   — 2 config/usage, 3 size guard, 4 consistency, 5 tool failure
die() { echo "backup: ERROR: $1" >&2; exit "${2:-1}"; }
need() { command -v "$1" >/dev/null 2>&1 || die "the tool '$1' is not installed" 2; }

# 16 hex characters identifying an age public key (shown in the status panel; not secret).
fingerprint() { printf '%s' "$1" | sha256sum | cut -c1-16; }

# Overwrite then remove a plaintext file; plain rm where shred is unavailable.
wipe() {
  local f
  for f in "$@"; do
    [ -e "$f" ] || continue
    if command -v shred >/dev/null 2>&1; then shred -u -- "$f" 2>/dev/null || rm -f -- "$f"; else rm -f -- "$f"; fi
  done
}

# Run a PostgreSQL client tool with the PG* environment. BACKUP_PG_DOCKER_IMAGE (e.g. postgres:17) runs
# it in a container instead — for a machine without client tools. stdin/stdout pass through.
pgrun() {
  local tool="$1"; shift
  # Only warnings and errors from the server: PL/pgSQL's "already exists, skipping" notices are noise.
  export PGOPTIONS="${PGOPTIONS:--c client_min_messages=warning}"
  if [ -n "${BACKUP_PG_DOCKER_IMAGE:-}" ]; then
    docker run --rm -i --network host -e PGHOST -e PGPORT -e PGUSER -e PGPASSWORD -e PGDATABASE -e PGSSLMODE -e PGOPTIONS \
      "$BACKUP_PG_DOCKER_IMAGE" "$tool" "$@"
  else
    "$tool" "$@"
  fi
}

# The valid age recipients in a recipients file (comments and blank lines ignored). Fails on anything else,
# so a typo can never silently produce a backup nobody can read.
read_recipients() {
  local file="$1" line n=0
  [ -r "$file" ] || die "recipients file not found: $file" 2
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%%#*}"; line="${line//[[:space:]]/}"
    [ -z "$line" ] && continue
    [[ "$line" =~ ^age1[0-9a-z]{58}$ ]] || die "recipients file has a line that is not an age public key (age1…)" 2
    echo "$line"; n=$((n + 1))
  done < "$file"
  [ "$n" -ge 1 ] || die "recipients file lists nobody — a backup nobody can read is not a backup" 2
}
