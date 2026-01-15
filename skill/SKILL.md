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

---

## Complete Workflow (Step-by-Step)

Follow these phases in order for every swarm session:

### Phase 0: Repository Readiness Check

Before starting any feature work, check if the repository needs configuration:

```
1. ANALYZE the repository:
   → setup_analyze(projectDir)

2. IF freshness score >= 50 (missing configurations):
   → setup_init(projectDir)
   → Monitor: setup_status(projectDir)
   → Wait for all setup workers to complete

3. IF freshness score < 50:
   → Proceed to Phase 1 (repo already configured)
```

**Why:** Ensures repos have CLAUDE.md, CI, and other essentials before feature work begins.

### Phase 1: Session Setup

```
1. DECOMPOSE the task into 15-60 minute features
   - Each feature should be independently testable
   - Order by dependency (foundations first)

2. INITIALIZE the session:
   → orchestrator_init(projectDir, taskDescription, existingFeatures)

3. ANALYZE COMPLEXITY for all features (mandatory):
   → FOR EACH feature:
      get_feature_complexity(featureId)
   - Records complexity score and recommendation for each feature
   - Features with score >= 60 are flagged for competitive planning
   - Use these results to inform Phase 3 execution strategy

4. OPTIONAL - Set up behavioral constraints:
   → protocol_register(protocol JSON)
   → protocol_activate(protocolId)

5. OPTIONAL - Configure pre-completion verification:
   → configure_verification(commands: ["npm test", "tsc --noEmit"])

6. OPTIONAL - Set feature dependencies:
   → set_dependencies(featureId, dependsOn: ["feature-1", "feature-2"])
```

### Phase 2: Pre-Work Preparation (Per Feature)

Before starting each feature, prepare as needed based on Phase 1 complexity analysis:

```
1. IF feature complexity >= 60 (from Phase 1 analysis):
   → start_competitive_planning(featureId)
   → sleep 300  (wait 5 minutes for planners)

   REVIEW PLANS (recommended for critical features):
   → check_worker(plannerSessionA)  # View Planner A's output
   → check_worker(plannerSessionB)  # View Planner B's output

   EVALUATE AND SELECT:
   → evaluate_plans(featureId)  # Automatic selection based on scoring
   OR for manual override:
   → evaluate_plans(featureId, manualSelection: "A", selectionReason: "...")

2. OPTIONAL - Enrich with context:
   Option A: Automatic discovery
   → enrich_feature(featureId)  # Auto-finds relevant docs/code

   Option B: Manual/precise context
   → set_feature_context(featureId, documentation: [...])

3. OPTIONAL - Validate against protocols:
   → validate_feature_protocols(featureId)
```

**When to enrich:** Use for complex features touching unfamiliar code areas. Skip for simple, isolated changes.

### Phase 3: Execution

Choose your execution strategy:

```
OPTION A: Manual Orchestration (Default)

FOR INDEPENDENT FEATURES (can run simultaneously):
   → validate_workers(featureIds)  # Check for conflicts
   → start_parallel_workers(featureIds)  # Up to 10 workers

FOR DEPENDENT/SEQUENTIAL FEATURES:
   → start_worker(featureId)

---

OPTION B: Hands-Free Orchestration

For fully autonomous execution until completion:
   → auto_orchestrate(projectDir, strategy: "adaptive", maxConcurrent: 5)

Strategies:
- breadth-first: Parallelize independent features first
- depth-first: Focus on unblocking dependent features
- adaptive: Let the system decide based on dependencies

Note: auto_orchestrate handles Phases 3-5 automatically, returning when all features complete.
```

### Phase 4: Monitoring Loop

**IMPORTANT: Workers take 5-10 minutes. Do NOT check immediately.**

```
1. WAIT before first check:
   → sleep 180  (3 minutes)

2. CHECK status (lightweight):
   → check_worker(featureId, heartbeat: true)
   OR
   → check_all_workers(heartbeat: true)

3. IF worker seems stuck (low confidence):
   → get_worker_confidence(featureId)
   → send_worker_message(featureId, "guidance here")

4. IF still running:
   → sleep 120  (wait 2 more minutes)
   → Repeat from step 2

5. IF completed:
   → Proceed to Phase 5
```

### Phase 5: Completion (Per Feature)

