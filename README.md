# Claude Swarm

An MCP server for orchestrating parallel Claude Code worker swarms with protocol-based behavioral governance. Enables multi-hour autonomous coding sessions with persistent state, parallel workers, and runtime enforcement of behavioral constraints.

## Features

### Worker Orchestration
- **Persistent State** - Session state survives context compaction via MCP server
- **Parallel Workers** - Run multiple Claude Code workers simultaneously via tmux
- **Competitive Planning** - Complex features get two competing implementation plans
- **Confidence Monitoring** - Multi-signal scoring detects struggling workers
- **Auto-retry** - Failed features automatically retry with configurable limits
- **Feature Dependencies** - Define execution order between features

### Protocol-Based Governance
- **Behavioral Protocols** - Define constraints on what workers can/cannot do
- **Pre-spawn Validation** - Verify protocols allow task before worker starts
- **Continuous Monitoring** - Track constraint violations during execution
- **LLM-Generated Protocols** - Workers can propose new protocols (validated against base constraints)
- **Cross-instance Sync** - Share protocols across MCP instances

### Monitoring
- **Real-time Dashboard** - Web UI at `http://localhost:3456`
- **Live Terminal Streaming** - Watch worker output in real-time
- **Violation Tracking** - Audit log of all protocol violations
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

### Basic Usage

Tell Claude to use the swarm:

```
Use /swarm to build a REST API with authentication, user management, and tests
```

Or manually orchestrate:

```
1. orchestrator_init - Initialize session with features
2. start_parallel_workers - Launch workers for multiple features
3. check_all_workers - Monitor all workers at once
4. mark_complete - Mark features done (auto-retry on failure)
5. commit_progress - Git checkpoint
```

## Protocol System

Protocols define behavioral constraints that govern worker actions. This enables safe autonomous operation with clear boundaries.

### Constraint Types

| Type | Description | Example |
|------|-------------|---------|
| `tool_restriction` | Allow/deny specific tools | Only allow Read, Glob, Grep |
| `file_access` | Control file system access | Block access to `.env` files |
| `output_format` | Require specific output patterns | Must include test coverage report |
| `behavioral` | High-level behavior rules | Require confirmation before destructive actions |
| `temporal` | Time-based constraints | Max 30 minutes per feature |
| `resource` | Resource usage limits | Max 100 file operations |
| `side_effect` | Control external effects | No network requests, no git push |

### Example Protocol

```json
{
  "id": "safe-refactoring-v1",
  "name": "Safe Refactoring Protocol",
  "version": "1.0.0",
  "priority": 100,
  "constraints": [
    {
      "id": "no-secrets",
      "type": "file_access",
      "rule": {
        "type": "file_access",
        "deniedPaths": ["**/.env", "**/secrets.*", "**/credentials.json"]
      },
      "severity": "error",
      "message": "Cannot access files that may contain secrets"
    },
    {
      "id": "read-only-config",
      "type": "file_access",
      "rule": {
        "type": "file_access",
        "allowedPaths": ["src/**/*.ts"],
        "deniedPaths": ["**/config/**"]
      },
      "severity": "warning",
      "message": "Avoid modifying configuration files during refactoring"
    }
  ],
  "enforcement": {
    "mode": "strict",
    "preExecution": true,
    "postExecution": true,
    "onViolation": "block"
  }
}
```

### Protocol Workflow

```
1. protocol_register - Register a new protocol
2. protocol_activate - Activate for enforcement
3. start_worker - Workers are validated against active protocols
4. [worker runs with continuous monitoring]
5. get_violations - Review any constraint violations
```

### LLM-Generated Protocols

Workers can propose new protocols that are validated against immutable base constraints:

```
1. get_base_constraints - View immutable security rules
2. propose_protocol - Worker submits proposal
3. review_proposals - See pending proposals with risk scores
4. approve_protocol / reject_protocol - Human review for high-risk
```

