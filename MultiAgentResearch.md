# Building the ultimate multi-agent Claude Code orchestrator

**The best architecture for Zach's orchestrator combines CCPM's structured decomposition pipeline, Composio's self-healing reactions engine, ittybitty's hook-based safety model, and Codeman's respawn controller — all glued together with TypeScript and SSH-aware tmux management.** No single existing tool handles the full Boss→Workers→Reviewers→Checklist pipeline with cross-machine support. The optimal path is building a new orchestrator in TypeScript that cherry-picks proven patterns, uses GitHub Issues as the single source of truth via `gh` CLI, spawns real `claude -p` sessions in tmux (both local and remote via SSH), and coordinates through a file-based event system. This report synthesizes research across 8 existing orchestrator tools, Claude Code's internal Agent Teams architecture, and the full CLI/MCP ecosystem to deliver a concrete implementation blueprint.

---

## The landscape of orchestrator tools reveals clear winners and losers

Eight orchestrator tools exist as of March 2026, each solving a different slice of the problem. None solves the whole thing.

**Composio agent-orchestrator** (TypeScript, ~5.3K stars) is the most architecturally sophisticated. Its **8-slot plugin system** cleanly separates Runtime (tmux/Docker), Agent (Claude/Codex/Aider), Workspace (worktree/clone), Tracker (GitHub/Linear), SCM, Notifier, Terminal, and Lifecycle concerns. Its killer feature is the **reactions engine**: when CI fails, it auto-injects failure logs into the responsible agent's session, which fixes the code and retries — **84.6% CI success rate** across 41 failures, all self-corrected. It tested 30 concurrent agents and merged 65 PRs, 84% AI-generated. The weakness: polling-based (30s intervals), file-based state, and not yet published to npm.

**CCPM** (7.1K stars, most popular) nails task decomposition: PRD → Epic → Tasks → GitHub Issues with frontmatter metadata for `depends_on`, `parallel`, and `conflicts_with` per task. It's harness-agnostic (works with Claude, Codex, Cursor) and uses **deterministic bash scripts** for status/search/validation operations — saving LLM tokens on things scripts can do. But CCPM is a coordination protocol, not a runtime orchestrator: it can't spawn processes, manage tmux sessions, or react to CI failures.

**ittybitty** (pure Bash) proves safety-first orchestration works. It's the only tool that avoids `--dangerously-skip-permissions`, instead using Claude Code hooks to auto-approve tools within each agent's worktree while auto-denying anything outside it. Its `PreToolUse` hook runs `ib hook-check-path` to sandbox agents. The Manager/Worker hierarchy prevents workers from spawning sub-agents. The `Stop` hook monitors for status phrases ("WAITING", "I HAVE COMPLETED THE GOAL") to auto-notify managers.

**Claude Squad** (Go, 6.3K stars) has the most polished TUI and the cleanest worktree lifecycle: on pause, it commits changes and removes the worktree (saving disk); on resume, it recreates from the branch. **Codeman** (TypeScript) contributes the most sophisticated session lifecycle management via its **respawn controller with circuit breaker** — multi-layer idle detection, health scoring (0-100), and auto `/compact` at 110K tokens / auto `/clear` at 140K.

**claude-session-driver** provides the cleanest composable primitives: individual shell scripts for launch, send, wait, read, stop, and approve, plus a JSONL event stream at `/tmp/claude-workers/<session>.events.jsonl`. Its **per-tool approval window** (30s configurable timeout before each tool call) is unique. **Ruflo/claude-flow** (16K stars) attempts everything — 259 MCP tools, 54+ agent types, WASM kernels, "swarm intelligence" — but its extraordinary performance claims are unverified and the kitchen-sink scope raises quality concerns.

The synthesis is clear: **Composio's plugin architecture + reactions engine, CCPM's decomposition pipeline, ittybitty's safety hooks, Codeman's respawn/health system, and session-driver's event stream primitives** form the ideal pattern set.

---

## How Claude Code's internals actually work (and break)

Understanding the foundation is critical before building on top of it. Claude Code Agent Teams (experimental, v2.1.32+) operates through **7 tool primitives**: TeamCreate, TaskCreate, TaskUpdate, TaskList, Task (spawn teammate), SendMessage, and TeamDelete. Teams store configuration at `~/.claude/teams/{name}/config.json` and tasks at `~/.claude/tasks/{name}/N.json`. Inter-agent messaging uses JSON inbox files at `~/.claude/teams/{name}/inboxes/{agent}.json`. Task states flow through `pending` → `in_progress` → `completed` with file-lock-based claiming to prevent races.