```
1. VERIFY the work:
   → run_verification(command: "npm test")

2. MARK completion:
   → mark_complete(featureId, success: true/false)
   - If failed: auto-retry enabled (3 attempts by default)
   - If retries exhausted: retry_feature(featureId) to reset

3. CHECKPOINT (on success):
   → commit_progress("feat: description of work")

4. REPEAT Phases 2-5 for next pending feature
```

### Phase 6: Post-Completion Reviews

After ALL features complete, reviews run automatically:

```
1. MONITOR review progress:
   → check_reviews()

2. GET findings when complete:
   → get_review_results()

3. OPTIONAL - Create follow-up features from issues:
   → implement_review_suggestions(autoSelect: true, minSeverity: "warning")

4. IF new features added:
   → Repeat from Phase 2
```

### Recovery Points

```
LOST CONTEXT (after compaction)?
   → orchestrator_status(projectDir)  # Restores full state

NEED TO PAUSE?
   → pause_session()   # Stops all workers
   → resume_session()  # Continue later

NEED TO ABORT?
   → orchestrator_reset(confirm: true)  # Nuclear option

FEATURE FAILED REPEATEDLY?
   → retry_feature(featureId)     # Reset attempt counter and try again

FEATURE FAILED AND NEEDS ROLLBACK?
   → check_rollback_conflicts(featureId)  # Check for conflicts with parallel workers
   → rollback_feature(featureId)  # Restore files to pre-worker state
   → retry_feature(featureId)     # Reset attempt counter
```

**Rollback Warning:** In parallel environments, rolling back can affect files modified by other concurrent workers. Always run `check_rollback_conflicts` first to see which files would be affected.

---

## Quick Reference Flowchart

```
┌─────────────────────────────────────────────────────────────────┐
│                         SESSION START                            │
└─────────────────────────────────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────┐
│  Phase 0: setup_analyze → IF score >= 50: setup_init             │
│           └─ Wait for repo configuration if needed               │
└─────────────────────────────────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────┐
│  Phase 1: orchestrator_init + get_feature_complexity (all)       │
│           └─ Optional: protocols, verification, dependencies     │
└─────────────────────────────────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────┐
│  Phase 2: IF complexity >= 60: competitive_planning → evaluate   │
│           └─ Optional: enrich_feature, validate_feature_protocols│
└─────────────────────────────────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────┐
│  Phase 3: start_worker OR start_parallel_workers                 │
│           └─ OR: auto_orchestrate (hands-free execution)         │
└─────────────────────────────────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────┐
│  Phase 4: sleep 180 → check_worker → (loop until complete)       │
│           └─ IF stuck: get_worker_confidence, send_worker_message│
└─────────────────────────────────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────┐
│  Phase 5: run_verification → mark_complete → commit_progress     │
│           └─ Repeat Phase 2-5 for remaining features             │
└─────────────────────────────────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────┐
│  Phase 6: check_reviews → get_review_results                     │
│           └─ Optional: implement_review_suggestions              │
└─────────────────────────────────────────────────────────────────┘
                                 │
                                 ▼
                            SESSION END
```

---

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

### Sharing Protocols Across Projects

Protocols can be exported, shared, and synchronized across MCP instances:

```
EXPORT protocols from current project:
   → export_protocols(projectDir, protocolIds: [...])
   - Creates a shareable bundle file
   - Optionally sign for integrity verification

IMPORT protocols from bundle:
   → import_protocols(projectDir, bundlePath: "path/to/bundle.json")
   - Validates against base constraints
   - Conflict strategies: skip, replace, rename, merge

SYNC with peer instances:
   → discover_protocols(projectDir)  # Find available peers
   → sync_protocols(projectDir, direction: "pull")  # Get protocols from peers
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

### Evaluating Competing Plans (Detailed Guide)

After planners complete, use `evaluate_plans` to compare their approaches. Understanding the evaluation helps you decide when to accept automatic selection vs. override manually.

#### Step 1: Review Planner Outputs

Before evaluation, review what each planner produced:

```
# Quick status check
check_worker(featureId, heartbeat: true)

