## Summary
Add a feature validation framework that allows defining success criteria per feature.

## Features
- **ValidationConfig**: Per-feature validation settings
  - `enabled`: Enable/disable validation
  - `coverageTarget`: e.g., 50.0 for 50% coverage
  - `testPassRequired`: Require tests to pass
  - `enforceBlocking`: Block completion on failure
  - `verifyCommand`: Custom verification command
  - `expectedPackages`: Required package structure

- **ValidationResult**: Validation check results with pass/fail status

- **Structured prompts**: Build prompts with validation guidance

## Usage Example
\`\`\`typescript
{
  id: 'feature-1',
  validation: {
    enabled: true,
    coverageTarget: 80.0,
    testPassRequired: true,
    enforceBlocking: true,
    verifyCommand: 'npm test',
    expectedPackages: ['src/components/']
  }
}
\`\`\`

## Behavior
- When `mark_complete success=true` is called, validation runs
- If `enforceBlocking=true` and validation fails, feature stays pending
- Non-blocking failures show warnings but allow completion
- Supports retry with attempt tracking
