# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build and Development Commands

```bash
npm run build         # Compile TypeScript and copy dashboard assets
npm run dev           # Watch mode for TypeScript compilation
npm start             # Run the compiled MCP server
npm run inspector     # Debug with MCP Inspector
npx tsc --noEmit      # Type-check without emitting (CI validation)
npm test              # Run all tests with Vitest
npm run test:watch    # Run tests in watch mode
npm run test:coverage # Run tests with coverage report
npx vitest run src/utils/git-verification.test.ts  # Run a single test file
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

**src/index.ts** - MCP server entry point registering 55+ tools. All tool handlers are defined inline. Tool schemas use Zod for validation. The file is structured by tool category: core orchestration, worker management, competitive planning, confidence monitoring, feature management, session control, post-completion reviews, protocol management, protocol networking, context management, and repository setup.

**src/state/manager.ts** - Persistent state management using the "notebook pattern". Stores session state in `.claude/orchestrator/state.json` with atomic writes (temp file + rename). Also generates `claude-progress.txt` for human readability and `init.sh` for environment setup. Manages feature context (`FeatureContext`), routing config, and protocol bindings per feature.

**src/workers/manager.ts** - Manages Claude Code worker sessions via tmux. Key security pattern: prompts are passed via files (not shell strings, mode 0600) to prevent injection. Includes completion monitoring (10s polling) with circuit breaker pattern (`MAX_MONITOR_ERRORS = 5` auto-stops after repeated failures), heartbeat tracking, and conflict analysis for parallel execution. Supports competitive planning mode with dual planners.

**src/workers/confidence.ts** - Multi-signal confidence scoring combining tool activity patterns (35%), self-reported confidence (35%), and output analysis (30%). Detects struggling workers via stuck loops, error patterns, and frustration language.

**src/workers/enforcement-integration.ts** - Hooks protocol enforcement into the worker lifecycle. Validates constraints before worker spawns and monitors during execution.

**src/workers/review-manager.ts** - Orchestrates post-completion code and architecture reviews. Parses worker logs to identify modified files, builds review prompts with session context, and aggregates findings into structured JSON. Review workers have read-only tool access (no Bash). Notifies orchestrator when reviews complete via status file updates.

### Protocol Governance System

The protocol system enables behavioral constraints on workers. Located in `src/protocols/`:

**schema.ts** - Zod schemas defining `Protocol`, `ProtocolConstraint`, constraint types (tool_restriction, file_access, output_format, behavioral, temporal, resource, side_effect), and `BaseConstraints`. All protocol data is validated against these schemas.

**registry.ts** - Protocol storage, activation status, and violation tracking. Persists to `.claude/orchestrator/protocols/`. Implements `ProtocolRegistryLike` interface for resolver compatibility. Maintains audit log of all protocol operations.

**enforcement.ts** - Pre/post execution validation engine. Validates worker actions against active protocol constraints. Supports learning mode for protocol development. Memory-bounded with `MAX_OBSERVED_PATTERNS = 100` and `MAX_ACTIVE_ALERTS = 50` using LRU eviction when limits are reached.

**resolver.ts** - Resolves effective constraints by merging multiple active protocols, handling inheritance (`extends`), and conflict resolution based on priority.

**base-constraints.ts** - Immutable security boundaries (frozen at runtime). Defines prohibited tools (rm -rf, sudo, etc.), prohibited paths (/etc, ~/.ssh, etc.), and maximum privilege ceiling. LLM-generated protocols cannot override these.

**proposal-manager.ts** - Manages LLM-generated protocol proposals. Validates against base constraints, calculates risk scores, and tracks approval workflow (pending -> reviewing -> approved/rejected).

**proposal-validator.ts** - Deep validation of protocol proposals including constraint rule verification and risk scoring algorithm.

**constraint-evaluator.ts** - Rule evaluation engine that executes constraint checks at runtime. Handles all constraint types with type-specific evaluation logic.

**generator.ts** - Protocol generation utilities for creating well-formed protocols programmatically.

**network/** - Protocol distribution across MCP instances. `distributor.ts` handles bundle export/import with optional signing. `sync.ts` enables push/pull/bidirectional synchronization.

### Repository Setup System

Located in `src/setup/`:

**manager.ts** - Orchestrates repository configuration with platform detection (GitHub, GitLab, Gitea, Bitbucket, Azure DevOps). Generates setup features for missing configurations and builds prompts for worker execution.

**analyzer.ts** - Project structure analysis detecting languages, frameworks, and package managers. Identifies existing configurations and calculates repository "freshness" score.

**detector.ts** - Language and framework detection utilities. Scans for package manifests (package.json, Cargo.toml, pyproject.toml, etc.) and identifies test frameworks, build tools.

**platforms.ts** - Platform-specific configuration adapters. Maps generic configs to GitHub, GitLab, Gitea, Bitbucket, and Azure DevOps formats.

**merge-strategy.ts** - Handles merging new configurations with existing files. Supports JSON, YAML, and markdown merge modes.

**generator.ts** - Template generators for repository configuration files:
- `generateClaudeMd()` - Project-specific CLAUDE.md
- `generateCIWorkflow()` - GitHub Actions CI for detected languages
- `generateDependabot()` - Dependency update configuration
- `generateReleasePlease()` - Automated release workflow
- `generateIssueTemplates()` - Bug report and feature request forms
- `generatePRTemplate()` - Pull request description template
- `generateContributing()` - CONTRIBUTING.md with project-specific guidance
- `generateSecurity()` - SECURITY.md with vulnerability reporting policy

### Dashboard System

**src/dashboard/server.ts** - Express 5 HTTP server with REST API and SSE (Server-Sent Events) endpoints. Provides real-time updates for session status, worker progress, and terminal output.

**src/dashboard/public/** - Static dashboard UI with:
- Live terminal streaming with ANSI to HTML color conversion
- Review worker visibility (code-review, architecture-review)
- Feature cards with status, dependencies, and worker assignment
- Session overview with progress bar and statistics
- Dark mode support with system preference detection

### Additional Components

**src/context/enricher.ts** - Auto-enriches features with relevant documentation (CLAUDE.md, README) and related code files. Configurable context limits prevent prompt bloat (default: 16KB max total, 4KB per doc, 2KB per code file). Includes 60-second cache TTL for frequently accessed context.

**src/utils/complexity-detector.ts** - Analyzes feature complexity (0-100 score) based on description keywords, scope indicators, dependency count. Features scoring 60+ trigger competitive planning recommendation.

**src/utils/plan-evaluator.ts** - Compares competing implementation plans, scoring on completeness, risk mitigation, and testing coverage.

**src/utils/security.ts** - Comprehensive security utilities:
- `validatePath()` - Path traversal prevention with symlink detection
- `validateFeatureId()` - Feature ID format validation
- `validateSessionName()` - Session name sanitization
- `isAllowedCommand()` - Command allowlist enforcement via `ALLOWED_COMMAND_PATTERNS`
- `sanitizeOutput()` - Output sanitization for logs
- `isDangerousRegexPattern()` - ReDoS pattern detection (nested quantifiers, overlapping alternation, range quantifiers, non-capturing groups)
- `safeRegexTest()` - Safe regex testing with automatic fallback to literal matching for dangerous patterns
- `escapeRegex()` - Regex metacharacter escaping for safe pattern construction

**src/utils/feature-generator.ts** - Auto-generates feature lists from task descriptions using keyword extraction and pattern matching.

**src/utils/format.ts** - Formatting utilities for consistent output across tools (compact vs pretty modes).

**src/utils/validation.ts** - Common validation utilities for user inputs, feature IDs, and session names.

**src/utils/git-verification.ts** - Git operation verification utilities. Validates git state, checks for uncommitted changes, and verifies branch existence.

**src/utils/prompt-templates.ts** - Prompt templates for worker instructions. Centralizes prompts for consistency across worker types.

### Key Design Patterns

1. **Persistent State Outside Context** - State survives Claude's context compaction via the MCP server
2. **Worker Isolation** - Each worker runs in its own tmux session with controlled tool access (`Bash,Read,Write,Edit,Glob,Grep`)
3. **Atomic File Operations** - State and progress files use write-to-temp-then-rename pattern
4. **Command Allowlist** - Only safe verification commands (npm test, pytest, etc.) can be executed
5. **File-Based Prompt Passing** - Worker prompts written to `.prompt` files, not shell strings
6. **Fail-Closed Enforcement** - Unknown constraint types block by default in protocol validation
7. **Immutable Base Constraints** - Security boundaries frozen at module load, cannot be overridden
8. **SSE for Real-time Updates** - Dashboard uses Server-Sent Events for live worker monitoring

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

## Adding New Tools

When adding a new MCP tool to `src/index.ts`:
1. Define Zod schema for parameters
2. Add tool registration with `server.tool(name, description, schema, handler)`
3. Use `ensureInitialized(projectDir)` to get managers
4. Use security utilities from `src/utils/security.ts` for input validation
5. Follow existing patterns for error handling and response formatting
6. Update README.md tool reference table

## Adding New Setup Configurations

When adding a new repository configuration type:
1. Add generator function in `src/setup/generator.ts`
2. Add feature definition in `src/setup/manager.ts` `generateSetupFeatures()`
3. Add prompt builder method in `src/setup/manager.ts`
4. Add switch case in `generatePromptForFeature()`
5. Update `GeneratedFiles` type if adding a new file category

## Parallel Worker Limitations

Workers run in isolated tmux sessions and cannot see each other's changes until they commit. This creates potential conflicts:

### Conflict Scenarios
- **Same file edits**: Two workers modifying the same file will cause merge conflicts
- **Type definition changes**: One worker changing types that another depends on
- **Shared dependencies**: Both workers updating package.json or lock files
- **Import paths**: Renaming/moving files that other workers import

### Conflict Detection
Use `validate_workers` before `start_parallel_workers` to detect potential conflicts:
- Analyzes feature descriptions for file/folder/component overlap
- Identifies dangerous action combinations (refactor + refactor)
- Provides safe parallel groups vs. sequential recommendations

### Mitigation Strategies
1. **Feature Ordering**: Use `set_dependencies` to explicitly order features
2. **Sequential Execution**: Run conflicting features one at a time
3. **Verification Commands**: Use `configure_verification` to run `npx tsc --noEmit` to catch type errors
4. **Review Workers**: Post-completion reviews detect merge conflicts and type inconsistencies
5. **Small Features**: Break large features into smaller, non-overlapping units

### Best Practices
```bash
# Before starting parallel workers, always validate
# Tool: validate_workers with featureIds