# Full output review (recommended for critical features)
check_worker(plannerSessionA)  # View full Planner A output
check_worker(plannerSessionB)  # View full Planner B output
```

Planners have different approaches by design:
- **Planner A**: Focuses on incremental, low-risk changes using established patterns
- **Planner B**: Explores alternative or more elegant approaches, looking for architectural improvements

#### Step 2: Understand the Scoring System

The automatic evaluation scores plans against five criteria (100 points total):

| Criterion | Points | What It Measures |
|-----------|--------|------------------|
| **Completeness** | 25 | Steps defined (3+ ideal), feature keywords addressed, test strategy present |
| **Feasibility** | 25 | Files to modify exist, reasonable step count (2-10), specific files listed |
| **Risk Awareness** | 20 | Risks identified, mitigation strategies (prevent, handle, fallback, rollback) |
| **Clarity** | 15 | Step descriptions >10 chars, validation criteria included, summary 50-500 chars |
| **Efficiency** | 15 | Optimal step count (2-5 ideal), focused file scope (1-5 files ideal) |

#### Step 3: Interpret the Results

The evaluation output shows scores and a winner recommendation:

```
Winner: Plan A
Margin: 12 points
Reason: Plan A selected with moderate advantage. Key strength: Includes risk mitigation strategies

--- Plan A (78/100) ---
  Completeness: 22/25
  Feasibility: 20/25
  Risk Awareness: 18/20
  Clarity: 10/15
  Efficiency: 8/15
  Strengths: Well-structured multi-step approach; Identifies 3 potential risks
  Concerns: Large number of files may indicate scope creep

--- Plan B (66/100) ---
  ...
```

**Margin of Victory Interpretation:**

| Margin | Meaning | Recommended Action |
|--------|---------|-------------------|
| < 5 points | Plans nearly equal | Review both manually; consider domain factors |
| 5-15 points | Moderate advantage | Accept winner unless you have specific concerns |
| >= 15 points | Clear superiority | Accept winner with confidence |

#### Step 4: When to Use Manual Override

Override automatic selection when:

1. **Domain knowledge trumps metrics**: You know codebase constraints the evaluator cannot detect
2. **Security-critical features**: One plan has better security considerations despite lower score
3. **Team conventions**: One plan follows your team's established patterns better
4. **Risk tolerance**: Your project needs the conservative approach even if it scores slightly lower
5. **Close margins with red flags**: Plans nearly equal but one has concerning "Concerns" in output

#### Step 5: Making Manual Selections

To override, provide both the selection and reasoning:

```
evaluate_plans(
  featureId,
  manualSelection: "B",
  selectionReason: "Plan B's approach aligns with our event-driven architecture migration"
)
```

Good selection reasons include:
- Alignment with architectural direction
- Better handling of specific edge cases
- Consistency with recent team decisions
- Risk considerations for production systems

**Example Override Scenarios:**

| Scenario | Override To | Example Reason |
|----------|-------------|----------------|
| Security feature | Conservative plan | "Plan A's incremental approach allows security review at each step" |
| Performance critical | Elegant plan | "Plan B's approach reduces database queries by 60%" |
| Legacy integration | Established patterns | "Plan A uses the same patterns as our existing adapters" |
| Tight deadline | Simpler plan | "Plan A has fewer moving parts, reducing implementation risk" |

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

### When to Use Protocol Governance

Protocol governance adds behavioral constraints to workers. Use it when you need:

**Security Enforcement:**
- Restrict dangerous file operations during bulk refactoring
- Prevent accidental production data modification
- Block execution of certain shell commands

**Team Policies:**
- Enforce code style checking before file writes
- Limit iteration counts on long-running tasks
- Rate limit API calls in multi-worker scenarios

**Compliance & Audit:**
- Track constraint violations for compliance reports
- Enforce approval workflows for sensitive changes

**When NOT to Use:**
- Single-feature tasks (overhead not justified)
- Rapid experimentation (approval slows iteration)
- When base constraints are already sufficient

### How Workers Can Propose Protocols

Workers can dynamically propose new protocols, validated against immutable base constraints before human review.

#### Step 1: Check Base Constraints

Before proposing, understand what cannot be overridden:

```
get_base_constraints(projectDir)
```

Base constraints include:
- **Prohibited tools**: rm -rf, sudo, chmod 777, etc.
- **Protected paths**: ~/.ssh, .env.production, /etc/passwd
- **Required enforcement**: Pre/post validation always enabled, 30-day audit retention

#### Step 2: Design the Protocol

```
propose_protocol(
  projectDir,
  protocol: {
    id: "my-protocol-v1",
    version: "1.0.0",
    name: "My Protocol Name",
    description: "What this protocol does",
    constraints: [
      {
        id: "constraint-1",
        type: "file_access",        // or: tool_restriction, behavioral, temporal, etc.
        severity: "error",          // or: warning, info
        message: "Human-readable explanation",
        rule: {
          type: "file_access",
          deniedPaths: [".env.production", "config/prod/**"]
        }
      }
    ],
    enforcement: {
      mode: "strict",               // or: permissive, audit, learning
      preExecutionValidation: true, // REQUIRED by base constraints
      postExecutionValidation: true,// REQUIRED by base constraints
      onViolation: "block",         // or: warn, log, notify
      logLevel: "standard"
    }
  },
  description: "Why this protocol is needed",
  rationale: "Design decisions and tradeoffs"
)
```

#### Step 3: Review Validation Results

The proposal is immediately validated. Check:
- `isValid`: Whether it passes all checks
- `riskAssessment.overallScore`: Risk score (0-100, lower is better)
- `recommendations`: Suggestions for improvement
- `proposedFixes`: Auto-fixable issues

**Risk Level Thresholds:**

| Score | Level | Meaning |
|-------|-------|---------|
| 0-19 | Minimal | Very safe, likely auto-approvable |
| 20-39 | Low | Minor concerns, should pass review |
| 40-59 | Medium | Review carefully before approval |
| 60-79 | High | Significant risks, may need modification |
| 80-100 | Critical | Likely rejected, needs major changes |

#### Step 4: Review and Approve

```
# List pending proposals
review_proposals(projectDir, status: "pending")

