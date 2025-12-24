# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build and Development Commands

```bash
npm run build      # Compile TypeScript and copy dashboard assets
npm run dev        # Watch mode for TypeScript compilation
npm start          # Run the compiled MCP server
npm run inspector  # Debug with MCP Inspector
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

**src/index.ts** - MCP server entry point registering 20 tools. All tool handlers are defined inline here. Tool schemas use Zod for validation.

**src/state/manager.ts** - Persistent state management using the "notebook pattern". Stores session state in `.claude/orchestrator/state.json` with atomic writes (temp file + rename). Also generates `claude-progress.txt` for human readability and `init.sh` for environment setup.

**src/workers/manager.ts** - Manages Claude Code worker sessions via tmux. Key security pattern: prompts are passed via files (not shell strings) to prevent injection. Includes completion monitoring (10s polling), heartbeat tracking, and conflict analysis for parallel execution.

**src/dashboard/server.ts** - Express 5 HTTP server with REST API and SSE endpoints for real-time monitoring. Dashboard UI served from `src/dashboard/public/`.

**src/utils/security.ts** - Security utilities: path traversal prevention, feature ID validation, session name validation, command allowlist enforcement, and output sanitization. The `ALLOWED_COMMAND_PATTERNS` regex list controls which verification commands can run.

**src/utils/format.ts** - Duration formatting and percentage calculation helpers.

### Key Design Patterns

1. **Persistent State Outside Context** - State survives Claude's context compaction via the MCP server
2. **Worker Isolation** - Each worker runs in its own tmux session with controlled tool access (`Bash,Read,Write,Edit,Glob,Grep`)
3. **Atomic File Operations** - State and progress files use write-to-temp-then-rename pattern
4. **Command Allowlist** - Only safe verification commands (npm test, pytest, etc.) can be executed
5. **File-Based Prompt Passing** - Worker prompts written to `.prompt` files, not shell strings

### State Files Created Per Project

- `.claude/orchestrator/state.json` - Main session state (Zod-validated on load)
- `.claude/orchestrator/feature_list.json` - Feature status for structured access
- `.claude/orchestrator/workers/*.prompt` - Worker prompts (mode 0600)
- `.claude/orchestrator/workers/*.log` - Worker output logs
- `.claude/orchestrator/workers/*.done` - Completion marker files
- `.claude/orchestrator/workers/*.status` - Worker status JSON
- `claude-progress.txt` - Human-readable progress log
- `init.sh` - Environment setup script (mode 0700)

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `DASHBOARD_PORT` | `3456` | Dashboard HTTP port |
| `ENABLE_DASHBOARD` | `true` | Set to `false` to disable |

## Dependencies

Requires tmux for worker session management (`brew install tmux` on macOS).

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
