#!/bin/bash
set -e

if [ -z "$GITHUB_TOKEN" ]; then
  echo "❌  GITHUB_TOKEN secret is not set. Add it in the Secrets tab first."
  exit 1
fi

REMOTE="https://punjabone12345:${GITHUB_TOKEN}@github.com/punjabone12345/MemecoinTrading.git"

echo "🔧  Setting authenticated remote..."
git remote set-url origin "$REMOTE"

echo "⬇️   Fetching latest from GitHub..."
git fetch origin main

echo "🔀  Merging GitHub's commits into this branch..."
git merge origin/main --no-edit --strategy-option=ours

echo "⬆️   Pushing merged history to GitHub..."
git push origin main

echo "🔒  Restoring clean remote URL..."
git remote set-url origin "https://github.com/punjabone12345/MemecoinTrading.git"

echo ""
echo "✅  Done! Both sets of commits are now on GitHub."
echo "    Your local code is kept as-is (this Replit's version wins on any conflicts)."