# View specific proposal details
review_proposals(projectDir, proposalId: "prop-xxx")

# Approve and optionally activate immediately
approve_protocol(
  projectDir,
  proposalId: "prop-xxx",
  reason: "Needed for parallel refactoring safety",
  activate: true
)

# Or reject with explanation
reject_protocol(
  projectDir,
  proposalId: "prop-xxx",
  reason: "Too permissive, needs stricter file patterns"
)
```

#### Step 5: Activate and Monitor

```
# If not activated during approval
protocol_activate(protocolId)

# Monitor violations during work
get_violations(projectDir)

# Resolve false positives
resolve_violation(violationId, resolution: "False positive - file is test fixture")

# Deactivate when done
protocol_deactivate(protocolId)
```

### Example Protocol Scenarios

**Scenario 1: Production Protection**
```json
{
  "id": "prod-protection",
  "name": "Production Config Protection",
  "constraints": [{
    "id": "block-prod-env",
    "type": "file_access",
    "severity": "error",
    "message": "Cannot modify production config",
    "rule": {
      "type": "file_access",
      "deniedPaths": [".env.production", "config/production/**"]
    }
  }]
}
```

**Scenario 2: API Rate Limiting**
```json
{
  "id": "api-rate-limit",
  "name": "API Rate Limiting",
  "constraints": [{
    "id": "limit-requests",
    "type": "temporal",
    "severity": "warning",
    "message": "Rate limit exceeded",
    "rule": {
      "type": "temporal",
      "rateLimitPerMinute": 10,
      "burstLimit": 3
    }
  }]
}
```

**Scenario 3: Safe Refactoring Mode**
```json
{
  "id": "safe-refactor",
  "name": "Safe Refactoring Protocol",
  "constraints": [{
    "id": "read-first",
    "type": "behavioral",
    "severity": "warning",
    "message": "Analyze code before modifying",
    "rule": {
      "type": "behavioral",
      "maxIterations": 10,
      "requireConfirmation": true
    }
  }]
}
```

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

**Protocol Proposal Workflow:**
1. `get_base_constraints` - View what cannot be overridden
2. `propose_protocol` - Submit proposal (validated immediately)
3. `review_proposals` - See pending with risk scores
4. `approve_protocol` / `reject_protocol` - Human decision
5. `protocol_activate` - Enable enforcement

### Protocol Networking
| Tool | Purpose |
|------|---------|
| `export_protocols` | Export protocols to shareable bundle |
| `import_protocols` | Import protocols from bundle file |
| `discover_protocols` | Find protocols on peer MCP instances |
| `sync_protocols` | Sync protocols bidirectionally with peers |

### Setup & Analysis
| Tool | Purpose |
|------|---------|
| `setup_analyze` | Check repository freshness and missing configs |
| `setup_init` | Initialize repo with auto-detected configurations |
| `setup_status` | Monitor progress of setup operation |

### Context Management
| Tool | Purpose |
|------|---------|
| `enrich_feature` | Auto-enrich feature with relevant docs/code |
| `set_feature_context` | Manually set context, docs, and protocol bindings |
| `get_feature_graph` | View dependency graph with context info |
| `route_feature` | Configure worker routing and capabilities |

### Rollback
| Tool | Purpose |
|------|---------|
| `rollback_feature` | Restore files to pre-worker state |
| `check_rollback_conflicts` | Check for conflicts before rollback |

### Automation
| Tool | Purpose |
|------|---------|
| `auto_orchestrate` | Hands-free orchestration until completion |

## Example Session

```
User: "Build a REST API for a todo app with CRUD operations"

