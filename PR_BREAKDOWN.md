# PR Breakdown Plan

## Strategy: Small, Incremental PRs

The goal is to submit features independently so maintainers can review and merge easily.

---

## PR 1: Test Coverage Foundation ⭐
**Purpose:** Non-breaking, shows quality commitment first

**Files:**
- `vitest.config.ts`
- `src/state/manager.test.ts`
- `src/utils/complexity-detector.test.ts`
- `src/utils/feature-generator.test.ts`
- `src/utils/format.test.ts`
- `src/utils/plan-evaluator.test.ts`
- `src/utils/prompt-templates.test.ts`
- `src/utils/security.test.ts`
- `src/utils/validation.test.ts`
- `src/workers/confidence.test.ts`
- `src/workers/manager.test.ts`
- `src/workers/manager.integration.test.ts`

**Why first:** Pure tests, zero runtime impact, builds trust

---

## PR 2: Feature Validation Framework
**Purpose:** Allow features to define success criteria and auto-validate

**Files:**
- `src/utils/validation.ts` + `.test.ts`
- `src/state/manager.ts` - Add `ValidationConfig`, `ValidationResult`, `ValidationCheck` interfaces
- `src/index.ts` - Integrate validation logic in `mark_complete`
- `src/workers/manager.ts` - Use `buildStructuredPrompt` for validation-enabled features

**New feature:** Features can now have validation criteria (coverage targets, test requirements, etc.)

---

## PR 3: Git Verification
**Purpose:** Track and verify code changes per feature

**Files:**
- `src/utils/git-verification.ts` + `.test.ts`
- `src/state/manager.ts` - Add `GitVerification` interface
- `src/index.ts` - Capture git state before/after workers, verify changes

**New feature:** Automatic detection of files changed, lines added/deleted per feature

---

## PR 4: Structured Prompt Templates
**Purpose:** Provide clear implementation phases for workers

**Files:**
- `src/utils/prompt-templates.ts` + `.test.ts`
- `src/workers/manager.ts` - Use `buildStructuredPrompt` for validation-enabled features

**New feature:** Workers see 4-phase guidance (Get Bearings → Verify Health → Implement → Clean Up)

---

## PR 5: Enhanced State & Security Schemas
**Purpose:** Add protocol governance foundation (extensible, non-breaking)

**Files:**
- `src/state/manager.ts` - Add `DocumentationRef`, `PreparedContext`, `ProtocolBinding`, `RoutingConfig` interfaces
- `src/utils/security.ts` - Add Zod schemas for new types

**Why separate:** These interfaces are "opt-in" - no behavior changes, just type definitions

---

## PR 6: Confidence Monitoring
**Purpose:** Detect stuck/idle workers early

**Files:**
- `src/workers/confidence.ts` + `.test.ts`
- Already mostly in main, this PR adds comprehensive tests

**Note:** May already exist in main - verify and skip if so

---

## Execution Order

1. **PR 1** → Merge (low risk, builds trust)
2. **PR 2** → Merge (validation logic)
3. **PR 3** → Merge (git verification)  
4. **PR 4** → Merge (prompt improvements)
5. **PR 5** → Merge (schema definitions)
6. **PR 6** → Merge (confidence tests)

---

## Commands to Execute

```bash
# Create branches for each PR
git checkout pr-2

# PR 1: Tests
git checkout -b feature/test-coverage
git add vitest.config.ts src/**/*.test.ts
git commit -m "test: add comprehensive test coverage (418 tests)"
git push -u origin feature/test-coverage

# PR 2: Validation
git checkout pr-2
git checkout -b feature/feature-validation
git add src/utils/validation.ts src/state/manager.ts src/index.ts
git commit -m "feat: add feature validation framework with configurable success criteria"
git push -u origin feature/feature-validation

# ... continue for each PR
```
