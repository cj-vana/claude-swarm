---
name: swarm
description: Orchestrate parallel Claude Code worker swarms with protocol-based behavioral governance. Use for complex features, large refactors, or multi-step tasks. Supports behavioral constraints, parallel workers, and persistent state across context compactions.
---

# Claude Swarm Skill

This skill enables autonomous, multi-hour coding sessions using the claude-swarm MCP server with protocol-based behavioral governance.

## Overview

The orchestrator pattern separates concerns:
- **Orchestrator (you)**: Plans work, monitors progress, handles decisions
- **Workers**: Focused Claude Code sessions that implement individual features
- **Protocols**: Behavioral constraints that govern what workers can/cannot do

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

**IMPORTANT: Workers typically take 5-10 minutes per feature.** Do NOT check workers immediately after starting them.

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

## Protocol-Based Governance

Protocols define behavioral constraints that govern worker actions. This enables safe autonomous operation with clear boundaries.

### Constraint Types

| Type | Description | Example |
|------|-------------|---------|
| `tool_restriction` | Allow/deny specific tools | Only allow Read, Glob, Grep |
| `file_access` | Control file system access | Block access to `.env` files |
| `output_format` | Require specific output patterns | Must include test coverage |
| `behavioral` | High-level behavior rules | Require confirmation before destructive actions |
| `temporal` | Time-based constraints | Max 30 minutes per feature |
| `resource` | Resource usage limits | Max 100 file operations |
| `side_effect` | Control external effects | No network requests, no git push |

### Using Protocols

```
1. protocol_register - Register a new protocol (JSON definition)
2. protocol_activate - Activate for enforcement
3. start_worker - Workers are validated against active protocols
4. get_violations - Review any constraint violations
5. protocol_deactivate - Deactivate when done
```

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
        "deniedPaths": ["**/.env", "**/secrets.*"]
      },
      "severity": "error",
      "message": "Cannot access files that may contain secrets"
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

### LLM-Generated Protocols

Workers can propose new protocols validated against immutable base constraints:

```
1. get_base_constraints - View immutable security rules
2. propose_protocol - Worker submits proposal
3. review_proposals - See pending proposals with risk scores
4. approve_protocol / reject_protocol - Human review for high-risk
```

## Best Practices

### Feature Decomposition
- Each feature should be completable in 15-60 minutes
- Features should be independently testable
- Order features by dependency (foundations first)
- Use `set_dependencies` to enforce ordering when needed

### Parallel Execution
- Identify features that can run in parallel (no shared dependencies)
- Use `start_parallel_workers` to launch up to 10 workers at once
- Monitor all workers with `check_all_workers`
- Independent features complete faster when parallelized

### Monitoring Workers
- **Wait 2-3 minutes after starting before first check**
- Use `sleep 120` or `sleep 180` between starting and checking
- Workers typically complete features in 5-10 minutes
- If stuck after 10+ minutes, review output carefully
- Use `send_worker_message` to provide guidance without restarting

### Efficient Monitoring with Heartbeat Mode
Use `check_worker` with `heartbeat: true` for lightweight status checks:
```
check_worker(featureId, heartbeat: true)
-> Returns: status, lastToolUsed, lastFile, lastActivity, runningFor
```

### Competitive Planning for Complex Features
For complex features (score >= 60), use competitive planning:

```
1. get_feature_complexity(featureId) - Analyze complexity
2. start_competitive_planning(featureId) - Spawn 2 planners
3. Wait for planners to complete (3-5 minutes)
4. evaluate_plans(featureId) - Compare and pick winner
5. start_worker with the winning plan as context
```

### Confidence-Based Monitoring
Track worker confidence to detect issues early:

```
1. set_confidence_threshold(35) - Configure alert threshold
2. get_worker_confidence(featureId) - Get detailed breakdown
```

Confidence levels:
- **High (80-100)**: On track
- **Medium (50-79)**: Normal operation
- **Low (25-49)**: May need guidance
- **Critical (0-24)**: Immediate attention