# Configure verification to catch type errors early
# Tool: configure_verification with commands: ["npx tsc --noEmit"]

# Group independent features (UI vs backend vs config)
# Run overlapping features sequentially with dependencies
```

## Feature Rollback

The orchestrator creates git snapshot branches before each worker starts, enabling safe rollback of failed features.

### How Rollback Works

1. **Snapshot Creation**: When `start_worker` is called, a `swarm/{featureId}` branch is created at current HEAD
2. **Worker Execution**: The worker makes changes to the working directory
3. **Completion Handling**:
   - On success: `mark_complete` deletes the snapshot branch (no longer needed)
   - On failure: The snapshot branch is preserved for potential rollback

### Using Rollback

```bash
# Rollback all files changed by a failed feature
# Tool: rollback_feature with featureId: "feature-1"

# Rollback specific files only
# Tool: rollback_feature with featureId: "feature-1", files: ["src/component.ts"]
```

### Rollback Behavior

- **Modified files**: Restored to their state before the worker started
- **New files**: Removed (files that didn't exist in the snapshot)
- **Deleted files**: Restored (files that existed in snapshot but were deleted)

### Race Condition Warning

When rolling back a feature in a parallel worker environment:
- If other workers modified the same files, their changes will also be reverted
- Always run `validate_workers` to check for file conflicts before rollback
- Consider using specific file list for targeted rollback to minimize side effects

### Snapshot Branch Cleanup

Snapshot branches are automatically cleaned up:
- On successful feature completion (`mark_complete` with `success: true`)
- During session reset (`orchestrator_reset`)

To manually check for leftover branches:
```bash
git branch --list 'swarm/*'
```
