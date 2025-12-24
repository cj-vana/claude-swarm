---
name: swarm
description: Orchestrate parallel Claude Code worker swarms for multi-hour coding sessions. Use when implementing complex features, large refactors, or multi-step tasks that benefit from parallel worker sessions. Maintains state across context compactions.
---

# Claude Swarm Skill

This skill enables autonomous, multi-hour coding sessions using the claude-swarm MCP server.

## Overview

The orchestrator pattern separates concerns:
- **Orchestrator (you)**: Plans work, monitors progress, handles decisions
- **Workers**: Focused Claude Code sessions that implement individual features

## Quick Start

### 1. Initialize a Session

First, analyze the task and decompose it into features:

```
Task: "Build a user authentication system"

Features:
1. Create user registration endpoint with validation
2. Implement password hashing with bcrypt
3. Add JWT token generation and verification
4. Create login endpoint
5. Add protected route middleware
6. Implement logout and token invalidation
```

Then initialize:
```
Use orchestrator_init with:
- projectDir: /path/to/project
- taskDescription: "Build a user authentication system with..."
- existingFeatures: [list of feature descriptions above]
```

### 2. Work Loop

**IMPORTANT: Workers typically take 5-10 minutes per feature.** Do NOT check workers immediately after starting them - this wastes context and provides no useful information.

For each pending feature:

```
1. start_worker for the feature (or start_parallel_workers for independent features)
2. WAIT 2-3 minutes before first check (use: sleep 120 or sleep 180)
3. check_worker to monitor progress
4. If still working, wait another 2-3 minutes before checking again
5. Use send_worker_message if worker needs additional guidance
6. When worker completes, run_verification (tests, build, etc.)
7. mark_complete with success/failure (auto-retry enabled by default)
8. commit_progress to checkpoint
9. Repeat for next feature
```

**Timing guidance:**
- After starting a worker, run `sleep 120` (2 min) or `sleep 180` (3 min) before checking
- If worker is still in progress, wait another 2-3 minutes before the next check
- Most features complete in 5-10 minutes; complex features may take longer

For parallel execution:
```
1. Identify independent features (no dependencies between them)
2. Use set_dependencies if features must be ordered
3. Use validate_workers to check for conflicts before starting
4. start_parallel_workers with multiple feature IDs
5. Run: sleep 180 (wait 3 minutes before checking)
6. Use check_all_workers to monitor all workers at once
7. Mark each complete as they finish
```

### 3. After Context Compaction

If your context is compacted, simply:
```
Call orchestrator_status with the projectDir
```

This restores your understanding of the current state from the persistent MCP server.

## Best Practices

### Feature Decomposition
- Each feature should be completable in 15-60 minutes
- Features should be independently testable
- Order features by dependency (foundations first)
- Use `set_dependencies` to enforce ordering when needed

### Parallel Execution
- Identify features that can run in parallel (no shared dependencies)
- Use `start_parallel_workers` to launch up to 10 workers at once
- Monitor all workers with `check_worker` for each feature ID
- Independent features complete faster when parallelized

### Monitoring Workers
- **Wait 2-3 minutes after starting before first check** - workers need time to make progress
- Use `sleep 120` or `sleep 180` between starting a worker and checking it
- If worker is still in progress, wait another 2-3 minutes before checking again
- Workers typically complete features in 5-10 minutes
- If a worker seems stuck after 10+ minutes, review its output carefully
- Use `send_worker_message` to provide guidance without restarting
- Kill stuck workers and retry with more specific instructions

### Efficient Monitoring with Heartbeat Mode
Use `check_worker` with `heartbeat: true` for lightweight status checks that save context:
```
check_worker(featureId, heartbeat: true)
→ Returns: status, lastToolUsed, lastFile, lastActivity, runningFor
```
Use `check_all_workers` with `heartbeat: true` to check all active workers at once.

### Incremental Output with Cursor Mode
For long-running workers, use `sinceLine` to get only new output:
```
check_worker(featureId, sinceLine: 0)    → Returns lines 0-50, cursor: 50
check_worker(featureId, sinceLine: 50)   → Returns lines 50-75, cursor: 75
```
This reduces context usage when monitoring verbose workers.

### Auto Completion Detection
The orchestrator automatically monitors workers and logs when they complete or crash:
- Logs appear in `progressLog` and stderr
- Format: `🔔 Worker completed: feature-1 - use mark_complete to update status`
- You still need to call `mark_complete` to update feature status