═══════════════════════════════════════════════════════════════════
PHASE 0: REPOSITORY READINESS CHECK
═══════════════════════════════════════════════════════════════════

Me: Let me check if this repository needs setup first.

[setup_analyze(projectDir)]
→ Freshness score: 75 (missing CLAUDE.md and CI workflow)

Since score >= 50, running setup...

[setup_init(projectDir)]
→ Setup workers started for CLAUDE.md, GitHub CI...

[setup_status(projectDir)]
→ All setup workers complete. Repo is now configured.

═══════════════════════════════════════════════════════════════════
PHASE 1: SESSION SETUP
═══════════════════════════════════════════════════════════════════

Me: Now I'll decompose the task and initialize the session.

[orchestrator_init with features:
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

Now analyzing complexity for all features...

[get_feature_complexity for each feature-1 through feature-9]

Results:
- feature-1 (Express setup): score 35, recommendation: simple
- feature-2 (Mongoose model): score 25, recommendation: simple
- feature-3 through feature-6 (CRUD): scores 20-30, recommendation: simple
- feature-7 (validation): score 45, recommendation: manual_review
- feature-8 (error handling): score 50, recommendation: manual_review
- feature-9 (integration tests): score 65, recommendation: competitive_planning ← FLAG

One feature (tests) flagged for competitive planning.

═══════════════════════════════════════════════════════════════════
PHASE 2: PRE-WORK PREPARATION (for feature-9)
═══════════════════════════════════════════════════════════════════

Since feature-9 has complexity >= 60, using competitive planning:

[start_competitive_planning(feature-9)]
→ Planners A and B started...

[sleep 300]  # Wait 5 minutes for planners

[evaluate_plans(feature-9)]
→ Plan A selected: comprehensive Jest test suite with mocking strategy

═══════════════════════════════════════════════════════════════════
PHASE 3: EXECUTION
═══════════════════════════════════════════════════════════════════

Starting with simple features in parallel:

[validate_workers([feature-1, feature-2, feature-3, feature-4])]
→ No conflicts detected.

[start_parallel_workers([feature-1, feature-2, feature-3, feature-4])]
→ 4 workers started in parallel.

═══════════════════════════════════════════════════════════════════
PHASE 4: MONITORING
═══════════════════════════════════════════════════════════════════

[sleep 180]  # Wait 3 minutes before first check

[check_all_workers(heartbeat: true)]
→ All 4 workers still running...

[sleep 120]

[check_all_workers(heartbeat: true)]
→ Workers completed: feature-1, feature-2, feature-3, feature-4

═══════════════════════════════════════════════════════════════════
PHASE 5: COMPLETION
═══════════════════════════════════════════════════════════════════

[run_verification("npm run build")]
→ Build passed!

[mark_complete(feature-1, success: true)]
[mark_complete(feature-2, success: true)]
[mark_complete(feature-3, success: true)]
[mark_complete(feature-4, success: true)]

[commit_progress("feat: add Express server, Mongoose model, and basic CRUD endpoints")]

═══════════════════════════════════════════════════════════════════
CONTINUE WITH REMAINING FEATURES
═══════════════════════════════════════════════════════════════════

[start_parallel_workers([feature-5, feature-6, feature-7, feature-8])]
... (monitoring and completion cycle)

[start_worker(feature-9)]  # Uses winning plan from competitive planning
... (monitoring and completion cycle)

═══════════════════════════════════════════════════════════════════
PHASE 6: POST-COMPLETION REVIEWS
═══════════════════════════════════════════════════════════════════

All features complete. Automatic reviews starting...

[check_reviews()]
→ Reviews in progress: code-review, architecture-review

[sleep 180]

[get_review_results()]
→ Code review: 2 warnings (missing error handling in 2 places)
→ Architecture review: 1 suggestion (consider middleware consolidation)

[implement_review_suggestions(autoSelect: true, minSeverity: "warning")]
→ Created feature-10: Add missing error handling
→ Created feature-11: Consolidate middleware

[Continue from Phase 2 with new features...]
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
