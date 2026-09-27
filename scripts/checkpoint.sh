#!/usr/bin/env bash
set -uo pipefail
# Commits + pushes CHECKPOINT_PATHS (default "logs" — i.e. logs/decisions.jsonl,
# this bot's journal) so trade history survives Render's ephemeral disk across
# redeploys. Safe to call repeatedly, including from a burst of trades:
#
# - logs/decisions.jsonl is append-only, so .gitattributes marks it
#   `merge=union` — git's built-in union merge driver keeps every unique
#   line from both sides on conflict instead of picking one side and
#   discarding the other's newly-appended records.
# - Any other file under CHECKPOINT_PATHS is treated with -X ours on
#   conflict, i.e. "the freshest local version wins" — fine for anything
#   that's a recomputed snapshot rather than an append-only log.
#
# Exits 0 on genuine no-op (nothing to commit) or when GITHUB_REPO/
# GITHUB_TOKEN aren't set (opt-in feature, silent no-op without keys).
# Non-zero + stderr on any real failure; checkpoint.ts captures both and
# never treats a failure as fatal to the caller.

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT" || { echo "checkpoint: couldn't cd to repo root $REPO_ROOT"; exit 1; }

BRANCH="${CHECKPOINT_BRANCH:-main}"
PATHS="${CHECKPOINT_PATHS:-logs}"
MAX_PUSH_RETRIES=3

# Required on Render — deploy images have no git identity, so commit fails
# with "Author identity unknown" without this.
git config user.email "${GIT_AUTHOR_EMAIL:-checkpoint@binal-bot.local}"
git config user.name "${GIT_AUTHOR_NAME:-binal-bot}"

# Requires two Render env vars on this service:
#   GITHUB_REPO   e.g. "yourusername/dreamdex-bot-kit"
#   GITHUB_TOKEN  a GitHub PAT with at least read+write access to that repo
if [ -n "${GITHUB_REPO:-}" ] && [ -n "${GITHUB_TOKEN:-}" ]; then
  git remote remove origin 2>/dev/null || true
  git remote add origin "https://x-access-token:${GITHUB_TOKEN}@github.com/${GITHUB_REPO}.git"
else
  echo "checkpoint: GITHUB_REPO/GITHUB_TOKEN not set — skipping"
  exit 0
fi

# Render's deploy checkout is often a detached HEAD — that's normal, not an
# error. We just need a real branch ref to push against.
CURRENT_REF="$(git symbolic-ref --short -q HEAD || true)"
if [ -z "$CURRENT_REF" ]; then
  echo "checkpoint: detached HEAD detected (normal on Render's deploy checkout) — targeting '$BRANCH' instead"
fi

# shellcheck disable=SC2086
git add $PATHS || { echo "checkpoint: git add failed"; exit 1; }

if git diff --cached --quiet; then
  echo "checkpoint: nothing to commit"
  exit 0
fi

COMMIT_MSG="checkpoint: $(date -u +'%Y-%m-%dT%H:%M:%SZ')"
if ! git commit -m "$COMMIT_MSG" >/dev/null 2>&1; then
  echo "checkpoint: git commit failed"
  git commit -m "$COMMIT_MSG" 2>&1 || true
  exit 1
fi

attempt=0
while [ "$attempt" -lt "$MAX_PUSH_RETRIES" ]; do
  attempt=$((attempt + 1))

  if ! git fetch origin "$BRANCH" 2>&1; then
    echo "checkpoint: git fetch origin $BRANCH failed on attempt $attempt"
    sleep $((attempt * 2))
    continue
  fi

  # Merge remote into our detached/local commit. .gitattributes' union
  # driver handles decisions.jsonl conflicts by keeping both sides' lines;
  # -X ours is the fallback ONLY for files without a merge= attribute.
  # --allow-unrelated-histories is a safety net: restore-and-start.sh's boot
  # logic is responsible for giving this branch shared ancestry with origin
  # up front, so this flag should normally be a no-op. It's here only so
  # that if that boot-time step is ever skipped or fails silently, a
  # checkpoint still succeeds (with an honest merge of two real histories)
  # instead of hard-failing with "refusing to merge unrelated histories".
  if git merge --no-edit --allow-unrelated-histories -X ours "origin/$BRANCH" 2>&1; then
    : # merged cleanly (or via union driver) — fall through to push
  else
    echo "checkpoint: merge with origin/$BRANCH had unresolved conflicts outside tracked paths — aborting merge, will retry"
    git merge --abort 2>/dev/null || true
    sleep $((attempt * 2))
    continue
  fi

  if git push origin "HEAD:$BRANCH" 2>&1; then
    echo "checkpoint: pushed to $BRANCH (attempt $attempt)"
    exit 0
  else
    echo "checkpoint: push rejected on attempt $attempt — likely a concurrent checkpoint from another service, retrying"
    sleep $((attempt * 2))
  fi
done

echo "checkpoint: failed after $MAX_PUSH_RETRIES attempts — commit is safe locally on this instance's disk, will retry next trade"
exit 1