### Error Recovery
- If a worker fails, check the error in check_worker output
- Auto-retry is enabled by default (3 attempts) via `mark_complete`
- Use `retry_feature` to manually reset after fixing issues
- Add clarifying context when retrying with start_worker
- Use add_feature if you discover missing work

### Session Management
- Use `pause_session` to gracefully stop work (kills all workers)
- Use `resume_session` to continue where you left off
- Use `get_session_stats` to monitor success rates and timing

### Git Checkpoints
- Commit after each successful feature
- Use descriptive commit messages
- This allows easy rollback if needed

## Web Dashboard

A real-time web dashboard is available at `http://localhost:3456` when the MCP server is running.

### Dashboard Features
- **Live updates** via Server-Sent Events (no manual refresh needed)
- **Session overview** with progress bar and elapsed time
- **Feature cards** with status, attempts, and dependencies
- **Worker terminal output** streaming in a modal
- **Activity log** with timestamps
- **Dark mode** toggle (persists in localStorage)
- **Mobile responsive** layout

### Configuration
- `DASHBOARD_PORT=3456` - Change the dashboard port
- `ENABLE_DASHBOARD=false` - Disable the dashboard entirely

## Tools Reference

| Tool | Purpose |
|------|---------|
| `orchestrator_init` | Start new session with features |
| `orchestrator_status` | Check current state (use after compaction!) |
| `start_worker` | Launch worker for a feature |
| `start_parallel_workers` | Launch multiple workers for independent features |
| `validate_workers` | Pre-flight validation before parallel execution |
| `check_worker` | Monitor worker output (supports heartbeat + cursor modes) |
| `check_all_workers` | Check all active workers at once |
| `send_worker_message` | Send follow-up instructions to running worker |
| `mark_complete` | Mark feature done/failed (with auto-retry) |
| `retry_feature` | Reset failed feature for manual retry |
| `run_verification` | Run tests/build to verify |
| `add_feature` | Add discovered work |
| `set_dependencies` | Define feature dependencies |
| `get_progress_log` | Full history |
| `get_session_stats` | Success rates and timing metrics |
| `pause_session` | Pause session, stop all workers |
| `resume_session` | Resume paused session |
| `commit_progress` | Git checkpoint |
| `orchestrator_reset` | Nuclear option - clear everything |

## Example Session

```
User: "Build a REST API for a todo app with CRUD operations"

[Analyze and decompose into features]

Me: I'll orchestrate building this API. Let me initialize the session.

[Call orchestrator_init with features:
1. Set up Express server with basic middleware
2. Create Todo model with Mongoose
3. Implement POST /todos endpoint
4. Implement GET /todos endpoint
5. Implement GET /todos/:id endpoint
6. Implement PUT /todos/:id endpoint
7. Implement DELETE /todos/:id endpoint
8. Add input validation middleware
9. Add error handling middleware
10. Write integration tests]

Session initialized with 10 features.

[start_worker for feature-1]
Worker started: cc-worker-feature-1-abc123

[Run: sleep 180]  # Wait 3 minutes before first check

[check_worker for feature-1]
Worker output shows Express setup complete...

[run_verification: "npm run build"]
Build passed!

[mark_complete: feature-1, success: true]
[commit_progress: "feat: set up Express server"]

Moving to feature-2...
[start_worker for feature-2]
...

[Continue until all features complete]
```

## Troubleshooting

### "No active session"
Run `orchestrator_status` to check state, or `orchestrator_init` to start fresh.

### Worker seems stuck
1. `check_worker` to see current output
2. Try `send_worker_message` to give it guidance
3. If truly stuck, `mark_complete` with success=false (will auto-retry)
4. If auto-retries exhausted, use `retry_feature` to reset manually

### Feature has unmet dependencies
1. Check which features it depends on with `orchestrator_status`
2. Complete the dependency features first
3. Or use `set_dependencies` to modify the dependency chain

### Lost context after compaction
Just call `orchestrator_status` - the MCP server maintains all state independently.

### Need to pause temporarily
Use `pause_session` to stop all workers gracefully, then `resume_session` when ready.

### Need to abort
Use `orchestrator_reset` with confirm=true to kill all workers and clear state.