**Base Constraints** (cannot be overridden):
- Certain tools always denied (e.g., dangerous system commands)
- Critical paths always protected (e.g., `/etc`, system files)
- Maximum privilege ceiling enforced

## Competitive Planning

For complex features, spawn two planners with different approaches:

```
1. get_feature_complexity(featureId)     # Analyze complexity (0-100)
2. start_competitive_planning(featureId) # Spawn Planner A & B
3. [wait for planners to complete]
4. evaluate_plans(featureId)             # Compare and pick winner
5. start_worker(featureId)               # Implement with winning plan
```

- **Planner A**: Incremental, safe approach
- **Planner B**: Elegant, innovative approach
- **Threshold**: Features scoring 60+ trigger competitive planning

## Confidence Monitoring

Real-time confidence scoring detects struggling workers:

| Signal | Weight | Measures |
|--------|--------|----------|
| Tool Activity | 35% | Read→Edit→Test cycles, stuck loops |
| Self-Reported | 35% | Worker writes to `.confidence` file |
| Output Analysis | 30% | Error patterns, frustration language |

**Levels**: High (80-100), Medium (50-79), Low (25-49), Critical (0-24)

```
set_confidence_threshold(35)       # Configure alert level
get_worker_confidence(featureId)   # Get detailed breakdown
```

## Architecture

```
┌────────────────────────────────────────────────────────────────┐
│                        MCP Server                               │
│            (Persistent state, survives compaction)              │
│                                                                 │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐         │
│  │    State     │  │    Worker    │  │   Protocol   │         │
│  │   Manager    │  │   Manager    │  │   Registry   │         │
│  └──────────────┘  └──────────────┘  └──────────────┘         │
│         │                 │                  │                  │
│  ┌──────┴─────────────────┴──────────────────┴───────────────┐ │
│  │  Enforcement Engine  │  Resolver  │  Context Enricher     │ │
│  └───────────────────────────────────────────────────────────┘ │
│                              │                                  │
│  ┌───────────────────────────┴───────────────────────────────┐ │
│  │  Dashboard  │  Complexity Detector  │  Plan Evaluator     │ │
│  └───────────────────────────────────────────────────────────┘ │
└────────────────────────────────┬───────────────────────────────┘
                                 │ MCP Protocol
┌────────────────────────────────┼───────────────────────────────┐
│                          Claude Code                            │
│                                                                 │
│     Context compacts → Just call orchestrator_status            │
│     Protocol violations → Automatic blocking/warning            │
└─────────────────────────────────────────────────────────────────┘
```

## MCP Tools Reference

### Core Orchestration (3 tools)
| Tool | Description |
|------|-------------|
| `orchestrator_init` | Start session with task and features |
| `orchestrator_status` | Get current state (use after compaction) |
| `orchestrator_reset` | Clear state and kill all workers |

### Worker Management (6 tools)
| Tool | Description |
|------|-------------|
| `start_worker` | Launch worker for a feature |
| `start_parallel_workers` | Launch multiple workers simultaneously |
| `validate_workers` | Pre-flight validation before parallel execution |
| `check_worker` | Get worker output (supports heartbeat mode) |
| `check_all_workers` | Check all active workers at once |
| `send_worker_message` | Send instructions to running worker |

### Competitive Planning (3 tools)
| Tool | Description |
|------|-------------|
| `get_feature_complexity` | Analyze complexity score |
| `start_competitive_planning` | Spawn 2 planners with different approaches |
| `evaluate_plans` | Compare plans and select winner |

### Confidence Monitoring (2 tools)
| Tool | Description |
|------|-------------|
| `get_worker_confidence` | Get detailed confidence breakdown |
| `set_confidence_threshold` | Configure alert threshold |

### Feature Management (5 tools)
| Tool | Description |
|------|-------------|
| `mark_complete` | Mark feature done/failed (auto-retry) |
| `retry_feature` | Reset failed feature for retry |
| `run_verification` | Run tests/build commands |
| `add_feature` | Add discovered work |
| `set_dependencies` | Define feature dependencies |