**The critical failure modes are well-documented.** `/resume` and `/rewind` do not restore teammates — after resuming a session, the lead may try to message agents that no longer exist. Crashed teammates trigger a **5-minute heartbeat timeout** before being marked inactive and their tasks becoming claimable. Auto-compact fires at approximately **83.5% of the 200K context window** (~167K tokens) with a 33K buffer reserved for summarization. After compaction, agents lose specific variable names, exact error messages, and nuanced decisions — they typically re-read files to recover, filling context again. Known bugs include infinite compaction loops when context management becomes "permanently corrupted" and sessions that become unresumable when context exceeds limits before any user interaction.

**The `claude -p` headless mode** is the reliable foundation for programmatic spawning. It supports three output formats: `text` (default), `json` (structured with `session_id`, `usage`, `cost_usd`), and `stream-json` (NDJSON with `system/init`, `assistant`, `user/tool_result`, and `result` events). Key flags include `--allowedTools` (restrict tool access without YOLO mode), `--max-turns` (limit agent loops, default ~10), `--continue`/`--resume` (session continuity), and `--model` (per-session model selection). A known bug: the `result` event sometimes isn't emitted, causing processes to hang indefinitely despite completing work — **always implement timeouts**.

---

## The recommended architecture: five layers, one source of truth

The orchestrator should be structured as five distinct layers, with GitHub Issues as the single source of truth for all task state:

**Layer 1 — Boss (Interactive CLI).** Zach talks to the Boss in a terminal. The Boss uses Opus (or `opusplan`) for deep reasoning. It takes a project description, invokes CCPM-style decomposition (PRD → Epic → Tasks), and creates GitHub Issues with label-based state (`status:todo`, `status:in-progress`, `status:blocked`, `status:review`, `status:done`) and frontmatter-style metadata in the issue body (`depends_on: #42, #43`, `parallel: true`, `conflicts_with: #45`). The Boss runs locally on WSL2.

**Layer 2 — Scheduler (Event Loop).** A TypeScript daemon monitors GitHub Issues and manages the task queue. When a `status:todo` issue has all dependencies met, the Scheduler spawns a worker. It stagger-launches workers (**30-second intervals** to avoid rate limit thundering herd), respects a configurable concurrency cap (5-10 sessions), and routes tasks to local or remote machines based on load. The Scheduler polls GitHub Issues every 15-30 seconds via `gh issue list --json` and monitors worker health via tmux output hashing (Claude Squad's pattern) plus JSONL event files (session-driver's pattern).

**Layer 3 — Workers (Headless Claude Sessions).** Each worker is a real `claude -p` session running in its own tmux window with its own git worktree. Workers are spawned with `--allowedTools` restricted to safe operations plus ittybitty-style hook sandboxing. Each worker reads its task from a GitHub Issue, reports progress as issue comments, commits to its worktree branch, and opens a PR when done. Workers use Sonnet by default (`--model sonnet --max-turns 25`). On the remote machine, workers are spawned via SSH: `ssh user@172.16.2.135 "tmux new-session -d -s task-42 'cd /repo/.worktrees/task-42 && claude --model sonnet -p \"$(cat task-42.md)\"'"`.

**Layer 4 — Review Pipeline (Parallel Audit).** When a worker's PR is ready, the Scheduler spawns **5 parallel review agents**, each with a fresh context (no confirmation bias) and read-only tool access (`--allowedTools "Read,Grep,Glob,Bash(git diff:*),Bash(gh:*)"`). Each reviewer focuses on one dimension: security, code quality, waste/simplification, test coverage, and performance. Reviews scope to changed files only via `git diff main...HEAD --name-only`. Each reviewer outputs findings with confidence scores; only findings ≥80 confidence pass through. A synthesis step deduplicates by file:line range, merges overlapping findings, and ranks by severity.

**Layer 5 — Checklist Generator.** Aggregates all review findings into a structured markdown checklist with specific `file:line` references, severity tags (Critical/High/Medium/Low), and category tags. Posts this as a GitHub PR comment and prints to the Boss terminal for Zach.

---

## Session spawning: the exact implementation details

