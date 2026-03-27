# Closing every gap in multi-agent Claude Code orchestration

**A single bash script spawning `claude -p` sessions in tmux with git worktree isolation is the proven minimal viable orchestrator — ittybitty shipped exactly this in under 25 lines of core logic.** The six gaps below represent the difference between a weekend prototype and a production-ready system. Each gap now has specific, implementable solutions drawn from real tools (ittybitty, Composio, Claude Squad, Codeman), Claude Code internals (compaction, hooks, Agent Teams), recent research (Vending-Bench, DeepMind scaling studies), and battle-tested infrastructure patterns. What follows is a build-ready engineering specification.

---

## GAP 1: The walking skeleton ships in 25 lines of bash

Every successful orchestrator in this space — ittybitty, Claude Squad, agent-farm, CCPM — converges on the same three primitives: **tmux** for process isolation, **git worktrees** for code isolation, and **`claude -p`** for headless execution. The walking skeleton connects all three end-to-end.

### Phase 0: Walking skeleton (Saturday morning)

```bash
#!/bin/bash
# orchestrator.sh — Walking Skeleton v0.1
set -euo pipefail

TASK="$1"
AGENT_ID="agent-$(date +%s)"
REPO_ROOT=$(git rev-parse --show-toplevel)
WORK_DIR="$REPO_ROOT/.agents/$AGENT_ID"

# 1. Create worktree
git worktree add -b "$AGENT_ID" "$WORK_DIR" HEAD

# 2. Spawn claude in tmux
tmux new-session -d -s "$AGENT_ID" -c "$WORK_DIR" \
  "claude -p '$TASK' --output-format json > /tmp/$AGENT_ID.json 2>&1; \
   echo DONE > /tmp/$AGENT_ID.status"

echo "Agent $AGENT_ID spawned. Monitoring..."

# 3. Poll for completion
while [ ! -f "/tmp/$AGENT_ID.status" ]; do
  sleep 5; echo "  ...still working"
done

# 4. Report result
echo "=== Agent Complete ==="
cat /tmp/$AGENT_ID.json | jq -r '.result' 2>/dev/null || cat /tmp/$AGENT_ID.json

# 5. Cleanup
git worktree remove "$WORK_DIR" --force
git branch -D "$AGENT_ID" 2>/dev/null
```

This is **25 lines of real code** that proves the entire architecture: input → worktree → tmux → claude → output. ittybitty's Adam Wulf confirmed this exact pattern works: "Pure bash — it should work while I build it and should work when you download it."

### Phase 1: Weekend build (2 days)

Add multi-agent spawning with `spawn <prompt>`, `list`, `look <id>`, `kill <id>`, and `nuke` commands. Status tracking via per-agent files in `.agents/<id>/status.json`. The core monitoring loop is trivial:

```bash
for agent_dir in .agents/*/; do
  id=$(basename "$agent_dir")
  tmux has-session -t "$id" 2>/dev/null && echo "$id: RUNNING" || echo "$id: COMPLETE"
done
```

ittybitty proves this works as a single bash file. Claude Squad proves a TUI dashboard can be layered on top. **Deliverable: 3–5 parallel agents with monitoring, ~200–400 lines of bash.**

### Phase 2: One-week build

Days 3–4 add inter-agent messaging via `tmux send-keys -t $session "message" Enter` (the ittybitty pattern), manager/worker hierarchy, and parent tracking. Day 5 adds GitHub Issues integration using `gh issue list` and `gh issue comment`. Days 6–7 add Claude Code hooks for tool approval, path enforcement, and auto-notification on completion. **Deliverable: ~800–1500 lines of bash with GitHub integration.**

### Phase 3: One-month build

Weeks 2–4 add production hardening: YAML config, CI feedback routing, plugin architecture, stall detection, cost tracking (parsing `total_cost_usd` from JSON output), rate limit handling, web dashboard, and session resume/reboot recovery. Composio's agent-orchestrator represents this endpoint — a TypeScript monorepo with 3,288 test cases that was literally **built by 30 agents running itself**.

### Key `claude -p` flags for orchestration

| Flag | Purpose |
|------|---------|
| `--output-format json` | Structured response with `session_id`, `cost`, `result` |
| `--output-format stream-json` | Real-time NDJSON streaming |
| `--resume <session-id>` | Continue a specific conversation |
| `--allowedTools "Read,Write,Edit,Bash"` | Restrict tool access per agent |
| `--max-turns 5` | Cap iterations (cost control) |
| `--bare` | Skip hooks/plugins (fastest) |
| `--permission-mode bypassPermissions` | Skip all prompts (trusted environments only) |

