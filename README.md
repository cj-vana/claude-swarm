# Claude Swarm

An MCP server for orchestrating parallel Claude Code worker swarms. Enables multi-hour coding tasks with persistent state, parallel workers, competitive planning, confidence monitoring, and graceful recovery after context compaction.

## Features

- **Persistent State** - Session state survives context compaction
- **Parallel Workers** - Run multiple Claude Code workers simultaneously via tmux
- **Competitive Planning** - Complex features get two competing implementation plans; the best wins
- **Confidence Monitoring** - Multi-signal confidence scoring alerts when workers struggle
- **Real-time Dashboard** - Web UI for monitoring at `http://localhost:3456`
- **Auto-retry** - Failed features automatically retry (configurable)
- **Feature Dependencies** - Define execution order between features
- **Live Terminal Streaming** - Watch worker output in real-time
- **Git Checkpoints** - Commit progress after each feature

## Quick Start

### Prerequisites

- Node.js 18+
- tmux (`brew install tmux` on macOS)
- Claude Code CLI

### Installation

```bash
git clone https://github.com/cj-vana/claude-swarm.git
cd claude-swarm
npm install
npm run build

# Add to Claude Code
claude mcp add claude-swarm --scope user -- node $(pwd)/dist/index.js

# Install the skill (optional but recommended)
mkdir -p ~/.claude/skills/swarm && cp skill/SKILL.md ~/.claude/skills/swarm/
```

### Usage

Tell Claude to use the swarm:

```
Use /swarm to build a REST API with authentication, user management, and tests
```

Or manually:

```
1. orchestrator_init - Initialize session with features
2. start_parallel_workers - Launch workers for multiple features
3. check_all_workers - Monitor all workers at once
4. mark_complete - Mark features done (auto-retry on failure)
5. commit_progress - Git checkpoint
```

## Competitive Planning

For complex features, the orchestrator can spawn two planners with different approaches:

```
1. get_feature_complexity(featureId)     # Analyze complexity (score 0-100)
2. start_competitive_planning(featureId) # Spawn Planner A & B
3. [wait for planners to complete]
4. evaluate_plans(featureId)             # Compare and pick winner
5. start_worker(featureId)               # Implement with winning plan
```

**How it works:**
- **Complexity Detection** - Analyzes description for keywords (refactor, migrate, integrate), scope indicators (multiple, all, system-wide), and dependencies
- **Two Approaches** - Planner A uses incremental/safe approach; Planner B explores elegant alternatives
- **Plan Evaluation** - Scores on completeness (25), feasibility (25), risk awareness (20), clarity (15), efficiency (15)
- **Winner Implements** - Selected plan provides context for the implementation worker

Threshold: Features scoring 60+ trigger competitive planning automatically.

## Confidence Monitoring

Real-time confidence scoring detects when workers are struggling:

```
1. set_confidence_threshold(35)       # Configure alert level (default: 35%)
2. get_worker_confidence(featureId)   # Get detailed breakdown
3. check_worker with heartbeat: true  # Includes confidence automatically
```

**Three Signals Combined:**

| Signal | Weight | What it Measures |
|--------|--------|------------------|
| Tool Activity | 35% | Read→Edit→Test cycles, stuck loops, idle periods |
| Self-Reported | 35% | Worker writes confidence to `.confidence` file |
| Output Analysis | 30% | Error patterns, success indicators, frustration language |

**Confidence Levels:**
- **High (80-100)** - On track, progressing well
- **Medium (50-79)** - Normal operation
- **Low (25-49)** - May need guidance
- **Critical (0-24)** - Immediate attention required

When confidence drops below threshold, alerts are logged to the progress log.

## Web Dashboard

Real-time monitoring dashboard at **http://localhost:3456**

- Live updates via Server-Sent Events (SSE)
- Session overview with progress bar
- Feature cards with status, attempts, and confidence
- Worker terminal output streaming
- Activity log with timestamps
- Dark mode (persists in localStorage)

### Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `DASHBOARD_PORT` | `3456` | Dashboard port |
| `ENABLE_DASHBOARD` | `true` | Set `false` to disable |

## How It Works