### Post-Completion Reviews
After all workers complete, automated reviews run automatically:

```
1. All workers complete -> session transitions to "reviewing" status
2. Code review worker analyzes: bugs, security, style, test coverage
3. Architecture review worker analyzes: coupling, patterns, scalability
4. Findings aggregated into progress log
5. Use get_review_results for detailed findings
6. Use implement_review_suggestions to convert findings into new features
```

Review configuration:
- `configure_reviews(enabled: false)` - Disable automatic reviews
- `run_review(reviewTypes: ["code"])` - Manually run specific reviews

### Acting on Review Findings
Convert review issues into actionable features:

```
# View available issues from reviews
implement_review_suggestions(projectDir)

# Create features from specific issues by index
implement_review_suggestions(projectDir, issueIndices: [0, 2, 5])

# Auto-select warnings and errors
implement_review_suggestions(projectDir, autoSelect: true, minSeverity: "warning")
```

### Error Recovery
- Auto-retry is enabled by default (3 attempts) via `mark_complete`
- Use `retry_feature` to manually reset after fixing issues
- Use `add_feature` if you discover missing work

### Session Management
- Use `pause_session` to gracefully stop work
- Use `resume_session` to continue where you left off
- Use `get_session_stats` for success rates and timing

### Git Checkpoints
- Commit after each successful feature with `commit_progress`
- Use descriptive commit messages
- Enables easy rollback if needed

## Web Dashboard

A real-time web dashboard is available at `http://localhost:3456`:
- Live updates via Server-Sent Events
- Session overview with progress bar
- Feature cards with status and dependencies
- Worker terminal output streaming with ANSI color support
- Review worker progress visibility
- Dark mode support

## Tools Reference

### Core Orchestration
| Tool | Purpose |
|------|---------|
| `orchestrator_init` | Start new session with features |
| `orchestrator_status` | Check current state (use after compaction!) |
| `orchestrator_reset` | Nuclear option - clear everything |

### Worker Management
| Tool | Purpose |
|------|---------|
| `start_worker` | Launch worker for a feature |
| `start_parallel_workers` | Launch multiple workers |
| `validate_workers` | Pre-flight validation |
| `check_worker` | Monitor worker output (heartbeat + cursor modes) |
| `check_all_workers` | Check all active workers at once |
| `send_worker_message` | Send instructions to running worker |

### Competitive Planning
| Tool | Purpose |
|------|---------|
| `get_feature_complexity` | Analyze complexity score |
| `start_competitive_planning` | Spawn 2 planners |
| `evaluate_plans` | Compare and select winner |

### Confidence Monitoring
| Tool | Purpose |
|------|---------|
| `get_worker_confidence` | Get confidence breakdown |
| `set_confidence_threshold` | Configure alert threshold |

### Feature Management
| Tool | Purpose |
|------|---------|
| `mark_complete` | Mark feature done/failed (auto-retry) |
| `retry_feature` | Reset for manual retry |
| `run_verification` | Run tests/build |
| `add_feature` | Add discovered work |
| `set_dependencies` | Define dependencies |

### Session & Progress
| Tool | Purpose |
|------|---------|
| `get_progress_log` | Full history (paginated) |
| `get_session_stats` | Success rates and timing |
| `pause_session` | Pause, stop all workers |
| `resume_session` | Resume paused session |
| `commit_progress` | Git checkpoint |

### Post-Completion Reviews
| Tool | Purpose |
|------|---------|
| `run_review` | Manually trigger reviews |
| `check_reviews` | Monitor review worker progress |
| `get_review_results` | Get aggregated findings |
| `configure_reviews` | Configure automatic reviews |
| `implement_review_suggestions` | Convert findings into features |

### Protocol Management
| Tool | Purpose |
|------|---------|
| `protocol_register` | Register a protocol |
| `protocol_activate` | Activate for enforcement |
| `protocol_deactivate` | Deactivate protocol |
| `protocol_list` | List all protocols |
| `protocol_status` | Get protocol status |