---

## GAP 2: The Boss survives compaction through disk-backed state

Claude Code uses a **three-layer compaction system**: microcompaction offloads large tool outputs to disk early, auto-compaction triggers at ~95% context capacity (CLI) or ~75% (VSCode), and manual `/compact` accepts focus hints. After compaction, Claude receives a continuation message stating "This session is being continued from a previous conversation" plus a structured summary. The summary must be "reconstruction-grade" — capturing user intent, decisions made, files touched, errors fixed, and pending tasks.

### The hybrid Boss architecture

The most resilient pattern combines three mechanisms. First, an **interactive Claude Code session** for natural conversation and complex planning. Second, a **plan file on disk** that survives anything — compaction, crashes, terminal closes, full context resets. Third, **post-compaction hooks** that automatically re-inject critical context.

The PSantanna/Stanford workflow implements this exactly. Two hooks work in sequence: `PreCompact` saves active plan path, current task, and recent decisions to disk. After compaction fires, `PostToolUse` with a `compact` matcher re-injects the saved state:

```json
{
  "hooks": {
    "PostToolUse": [{
      "matcher": "compact",
      "hooks": [{
        "type": "command",
        "command": "cat ~/.claude/context-essentials.md"
      }]
    }]
  }
}
```

When compaction happens, the hook's stdout gets injected as a system message — Claude immediately has its context back. The plan file format follows the GSD framework pattern:

```markdown
# PROJECT_STATE.md — Updated after every significant step
## Completed
- [x] Database schema migration (PR #45, branch merged)
- [x] JWT auth middleware (PR #46, tests passing)
## In Progress
- [ ] OAuth2 integration (Agent B, branch: feature/oauth2)
## Blocked
- [ ] Rate limiting middleware (waiting on Redis setup)
## Decisions Made
- Using RS256 over HS256 for JWT (see ADR-003.md)
## Known Issues
- Tests flaky on CI due to timing — use `--runInBand` flag
```

### Session resume mechanics

Claude Code sessions persist to `~/.claude/projects/` as `.jsonl` files with complete message history. Sessions **never expire**. Resume commands: `claude -c` (continue most recent), `claude -r` (interactive picker), `claude --resume "session-name"` (specific session). For headless orchestration, use `--resume` with an explicit session ID — `--continue` in non-interactive mode can create a new session instead of resuming.

### Pattern comparison for Boss architecture

**Boss as persistent interactive session** gives natural conversation flow but degrades after compaction. **Boss as a script calling `claude -p`** gives maximum resilience — each call gets a fresh context, state is fully explicit on disk, the script can be killed and restarted at any point — but loses conversational continuity. **Boss as TUI wrapper** (Claude Squad model) persists sessions via tmux but requires manual coordination.

The recommendation: **use the interactive session for planning and conversation, but treat disk state as the source of truth**. If the Boss session dies, start fresh with "Read PROJECT_STATE.md and continue from where we left off." CLAUDE.md with `## Compact Instructions` guides what survives compaction. Subagents handle heavy work to keep Boss context clean.

---

## GAP 3: A layered notification stack from terminal bell to Slack

Claude Code has **native notification hooks** that fire on `Stop` (task finished), `Notification` with matcher `idle_prompt` (needs input), and `Notification` with matcher `permission_prompt` (needs approval). The simplest notification is the terminal bell: `claude config set --global preferredNotifChannel terminal_bell`.

### Desktop notifications via hooks

```json
{
  "hooks": {
    "Stop": [{
      "matcher": "",
      "hooks": [{ "type": "command", "command": "notify-send 'Claude Code' 'Task completed!'" }]
    }],
    "Notification": [{
      "matcher": "idle_prompt",
      "hooks": [{ "type": "command", "command": "terminal-notifier -title 'Claude Code' -message 'Ready for input'" }]
    }]
  }
}
```

On macOS: `brew install terminal-notifier && terminal-notifier -title "Agent #1" -message "Done" -sound Glass`. On Linux: `notify-send "Agent #1" "Task completed"`. Tools like **code-notify** (`brew install code-notify`) and **claude-notifications-go** provide cross-platform wrappers with click-to-focus and webhook support for Slack, Discord, Telegram, and ntfy.sh.