```
┌─────────────────────────────────────────────────────────────┐
│                      MCP Server                              │
│       (Persistent state, survives context compaction)        │
│                                                              │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐    │
│  │  State   │  │  tmux    │  │ Verify   │  │ Dashboard│    │
│  │ Manager  │  │ Workers  │  │ Runner   │  │  Server  │    │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘    │
│        │              │                                      │
│  ┌─────┴──────────────┴─────────────────────────────────┐   │
│  │  Complexity Detector  │  Plan Evaluator  │ Confidence │   │
│  └───────────────────────────────────────────────────────┘   │
└──────────────────────────┬──────────────────────────────────┘
                           │ MCP Protocol
┌──────────────────────────┼──────────────────────────────────┐
│                    Claude Code                               │
│                                                              │
│   Context compacts → Just call orchestrator_status          │
│   State is preserved in the MCP server                      │
└─────────────────────────────────────────────────────────────┘
```

## MCP Tools

### Core Orchestration
| Tool | Description |
|------|-------------|
| `orchestrator_init` | Start session with task and features |
| `orchestrator_status` | Get current state (use after compaction) |
| `orchestrator_reset` | Clear state and kill workers |

### Worker Management
| Tool | Description |
|------|-------------|
| `start_worker` | Launch worker for a feature |
| `start_parallel_workers` | Launch multiple workers simultaneously |
| `validate_workers` | Pre-flight validation before parallel execution |
| `check_worker` | Get worker output (supports heartbeat mode) |
| `check_all_workers` | Check all active workers at once |
| `send_worker_message` | Send instructions to running worker |

### Competitive Planning
| Tool | Description |
|------|-------------|
| `get_feature_complexity` | Analyze complexity and get planning recommendation |
| `start_competitive_planning` | Spawn 2 planners for competing implementation plans |
| `evaluate_plans` | Compare plans and select winner |

### Confidence Monitoring
| Tool | Description |
|------|-------------|
| `get_worker_confidence` | Get detailed confidence breakdown for a worker |
| `set_confidence_threshold` | Configure alert threshold (default: 35%) |

### Feature Management
| Tool | Description |
|------|-------------|
| `mark_complete` | Mark feature done/failed (auto-retry enabled) |
| `retry_feature` | Reset failed feature for retry |
| `run_verification` | Run tests/build commands |
| `add_feature` | Add discovered work |
| `set_dependencies` | Define feature dependencies |

### Session & Progress
| Tool | Description |
|------|-------------|
| `get_progress_log` | View full history |
| `get_session_stats` | Success rates and timing |
| `pause_session` | Pause and stop all workers |
| `resume_session` | Resume paused session |
| `commit_progress` | Create git checkpoint |

## Files Created

```
your-project/
├── .claude/orchestrator/
│   ├── state.json          # Session state
│   ├── feature_list.json   # Feature status
│   └── workers/
│       ├── *.prompt        # Worker prompts
│       ├── *.log           # Worker output logs
│       ├── *.plan.json     # Competitive plans
│       └── *.confidence    # Self-reported confidence
├── claude-progress.txt     # Human-readable log
└── init.sh                 # Environment setup
```

## Security

- **Command allowlist** - Only safe verification commands (npm test, pytest, etc.)
- **Path validation** - Prevents directory traversal
- **Input sanitization** - All inputs validated with Zod schemas
- **No shell injection** - Uses `execFile` with arguments, prompts via files

## Inspiration

- [Anthropic's "Effective harnesses for long-running agents"](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)
- [MAKER: "Solving a Million-Step LLM Task with Zero Errors"](https://arxiv.org/abs/2511.09030)
- [Multi-Agent Collaboration via Evolving Orchestration](https://arxiv.org/abs/2505.19591)

## Limitations

- Requires tmux (WSL on Windows)
- Workers use your Claude Code subscription
- Complex feature detection is heuristic-based

## Future Ideas

- [ ] Built-in Puppeteer integration for E2E testing
- [ ] Cost tracking and budget limits
- [ ] Integration with CI/CD pipelines
- [ ] Human-in-the-loop approval gates
- [ ] Multi-model support (different models for planning vs implementation)

## Contributing

Contributions welcome! Open an issue or PR.

## License

MIT
