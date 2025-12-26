# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build and Development Commands

```bash
npm run build         # Compile TypeScript and copy dashboard assets
npm run dev           # Watch mode for TypeScript compilation
npm start             # Run the compiled MCP server
npm run inspector     # Debug with MCP Inspector
npx tsc --noEmit      # Type-check without emitting (CI validation)
```

**Install the MCP server** into Claude Code:
```bash
claude mcp add claude-swarm --scope user -- node $(pwd)/dist/index.js
```

**Install the /swarm skill** for guided orchestration:
```bash
mkdir -p ~/.claude/skills/swarm && cp skill/SKILL.md ~/.claude/skills/swarm/
```

## Architecture Overview

This is an MCP (Model Context Protocol) server that orchestrates parallel Claude Code worker swarms via tmux sessions. The pattern separates concerns between an orchestrator (which plans and monitors) and workers (which implement individual features).

### Core Components

**src/index.ts** - MCP server entry point registering 50+ tools. All tool handlers are defined inline. Tool schemas use Zod for validation. The file is structured by tool category: core orchestration, worker management, competitive planning, confidence monitoring, feature management, session control, post-completion reviews, protocol management, and protocol networking.

**src/state/manager.ts** - Persistent state management using the "notebook pattern". Stores session state in `.claude/orchestrator/state.json` with atomic writes (temp file + rename). Also generates `claude-progress.txt` for human readability and `init.sh` for environment setup. Manages feature context (`FeatureContext`), routing config, and protocol bindings per feature.

**src/workers/manager.ts** - Manages Claude Code worker sessions via tmux. Key security pattern: prompts are passed via files (not shell strings) to prevent injection. Includes completion monitoring (10s polling), heartbeat tracking, and conflict analysis for parallel execution. Supports competitive planning mode with dual planners.

**src/workers/confidence.ts** - Multi-signal confidence scoring combining tool activity patterns (35%), self-reported confidence (35%), and output analysis (30%). Detects struggling workers via stuck loops, error patterns, and frustration language.

**src/workers/enforcement-integration.ts** - Hooks protocol enforcement into the worker lifecycle. Validates constraints before worker spawns and monitors during execution.

**src/workers/review-manager.ts** - Orchestrates post-completion code and architecture reviews. Parses worker logs to identify modified files, builds review prompts with session context, and aggregates findings into structured JSON. Review workers have read-only tool access (no Bash).

### Protocol Governance System

The protocol system enables behavioral constraints on workers. Located in `src/protocols/`:

**schema.ts** - Zod schemas defining `Protocol`, `ProtocolConstraint`, constraint types (tool_restriction, file_access, output_format, behavioral, temporal, resource, side_effect), and `BaseConstraints`. All protocol data is validated against these schemas.

**registry.ts** - Protocol storage, activation status, and violation tracking. Persists to `.claude/orchestrator/protocols/`. Implements `ProtocolRegistryLike` interface for resolver compatibility. Maintains audit log of all protocol operations.

**enforcement.ts** - Pre/post execution validation engine. Validates worker actions against active protocol constraints. Supports learning mode for protocol development.

**resolver.ts** - Resolves effective constraints by merging multiple active protocols, handling inheritance (`extends`), and conflict resolution based on priority.

**base-constraints.ts** - Immutable security boundaries (frozen at runtime). Defines prohibited tools (rm -rf, sudo, etc.), prohibited paths (/etc, ~/.ssh, etc.), and maximum privilege ceiling. LLM-generated protocols cannot override these.

**proposal-manager.ts** - Manages LLM-generated protocol proposals. Validates against base constraints, calculates risk scores, and tracks approval workflow (pending → reviewing → approved/rejected).

**proposal-validator.ts** - Deep validation of protocol proposals including constraint rule verification and risk scoring algorithm.

**constraint-evaluator.ts** - Rule evaluation engine that executes constraint checks at runtime. Handles all constraint types with type-specific evaluation logic.

**generator.ts** - Protocol generation utilities for creating well-formed protocols programmatically.