### Slack and Discord webhooks

```bash
# Slack — rich message with agent status fields
curl -X POST -H 'Content-type: application/json' \
  --data '{"attachments":[{"color":"good","title":"Agent #1 — Auth Module",
    "text":"✅ All tests passing. PR #42 ready for review.",
    "fields":[{"title":"Status","value":"Completed","short":true},
              {"title":"Duration","value":"12m 34s","short":true}]}]}' \
  "$SLACK_WEBHOOK_URL"

# Discord — embed with color-coded status
curl -H "Content-Type: application/json" -X POST \
  -d '{"embeds":[{"title":"🤖 Agent Status","color":3066993,
    "fields":[{"name":"Agent #1","value":"✅ Auth complete","inline":true},
              {"name":"Agent #2","value":"🔄 In progress","inline":true}]}]}' \
  "$DISCORD_WEBHOOK_URL"
```

### tmux status bar as live dashboard

```bash
# ~/.tmux.conf
set -g status-interval 2
set -g status-right '#[fg=cyan]🤖 #(cat /tmp/agent-count.txt) agents #[fg=green]✅ #(cat /tmp/agents-done.txt) done #[fg=yellow]| %H:%M'
setw -g monitor-activity on
setw -g monitor-bell on
set -g allow-passthrough on
```

The orchestrator script updates `/tmp/agent-count.txt` and `/tmp/agents-done.txt` as agents spawn and complete. For richer monitoring, tmux's `monitor-silence 30` detects stalled agents, and `window-status-activity-style bg=red` highlights active panes.

### GitHub Check Runs for PR-level progress

The orchestrator can create GitHub Check Runs to show agent progress directly in PRs using a personal access token or GitHub App:

```bash
curl -L -X POST \
  -H "Authorization: Bearer $GITHUB_TOKEN" \
  https://api.github.com/repos/OWNER/REPO/check-runs \
  -d '{"name":"Agent #1 — Auth Module","head_sha":"'$SHA'",
       "status":"in_progress","output":{"title":"Working...",
       "summary":"✅ Created auth service\n🔄 Writing tests"}}'
```

Each agent gets its own Check Run context, visible as separate status lines on the PR. **Codeman** goes further with a full WebUI at `localhost:3000` featuring floating terminal windows per agent, animated parent-child connection lines, mobile access via Cloudflare tunnel, and QR-code authentication.

### Recommended notification stack

The layers work together: **terminal bell** for immediate local alerts, **tmux status bar** for at-a-glance monitoring, **desktop notifications** for background awareness, **Slack/Discord webhooks** for team visibility, **GitHub Check Runs** for PR-level tracking, and **Codeman or a Flask dashboard** for remote monitoring. Each layer adds coverage without replacing the others.

---

## GAP 4: SSH hardening that survives network chaos

The orchestrator runs on WSL2 and spawns Claude Code agents on a remote Linux server. Three things must survive: SSH connections dropping, credentials expiring, and the orchestrator itself restarting.

### SSH agent persistence in WSL2

The `ssh-agent` started with `eval $(ssh-agent -s)` does **not** persist across terminal sessions. The fix is `keychain`:

```bash
sudo apt install keychain
# Add to ~/.bashrc:
/usr/bin/keychain -q --nogui $HOME/.ssh/id_ed25519
source $HOME/.keychain/$(hostname)-sh
```

First shell after reboot prompts for passphrase once. All subsequent shells — including tmux panes — reuse the same agent. For Windows-native key management, `npiperelay.exe` + `socat` bridges the Windows OpenSSH agent into WSL2 via a UNIX socket.

### SSH ControlMaster eliminates connection overhead

The orchestrator makes **many rapid SSH calls** (spawning, polling, capturing). Without multiplexing, each requires a full TCP+SSH handshake (~200ms). ControlMaster multiplexes subsequent calls over the existing connection (~20ms):

```
# ~/.ssh/config
Host remote-worker
    HostName 192.168.1.100
    User deploy
    ControlMaster auto
    ControlPath ~/.ssh/control-%C
    ControlPersist 30m
    ServerAliveInterval 30
    ServerAliveCountMax 3
    ForwardAgent yes
    ConnectTimeout 10
    ConnectionAttempts 3
```

