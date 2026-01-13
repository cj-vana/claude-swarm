# Contributing to Claude Swarm

Thank you for your interest in contributing! This document provides guidelines and instructions for contributing to Claude Swarm.

## Getting Started

### Prerequisites

- Node.js 18+
- tmux (`brew install tmux` on macOS)
- Claude Code CLI

### Setup

1. Fork the repository
2. Clone your fork:
   ```bash
   git clone https://github.com/YOUR_USERNAME/claude-swarm.git
   cd claude-swarm
   ```
3. Install dependencies:
   ```bash
   npm install
   ```
4. Build the project:
   ```bash
   npm run build
   ```

### Testing Your Setup

```bash
# Add the MCP server to Claude Code for testing
claude mcp add claude-swarm --scope user -- node $(pwd)/dist/index.js

# Install the skill for orchestration
mkdir -p ~/.claude/skills/swarm && cp skill/SKILL.md ~/.claude/skills/swarm/
```

## Development Workflow

### Running in Development Mode

```bash
npm run dev
```

This starts TypeScript in watch mode for automatic recompilation when you save changes.

### Type Checking

```bash
npx tsc --noEmit
```

Run type checks without emitting files. This is also run in CI.

### Testing with MCP Inspector

```bash
npm run inspector
```

The MCP Inspector lets you test tool calls interactively without running Claude Code.

### Viewing the Dashboard

The web dashboard runs at `http://localhost:3456` when the MCP server is active. Test changes to the dashboard by:

1. Modifying files in `src/dashboard/public/`
2. Rebuilding: `npm run build`
3. Refreshing the browser

## Project Structure

```
src/
├── index.ts              # MCP server entry point with all tools
├── state/
│   └── manager.ts        # Session state persistence
├── workers/
│   ├── manager.ts        # tmux worker management
│   ├── confidence.ts     # Worker confidence scoring
│   ├── review-manager.ts # Post-completion reviews
│   └── enforcement-integration.ts
├── protocols/
│   ├── schema.ts         # Zod schemas for protocols
│   ├── registry.ts       # Protocol storage
│   ├── enforcement.ts    # Constraint validation
│   ├── resolver.ts       # Protocol merging
│   ├── base-constraints.ts
│   ├── proposal-manager.ts
│   └── network/          # Cross-instance sync
├── setup/
│   ├── manager.ts        # Repo setup orchestration
│   └── generator.ts      # Config file generators
├── context/
│   └── enricher.ts       # Feature context enrichment
├── dashboard/
│   ├── server.ts         # Express server with SSE
│   └── public/           # Dashboard HTML/CSS/JS
└── utils/
    ├── security.ts       # Input validation
    ├── complexity-detector.ts
    ├── plan-evaluator.ts
    └── format.ts
```

## Making Changes

### Branch Naming

- `feature/description` - New features
- `fix/description` - Bug fixes
- `docs/description` - Documentation updates
- `refactor/description` - Code refactoring

### Commit Messages

Follow conventional commits:

```
type(scope): description

[optional body]
```

Types:
- `feat` - New feature
- `fix` - Bug fix
- `docs` - Documentation
- `refactor` - Code refactoring
- `test` - Adding tests
- `chore` - Maintenance

Examples:
```
feat(dashboard): add ANSI color support for terminal output
fix(worker): handle tmux session cleanup on failure
docs(readme): document repository setup feature
refactor(protocols): extract constraint evaluation logic
```

### Code Guidelines

**TypeScript**
- Use strict mode (enabled in tsconfig.json)
- Add types for function parameters and return values
- Use Zod for runtime validation of external input
- Use `.js` extension for imports (ESM requirement)

**Security**
- All file paths must be validated with `validatePath()` from `src/utils/security.ts`
- Use `validateFeatureId()`, `validateSessionName()` for identifiers
- Commands must match `ALLOWED_COMMAND_PATTERNS` in security.ts
- Never pass user input directly to shell commands