### Protocol Enforcement
| Tool | Purpose |
|------|---------|
| `validate_feature_protocols` | Check feature against protocols |
| `get_violations` | Get violations (paginated) |
| `resolve_violation` | Mark violation resolved |
| `get_audit_log` | Get audit history |

### LLM Protocol Generation
| Tool | Purpose |
|------|---------|
| `get_base_constraints` | View immutable constraints |
| `propose_protocol` | Submit proposal |
| `review_proposals` | List pending proposals |
| `approve_protocol` | Approve proposal |
| `reject_protocol` | Reject proposal |

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
5. Implement PUT /todos/:id endpoint
6. Implement DELETE /todos/:id endpoint
7. Add input validation middleware
8. Add error handling middleware
9. Write integration tests]

Session initialized with 9 features.

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
[Automatic code and architecture reviews run]
[get_review_results to see findings]
[implement_review_suggestions to create follow-up features if needed]
```

## Repo Setup

Use the Repo Setup feature to configure new or existing repositories with development best practices. The swarm can set up CLAUDE.md files, CI/CD workflows, issue templates, and more—all in parallel with smart defaults based on your project type.

### When to Use

- **Fresh projects**: Initialize a new repo with complete development infrastructure
- **Adding CI to existing projects**: Add GitHub Actions, Dependabot, or Release Please to a mature codebase
- **Standardizing repos**: Apply consistent configuration across multiple repositories
- **Upgrading configs**: Update outdated CI workflows or templates to current best practices

### Quick Setup Workflow

```
User: "Set up this new TypeScript project with CI, issue templates, and release automation"

[Analyze project: detect package.json, tsconfig.json, src/ structure]

Me: I'll configure this repo with appropriate settings. Let me initialize the setup swarm.

[Call orchestrator_init with features:
1. Create CLAUDE.md with project-specific guidance
2. Add GitHub Actions CI workflow for TypeScript
3. Configure Dependabot for npm dependencies
4. Add Release Please for automated releases
5. Create issue templates (bug report, feature request)
6. Add pull request template
7. Create CONTRIBUTING.md with guidelines
8. Add SECURITY.md with vulnerability policy]

Session initialized with 8 features.

[start_parallel_workers for features 1-8]  # All independent, run in parallel
Workers started for all configuration features...

[Run: sleep 120]  # Wait 2 minutes

[check_all_workers]
All workers completed successfully.

[run_verification: "npm run build && npm test"]
Build and tests pass with new configuration!