**Local spawning (WSL2):**
```bash
# Create worktree
git worktree add .worktrees/task-42 -b task/42 main

# Copy environment files
cp .env .worktrees/task-42/.env

# Install dependencies (if node project)
cd .worktrees/task-42 && npm ci

# Spawn Claude in tmux with hook-based safety
tmux new-session -d -s task-42 \
  "cd $(pwd)/.worktrees/task-42 && \
   CLAUDE_CODE_TASK_LIST_ID=project-x \
   claude --model sonnet --max-turns 25 \
   --allowedTools 'Read,Write,Edit,Bash(git:*),Bash(npm:*)' \
   -p \"$(cat /tmp/task-42-prompt.md)\" \
   --output-format stream-json > /tmp/task-42-events.jsonl 2>&1"
```

**Remote spawning (SSH to 172.16.2.135):**
```bash
# Create worktree on remote
ssh user@172.16.2.135 "cd /repo && git worktree add .worktrees/task-43 -b task/43 main"

# Spawn Claude in remote tmux
ssh user@172.16.2.135 "tmux new-session -d -s task-43 \
  'cd /repo/.worktrees/task-43 && \
   claude --model sonnet --max-turns 25 \
   -p \"$(cat /tmp/task-43-prompt.md)\" \
   --output-format stream-json > /tmp/task-43-events.jsonl 2>&1'"

# Monitor remote worker
ssh user@172.16.2.135 "tail -f /tmp/task-43-events.jsonl"

# Send command to remote worker
ssh user@172.16.2.135 "tmux send-keys -t task-43 '/compact' C-m"

# Check if session is still alive
ssh user@172.16.2.135 "tmux has-session -t task-43 2>/dev/null && echo alive || echo dead"
```