**Regex Safety (ReDoS Prevention)**
- Never create `new RegExp()` with user input directly
- Use `safeRegexTest()` for all pattern matching operations
- Test patterns with `isDangerousRegexPattern()` before using
- Escape user input with `escapeRegex()` when building patterns

**Memory Safety**
- Add bounds to any growing collections (Maps, Arrays, Sets)
- Use LRU eviction or periodic cleanup for caches (see `proposal-manager.ts` for LRU example)
- Truncate historical data after filtering (see `enforcement.ts` for examples)
- Use `MAX_CACHE_SIZE` constants to cap singleton caches

**Async Safety**
- Prevent overlapping async executions with mutex patterns
- Add error counting and circuit breakers to monitors/intervals
- Always handle promise rejections

**Error Handling**
- Return structured errors with `{ success: false, error: message }`
- Log errors with context for debugging
- Use fail-closed approach for security-sensitive operations

### Adding a New Tool

1. Define the Zod schema in `src/index.ts`:
   ```typescript
   const myToolSchema = z.object({
     projectDir: z.string().describe("Absolute path to the project directory"),
     // ... other parameters
   });
   ```

2. Register the tool with the server:
   ```typescript
   server.tool(
     "my_tool_name",
     "Description of what this tool does",
     myToolSchema.shape,
     async ({ projectDir, ...params }) => {
       const { stateManager, workerManager } = await ensureInitialized(projectDir);
       // Implementation
       return { content: [{ type: "text", text: JSON.stringify(result) }] };
     }
   );
   ```

3. Update CLAUDE.md to document the new tool

### Testing Security Features

When adding security-related code:

1. **Test with malicious inputs:**
   - Patterns like `(a+)+b`, `(?:x+)+`, `(a{1,10}){2,}` (ReDoS)
   - Path traversal attempts: `../../../etc/passwd`
   - Null/undefined values in all string parameters

2. **Test bounds:**
   - Verify collections don't grow unbounded
   - Confirm LRU eviction works correctly
   - Check memory usage under load

3. **Test fail-closed behavior:**
   - Invalid inputs should block, not allow
   - Errors should fail safely, not open holes

### Adding a New Setup Configuration

1. Add the generator function in `src/setup/generator.ts`:
   ```typescript
   export function generateMyConfig(analysis: ProjectAnalysis): string {
     // Return the file content
   }
   ```

2. Add the setup feature in `src/setup/manager.ts`:
   - Add the feature definition in `generateSetupFeatures()`
   - Add the prompt builder method
   - Add the case in `generatePromptForFeature()`

3. Update the `GeneratedFiles` type if adding a new file type

## Pull Request Process

1. Create a feature branch from `main`
2. Make your changes
3. Ensure the build passes: `npm run build`
4. Run type checking: `npx tsc --noEmit`
5. Update documentation if needed
6. Submit a pull request

### PR Checklist

- [ ] Code compiles without errors (`npm run build`)
- [ ] Type checking passes (`npx tsc --noEmit`)
- [ ] Changes are documented in README if applicable
- [ ] CLAUDE.md updated if adding/changing tools
- [ ] Commit messages follow conventions
- [ ] PR description explains the changes

### PR Description Template

```markdown
## Summary
Brief description of what this PR does

## Changes
- List of specific changes made

## Testing
How you tested these changes

## Documentation
- [ ] README.md updated (if applicable)
- [ ] CLAUDE.md updated (if applicable)
- [ ] SKILL.md updated (if applicable)
```

## Reporting Issues

### Bug Reports

Please include:
- Description of the bug
- Steps to reproduce
- Expected behavior
- Actual behavior
- Environment (OS, Node version, Claude Code version)
- Relevant logs or screenshots
- tmux session output if worker-related

### Feature Requests

Please include:
- Description of the feature
- Use case / motivation
- Proposed implementation (optional)
- Impact on existing functionality

## Code of Conduct

- Be respectful and inclusive
- Focus on constructive feedback
- Help others learn and grow
- Keep discussions on-topic

## Questions?

Open an issue with the "question" label or start a discussion.

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
