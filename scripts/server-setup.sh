#!/bin/bash
# Forge Worker API — Server Setup Script
# Run this on the server (192.168.12.111) to deploy the Docker container
set -euo pipefail

cd ~/forge

# 1. Generate FORGE_API_TOKEN if not already in .env
if ! grep -q "FORGE_API_TOKEN" .env 2>/dev/null; then
  TOKEN=$(openssl rand -hex 24)
  echo "FORGE_API_TOKEN=$TOKEN" >> .env
  echo "Generated FORGE_API_TOKEN: $TOKEN"
  echo ">>> SAVE THIS TOKEN — you need it on your PC's .env too <<<"
fi

# 2. Get GH token from gh CLI auth
GH_TOKEN=$(gh auth token 2>/dev/null || echo "")
if [ -n "$GH_TOKEN" ] && ! grep -q "GH_TOKEN" .env 2>/dev/null; then
  echo "GH_TOKEN=$GH_TOKEN" >> .env
  echo "Added GH_TOKEN from gh auth"
fi

# 3. ANTHROPIC_API_KEY is optional if mounting ~/.claude (OAuth)
# The docker-compose mounts ~/.claude:/root/.claude:ro for OAuth auth
# But set a placeholder if you want to use API key instead:
if ! grep -q "ANTHROPIC_API_KEY" .env 2>/dev/null; then
  echo "ANTHROPIC_API_KEY=" >> .env
  echo "Note: ANTHROPIC_API_KEY left empty — using OAuth via mounted ~/.claude"
fi

echo ""
echo "=== .env contents (keys only) ==="
grep -oP '^[A-Z_]+' .env || true
echo ""

# 4. Build and start the container
echo "Building Docker container..."
docker compose up -d --build

echo ""
echo "=== Container status ==="
docker compose ps

echo ""
echo "=== Testing health endpoint ==="
sleep 3
curl -s http://localhost:8787/health | python3 -m json.tool 2>/dev/null || curl -s http://localhost:8787/health

echo ""
echo "Done! Container should be accessible at https://forge.bozits.com/health"
