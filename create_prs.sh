#!/bin/bash
set -e
cd /opt/claude-swarm

echo "=== PR 3: Git Verification ==="
git checkout pr-2 -b feature/git-verification
git reset --hard 75f6ae5^
git checkout 75f6ae5 -- src/utils/git-verification.ts src/utils/git-verification.test.ts src/index.ts src/state/manager.ts
git add src/utils/git-verification.ts src/utils/git-verification.test.ts src/index.ts src/state/manager.ts
git commit -m "feat: add git verification to track code changes per feature

- Capture git state before workers start (beforeHash)
- Calculate diff after completion (afterHash, filesChanged, linesAdded/Deleted)
- Store verification in feature state for audit trail
- Verify expected packages were modified"
git push -u fork feature/git-verification
gh pr create --repo cj-vana/claude-swarm --head jeffersonwarrior:feature/git-verification --title "feat: add git verification to track code changes per feature" --body "## Summary
Add git verification that captures and verifies code changes made by each feature worker.

## Features
- **Before hash**: Capture git HEAD when worker starts
- **After hash**: Capture git HEAD when worker completes
- **Diff calculation**: Track files changed, lines added/deleted
- **Checksum verification**: Validate diff integrity

## Usage
When starting a worker, the orchestrator captures `beforeHash`. When marking complete, it calculates:
- `afterHash`: Final HEAD
- `filesChanged`: Array of modified files
- `linesAdded`: Total lines added
- `linesDeleted`: Total lines deleted
- `diffChecksum`: SHA of the diff for verification

## Integration
- Used in `start_worker` to capture initial state
- Calculated in `mark_complete` to verify changes
- Stored in `feature.gitVerification` for audit"

echo ""
echo "=== PR 4: Structured Prompt Templates ==="
git checkout pr-2 -b feature/prompt-templates
git reset --hard 75f6ae5^
git checkout 75f6ae5 -- src/utils/prompt-templates.ts src/utils/prompt-templates.test.ts
git add src/utils/prompt-templates.ts src/utils/prompt-templates.test.ts
git commit -m "feat: add structured prompt templates for worker guidance

- buildStructuredPrompt: Creates detailed 4-phase prompts
- Phase 1: Get Your Bearings (explore codebase)
- Phase 2: Verify Environment Health
- Phase 3: Implement Feature
- Phase 4: Leave Environment Clean"
git push -u fork feature/prompt-templates
gh pr create --repo cj-vana/claude-swarm --head jeffersonwarrior:feature/prompt-templates --title "feat: add structured prompt templates for worker guidance" --body "## Summary
Add structured prompt templates that guide workers through a clear 4-phase implementation process.

## Features
- **buildStructuredPrompt**: Generates detailed prompts with phase guidance
- **Phase 1 - Get Bearings**: Explore codebase, read logs, understand context
- **Phase 2 - Verify Health**: Run tests, ensure working environment
- **Phase 3 - Implement**: Make changes, test thoroughly, create .done file
- **Phase 4 - Clean Up**: Leave environment ready for next worker

## Benefits
- Consistent worker behavior across features
- Clear expectations for each implementation step
- Reduces forgotten steps (like testing or cleanup)
- Critical requirements highlighted (no code changes = warning)"

echo ""
echo "=== PR 5: Enhanced State Schemas ==="
git checkout pr-2 -b feature/state-schemas
git reset --hard 75f6ae5^
git checkout 75f6ae5 -- src/state/manager.ts src/utils/security.ts
git add src/state/manager.ts src/utils/security.ts
git commit -m "feat: add protocol governance state schemas

- DocumentationRef: Reference documentation for worker context
- PreparedContext: Pre-processed context for efficient worker startup
- ProtocolBinding: Bind protocols to features for behavioral governance
- RoutingConfig: Configure feature routing to workers
- Zod schemas for type-safe validation"
git push -u fork feature/state-schemas
gh pr create --repo cj-vana/claude-swarm --head jeffersonwarrior:feature/state-schemas --title "feat: add protocol governance state schemas" --body "## Summary
Add TypeScript interfaces and Zod schemas for protocol-based behavioral governance.

## New Interfaces
- **DocumentationRef**: Reference docs (file/url/snippet) with relevance scoring
- **PreparedContext**: Pre-processed context blocks with token estimates
- **ProtocolBinding**: Bind protocols to features with scope and priority
- **RoutingConfig**: Feature routing preferences (worker type, capabilities, isolation)

## Usage
These interfaces are opt-in and don't change behavior unless used:
```typescript
feature.context = {
  documentation: [{ type: 'file', path: 'docs/api.md', relevance: 'API reference' }],
  prepared: [{ key: 'api-summary', content: '...', priority: 'required' }]
}
feature.protocolBindings = [{ protocolId: 'strict-testing', scope: 'all', priority: 10 }]
feature.routing = { preferredWorkerType: 'senior', isolationLevel: 'container' }
```

## Zod Schemas
All new types have corresponding Zod schemas in security.ts for validation."

echo ""
echo "=== PR 6: Confidence Tests ==="
git checkout pr-2 -b feature/confidence-tests
git reset --hard 75f6ae5^
git checkout 75f6ae5 -- src/workers/confidence.test.ts
git add src/workers/confidence.test.ts
git commit -m "test: add comprehensive tests for worker confidence monitoring

- Test confidence score calculation from tool usage patterns
- Test alert generation at threshold boundaries
- Test aggregated confidence across worker sessions
- Test historical trend detection"
git push -u fork feature/confidence-tests
gh pr create --repo cj-vana/claude-swarm --head jeffersonwarrior:feature/confidence-tests --title "test: add comprehensive tests for worker confidence monitoring" --body "## Summary
Add comprehensive test coverage for the worker confidence monitoring feature.

## Tests Included
- Confidence score calculation from tool usage patterns
- Alert generation at configurable thresholds (default: 35)
- Aggregated confidence across multiple worker sessions
- Historical trend detection (improving/declining/stable)
- Low confidence flagging and auto-alert logging

## Coverage
- Unit tests for confidence.ts utility functions
- Integration tests for confidence monitoring in workers
- Edge cases: empty sessions, threshold boundaries, rapid changes"

echo ""
echo "=== All PRs Created ==="
gh pr list --repo cj-vana/claude-swarm --head jeffersonwarrior --state all