### Session & Progress (5 tools)
| Tool | Description |
|------|-------------|
| `get_progress_log` | View history (paginated) |
| `get_session_stats` | Success rates and timing |
| `pause_session` | Pause and stop all workers |
| `resume_session` | Resume paused session |
| `commit_progress` | Create git checkpoint |

### Protocol Management (5 tools)
| Tool | Description |
|------|-------------|
| `protocol_register` | Register a new protocol |
| `protocol_activate` | Activate protocol for enforcement |
| `protocol_deactivate` | Deactivate protocol |
| `protocol_list` | List all registered protocols |
| `protocol_status` | Get protocol activation status |

### Protocol Enforcement (4 tools)
| Tool | Description |
|------|-------------|
| `validate_feature_protocols` | Check if feature can run under active protocols |
| `get_violations` | Get recorded violations (paginated) |
| `resolve_violation` | Mark violation as resolved |
| `get_audit_log` | Get protocol audit history |

### LLM Protocol Generation (5 tools)
| Tool | Description |
|------|-------------|
| `get_base_constraints` | View immutable base constraints |
| `propose_protocol` | Submit a protocol proposal |
| `review_proposals` | List pending proposals with risk scores |
| `approve_protocol` | Approve a protocol proposal |
| `reject_protocol` | Reject a protocol proposal |

### Protocol Networking (4 tools)
| Tool | Description |
|------|-------------|
| `export_protocols` | Export protocols to file |
| `import_protocols` | Import protocols from file |
| `sync_protocols` | Sync with other instances |
| `discover_instances` | Discover other MCP instances |

## Files Created

```
your-project/
├── .claude/orchestrator/
│   ├── state.json              # Session state
│   ├── feature_list.json       # Feature status
│   ├── protocols/
│   │   ├── registry.json       # Protocol definitions
│   │   ├── active.json         # Active protocols
│   │   ├── violations.json     # Violation records
│   │   └── proposals/          # Pending proposals
│   ├── sync/                   # Cross-instance sync
│   └── workers/
│       ├── *.prompt            # Worker prompts
│       ├── *.log               # Worker output logs
│       ├── *.plan.json         # Competitive plans
│       └── *.confidence        # Self-reported confidence
├── claude-progress.txt         # Human-readable log
└── init.sh                     # Environment setup
```

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `DASHBOARD_PORT` | `3456` | Dashboard HTTP port |
| `ENABLE_DASHBOARD` | `true` | Set `false` to disable |

## Security

- **Path traversal protection** - All file paths validated against project directory
- **Cryptographically secure IDs** - Uses `crypto.randomUUID()`
- **Symlink escape prevention** - Real paths validated before file operations
- **Fail-closed enforcement** - Unknown constraint types block by default
- **Command allowlist** - Only safe verification commands allowed
- **No shell injection** - Uses `execFile` with arguments, prompts via files
- **Input validation** - All inputs validated with Zod schemas
- **Base constraints** - Immutable security rules cannot be overridden

## Inspiration

- [Anthropic's "Effective harnesses for long-running agents"](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)
- [MAKER: "Solving a Million-Step LLM Task with Zero Errors"](https://arxiv.org/abs/2511.09030)
- [Multi-Agent Collaboration via Evolving Orchestration](https://arxiv.org/abs/2505.19591)
- [AFlow: Automatic Workflow Optimization](https://arxiv.org/abs/2410.10762)
- [AgentsNet: Coordinating Multi-Agent Networks](https://arxiv.org/html/2507.08616v1)

## Limitations

- Requires tmux (WSL on Windows)
- Workers use your Claude Code subscription
- Protocol enforcement is observational (monitors but doesn't intercept tool calls)
- Complex feature detection is heuristic-based

## Contributing

Contributions welcome! Open an issue or PR.

## License

MIT