**network/** - Protocol distribution across MCP instances. `distributor.ts` handles bundle export/import with optional signing. `sync.ts` enables push/pull/bidirectional synchronization.

### Additional Components

**src/dashboard/server.ts** - Express 5 HTTP server with REST API and SSE endpoints for real-time monitoring. Dashboard UI served from `src/dashboard/public/`.

**src/context/enricher.ts** - Auto-enriches features with relevant documentation (CLAUDE.md, README) and related code files. Configurable context limits prevent prompt bloat (default: 16KB max total, 4KB per doc, 2KB per code file). Includes 60-second cache TTL for frequently accessed context.

**src/utils/complexity-detector.ts** - Analyzes feature complexity (0-100 score) based on description keywords, scope indicators, dependency count. Features scoring 60+ trigger competitive planning recommendation.

**src/utils/plan-evaluator.ts** - Compares competing implementation plans, scoring on completeness, risk mitigation, and testing coverage.

**src/utils/security.ts** - Path traversal prevention, feature ID validation, session name validation, command allowlist enforcement, and output sanitization. The `ALLOWED_COMMAND_PATTERNS` regex list controls which verification commands can run.

**src/utils/feature-generator.ts** - Auto-generates feature lists from task descriptions using keyword extraction and pattern matching.

**src/utils/format.ts** - Formatting utilities for consistent output across tools (compact vs pretty modes).

### Key Design Patterns

1. **Persistent State Outside Context** - State survives Claude's context compaction via the MCP server
2. **Worker Isolation** - Each worker runs in its own tmux session with controlled tool access (`Bash,Read,Write,Edit,Glob,Grep`)
3. **Atomic File Operations** - State and progress files use write-to-temp-then-rename pattern
4. **Command Allowlist** - Only safe verification commands (npm test, pytest, etc.) can be executed
5. **File-Based Prompt Passing** - Worker prompts written to `.prompt` files, not shell strings
6. **Fail-Closed Enforcement** - Unknown constraint types block by default in protocol validation
7. **Immutable Base Constraints** - Security boundaries frozen at module load, cannot be overridden

### State Files Created Per Project

```
.claude/orchestrator/
├── state.json                    # Main session state (Zod-validated on load)
├── feature_list.json             # Feature status for structured access
├── protocols/
│   ├── registry.json             # Protocol definitions
│   ├── active.json               # Currently active protocols
│   ├── violations.json           # Recorded violations
│   ├── audit.json                # Protocol operation audit log
│   └── proposals/                # Pending LLM-generated proposals
├── sync/                         # Cross-instance protocol sync
└── workers/
    ├── *.prompt                  # Worker prompts (mode 0600)
    ├── *.log                     # Worker output logs
    ├── *.done                    # Completion marker files
    ├── *.status                  # Worker status JSON
    ├── *.plan.json               # Competitive planning results
    ├── *.confidence              # Self-reported confidence files
    ├── code-review.findings.json # Code review results
    └── architecture-review.findings.json # Architecture review results

claude-progress.txt               # Human-readable progress log
init.sh                           # Environment setup script (mode 0700)
```

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `DASHBOARD_PORT` | `3456` | Dashboard HTTP port |
| `ENABLE_DASHBOARD` | `true` | Set to `false` to disable |

## TypeScript Configuration

- **Target**: ES2022 with NodeNext module resolution
- **Strict mode** enabled - all strict type checks enforced
- **Declaration files** generated for type exports
- Imports require `.js` extension for ESM compatibility (e.g., `import { foo } from './bar.js'`)

## Dependencies

- **Node.js 18+** (ES2022 features required)
- **tmux** for worker session management (`brew install tmux` on macOS)

## Worker Authentication

Workers authenticate using the parent Claude Code session. The orchestrator automatically:
1. Captures `CLAUDE_CODE_SESSION_ID` from the environment
2. Passes it to each tmux worker session
3. Workers use this session ID to authenticate with Claude Code

### Requirements

- **MUST** run claude-swarm from within Claude Code (not standalone terminal)
- Parent process must have active Claude Code authentication
- Workers will fail with "Credit balance is too low" if session ID is missing

### Environment Variables

Workers inherit these Claude Code authentication environment variables:

| Variable | Purpose | Example Value |
|----------|---------|---------------|
| `CLAUDE_CODE_SESSION_ID` | Session token for subscription-based authentication | `h0_abc123xyz...` |
| `CLAUDE_CODE_ENTRYPOINT` | Tells Claude CLI this is running in CLI context (not web/app) | `cli` |
| `CLAUDECODE` | Flag indicating we're running within Claude Code environment | `1` |

**Session ID Format:** `h<version>_<token>` where version is a digit (e.g., `h0`, `h1`) and token is alphanumeric with dashes/underscores.

**Note:** These environment variables are internal to Claude Code. Session IDs are captured at orchestrator startup and remain valid for the session duration (typically hours). If you see warnings about "unexpected format", the session ID may be corrupted or Claude Code's auth mechanism may have changed.

### Troubleshooting Authentication Issues

If workers crash with "Credit balance is too low":

1. **Check you're in Claude Code:**
   ```bash
   echo $CLAUDE_CODE_SESSION_ID
   # Should output: something like "h0_abc123..."
   ```

2. **Verify orchestrator captured session:**
   Check worker logs in `.claude/orchestrator/workers/*.log`
   Look for "Spawned with session ID: present"

3. **Re-authenticate:**
   ```bash
   claude /logout
   claude
   ```

4. **Check worker logs:**
   ```bash
   cat .claude/orchestrator/workers/<feature-id>.log
   ```

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
```

## Adding New Tools

When adding a new MCP tool to `src/index.ts`:
1. Define Zod schema for parameters
2. Add tool registration with `server.tool(name, description, schema, handler)`
3. Use `ensureInitialized(projectDir)` to get managers
4. Use security utilities from `src/utils/security.ts` for input validation
5. Follow existing patterns for error handling and response formatting
