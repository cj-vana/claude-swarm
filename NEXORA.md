# NEXORA.md

This document provides comprehensive guidance for the Nexora AI system when working with the claude-swarm repository. It integrates project-specific information, local environment settings, and Nexora-specific configurations.

---

## Nexora System Settings

### System Configuration Directory
Nexora client system settings are stored in `~/.local/share/nexora/`:

```
~/.local/share/nexora/
├── nexora.db              # SQLite database containing:
│                           #   - Session history
│                           #   - Configuration settings
│                           #   - Conversation state
└── mcp.json               # MCP server configurations and connection parameters
```

### MCP Server Registration
The claude-swarm MCP server should be registered in `~/.local/share/nexora/mcp.json`:

```json
{
  "mcpServers": {
    "claude-swarm": {
      "command": "node",
      "args": ["/opt/claude-swarm/dist/index.js"],
      "env": {
        "NODE_ENV": "production"
      }
    }
  }
}
```

---

## Project Overview

### What is Claude Swarm?

Claude Swarm is an MCP (Model Context Protocol) server that orchestrates parallel Claude Code worker swarms with protocol-based behavioral governance. It enables:

- **Multi-hour autonomous coding sessions** with persistent state
- **Parallel workers** running simultaneously via tmux sessions
- **Protocol-based governance** with behavioral constraints
- **Competitive planning** for complex features
- **Confidence monitoring** to detect struggling workers
- **Post-completion reviews** (code + architecture)
- **Repository setup automation** for CI/CD, templates, and documentation

### Core Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        MCP Server                                │
│            (Persistent state, survives compaction)               │
│                                                                  │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐       │
│  │  State   │  │  Worker  │  │ Protocol │  │ Dashboard│       │
│  │ Manager  │  │ Manager  │  │ Registry │  │ Server   │       │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘       │
└─────────────────────────────────────────────────────────────────┘
                              │
        ┌─────────────────────┼─────────────────────┐
        │                     │                     │
┌───────▼────────┐  ┌────────▼────────┐  ┌────────▼─────────┐
│  Claude Code   │  │   tmux Workers  │  │   Web Dashboard  │
│   (Orchestrator)│  │   (Parallel)    │  │   (Real-time)    │
└────────────────┘  └─────────────────┘  └──────────────────┘
```

---

## Key Concepts

### The Orchestrator Pattern

Claude Swarm separates concerns between two roles:

| Role | Responsibility | Tools Used |
|------|----------------|------------|
| **Orchestrator (You)** | Plan work, monitor progress, handle decisions, resolve conflicts | MCP tools directly |
| **Workers** | Implement individual features with focus | tmux sessions, limited tools |

### Protocol-Based Governance

Protocols define behavioral constraints that govern worker actions, enabling safe autonomous operation:

**Constraint Types:**

| Type | Description | Example |
|------|-------------|---------|
| `tool_restriction` | Allow/deny specific tools | Only allow Read, Glob, Grep |
| `file_access` | Control file system access | Block access to `.env` files |
| `output_format` | Require specific output patterns | Must include test coverage report |
| `behavioral` | High-level behavior rules | Require confirmation before destructive actions |
| `temporal` | Time-based constraints | Max 30 minutes per feature |
| `resource` | Resource usage limits | Max 100 file operations |
| `side_effect` | Control external effects | No network requests, no git push |

**Base Constraints (Immutable):**
- Certain tools always denied (e.g., dangerous system commands)
- Critical paths always protected (e.g., `/etc`, system files)
- Maximum privilege ceiling enforced

---

## Quick Start Guide

### Prerequisites

- **Node.js 18+** (required for ES2022 features)
- **tmux** (`brew install tmux` on macOS)
- **Claude Code CLI** (orchestrator interface)

### Installation

```bash
# Build the project
cd /opt/claude-swarm
npm install
npm run build

# Register with Nexora (add to ~/.local/share/nexora/mcp.json)
# The MCP server is now: node /opt/claude-swarm/dist/index.js