**Critical edge case**: when the underlying TCP connection drops, the control socket becomes stale. The orchestrator must detect this (SSH exit code 255), remove the stale socket with `rm ~/.ssh/control-*`, and retry. ControlMaster works identically in WSL2 — UNIX domain sockets are native to WSL2's Linux kernel.

### Claude Code authentication on remote machines

For headless deployments, set `ANTHROPIC_API_KEY` as an environment variable — this takes precedence over OAuth and works without a browser:

```bash
export ANTHROPIC_API_KEY="sk-ant-api03-xxxxx"
claude -p "Summarize this repo" --output-format json
```

For subscription users who want to use their Max plan quota, generate a long-lived token locally with `claude setup-token`, then set `CLAUDE_CODE_OAUTH_TOKEN` on the remote. For rotating credentials, use `apiKeyHelper` in settings — a script called at startup and every 5 minutes. **Never set both `ANTHROPIC_API_KEY` and `CLAUDE_CODE_OAUTH_TOKEN` simultaneously** — this causes auth conflicts.

### Git credentials: SSH agent forwarding handles it

If using `git@github.com:...` URLs, SSH agent forwarding (configured above) means the remote server authenticates to GitHub using your local keys — no credential copying needed. For HTTPS remotes, pipe `gh auth token` over SSH:

```bash
gh auth token | ssh remote-worker "gh auth login --with-token && gh auth setup-git"
```

### Network resilience: autossh + tmux + polling

`autossh` maintains persistent SSH connections with automatic reconnection. The recommended modern configuration uses `-M 0` with `ServerAliveInterval` instead of autossh's own monitoring port. For the orchestrator's control channel, the pattern is: **tmux on the remote survives all SSH drops** (agents keep running), and the orchestrator polls via periodic SSH commands:

```bash
# Check if worker is alive and get its status
STATUS=$(timeout 10 ssh -o ConnectTimeout=5 remote-worker \
  "tmux has-session -t worker-1 2>&1 && echo OK || echo GONE")
# Capture recent output
OUTPUT=$(ssh remote-worker "tmux capture-pane -t worker-1 -p -S -20")
```

### Tailscale vs direct SSH

For LAN-only use, direct SSH works fine. Tailscale adds **stable 100.x.x.x IPs**, WireGuard encryption, and NAT traversal for remote access from anywhere. Install Tailscale on the Windows host (not inside WSL2) — DNS resolution flows to WSL2 automatically. Tailscale SSH can replace OpenSSH entirely with zero key management, but direct SSH with ControlMaster gives the orchestrator more control. **Recommendation: Tailscale on Windows host + SSH from WSL2** for the best of both worlds.

---

## GAP 5: Nine specialized reviewers, one unified checklist

The hamy.xyz "9 Parallel AI Agents" system is the most detailed public implementation of multi-agent code review. It launches **all 9 agents simultaneously** using multiple `Task` tool calls from a single Claude Code session. Each agent has a precisely scoped, non-overlapping domain.

### The nine reviewer prompts (abbreviated)

The agents are: **Test Runner** (runs tests, reports pass/fail), **Linter & Static Analysis** (runs linters + IDE diagnostics), **Code Reviewer** (up to 5 concrete improvements ranked by impact × effort, explicitly skipping "formatting, naming nitpicks, and things linters catch"), **Security Reviewer** (injection, auth, secrets, error handling — with severity and file:line references), **Quality & Style** (complexity, dead code, duplication, consistency), **Test Quality** (coverage ROI, flakiness risk, anti-patterns), **Performance** (N+1 queries, memory leaks, blocking ops), **Dependency & Deployment Safety** (new deps justified, breaking changes, migration safety), and **Simplification** ("Could this be simpler?").

Duplicates are avoided primarily through **role specialization** — each agent's prompt explicitly defines what it should and should not cover. The Code Reviewer says "skip things linters catch." The Security Reviewer says "if no issues found, report 'No security concerns identified'" rather than padding with generic advice.

### Forcing specific, actionable findings

The anti-boilerplate technique is structural: require **exact file:line references, quoted problematic code, and concrete replacement code** in every finding. The prompt template:

```
For each finding, you MUST provide:
- Exact file path and line number
- The specific code that's problematic (quote it)
- Why THIS SPECIFIC INSTANCE is a problem (not generic advice)
- A concrete code fix (show the replacement code)

DO NOT provide generic advice like "add error handling."
Instead: "Function processPayment() at src/payments.ts:42 will throw TypeError 
if amount is undefined. Add: if (!amount) throw new PaymentError('Amount required')"
```

