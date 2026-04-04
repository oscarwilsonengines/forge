FROM node:20-slim

# Install system dependencies + VPN + SMB
RUN apt-get update && apt-get install -y --no-install-recommends \
    git tmux curl ca-certificates gnupg openssh-client \
    strongswan xl2tpd ppp cifs-utils sshfs lftp \
    && rm -rf /var/lib/apt/lists/*

# Install gh CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y gh \
    && rm -rf /var/lib/apt/lists/*

# Install Claude Code
RUN npm install -g @anthropic-ai/claude-code

# Create app directory
WORKDIR /app

# Copy package files and install production deps
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# Copy compiled dist and config
COPY dist/ ./dist/
COPY forge.yaml ./

# Create non-root user for running Claude (refuses root + bypassPermissions)
RUN useradd -m -s /bin/bash forge

# Create directories with forge user ownership
RUN mkdir -p /repos /app/.forge/agents /app/.forge/outputs /app/.forge/prompts /app/.forge/worktrees \
    && chown -R forge:forge /repos /app/.forge /app

# Git config for worktree operations (as forge user)
USER forge
RUN git config --global user.name "Forge Worker" \
    && git config --global user.email "forge@bozits.com" \
    && git config --global init.defaultBranch main \
    && git config --global --add safe.directory '*'

EXPOSE 8787

CMD ["node", "dist/server/worker-api.js"]
