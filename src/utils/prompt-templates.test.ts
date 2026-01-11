/**
 * TDD Tests for prompt-templates module
 *
 * Tests prompt generation with validation:
 * - Success criteria generation (coverage, tests, packages)
 * - Validation command generation
 * - Structured prompt building
 * - Retry prompt generation
 * - Criterion status tracking (passed/failed)
 * - Edge cases (no validation, partial validation)
 */

import { describe, it, expect } from 'vitest';
import {
  generateSuccessCriteria,
  generateValidationCommand,
  buildStructuredPrompt,
  buildRetryPrompt,
} from './prompt-templates.js';
import { Feature } from '../state/manager.js';

describe('prompt-templates module', () => {
  const createFeature = (overrides: Partial<Feature> = {}): Feature => ({
    id: 'test-feature',
    description: 'Implement user authentication',
    status: 'pending',
    attempts: 0,
    ...overrides,
  });

  describe('generateSuccessCriteria', () => {
    it('should return empty array if validation not enabled', () => {
      const feature = createFeature({
        validation: { enabled: false },
      });

      const criteria = generateSuccessCriteria(feature);

      expect(criteria).toEqual([]);
    });

    it('should return empty array if no validation config', () => {
      const feature = createFeature();

      const criteria = generateSuccessCriteria(feature);

      expect(criteria).toEqual([]);
    });

    it('should generate coverage criterion', () => {
      const feature = createFeature({
        validation: {
          enabled: true,
          coverageTarget: 80,
        },
      });

      const criteria = generateSuccessCriteria(feature);

      expect(criteria).toHaveLength(1);
      expect(criteria[0]).toMatchObject({
        name: 'Test Coverage',
        metric: 'coverage',
        operator: '>=',
        target: 80,
        passed: false,
      });
    });

    it('should mark coverage criterion as passed when met', () => {
      const feature = createFeature({
        validation: {
          enabled: true,
          coverageTarget: 80,
        },
        validationResult: {
          passed: true,
          checks: [{ name: 'coverage', passed: true, actual: 85 }],
        },
      });

      const criteria = generateSuccessCriteria(feature);

      expect(criteria[0].current).toBe(85);
      expect(criteria[0].passed).toBe(true);
    });

    it('should mark coverage criterion as failed when not met', () => {
      const feature = createFeature({
        validation: {
          enabled: true,
          coverageTarget: 80,
        },
        validationResult: {
          passed: false,
          checks: [{ name: 'coverage', passed: false, actual: 65 }],
        },
      });

      const criteria = generateSuccessCriteria(feature);

      expect(criteria[0].current).toBe(65);
      expect(criteria[0].passed).toBe(false);
    });

    it('should generate test pass criterion', () => {
      const feature = createFeature({
        validation: {
          enabled: true,
          testPassRequired: true,
        },
      });

      const criteria = generateSuccessCriteria(feature);

      expect(criteria).toHaveLength(1);
      expect(criteria[0]).toMatchObject({
        name: 'Tests Pass',
        metric: 'tests',
        operator: '==',
        target: 'PASS',
        current: 'FAIL',
        passed: false,
      });
    });

    it('should mark test criterion as passed when tests pass', () => {
      const feature = createFeature({
        validation: {
          enabled: true,
          testPassRequired: true,
        },
        validationResult: {
          passed: true,
          checks: [{ name: 'tests', passed: true }],
        },
      });

      const criteria = generateSuccessCriteria(feature);

      expect(criteria[0].current).toBe('PASS');
      expect(criteria[0].passed).toBe(true);
    });

    it('should generate package verification criterion', () => {
      const feature = createFeature({
        validation: {
          enabled: true,
          expectedPackages: ['internal/agent', 'internal/db'],
        },
      });

      const criteria = generateSuccessCriteria(feature);

      expect(criteria).toHaveLength(1);
      expect(criteria[0]).toMatchObject({
        name: 'Modified Packages',
        metric: 'files',
        operator: 'in',
        target: ['internal/agent', 'internal/db'],
        passed: false,
      });
    });

    it('should handle multiple criteria', () => {
      const feature = createFeature({
        validation: {
          enabled: true,
          coverageTarget: 80,
          testPassRequired: true,
          expectedPackages: ['internal/agent'],
        },
      });

      const criteria = generateSuccessCriteria(feature);

      expect(criteria).toHaveLength(3);
      expect(criteria[0].name).toBe('Test Coverage');
      expect(criteria[1].name).toBe('Tests Pass');
      expect(criteria[2].name).toBe('Modified Packages');
    });

    it('should skip coverage criterion if target is 0', () => {
      const feature = createFeature({
        validation: {
          enabled: true,
          coverageTarget: 0,
        },
      });

      const criteria = generateSuccessCriteria(feature);

      expect(criteria).toHaveLength(0);
    });

    it('should skip coverage criterion if target is undefined', () => {
      const feature = createFeature({
        validation: {
          enabled: true,
          testPassRequired: true,
        },
      });

      const criteria = generateSuccessCriteria(feature);

      expect(criteria).toHaveLength(1);
      expect(criteria[0].name).not.toBe('Test Coverage');
    });
  });

  describe('generateValidationCommand', () => {
    it('should return placeholder if no validation', () => {
      const feature = createFeature();

      const command = generateValidationCommand(feature);

      expect(command).toBe('# No validation configured');
    });

    it('should use custom verify command if provided', () => {
      const feature = createFeature({
        validation: {
          enabled: true,
          verifyCommand: 'npm test',
        },
      });

      const command = generateValidationCommand(feature);

      expect(command).toBe('npm test');
    });

    it('should generate coverage command for all packages', () => {
      const feature = createFeature({
        validation: {
          enabled: true,
          coverageTarget: 80,
        },
      });

      const command = generateValidationCommand(feature);

      expect(command).toBe('go test -cover ./...');
    });

    it('should generate coverage command for specific packages', () => {
      const feature = createFeature({
        validation: {
          enabled: true,
          coverageTarget: 80,
          expectedPackages: ['internal/agent', 'internal/db'],
        },
      });

      const command = generateValidationCommand(feature);

      expect(command).toBe('go test -cover internal/agent internal/db');
    });

    it('should generate test command without coverage', () => {
      const feature = createFeature({
        validation: {
          enabled: true,
          testPassRequired: true,
        },
      });

      const command = generateValidationCommand(feature);

      expect(command).toBe('go test ./...');
    });

    it('should generate test command for specific packages', () => {
      const feature = createFeature({
        validation: {
          enabled: true,
          testPassRequired: true,
          expectedPackages: ['internal/agent'],
        },
      });

      const command = generateValidationCommand(feature);

      expect(command).toBe('go test internal/agent');
    });

    it('should prioritize coverage command over test command', () => {
      const feature = createFeature({
        validation: {
          enabled: true,
          coverageTarget: 80,
          testPassRequired: true,
        },
      });

      const command = generateValidationCommand(feature);

      expect(command).toBe('go test -cover ./...');
      expect(command).not.toContain('&&');
    });

    it('should return placeholder if neither test nor coverage required', () => {
      const feature = createFeature({
        validation: {
          enabled: true,
          expectedPackages: ['internal/agent'],
        },
      });

      const command = generateValidationCommand(feature);

      expect(command).toBe('# No validation command needed');
    });
  });

  describe('buildStructuredPrompt', () => {
    it('should include task description', () => {
      const feature = createFeature({
        description: 'Implement JWT authentication',
      });

      const prompt = buildStructuredPrompt(feature);

      expect(prompt).toContain('# Your Task');
      expect(prompt).toContain('Implement JWT authentication');
    });

    it('should include custom context when provided', () => {
      const feature = createFeature();
      const context = 'Use bcrypt for password hashing';

      const prompt = buildStructuredPrompt(feature, context);

      expect(prompt).toContain('## Additional Context');
      expect(prompt).toContain('Use bcrypt for password hashing');
    });

    it('should not include custom context section when not provided', () => {
      const feature = createFeature();

      const prompt = buildStructuredPrompt(feature);

      expect(prompt).not.toContain('## Additional Context');
    });

    it('should include success criteria when validation enabled', () => {
      const feature = createFeature({
        validation: {
          enabled: true,
          coverageTarget: 80,
        },
      });

      const prompt = buildStructuredPrompt(feature);

      expect(prompt).toContain('## Success Criteria (MUST achieve ALL)');
      expect(prompt).toContain('**Test Coverage**');
      expect(prompt).toContain('coverage >= 80');
    });

    it('should show checkbox status for criteria', () => {
      const feature = createFeature({
        validation: {
          enabled: true,
          testPassRequired: true,
        },
        validationResult: {
          passed: true,
          checks: [{ name: 'tests', passed: true }],
        },
      });

      const prompt = buildStructuredPrompt(feature);

      expect(prompt).toContain('[x] **Tests Pass**'); // Passed
    });

    it('should show unchecked box for failed criteria', () => {
      const feature = createFeature({
        validation: {
          enabled: true,
          testPassRequired: true,
        },
      });

      const prompt = buildStructuredPrompt(feature);

      expect(prompt).toContain('[ ] **Tests Pass**'); // Not passed
    });

    it('should show current status for criteria', () => {
      const feature = createFeature({
        validation: {
          enabled: true,
          coverageTarget: 80,
        },
        validationResult: {
          passed: false,
          checks: [{ name: 'coverage', passed: false, actual: 65 }],
        },
      });

      const prompt = buildStructuredPrompt(feature);

      expect(prompt).toContain('Current: 65 ⚠️ NOT MET');
    });

    it('should show MET status for passed criteria', () => {
      const feature = createFeature({
        validation: {
          enabled: true,
          coverageTarget: 80,
        },
        validationResult: {
          passed: true,
          checks: [{ name: 'coverage', passed: true, actual: 85 }],
        },
      });

      const prompt = buildStructuredPrompt(feature);

      expect(prompt).toContain('Current: 85 ✅ MET');
    });

    it('should include validation command', () => {
      const feature = createFeature({
        validation: {
          enabled: true,
          coverageTarget: 80,
        },
      });

      const prompt = buildStructuredPrompt(feature);

      expect(prompt).toContain('## Validation Command');
      expect(prompt).toContain('```bash');
      expect(prompt).toContain('go test -cover ./...');
    });

    it('should not include validation command section if not needed', () => {
      const feature = createFeature({
        validation: {
          enabled: true,
          expectedPackages: ['internal/agent'],
        },
      });

      const prompt = buildStructuredPrompt(feature);

      expect(prompt).not.toContain('## Validation Command');
    });

    it('should include retry guidance on subsequent attempts', () => {
      const feature = createFeature({
        attempts: 1,
        lastError: 'Tests failed: coverage too low',
      });

      const prompt = buildStructuredPrompt(feature);

      expect(prompt).toContain('## Retry Guidance');
      expect(prompt).toContain('This is attempt 2/3');
      expect(prompt).toContain('**Previous failure reason:**');
      expect(prompt).toContain('Tests failed: coverage too low');
    });

    it('should not include retry guidance on first attempt', () => {
      const feature = createFeature({
        attempts: 0,
      });

      const prompt = buildStructuredPrompt(feature);

      expect(prompt).not.toContain('## Retry Guidance');
    });

    it('should include implementation guidelines', () => {
      const feature = createFeature();

      const prompt = buildStructuredPrompt(feature);

      expect(prompt).toContain('## Implementation Guidelines');
      expect(prompt).toContain('Read existing code before modifying');
      expect(prompt).toContain('Make targeted changes');
    });

    it('should include target packages section', () => {
      const feature = createFeature({
        validation: {
          enabled: true,
          expectedPackages: ['internal/agent', 'internal/db'],
        },
      });

      const prompt = buildStructuredPrompt(feature);

      expect(prompt).toContain('## Target Packages');
      expect(prompt).toContain('- internal/agent');
      expect(prompt).toContain('- internal/db');
    });

    it('should not include target packages if none specified', () => {
      const feature = createFeature({
        validation: {
          enabled: true,
          testPassRequired: true,
        },
      });

      const prompt = buildStructuredPrompt(feature);

      expect(prompt).not.toContain('## Target Packages');
    });

    it('should handle array criterion current value (truncate after 3)', () => {
      const feature = createFeature({
        validation: {
          enabled: true,
          expectedPackages: ['pkg1', 'pkg2'],
        },
        gitVerification: {
          filesChanged: ['file1.go', 'file2.go', 'file3.go', 'file4.go'],
        },
      });

      const prompt = buildStructuredPrompt(feature);

      // Should truncate to first 3 and add ...
      expect(prompt).toContain('file1.go, file2.go, file3.go...');
    });
  });

  describe('buildRetryPrompt', () => {
    it('should include retry header and attempt count', () => {
      const feature = createFeature({
        attempts: 1,
      });

      const prompt = buildRetryPrompt(feature, ['Coverage too low']);

      expect(prompt).toContain('# Retry Required - Validation Failed');
      expect(prompt).toContain('Attempt 1/3');
    });

    it('should list validation failures', () => {
      const feature = createFeature();
      const failures = ['Coverage too low: 65%', 'Tests failed: 2 errors'];

      const prompt = buildRetryPrompt(feature, failures);

      expect(prompt).toContain('## Validation Failures');
      expect(prompt).toContain('❌ Coverage too low: 65%');
      expect(prompt).toContain('❌ Tests failed: 2 errors');
    });

    it('should show what to fix with failed criteria', () => {
      const feature = createFeature({
        validation: {
          enabled: true,
          coverageTarget: 80,
        },
        validationResult: {
          passed: false,
          checks: [{ name: 'coverage', passed: false, actual: 65 }],
        },
      });

      const prompt = buildRetryPrompt(feature, ['Coverage too low']);

      expect(prompt).toContain('## What to Fix');
      expect(prompt).toContain('**Test Coverage**');
      expect(prompt).toContain('Target: coverage >= 80');
      expect(prompt).toContain('Current: 65');
    });

    it('should include validation command', () => {
      const feature = createFeature({
        validation: {
          enabled: true,
          coverageTarget: 80,
        },
      });

      const prompt = buildRetryPrompt(feature, ['Coverage too low']);

      expect(prompt).toContain('## Verify Your Fix');
      expect(prompt).toContain('```bash');
      expect(prompt).toContain('go test -cover ./...');
    });

    it('should not include validation command if not needed', () => {
      const feature = createFeature({
        validation: {
          enabled: true,
          expectedPackages: ['pkg'],
        },
      });

      const prompt = buildRetryPrompt(feature, ['Wrong package modified']);

      expect(prompt).not.toContain('## Verify Your Fix');
    });

    it('should handle multiple failed criteria', () => {
      const feature = createFeature({
        validation: {
          enabled: true,
          coverageTarget: 80,
          testPassRequired: true,
        },
        validationResult: {
          passed: false,
          checks: [
            { name: 'coverage', passed: false, actual: 65 },
            { name: 'tests', passed: false },
          ],
        },
      });

      const prompt = buildRetryPrompt(feature, ['Multiple failures']);

      expect(prompt).toContain('**Test Coverage**');
      expect(prompt).toContain('**Tests Pass**');
    });

    it('should show N/A for current when not available', () => {
      const feature = createFeature({
        validation: {
          enabled: true,
          testPassRequired: true,
        },
      });

      const prompt = buildRetryPrompt(feature, ['Tests not run']);

      expect(prompt).toContain('Current: FAIL');
    });
  });

  describe('edge cases', () => {
    it('should handle feature with maxRetries set', () => {
      const feature = createFeature({
        attempts: 2,
        maxRetries: 5,
      });

      const prompt = buildStructuredPrompt(feature);

      expect(prompt).toContain('attempt 3/5');
    });

    it('should handle empty expectedPackages array', () => {
      const feature = createFeature({
        validation: {
          enabled: true,
          expectedPackages: [],
        },
      });

      const criteria = generateSuccessCriteria(feature);

      expect(criteria).toHaveLength(0);
    });

    it('should handle undefined maxRetries (default to 3)', () => {
      const feature = createFeature({
        attempts: 1,
      });

      const prompt = buildRetryPrompt(feature, ['Failed']);

      expect(prompt).toContain('1/3');
    });

    it('should handle feature without lastError on retry', () => {
      const feature = createFeature({
        attempts: 1,
      });

      const prompt = buildStructuredPrompt(feature);

      expect(prompt).toContain('## Retry Guidance');
      expect(prompt).not.toContain('**Previous failure reason:**');
    });
  });
});