Cap findings per agent (up to 5) and require ranking by impact × effort. This constraint forces agents to prioritize rather than padding.

### Anthropic's own Code Review system

Anthropic's managed Code Review service (triggered by `@claude review` on a PR) runs **multiple agents analyzing the diff in parallel**, each looking for a different class of issue. A **verification step** checks candidates against actual code behavior to filter false positives. Results are **deduplicated, ranked by severity**, and posted as inline comments. Internal stats show the false positive rate is **less than 1%**, and reviews average **~20 minutes** at **$15–$25 per review**. Before Code Review, 16% of PRs got substantive review comments; after, **54%**.

### Deduplication pipeline

The aggregation follows three steps. **Deterministic pre-dedup**: match findings by file:line, use Jaccard similarity on descriptions. **Meta-reviewer agent**: takes all unique findings, resolves remaining semantic duplicates, calibrates severity across reviewers. **Verification**: check findings against actual code to filter false positives. The output format uses four severity levels:

- **Critical/P0**: Security vulnerabilities, data loss, crashes → **block merge**
- **High/P1**: Correctness bugs, auth issues → **block merge**  
- **Medium/P2**: Code quality, missing tests → **flag for attention**
- **Low/Nit**: Style, naming → **suggestion only, never block**

### Handling critical findings

Anthropic's Code Review deliberately does **not** approve or block PRs — it only surfaces findings. The recommended pattern for a multi-agent orchestrator: critical findings get **flagged for human decision** with an option to dispatch a fix-agent for automated remediation. The fix-agent attempts the repair, then the review pipeline runs again. If the re-review passes, the human approves. If it fails, the human intervenes directly.

---

## GAP 6: What remains unsolved and how to mitigate it

Google DeepMind's December 2025 study found **17× error amplification** in unstructured multi-agent pipelines. Augment Code reports **41–86.7% failure rates** in multi-agent LLM production systems. These are not edge cases — they are the baseline. Five problems are genuinely hard.

### Merge conflicts: detection exists, prevention doesn't

Git worktrees prevent working directory conflicts but **cannot prevent branch-level conflicts** when two agents modify the same file. The tool **Clash** (Rust CLI at github.com/clash-sh/clash) performs read-only `git merge-tree` three-way merges between all worktree pairs to detect conflicts before they happen. It can run as a Claude Code `PreToolUse` hook to block conflicting file writes.

**Mitigation stack**: Enable `git rerere` globally (auto-resolves recurring conflict patterns). Maintain a `.claude/locks.json` advisory file-lock registry where agents declare intent. Use module-level task partitioning so agents work on disjoint dependency subtrees. Merge sequentially into an integration branch with AI resolution for simple additive conflicts, human escalation for structural conflicts. For shared singleton files like `package.json`, designate one agent as the sole dependency manager — others request changes via a queue.

### Crash recovery: sessions restore but tasks don't

Claude Code session resume restores conversation history but **not task-level state** — what subtask was in progress, which items are complete, what the agent's plan was. Known issue: the `mutableMessages` array grows indefinitely; **14MB session files balloon to ~1.9GB in memory**, causing OOM kills. After OOM, `sessions-index.json` can become stale while JSONL files survive.

**Mitigation**: Agents write structured checkpoint files (`PROGRESS.json`) after completing each subtask. The orchestrator monitors heartbeats and, on failure, reads the progress file to re-dispatch remaining work to a fresh agent. Git commits serve as secondary checkpoints — `git log` reveals exactly what was completed. The **CONTINUITY MCP Server** provides 8 tools for this pattern: `continuity_checkpoint()` every 3–5 tool calls, `continuity_recover_crash()` on session start.

```json
{
  "task_id": "auth-refactor",
  "status": "in_progress",
  "completed": ["migrate-jwt-tokens", "update-middleware"],
  "current": "refactor-session-handler",
  "remaining": ["update-tests", "write-docs"],
  "last_checkpoint": "2026-03-26T14:30:00Z"
}
```

### Rate limit backpressure: no shared budget manager exists

Claude Max uses a **weekly rolling token window**, not daily. The dashboard percentage reflects only one of three constraints (RPM, input TPM, output TPM) — you can show **6% usage and still be rate-limited** on TPM. Running 5 parallel Claude Code sessions burns through the weekly budget fast because each session's multi-turn context grows token consumption per request faster than linearly.