**Worker health monitoring** combines three signals: (1) tmux session existence (`tmux has-session`), (2) JSONL event file modification time (no new events for >5 minutes = potentially stuck), and (3) tmux output hash changes at 500ms intervals (Claude Squad's pattern). If a worker is stuck, the Scheduler sends `/compact` via tmux, waits 60 seconds, then kills and respawns with the same task. Codeman's **circuit breaker pattern** (CLOSED → HALF_OPEN → OPEN) prevents respawn thrashing.

**Task prompts** should be written to temporary files and read by Claude, not passed inline, to avoid tmux buffer limits and shell escaping issues. The prompt template should include: the issue body, acceptance criteria, list of files likely affected, and explicit instructions to commit work and push the branch.

---

## GitHub Issues as the coordination backbone

Using the `gh` CLI is simpler and more reliable than the GitHub MCP Server for orchestrator operations. The MCP Server adds a Docker dependency and consumes **~72K tokens** of context for tool descriptions (reducible to ~8.7K with dynamic toolsets). The `gh` CLI runs in milliseconds, has zero context cost, and Claude can call it via Bash.

**State machine implementation:**
```bash
# Worker claims a task
gh issue edit 42 --add-label "status:in-progress" --remove-label "status:todo"
gh issue comment 42 --body "🤖 Worker task-42 starting in worktree task/42"

# Worker reports progress
gh issue comment 42 --body "Progress: implemented API endpoints (3/5 complete)"

# Worker completes and opens PR
gh pr create --base main --head task/42 --title "feat: implement auth (#42)" --body "Closes #42"
gh issue edit 42 --add-label "status:review" --remove-label "status:in-progress"

# Review agents post findings
gh pr comment 55 --body "$(cat review-checklist.md)"

# After human approval
gh issue close 42 --comment "✅ Merged via PR #55"
gh issue edit 42 --add-label "status:done" --remove-label "status:review"
```

**Dependency resolution** uses issue body metadata and `gh` queries:
```bash
# Check if all dependencies are done
DEPS=$(gh issue view 42 --json body -q '.body' | grep -oP 'depends_on: #\K\d+')
for dep in $DEPS; do
  STATE=$(gh issue view $dep --json state -q '.state')
  if [ "$STATE" != "CLOSED" ]; then echo "Blocked by #$dep"; exit 1; fi
done
```

**Rate limit budget**: With 5-10 parallel agents each making ~50-100 GitHub API calls per hour, total consumption stays well under the **5,000 requests/hour** PAT limit. The `search_issues` endpoint has a stricter **30/minute** limit — use `list_issues` with label filters instead.

For the review phase, however, the GitHub MCP Server is valuable inside Claude Code review agents because it allows them to post **inline PR comments** on specific lines, which `gh` CLI can't easily do. Configure it per-project in `.mcp.json`:
```json
{
  "mcpServers": {
    "github": {
      "command": "docker",
      "args": ["run", "-i", "--rm", "-e", "GITHUB_PERSONAL_ACCESS_TOKEN",
               "-e", "GITHUB_TOOLSETS=issues,pull_requests",
               "ghcr.io/github/github-mcp-server"],
      "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "${GITHUB_PAT}" }
    }
  }
}
```

---

## The review pipeline produces an actionable checklist, not a wall of text

The review pipeline spawns **5 specialized agents** in parallel after a worker's PR is ready. Each agent gets a fresh context window, read-only tool access, and a focused system prompt. The scoping command `git diff main...HEAD --name-only` limits analysis to changed files only.

**Security reviewer** checks for injection risks, auth bypass, secrets in code, error messages leaking internals, and missing input validation. **Code quality reviewer** reads CLAUDE.md first (for project conventions), then checks complexity, dead code, duplication, naming, and architectural pattern adherence. **Waste detector** asks "could this be simpler?" — hunting premature abstractions, over-configured solutions, and clever code that sacrifices clarity. **Test coverage reviewer** verifies critical paths are tested, edge cases are covered, assertions check behavior (not implementation details), and there's no flakiness risk from timing dependencies. **Performance reviewer** looks for N+1 queries, blocking operations in async contexts, memory leaks, missing pagination, and expensive operations in hot paths.

Each reviewer outputs structured JSON:
```json
{
  "findings": [
    {
      "file": "src/auth.ts",
      "line_start": 67,
      "line_end": 72,
      "severity": "critical",
      "category": "security",
      "confidence": 92,
      "title": "OAuth callback missing state parameter validation",
      "description": "The OAuth callback handler does not verify the state parameter...",
      "suggestion": "Add state parameter verification before exchanging the code..."
    }
  ]
}
```

The **synthesis step** (run by the Boss or a dedicated aggregator) filters findings below 80 confidence, groups by file and line range, merges overlapping findings (e.g., security and quality flagging the same code), keeps the most actionable description, and generates the final checklist:

```markdown
## Review Checklist for PR #55 (Auth System)

### 🔴 Critical (2 items)
- [ ] **src/auth.ts:67-72** [Security] OAuth callback missing state parameter validation
  → Add state verification before code exchange to prevent CSRF
- [ ] **src/auth.ts:88-95** [Security] OAuth tokens stored in localStorage
  → Move to httpOnly cookies or server-side session

### 🟡 High (3 items)
- [ ] **src/auth.ts:120** [Performance] User lookup runs N+1 query in loop
  → Batch fetch with WHERE IN clause
- [ ] **src/middleware.ts:45-60** [Quality] Auth middleware duplicates logic from auth.ts
  → Extract shared validation function
- [ ] **tests/auth.test.ts** [Tests] Missing test for token refresh flow
  → Add test covering expired token → refresh → retry

### 🔵 Medium (2 items)
- [ ] **src/auth.ts:30** [Waste] `AuthConfigFactory` class used exactly once
  → Replace with plain object literal
- [ ] **src/types.ts:15-25** [Quality] Auth types not exported from barrel file
  → Add to index.ts exports
```

---

## Cross-machine orchestration requires an SSH-aware tmux manager

**No existing tool natively supports cross-machine orchestration.** All 8 tools assume local tmux sessions. The orchestrator must build an SSH layer.

The pattern is straightforward: the Boss and Scheduler run on WSL2, workers spawn on either WSL2 or the remote Linux box at 172.16.2.135 via SSH. WSL2 outbound SSH requires no special configuration. Git repos are shared via push/pull (not shared filesystems — NTFS cross-access is slow and git file-watching breaks on NFS/SSHFS).

**The `RemoteHost` abstraction:**
```typescript
interface WorkerHost {
  spawn(taskId: string, prompt: string, model: string): Promise<WorkerHandle>;
  monitor(taskId: string): AsyncIterable<WorkerEvent>;
  sendCommand(taskId: string, command: string): Promise<void>;
  kill(taskId: string): Promise<void>;
  isAlive(taskId: string): Promise<boolean>;
}

class LocalHost implements WorkerHost {
  async spawn(taskId, prompt, model) {
    // git worktree add + tmux new-session locally
  }
}

class RemoteHost implements WorkerHost {
  constructor(private sshConfig: { host: string; user: string; keyPath: string }) {}
  async spawn(taskId, prompt, model) {
    // ssh user@host "git worktree add + tmux new-session"
  }
  async isAlive(taskId) {
    // ssh user@host "tmux has-session -t task-{id}"
  }
}
```

**Key WSL2 considerations**: keep all source code on ext4 (`/home/user/`), not NTFS (`/mnt/c/`). Use `git push/pull` to sync between WSL2 and remote. Each machine maintains its own worktrees. The remote needs Claude Code installed (`npm install -g @anthropic-ai/claude-code`) and authenticated (either via `claude login` with a browser or by copying `~/.claude/credentials.json`).

For stable networking between WSL2 and the remote, consider **Tailscale** — it creates encrypted mesh tunnels that eliminate NAT/firewall issues. Otherwise, standard SSH with key-based auth works fine for outbound connections from WSL2.

---

## Token budgeting on Claude Max demands strategic model routing

**Claude Max 20x ($200/mo) provides approximately 900 Sonnet messages per 5-hour rolling window**, with a weekly ceiling of 240-480 active compute hours. Claude.ai and Claude Code share the same quota. Running 5-10 parallel sessions consumes the budget roughly 5-10x faster.

The optimal model allocation strategy:

- **Boss agent**: `opusplan` (uses Opus for planning/reasoning, auto-switches to Sonnet for execution). This gives Opus-quality task decomposition with Sonnet-efficiency for any code it generates.
- **Code writing workers**: `sonnet` with `--effort medium` (default). Sonnet is the best balance of quality and budget for implementation work.
- **Review agents**: `sonnet` for routine reviews, `opus` for security-critical reviews. Review agents consume less budget because they're read-only and shorter-lived.
- **Simple operations** (formatting, file reading, validation): `haiku` when available, or deterministic bash scripts that consume zero LLM tokens (CCPM's pattern).

**Practical budget math**: With 10 parallel Sonnet workers, each consuming ~2 messages/minute, you burn through ~1,200 messages/hour — exceeding the ~180 messages/hour budget (900 messages / 5 hours). **Realistically, 5 parallel Sonnet workers is the sustainable ceiling** on Max 20x, with burst capacity to 8-10 for short periods. Stagger spawns by 30 seconds, set `--max-turns 25` to cap runaway sessions, and use `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=70` for aggressive context management.

**Cost tracking**: Parse JSONL files from `~/.claude/projects/` for per-session token counts. Use `ccusage` (`npx ccusage daily --breakdown --json`) for aggregate monitoring. The `--output-format json` flag returns `cost_usd` and `usage` objects per invocation. Build a simple dashboard that shows current 5-hour window consumption and alerts at 70% budget.

---

## Known pitfalls and how to avoid every one of them

**Pitfall 1: `result` event never emitted.** The `claude -p --output-format stream-json` command sometimes hangs indefinitely after completing work because the final `result` event is never written. **Mitigation**: always wrap spawns with a timeout (e.g., 30 minutes per task), and detect completion by monitoring for commit activity or specific output patterns rather than relying solely on process exit.

**Pitfall 2: Context corruption after compaction.** Auto-compact can lose track of schema decisions, re-read files, and contradict prior implementation choices mid-task. **Mitigation**: put critical task context in a `TASK.md` file in the worktree (not just the prompt). Use `CLAUDE.md` for persistent project instructions. Set `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=70` to compact earlier and more gracefully.

**Pitfall 3: Agents escaping their sandbox.** Without restrictions, agents will `cd` into other agents' worktrees or modify files outside their scope. **Mitigation**: use ittybitty's `PreToolUse` hook pattern to auto-deny file operations outside the agent's worktree path. Set `--allowedTools` to restrict bash commands.

**Pitfall 4: Rate limit thundering herd.** Spawning 10 agents simultaneously exhausts the 5-hour budget in minutes. **Mitigation**: stagger spawns by 30-60 seconds. Implement a token-aware queue that only spawns new workers when headroom exists. Use `--max-turns` to cap iterations.

**Pitfall 5: Merge conflicts between parallel agents.** Two agents modifying related files create conflicts invisible until merge time. **Mitigation**: CCPM's `conflicts_with` metadata enables the Scheduler to avoid running conflicting tasks in parallel. For tasks that must run in parallel, assign non-overlapping file scopes. Merge one branch at a time, rebasing remaining branches after each merge.

**Pitfall 6: Tmux keystroke injection is fragile.** Tools like ittybitty and multiclaude send input via `tmux send-keys`, which can have timing issues with special characters, multi-line input, and escape sequences. **Mitigation**: write complex prompts to files and instruct the agent to read them. Use `claude -p` with file-based input rather than tmux keystroke injection for initial task assignment.

**Pitfall 7: Remote agent auth expiry.** Claude Code sessions on the remote machine need valid authentication. **Mitigation**: use `claude login --method api-key` with a long-lived API key on the remote, or sync credentials. Monitor for auth errors in JSONL output.

---

## Build from scratch in TypeScript, borrowing patterns not code

**Do not fork an existing tool.** ittybitty is Bash (wrong language for complex orchestration). Composio agent-orchestrator is 40K lines of TypeScript across 17 packages (too heavy, not published to npm). CCPM is a command set, not a runtime. Claude Squad doesn't orchestrate. The best path is a new TypeScript project that implements proven patterns.

**TypeScript is the right choice** for five reasons: (1) it's Claude Code's native ecosystem — the Agent SDK (`@anthropic-ai/agent-sdk`) is TypeScript-first with `total_cost_usd` per query; (2) `execa` provides excellent subprocess management; (3) `ssh2` provides native SSH connections without shelling out; (4) `@octokit/rest` gives typed GitHub API access; (5) cross-platform behavior is identical on WSL2 and Linux.

**Recommended package structure:**
```
zachs-orchestrator/
├── src/
│   ├── boss/           # Interactive CLI, task decomposition
│   ├── scheduler/      # Event loop, health monitoring, task queue
│   ├── workers/        # Session spawning (local + remote), lifecycle
│   ├── github/         # Issue CRUD, label state machine, PR management
│   ├── worktrees/      # Git worktree creation, cleanup, merge
│   ├── review/         # 5 reviewer prompts, synthesis, checklist generation
│   ├── hosts/          # LocalHost + RemoteHost abstractions
│   └── monitoring/     # Cost tracking, health dashboard, notifications
├── prompts/            # Markdown templates for worker/reviewer instructions
├── hooks/              # Claude Code PreToolUse/Stop hooks (shell scripts)
├── .claude/            # CLAUDE.md, commands/, agents/
└── package.json
```

**Key dependencies**: `execa` (subprocesses), `ssh2` (remote execution), `@octokit/rest` (GitHub API), `ink` (terminal dashboard), `chokidar` (file watching for events), `zod` (schema validation for structured output).

---

## Conclusion: what makes this orchestrator different

The fundamental insight from this research is that **existing tools solve adjacent problems but none addresses the full lifecycle**. CCPM decomposes but doesn't execute. Composio executes but doesn't decompose. ittybitty is safe but simple. Claude Squad is polished but manual. The orchestrator Zach needs is a *pipeline* — decompose → schedule → execute → review → report — with GitHub Issues as the spine.

Three design decisions separate a great orchestrator from a mediocre one. First, **the Boss should never touch code** — it decomposes, delegates, and synthesizes, using Opus for reasoning while workers use Sonnet for implementation. This mirrors Composio's "orchestrator-as-agent" pattern. Second, **review agents must spawn with fresh contexts** on separate branches — Anthropic's own research confirms that Claude suffers confirmation bias when reviewing code it just wrote. Third, **deterministic operations should be bash scripts, not LLM calls** — checking issue status, creating worktrees, running git operations, and generating the final checklist template all waste tokens when done by AI. CCPM's hybrid approach (slash commands backed by shell scripts for deterministic ops, LLM for creative decomposition and implementation) is the model to follow.

The sustainable scale on Max 20x is **5 parallel Sonnet workers** with burst to 8 for short periods, staggered by 30-second intervals, with a token-aware queue managing the backpressure. Cross-machine support via the `LocalHost`/`RemoteHost` abstraction makes the scheduling layer agnostic to where workers run. The review pipeline's confidence-scored, deduplicated checklist with `file:line` references gives Zach exactly what he needs: not a wall of AI commentary, but a targeted list of specific locations to verify and why.