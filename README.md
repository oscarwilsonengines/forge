# Forge — Multi-Agent Claude Code Orchestrator

**You talk. Agents build. You review.**

Forge turns a single Claude Code conversation into a full development team. You describe what you want. Forge creates the repo, breaks the work into tasks, spawns real Claude Code sessions to build it, monitors their progress, runs a 5-agent review pipeline, and hands you a checklist of exactly what to verify.

## How It Works

```
You ──→ Boss (Claude Opus) ──→ forge plan "Build an auth system"
                               ├── Creates GitHub Issues with dependencies
                               ├── forge build
                               │   ├── Agent 1: JWT middleware [local, tmux]
                               │   ├── Agent 2: User model [remote, tmux]
                               │   └── Agent 3: Login endpoints [local, tmux]
                               ├── forge status → reports progress
                               ├── forge review
                               │   ├── Security reviewer
                               │   ├── Quality reviewer
                               │   ├── Waste detector
                               │   ├── Test coverage reviewer
                               │   └── Performance reviewer
                               └── forge checklist → your review items
```

## Quick Start

```bash
# 1. Clone Forge
git clone https://github.com/your-org/forge.git
cd forge && npm install && npm run build

# 2. Configure
cp forge.yaml ~/.config/forge/forge.yaml
# Edit: set github.org, hosts, notification webhooks

# 3. Start a project
./scripts/start.sh  # Opens Boss session in tmux

# Inside the Boss session, just talk:
# "Create a new project called invoice-api that handles
#  PDF invoice generation with Stripe integration"
```

## Commands

| Command | What it does |
|---------|-------------|
| `forge new <name>` | Create repo, labels, branch protection, CLAUDE.md |
| `forge init [repo]` | Initialize Forge in an existing repo |
| `forge plan "description"` | Decompose work into GitHub Issues with dependencies |
| `forge approve` | Approve the plan, mark ready to build |
| `forge build` | Spawn agents for all ready tasks |
| `forge status` | Live status of all agents and tasks |
| `forge tell <agent> "msg"` | Send a message to a running agent |
| `forge restart <agent>` | Kill and re-queue a stalled agent |
| `forge stop` | Emergency stop all agents |
| `forge review` | Run 5 parallel review agents |
| `forge checklist` | Generate severity-ranked review items |
| `forge notify test` | Test all notification channels |

## Architecture

### GitHub Issues as Source of Truth
Every task is a GitHub Issue with Forge labels (`forge:todo`, `forge:in-progress`, etc.) and metadata in the body (dependencies, acceptance criteria). Agents update issues as they work. You can see progress on GitHub even when you're not at your terminal.

### Real Claude Code Sessions
Workers are NOT subagents. Each is a full `claude -p` session running in its own tmux window with its own git worktree. They can use all Claude Code tools, run tests, commit code, and open PRs.

### Cross-Machine Support
Agents can run locally (WSL2) or on a remote Linux server via SSH. Forge manages tmux sessions on both machines. Remote agents survive SSH disconnections because tmux persists on the remote.

### Review Pipeline
5 specialized review agents run in parallel after dev work completes:
- **Security**: injection, auth bypass, secrets, input validation
- **Quality**: complexity, duplication, naming, architecture
- **Waste**: over-engineering, premature abstraction, unnecessary deps
- **Tests**: coverage gaps, flaky tests, assertion quality
- **Performance**: N+1 queries, memory leaks, blocking ops

Each finding includes file:line, confidence score, and concrete fix suggestion. Only findings above 80% confidence make the checklist.

### Compaction Survival
All state lives on disk in `.forge/`:
- `plan.json` — task states, dependencies, agent assignments
- `PROJECT_STATE.md` — human-readable summary (auto-injected after compaction)
- `agents/` — per-agent status and checkpoints
- `reviews/` — review findings by category
- `REVIEW_CHECKLIST.md` — your review items

A Claude Code hook auto-injects `PROJECT_STATE.md` after compaction, so the Boss recovers instantly.

## Configuration

Edit `forge.yaml`:

```yaml
github:
  org: "your-org"
  default_visibility: "private"

hosts:
  local:
    type: "local"
    max_agents: 5
  remote:
    type: "ssh"
    host: "172.16.2.135"
    user: "zach"
    key: "~/.ssh/id_ed25519"
    max_agents: 5

agents:
  model: "sonnet"          # Workers use Sonnet (fast, cheap)
  boss_model: "opus"       # Boss uses Opus (smart planning)
  review_model: "sonnet"   # Reviewers use Sonnet
  max_turns: 25            # Cap per agent
  stagger_seconds: 30      # Delay between spawns

notifications:
  terminal_bell: true
  desktop: true
  slack_webhook: "https://hooks.slack.com/services/..."
```

## Requirements

- Node.js 18+
- Claude Code CLI (`npm install -g @anthropic-ai/claude-code`)
- GitHub CLI (`gh`) authenticated
- tmux
- Claude Max plan ($100-200/mo) for parallel sessions

## Team Usage (Coming Soon)

Forge is designed for solo use first, team use later. The roadmap includes:
- Multiple humans running Boss sessions against the same repo
- Agent-level RBAC via GitHub teams
- Shared notification channels per project
- Cost tracking and budgeting per team member

## License

MIT
