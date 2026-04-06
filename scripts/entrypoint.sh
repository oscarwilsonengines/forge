#!/bin/bash
# Forge Docker entrypoint — fix permissions, set up auth, then run as forge user
set -e

# Fix volume ownership (volumes may have been created by root in older containers)
chown -R forge:forge /repos /app/.forge 2>/dev/null || true

# Set up Claude auth — symlink .claude.json from mounted .claude/ directory
if [ -f /home/forge/.claude/.claude.json ]; then
  ln -sf /home/forge/.claude/.claude.json /home/forge/.claude.json
elif ls /home/forge/.claude/backups/.claude.json.backup.* 1>/dev/null 2>&1; then
  BACKUP=$(ls -t /home/forge/.claude/backups/.claude.json.backup.* | head -1)
  cp "$BACKUP" /home/forge/.claude.json
  chown forge:forge /home/forge/.claude.json
fi

# Ensure credentials are readable by forge user
chmod a+r /home/forge/.claude/.credentials.json 2>/dev/null || true
chmod a+r /home/forge/.claude.json 2>/dev/null || true

# Ensure Claude session directories exist and are writable
mkdir -p /home/forge/.claude/session-env /home/forge/.claude/cache /home/forge/.claude/debug /home/forge/.claude/statsig
chown -R forge:forge /home/forge/.claude/session-env /home/forge/.claude/cache /home/forge/.claude/debug /home/forge/.claude/statsig 2>/dev/null || true

# Set up GitHub auth for git push and gh CLI
if [ -n "$GH_TOKEN" ]; then
  # gh CLI uses GH_TOKEN env var automatically
  # git push needs credential helper configured to use the token
  gosu forge git config --global credential.helper '!f() { echo "username=x-access-token"; echo "password=$GH_TOKEN"; }; f'
  gosu forge git config --global url."https://x-access-token:${GH_TOKEN}@github.com/".insteadOf "https://github.com/"
fi

# Drop to forge user and exec the actual command
exec gosu forge "$@"
