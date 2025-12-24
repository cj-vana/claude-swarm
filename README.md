# Claude Swarm

An MCP server for orchestrating parallel Claude Code worker swarms. Enables multi-hour coding tasks with persistent state, parallel workers, real-time dashboard monitoring, and graceful recovery after context compaction.

## Features

- **Persistent State** - Session state survives context compaction
- **Parallel Workers** - Run multiple Claude Code workers simultaneously via tmux
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

## Web Dashboard

Real-time monitoring dashboard at **http://localhost:3456**

### Dashboard Features
- Live updates via Server-Sent Events (SSE)
- Session overview with progress bar
- Feature cards with status and attempts
- Worker terminal output streaming
- Activity log with timestamps
- Dark mode (persists in localStorage)
- Mobile responsive layout

### Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `DASHBOARD_PORT` | `3456` | Dashboard port |
| `ENABLE_DASHBOARD` | `true` | Set `false` to disable |

### API Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /` | Dashboard page |
| `GET /api/status` | Session status |
| `GET /api/features` | Feature list |
| `GET /api/workers` | Worker statuses |
| `GET /api/logs` | Progress log |
| `GET /api/stats` | Statistics |
| `GET /api/events` | SSE stream |
| `GET /api/workers/:id/output` | Live worker output |

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

| Tool | Description |
|------|-------------|
| `orchestrator_init` | Start session with task and features |
| `orchestrator_status` | Get current state (use after compaction) |
| `start_worker` | Launch worker for a feature |
| `start_parallel_workers` | Launch multiple workers simultaneously |
| `validate_workers` | Pre-flight validation before parallel execution |
| `check_worker` | Get worker output (supports heartbeat mode) |
| `check_all_workers` | Check all active workers at once |
| `send_worker_message` | Send instructions to running worker |
| `mark_complete` | Mark feature done/failed (auto-retry enabled) |
| `retry_feature` | Reset failed feature for retry |
| `run_verification` | Run tests/build commands |
| `add_feature` | Add discovered work |
| `set_dependencies` | Define feature dependencies |
| `get_progress_log` | View full history |
| `get_session_stats` | Success rates and timing |
| `pause_session` | Pause and stop all workers |
| `resume_session` | Resume paused session |
| `commit_progress` | Create git checkpoint |
| `orchestrator_reset` | Clear state and kill workers |

## Skill Installation

Install the skill for guided swarm orchestration:

```bash
mkdir -p ~/.claude/skills/swarm
cp skill/SKILL.md ~/.claude/skills/swarm/
```

Then use `/swarm` to invoke.

## Files Created

```
your-project/
├── .claude/orchestrator/
│   ├── state.json          # Session state
│   ├── feature_list.json   # Feature status
│   └── workers/            # Worker logs
├── claude-progress.txt     # Human-readable log
└── init.sh                 # Environment setup
```

## Security

- **Command allowlist** - Only safe verification commands (npm test, pytest, etc.)
- **Path validation** - Prevents directory traversal
- **Input sanitization** - All inputs validated
- **No shell injection** - Uses `execFile` with arguments

## Inspiration

- [Anthropic's "Effective harnesses for long-running agents"](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)
- [MAKER: "Solving a Million-Step LLM Task with Zero Errors"](https://arxiv.org/abs/2511.09030)
- [Multi-Agent Collaboration via Evolving Orchestration](https://arxiv.org/abs/2505.19591)

## Limitations

- Requires tmux (WSL on Windows)
- Workers use your Claude Code subscription
- Feature decomposition is manual

## Future Ideas

- [ ] Automatic feature decomposition with voting
- [ ] Built-in Puppeteer integration for E2E testing
- [ ] Cost tracking and budget limits
- [ ] Integration with CI/CD pipelines
- [ ] Confidence-based worker monitoring
- [ ] Human-in-the-loop approval gates

## Contributing

Contributions welcome! Open an issue or PR.

## License

MIT