[commit_progress: "chore: add repo configuration and CI"]
```

### Configuration Types

| Type | Description | Files Created |
|------|-------------|---------------|
| **CLAUDE.md** | Project guidance for Claude Code | `CLAUDE.md` |
| **GitHub CI** | Build, test, lint workflows | `.github/workflows/ci.yml` |
| **Release Please** | Automated version bumps and changelogs | `.github/workflows/release-please.yml`, `.release-please-manifest.json` |
| **Dependabot** | Automated dependency updates | `.github/dependabot.yml` |
| **Issue Templates** | Structured bug/feature reporting | `.github/ISSUE_TEMPLATE/*.yml` |
| **PR Template** | Consistent pull request descriptions | `.github/PULL_REQUEST_TEMPLATE.md` |
| **CONTRIBUTING.md** | Contribution guidelines | `CONTRIBUTING.md` |
| **SECURITY.md** | Security policy and vulnerability reporting | `SECURITY.md` |

### Customization Options

Control which configurations are applied using these options in your task description or worker prompts:

**Skip specific configs** - Use `skipConfigs` to exclude certain configuration types:
```
"Set up CI and issue templates, but skip Release Please and Dependabot"
-> skipConfigs: ["release-please", "dependabot"]
```

**Force overwrite** - Use `force: true` to replace existing configurations:
```
"Update all CI workflows to latest patterns, replacing existing ones"
-> force: true (overwrites existing .github/workflows/)
```

**Merge mode (default)** - Without `force`, existing configs are preserved and merged:
- Existing CLAUDE.md sections are kept, new guidance is appended
- Workflow files are only created if they don't exist
- Issue templates add to existing templates rather than replacing

### Project Type Detection

The setup swarm auto-detects your project type and applies appropriate defaults:

| Detected | Configuration Applied |
|----------|----------------------|
| `package.json` | Node.js CI, npm Dependabot |
| `tsconfig.json` | TypeScript build steps, type checking |
| `pyproject.toml` | Python CI, pip/poetry Dependabot |
| `Cargo.toml` | Rust CI, cargo Dependabot |
| `go.mod` | Go CI, go modules Dependabot |
| `.github/` exists | Merge mode by default, preserves existing |

### Example: Adding CI to Existing Project

```
User: "Add GitHub Actions CI to this Python project, keep existing issue templates"

[Detect: pyproject.toml, pytest in dependencies, existing .github/ISSUE_TEMPLATE/]

Me: I'll add Python CI while preserving your existing templates.

[Call orchestrator_init with features:
1. Create GitHub Actions CI for Python with pytest
2. Configure Dependabot for pip dependencies
3. Update CLAUDE.md with CI information]

[start_parallel_workers]
...

[Workers complete, merge with existing .github/ structure]
[Existing issue templates preserved, new CI workflow added]

[commit_progress: "ci: add GitHub Actions workflow for Python"]
```

## Security Considerations

### Protocol Safety

Protocols are validated against immutable base constraints that cannot be overridden:
- **Prohibited tools**: Dangerous system commands (rm -rf, sudo, etc.)
- **Protected paths**: System directories, SSH keys, credentials
- **Privilege ceiling**: Maximum permissions any protocol can grant

### Worker Isolation

Workers operate with limited capabilities:
- **Implementation workers**: Bash, Read, Write, Edit, Glob, Grep only
- **Review workers**: Read-only (no Bash access)
- **Planner workers**: Read-only tools for analysis

### Safe Pattern Matching

The orchestrator uses safe regex handling:
- Dangerous patterns (ReDoS) are detected and fall back to literal matching
- User input is never passed directly to regex engines
- Glob patterns are safely converted with proper escaping

## Troubleshooting

### "No active session"
Run `orchestrator_status` to check state, or `orchestrator_init` to start fresh.

### Worker seems stuck
1. `check_worker` to see current output
2. Try `send_worker_message` to give guidance
3. If truly stuck, `mark_complete` with success=false (will auto-retry)
4. If retries exhausted, use `retry_feature` to reset

### Feature has unmet dependencies
1. Check dependencies with `orchestrator_status`
2. Complete dependency features first
3. Or use `set_dependencies` to modify the chain

### Lost context after compaction
Call `orchestrator_status` - the MCP server maintains all state.

### Need to pause temporarily
Use `pause_session` to stop workers, then `resume_session` when ready.

### Need to abort
Use `orchestrator_reset` with confirm=true to kill all workers and clear state.

### Protocol violations blocking work
1. `get_violations` to see what was violated
2. Fix the issue or `resolve_violation` if false positive
3. Adjust protocol constraints if too strict

### Memory issues
If the orchestrator seems slow or unresponsive:
1. Check active session size: `orchestrator_status`
2. Clear old violations: `resolve_violation` for old entries
3. Reset if necessary: `orchestrator_reset`

### Pattern matching issues
If protocol patterns aren't matching as expected:
1. Patterns use regex syntax (not glob by default)
2. Very complex patterns may fall back to literal matching for safety
3. Use simpler patterns if exact matching fails

### Monitor not running
If workers aren't being tracked:
1. The monitor auto-stops after 5 consecutive errors
2. Check MCP server logs for error messages
3. Restart the MCP server if needed
