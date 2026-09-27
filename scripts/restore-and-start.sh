#!/usr/bin/env bash
# Render Start Command: bash scripts/restore-and-start.sh
set -euo pipefail

echo "[boot] fetching latest committed data/ from git..."

BRANCH="${CHECKPOINT_BRANCH:-${GIT_BRANCH:-main}}"
PATHS="${CHECKPOINT_PATHS:-data}"

if [ ! -d .git ]; then
  if [ -n "${GITHUB_REPO:-}" ] && [ -n "${GITHUB_TOKEN:-}" ]; then
    echo "[boot] no .git at runtime — initializing"
    git init -q
  else
    echo "[boot] no .git at runtime and GITHUB_REPO/GITHUB_TOKEN not set — skipping restore"
  fi
fi

if [ -d .git ]; then
  if ! git remote get-url origin >/dev/null 2>&1; then
    if [ -n "${GITHUB_REPO:-}" ] && [ -n "${GITHUB_TOKEN:-}" ]; then
      echo "[boot] origin remote missing — reconstructing from GITHUB_REPO/GITHUB_TOKEN"
      git remote add origin "https://x-access-token:${GITHUB_TOKEN}@github.com/${GITHUB_REPO}.git"
    else
      echo "[boot] origin remote missing and GITHUB_REPO/GITHUB_TOKEN not set — skipping restore"
    fi
  fi

  if git remote get-url origin >/dev/null 2>&1; then
    git fetch origin "$BRANCH" --quiet || echo "[boot] git fetch failed, continuing with what's on disk"

    if ! git rev-parse --verify -q HEAD >/dev/null; then
      if git rev-parse --verify -q "origin/$BRANCH" >/dev/null; then
        echo "[boot] no local commits yet — adopting origin/$BRANCH as history"
        git symbolic-ref HEAD "refs/heads/$BRANCH"
        git reset "origin/$BRANCH" >/dev/null
      else
        echo "[boot] no local commits and no origin/$BRANCH yet (first run) — leaving history empty"
      fi
    fi

    # shellcheck disable=SC2086
    git checkout "origin/$BRANCH" -- $PATHS 2>/dev/null \
      && echo "[boot] restored $PATHS from origin" \
      || echo "[boot] no $PATHS on origin yet (first run) or checkout failed, continuing with local $PATHS"
  fi
else
  echo "[boot] skipping restore"
fi

echo "[boot] starting copy service..."
exec node local-server.mjs