**Mitigation**: Route all agent API calls through a central proxy maintaining a global token budget and priority queue (P0: bugfix, P1: feature, P2: docs). Read `anthropic-ratelimit-tokens-remaining` headers on every response. When remaining drops below 20%, pause lower-priority agents. Auto-downgrade non-critical agents from Opus to Sonnet or Haiku. Stagger agent startup by 2–3 minutes so context accumulation peaks don't align.

### Multi-day coherence: no model maintains it reliably

Vending-Bench tested agents managing a business over 365 simulated days (>20M tokens per run). Result: "all models have runs that derail, either through misinterpreting schedules, forgetting orders, or descending into tangential 'meltdown' loops." Critically, **no clear correlation between failures and context window fullness** — coherence loss is not simply a context length problem. METR finds models have **<10% success on tasks taking >4 hours**.

**Mitigation**: Use **CLAUDE.md as permanent memory** (survives compaction, re-read from disk). Use **PROJECT_STATE.md** updated after every significant step as the source of truth. Use **claude-mem** or **memsearch** plugins for automatic session memory with decay (architecture decisions permanent, progress fades after 7 days). Define explicit coherence thresholds per the COLLAPSE.md convention: at 85% context utilization, checkpoint → summarize → pause → await human approval.

### Cascading quality: the 17× amplification problem

When Agent A writes code that is syntactically correct but architecturally wrong, Agent B building on top produces working code that silently degrades. DeepMind measured **17× error amplification** in unstructured pipelines. OWASP ASI08 formally classifies this: semantic opacity (natural language errors pass validation), emergent behavior (multi-agent interactions create unintended outcomes), temporal compounding (errors persist in memory and contaminate future operations).

**Mitigation**: Deploy an **independent judge agent** with separate context and isolated prompts — if it shares context with producing agents, "it becomes another participant in collective delusion" (Augment Code). Use the **AgentCoder pattern**: test designer works independently of the programmer agent with no access to generated code, ensuring objective testing (achieves **91.5% Pass@1**). Run integration tests after each agent merge. Merge into integration branch one at a time, rejecting any merge that breaks tests. Use **contract-first development**: generate TypeScript interfaces or OpenAPI specs before agents begin, and validate compliance on every merge.

### Summary of solvability

| Problem | Status | Best available mitigation |
|---------|--------|--------------------------|
| File-level merge conflicts | Partially solved | Worktree isolation + Clash detection + git rerere |
| Shared singleton conflicts | Unsolved | Sequential merge + dedicated dependency agent |
| Task-level crash recovery | Partially solved | Structured checkpoints + CONTINUITY MCP |
| Rate limit coordination | Unsolved | Central proxy + priority queue + model downgrade |
| Multi-day coherence | Partially solved | CLAUDE.md + PROJECT_STATE.md + memory plugins |
| Cascading quality failures | Partially solved | Independent judge agents + contract-first + AgentCoder |

---

## Conclusion: the 90% plan

The path from weekend prototype to production system is now concrete. **Phase 0** is 25 lines of bash connecting tmux, git worktrees, and `claude -p` — the walking skeleton that every successful orchestrator started from. **The Boss session** survives compaction through the hybrid pattern: interactive Claude session for conversation, disk-backed state files for truth, post-compaction hooks for automatic recovery. **Notifications** layer from terminal bell (zero config) through tmux status bars to Slack webhooks and GitHub Check Runs. **SSH hardening** uses keychain for agent persistence, ControlMaster for connection multiplexing, and autossh for automatic reconnection — with tmux on the remote ensuring agents survive all network disruptions. **Code review** follows the hamy.xyz 9-agent architecture with role-specialized prompts, forced specificity constraints, and a meta-reviewer deduplication pass.

The genuinely unsolved problems — shared singleton file conflicts, rate limit coordination across agents, multi-day coherence, and cascading quality failures — have mitigations but not solutions. The **17× error amplification** finding means quality gates are not optional; they're structural requirements. The two highest-leverage investments beyond the MVP are the **plan-file-as-external-memory** pattern (because every other resilience mechanism depends on disk-backed state) and the **independent judge agent** pattern (because without it, multi-agent quality degrades faster than single-agent quality). Build the skeleton first, add the state file immediately, and never ship an orchestrator without a review gate.