# Install the orchestration skill (optional but recommended)
mkdir -p ~/.claude/skills/swarm
cp /opt/claude-swarm/skill/SKILL.md ~/.claude/skills/swarm/
```

### Basic Workflow

```
1. orchestrator_init        # Initialize session with features
2. start_worker             # Launch worker for a feature
3. WAIT 2-3 minutes         # Workers take time!
4. check_worker             # Monitor progress
5. run_verification         # Run tests/build
6. mark_complete            # Mark done (auto-retry on failure)
7. commit_progress          # Git checkpoint
```

### Parallel Execution

```
1. validate_workers         # Pre-flight validation
2. start_parallel_workers   # Launch multiple workers
3. WAIT 2-3 minutes         # Give workers time to work
4. check_all_workers        # Monitor all at once
5. Mark complete as they finish
```

---

## MCP Tools Reference

### Core Orchestration (3 tools)

| Tool | Purpose | Usage |
|------|---------|-------|
| `orchestrator_init` | Start new session with features | First step in any swarm session |
| `orchestrator_status` | Get current state | Use after context compaction |
| `orchestrator_reset` | Clear all state | Nuclear option, kills all workers |

### Worker Management (6 tools)

| Tool | Purpose | Usage |
|------|---------|-------|
| `start_worker` | Launch worker for a feature | One at a time |
| `start_parallel_workers` | Launch multiple workers | For independent features |
| `validate_workers` | Pre-flight validation | Before parallel execution |
| `check_worker` | Monitor worker output | Supports heartbeat + cursor modes |
| `check_all_workers` | Check all active workers | Bulk monitoring |
| `send_worker_message` | Send instructions to running worker | Guidance without restart |

### Competitive Planning (3 tools)

| Tool | Purpose | Usage |
|------|---------|-------|
| `get_feature_complexity` | Analyze complexity score (0-100) | For features scoring 60+ |
| `start_competitive_planning` | Spawn 2 planners | Planner A (safe) vs Planner B (innovative) |
| `evaluate_plans` | Compare and select winner | Pick best approach |

### Confidence Monitoring (2 tools)

| Tool | Purpose | Usage |
|------|---------|-------|
| `get_worker_confidence` | Get detailed confidence breakdown | Multi-signal scoring |
| `set_confidence_threshold` | Configure alert threshold | Default: 35 |

**Confidence Signals:**
- Tool Activity (35%): Read→Edit→Test cycles, stuck loops
- Self-Reported (35%): Worker writes to `.confidence` file
- Output Analysis (30%): Error patterns, frustration language

**Levels:** High (80-100), Medium (50-79), Low (25-49), Critical (0-24)

### Feature Management (5 tools)

| Tool | Purpose | Usage |
|------|---------|-------|
| `mark_complete` | Mark feature done/failed | Auto-retry enabled (3 attempts) |
| `retry_feature` | Reset for manual retry | After fixing issues |
| `run_verification` | Run tests/build commands | Validate implementation |
| `add_feature` | Add discovered work | Extend feature list |
| `set_dependencies` | Define execution order | Ensure correct sequencing |

### Session & Progress (5 tools)

| Tool | Purpose | Usage |
|------|---------|-------|
| `get_progress_log` | Full history (paginated) | Review what happened |
| `get_session_stats` | Success rates and timing | Performance metrics |
| `pause_session` | Pause, stop all workers | Temporary halt |
| `resume_session` | Resume paused session | Continue work |
| `commit_progress` | Git checkpoint | After each success |

### Post-Completion Reviews (5 tools)

| Tool | Purpose | Usage |
|------|---------|-------|
| `run_review` | Manually trigger reviews | ["code", "architecture"] |
| `check_reviews` | Monitor review worker progress | Track completion |
| `get_review_results` | Get aggregated findings | summary/detailed/json |
| `configure_reviews` | Configure automatic reviews | enabled/skipOnFailure |
| `implement_review_suggestions` | Convert findings into features | Create follow-up work |

**Review Types:**
- **Code Review**: Bugs, security, style, test coverage
- **Architecture Review**: Coupling, patterns, scalability

**Severity Levels:** clean, minor, moderate, major, critical

### Repository Setup (3 tools)

| Tool | Purpose | Usage |
|------|---------|-------|
| `setup_analyze` | Analyze repo freshness and missing configs | Discover what's needed |
| `setup_init` | Initialize repo configuration with parallel workers | Apply configs |
| `setup_status` | Check setup progress | Monitor setup state |

**Configuration Types:**

| Type | Files Created | Description |
|------|---------------|-------------|
| **CLAUDE.md** | `CLAUDE.md` | Project guidance for Claude Code |
| **GitHub CI** | `.github/workflows/ci.yml` | Build, test, lint workflows |
| **Dependabot** | `.github/dependabot.yml` | Automated dependency updates |
| **Release Please** | `.github/workflows/release-please.yml` | Automated version bumps |
| **Issue Templates** | `.github/ISSUE_TEMPLATE/*.yml` | Structured reporting |
| **PR Template** | `.github/PULL_REQUEST_TEMPLATE.md` | Consistent PR descriptions |
| **CONTRIBUTING.md** | `CONTRIBUTING.md` | Contribution guidelines |
| **SECURITY.md** | `SECURITY.md` | Security policy and reporting |

### Protocol Management (5 tools)

| Tool | Purpose | Usage |
|------|---------|-------|
| `protocol_register` | Register a protocol | Define constraints |
| `protocol_activate` | Activate for enforcement | Apply to workers |
| `protocol_deactivate` | Deactivate protocol | Stop enforcement |
| `protocol_list` | List all registered protocols | View available |
| `protocol_status` | Get protocol details and violations | Inspect state |

### Protocol Enforcement (4 tools)

| Tool | Purpose | Usage |
|------|---------|-------|
| `validate_feature_protocols` | Check feature against active protocols | Pre-spawn validation |
| `get_violations` | Get recorded violations (paginated) | Review violations |
| `resolve_violation` | Mark violation as resolved | Clear false positives |
| `get_audit_log` | Get protocol audit history | Track operations |

### LLM Protocol Generation (5 tools)

| Tool | Purpose | Usage |
|------|---------|-------|
| `get_base_constraints` | View immutable constraints | Security boundaries |
| `propose_protocol` | Submit a protocol proposal | Worker-generated |
| `review_proposals` | List pending proposals with risk scores | Review queue |
| `approve_protocol` | Approve a protocol proposal | Activate |
| `reject_protocol` | Reject a protocol proposal | Discard |

### Protocol Networking (4 tools)

| Tool | Purpose | Usage |
|------|---------|-------|
| `export_protocols` | Export to shareable bundle | Distribute |
| `import_protocols` | Import from bundle | Load |
| `sync_protocols` | Sync with peer instances | Bidirectional sync |
| `discover_protocols` | Discover peer MCP instances | Find peers |

### Context Management (4 tools)

| Tool | Purpose | Usage |
|------|---------|-------|
| `enrich_feature` | Auto-enrich with docs and code | Add context |
| `set_feature_context` | Manually set feature context | Customize context |
| `get_feature_graph` | View dependency graph | Visualize relationships |
| `route_feature` | Configure worker routing preferences | Worker selection |

---

## Project Structure

```
/opt/claude-swarm/
├── src/
│   ├── index.ts                      # MCP server entry point (55+ tools)
│   ├── state/
│   │   └── manager.ts                # Session state persistence
│   ├── workers/
│   │   ├── manager.ts                # tmux worker management
│   │   ├── confidence.ts             # Confidence scoring
│   │   ├── review-manager.ts         # Post-completion reviews
│   │   └── enforcement-integration.ts
│   ├── protocols/
│   │   ├── schema.ts                 # Zod schemas
│   │   ├── registry.ts               # Protocol storage
│   │   ├── enforcement.ts            # Constraint validation
│   │   ├── resolver.ts               # Protocol merging
│   │   ├── base-constraints.ts       # Immutable security rules
│   │   ├── proposal-manager.ts       # LLM-generated proposals
│   │   ├── proposal-validator.ts     # Deep validation
│   │   ├── constraint-evaluator.ts   # Rule evaluation engine
│   │   ├── generator.ts              # Protocol generation
│   │   └── network/
│   │       ├── distributor.ts        # Bundle export/import
│   │       ├── index.ts
│   │       └── sync.ts               # Push/pull sync
│   ├── setup/
│   │   ├── manager.ts                # Repo setup orchestration
│   │   ├── detector.ts               # Platform detection
│   │   ├── analyzer.ts               # Project structure analysis
│   │   ├── generator.ts              # Config file generators
│   │   ├── manager.ts
│   │   ├── merge-strategy.ts
│   │   └── platforms.ts
│   ├── context/
│   │   └── enricher.ts               # Feature context enrichment
│   ├── dashboard/
│   │   ├── server.ts                 # Express + SSE server
│   │   └── public/
│   │       └── index.html            # Dashboard UI
│   └── utils/
│       ├── security.ts               # Input validation
│       ├── complexity-detector.ts    # Feature complexity analysis
│       ├── plan-evaluator.ts         # Plan comparison
│       ├── feature-generator.ts      # Auto-generate feature lists
│       └── format.ts                 # Output formatting
├── skill/
│   └── SKILL.md                      # Orchestration skill guide
├── examples/
│   ├── hooks-config.json             # Example hooks config
│   ├── orchestrator-check-incomplete.sh
│   └── orchestrator-resume.sh
├── .github/
│   ├── workflows/
│   │   └── ci.yml                    # CI workflow
│   └── ISSUE_TEMPLATE/
│       ├── bug_report.md
│       ├── feature_request.md
│       └── question.md
├── CLAUDE.md                         # Project-specific guidance
├── README.md                         # Main documentation
├── CONTRIBUTING.md                   # Contribution guidelines
├── NEXORA.md                         # This file
├── package.json
├── tsconfig.json
└── vitest.config.ts                  # Test configuration (if added)
```

---

## State Files Created Per Project

```
your-project/
├── .claude/orchestrator/
│   ├── state.json                    # Main session state (Zod-validated)
│   ├── feature_list.json             # Feature status for structured access
│   ├── protocols/
│   │   ├── registry.json             # Protocol definitions
│   │   ├── active.json               # Currently active protocols
│   │   ├── violations.json           # Recorded violations
│   │   ├── audit.json                # Protocol operation audit log
│   │   └── proposals/                # Pending LLM-generated proposals
│   ├── sync/                         # Cross-instance protocol sync
│   └── workers/
│       ├── *.prompt                  # Worker prompts (mode 0600)
│       ├── *.log                     # Worker output logs
│       ├── *.done                    # Completion marker files
│       ├── *.status                  # Worker status JSON
│       ├── *.plan.json               # Competitive planning results
│       ├── *.confidence              # Self-reported confidence files
│       ├── code-review.findings.json # Code review results
│       └── architecture-review.findings.json # Architecture review results
├── claude-progress.txt               # Human-readable progress log
└── init.sh                           # Environment setup script (mode 0700)
```

---

## Development Commands

```bash
npm run build         # Compile TypeScript and copy dashboard assets
npm run dev           # Watch mode for TypeScript compilation
npm start             # Run the compiled MCP server
npm run inspector     # Debug with MCP Inspector
npx tsc --noEmit      # Type-check without emitting (CI validation)
```

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `DASHBOARD_PORT` | `3456` | Dashboard HTTP port |
| `ENABLE_DASHBOARD` | `true` | Set to `false` to disable |

## Debugging

```bash
# View active tmux sessions
tmux list-sessions

# Attach to a worker session
tmux attach -t cc-worker-feature-1-abc123

# Capture worker output
tmux capture-pane -t <session-name> -p -S -100

# Debug MCP protocol with inspector
npm run inspector

# View dashboard (when MCP server is running)
open http://localhost:3456
```

---

## Best Practices

### Feature Decomposition

- **Size**: Each feature should be completable in 15-60 minutes
- **Independence**: Features should be independently testable
- **Ordering**: Order features by dependency (foundations first)
- **Dependencies**: Use `set_dependencies` to enforce ordering

### Parallel Execution

- **Identify** features that can run in parallel (no shared dependencies)
- **Validate** with `validate_workers` before starting
- **Monitor** all workers with `check_all_workers`
- **Complete** features as they finish independently

### Monitoring Workers

- **Wait 2-3 minutes** after starting before first check
- **Use sleep 120** or **sleep 180** between operations
- **Workers typically complete** features in 5-10 minutes
- **If stuck after 10+ minutes**, review output carefully
- **Use `send_worker_message`** to provide guidance without restarting

### Efficient Monitoring with Heartbeat Mode

```bash
check_worker(featureId, heartbeat: true)
# Returns: status, lastToolUsed, lastFile, lastActivity, runningFor
```

### Error Recovery

- **Auto-retry** is enabled by default (3 attempts) via `mark_complete`
- **Use `retry_feature`** to manually reset after fixing issues
- **Use `add_feature`** if you discover missing work

### Session Management

- **Use `pause_session`** to gracefully stop work
- **Use `resume_session`** to continue where you left off
- **Use `get_session_stats`** for success rates and timing

### Git Checkpoints

- **Commit after each successful feature** with `commit_progress`
- **Use descriptive commit messages**
- **Enables easy rollback** if needed

---

## Security Features

- **Path traversal protection** - All file paths validated against project directory
- **Cryptographically secure IDs** - Uses `crypto.randomUUID()`
- **Symlink escape prevention** - Real paths validated before file operations
- **Fail-closed enforcement** - Unknown constraint types block by default
- **Command allowlist** - Only safe verification commands allowed
- **No shell injection** - Uses `execFile` with arguments, prompts via files
- **Input validation** - All inputs validated with Zod schemas
- **Base constraints** - Immutable security rules cannot be overridden
- **Review worker isolation** - Read-only tools (no Bash access)

---

## Limitations

- **Requires tmux** (WSL on Windows)
- **Workers use your Claude Code subscription**
- **Protocol enforcement is observational** (monitors but doesn't intercept tool calls)
- **Complex feature detection is heuristic-based**

---

## Local Project Status

### Current PRs (as of 2025-12-29)

| PR | Description | Status | Branch |
|----|-------------|--------|--------|
| PR #9 | Test Coverage Foundation | MERGED ✅ | feature/test-coverage |
| PR #10 | Feature Validation Framework | OPEN | feature/feature-validation |
| PR #11 | Git Verification | OPEN | feature/git-verification |
| PR #12 | Structured Prompt Templates | OPEN | feature/prompt-templates |
| PR #13 | Enhanced State Schemas | OPEN | feature/state-schemas |
| PR #14 | Confidence Tests | OPEN | feature/confidence-tests |

### Local TODO

**Critical Issues:**
- [ ] WorkerManager: Clean up `monitorInterval` on server shutdown
- [ ] Dashboard: More aggressive SSE client cleanup on disconnects
- [ ] `sanitizeOutput()`: Escape regex special chars in home dir replacement
- [ ] Dashboard: Add rate limiting to API endpoints

**Testing Gaps:**
- ❌ WorkerManager (tmux integration, completion monitoring)
- ❌ Security utilities (path traversal, command validation)
- ❌ Complexity detector
- ❌ Plan evaluator
- ❌ Dashboard server (API endpoints, SSE)
- ❌ StateManager (atomic writes, corruption recovery)

**Error Handling:**
- Standardize to Result<T, Error> or consistent patterns

---

## TypeScript Configuration

- **Target**: ES2022 with NodeNext module resolution
- **Strict mode** enabled - all strict type checks enforced
- **Declaration files** generated for type exports
- **Imports require `.js` extension** for ESM compatibility (e.g., `import { foo } from './bar.js'`)

---

## Design Patterns

1. **Persistent State Outside Context** - State survives Claude's context compaction via the MCP server
2. **Worker Isolation** - Each worker runs in its own tmux session with controlled tool access
3. **Atomic File Operations** - State and progress files use write-to-temp-then-rename pattern
4. **Command Allowlist** - Only safe verification commands can be executed
5. **File-Based Prompt Passing** - Worker prompts written to `.prompt` files, not shell strings
6. **Fail-Closed Enforcement** - Unknown constraint types block by default in protocol validation
7. **Immutable Base Constraints** - Security boundaries frozen at module load, cannot be overridden
8. **SSE for Real-Time Updates** - Dashboard uses Server-Sent Events for live worker monitoring

---

## Web Dashboard

A real-time web dashboard is available at `http://localhost:3456`:

- **Session Overview** - Progress bar, feature counts, session statistics
- **Feature Cards** - Status, dependencies, worker assignment
- **Live Terminal Output** - Real-time streaming with ANSI color support
- **Review Worker Progress** - Code and architecture review visibility
- **Dark Mode** - Automatic theme detection

---

## Inspiration & References

- [Anthropic's "Effective harnesses for long-running agents"](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)
- [MAKER: "Solving a Million-Step LLM Task with Zero Errors"](https://arxiv.org/abs/2511.09030)
- [Multi-Agent Collaboration via Evolving Orchestration](https://arxiv.org/abs/2505.19591)
- [AFlow: Automatic Workflow Optimization](https://arxiv.org/abs/2410.10762)
- [AgentsNet: Coordinating Multi-Agent Networks](https://arxiv.org/html/2507.08616v1)

---

## License

MIT License

---

## Contact & Support

- **Repository**: https://github.com/cj-vana/claude-swarm
- **Issues**: https://github.com/cj-vana/claude-swarm/issues
- **Contributing**: See [CONTRIBUTING.md](CONTRIBUTING.md)
