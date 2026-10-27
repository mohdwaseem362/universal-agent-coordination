#!/usr/bin/env bash
set -euo pipefail

# Helper script to initialize Git and push Universal Agent Coordination to GitHub
# Usage: bash scripts/publish-to-github.sh https://github.com/<your-username>/universal-agent-coordination.git

REMOTE_URL="${1:-}"

if [ -z "$REMOTE_URL" ]; then
  echo "Usage: bash scripts/publish-to-github.sh <github-repo-url>"
  echo "Example: bash scripts/publish-to-github.sh https://github.com/your-username/universal-agent-coordination.git"
  exit 1
fi

echo "==> 1. Running automated test suite before Git commit..."
npm test

echo "==> 2. Cleaning any local runtime state (.uac/)..."
rm -rf .uac

echo "==> 3. Initializing Git repository on branch 'main'..."
if [ ! -d ".git" ]; then
  git init -b main
else
  git branch -M main
fi

echo "==> 4. Staging all repository files..."
git add .

if git diff --cached --quiet; then
  echo "==> No new changes to commit."
else
  git commit -m "feat: initial release of Universal Agent Coordination (@followprotocol) v1.0.0"
fi

echo "==> 5. Configuring remote 'origin' -> $REMOTE_URL"
if git remote get-url origin >/dev/null 2>&1; then
  git remote set-url origin "$REMOTE_URL"
else
  git remote add origin "$REMOTE_URL"
fi

echo "==> 6. Pushing to GitHub (origin main)..."
git push -u origin main

echo "==> Done! Your repository is live at: $REMOTE_URL"
