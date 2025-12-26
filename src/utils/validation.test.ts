/**
 * TDD Tests for validation module
 *
 * Tests validation functionality including:
 * - Coverage measurement and parsing
 * - Test execution verification
 * - Git package verification
 * - Blocking vs non-blocking enforcement
 * - Edge cases and error handling
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { validateFeature, createValidationConfig } from './validation.js';
import { Feature, ValidationConfig } from '../state/manager.js';
import * as childProcess from 'child_process';

// Mock child_process.execSync
vi.mock('child_process', () => ({
  execSync: vi.fn(),
}));

// Mock git-verification module
vi.mock('./git-verification.js', () => ({
  verifyExpectedPackages: vi.fn((verification: any, packages: string[]) => ({
    matched: verification.filesChanged.some((f: string) => packages.some((p: string) => f.startsWith(p))),
    details: 'Mock git verification',
  })),
}));

describe('validation module', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('createValidationConfig', () => {
    it('should create config with defaults', () => {
      const config = createValidationConfig();

      expect(config).toEqual({
        enabled: true,
        coverageTarget: undefined,
        testPassRequired: true,
        enforceBlocking: true,
        verifyCommand: undefined,
        expectedPackages: undefined,
      });
    });

    it('should create config with custom values', () => {
      const config = createValidationConfig({
        enabled: false,
        coverageTarget: 50,
        testPassRequired: false,
        enforceBlocking: false,
        verifyCommand: 'go test ./...',
        expectedPackages: ['internal/agent'],
      });

      expect(config.enabled).toBe(false);
      expect(config.coverageTarget).toBe(50);
      expect(config.testPassRequired).toBe(false);
      expect(config.enforceBlocking).toBe(false);
      expect(config.verifyCommand).toBe('go test ./...');
      expect(config.expectedPackages).toEqual(['internal/agent']);
    });
  });

  describe('validateFeature', () => {
    it('should skip validation when disabled', async () => {
      const feature: Feature = {
        id: 'feature-1',
        description: 'Test feature',
        status: 'in_progress',
        attempts: 0,
        validation: {
          enabled: false,
          testPassRequired: true,
          enforceBlocking: true,
        },
      };

      const result = await validateFeature(feature, '/test/project');

      expect(result.passed).toBe(true);
      expect(result.checks).toHaveLength(0);
    });

    it('should validate coverage when target is set', async () => {
      const mockExecSync = vi.mocked(childProcess.execSync);
      mockExecSync.mockReturnValue(
        'coverage: 60.5% of statements\nok  \tinternal/agent\t0.123s' as any
      );

      const feature: Feature = {
        id: 'feature-1',
        description: 'Test feature',
        status: 'in_progress',
        attempts: 0,
        validation: {
          enabled: true,
          coverageTarget: 50,
          testPassRequired: false,
          enforceBlocking: true,
        },
      };

      const result = await validateFeature(feature, '/test/project');

      expect(result.passed).toBe(true);
      expect(result.checks).toHaveLength(1);
      expect(result.checks[0].name).toBe('coverage');
      expect(result.checks[0].passed).toBe(true);
      expect(result.checks[0].actual).toBe(60.5);
      expect(result.checks[0].expected).toBe(50);
    });

    it('should fail validation when coverage below target', async () => {
      const mockExecSync = vi.mocked(childProcess.execSync);
      mockExecSync.mockReturnValue(
        'coverage: 30.2% of statements\nok  \tinternal/agent\t0.123s' as any
      );

      const feature: Feature = {
        id: 'feature-1',
        description: 'Test feature',
        status: 'in_progress',
        attempts: 0,
        validation: {
          enabled: true,
          coverageTarget: 50,
          testPassRequired: false,
          enforceBlocking: true,
        },
      };

      const result = await validateFeature(feature, '/test/project');

      expect(result.passed).toBe(false);
      expect(result.checks[0].passed).toBe(false);
      expect(result.checks[0].actual).toBe(30.2);
      expect(result.error).toContain('Coverage 30.2% below target 50%');
    });

    it('should pass when coverage below target but non-blocking', async () => {
      const mockExecSync = vi.mocked(childProcess.execSync);
      mockExecSync.mockReturnValue(
        'coverage: 30.2% of statements\nok  \tinternal/agent\t0.123s' as any
      );

      const feature: Feature = {
        id: 'feature-1',
        description: 'Test feature',
        status: 'in_progress',
        attempts: 0,
        validation: {
          enabled: true,
          coverageTarget: 50,
          testPassRequired: false,
          enforceBlocking: false, // Non-blocking
        },
      };

      const result = await validateFeature(feature, '/test/project');

      expect(result.passed).toBe(true); // Overall passes
      expect(result.checks[0].passed).toBe(false); // But check failed
    });

    it('should validate tests pass when required', async () => {
      const mockExecSync = vi.mocked(childProcess.execSync);
      mockExecSync.mockReturnValue(
        'PASS\nok  \tinternal/agent\t0.123s\n--- PASS: TestFoo (0.00s)' as any
      );

      const feature: Feature = {
        id: 'feature-1',
        description: 'Test feature',
        status: 'in_progress',
        attempts: 0,
        validation: {
          enabled: true,
          testPassRequired: true,
          enforceBlocking: true,
        },
      };

      const result = await validateFeature(feature, '/test/project');

      expect(result.passed).toBe(true);
      expect(result.checks).toHaveLength(1);
      expect(result.checks[0].name).toBe('tests');
      expect(result.checks[0].passed).toBe(true);
    });

    it('should fail when tests fail', async () => {
      const mockExecSync = vi.mocked(childProcess.execSync);
      mockExecSync.mockImplementation(() => {
        throw new Error('Command failed: FAIL internal/agent');
      });

      const feature: Feature = {
        id: 'feature-1',
        description: 'Test feature',
        status: 'in_progress',
        attempts: 0,
        validation: {
          enabled: true,
          testPassRequired: true,
          enforceBlocking: true,
        },
      };

      const result = await validateFeature(feature, '/test/project');

      expect(result.passed).toBe(false);
      expect(result.checks[0].passed).toBe(false);
      expect(result.error).toContain('Test execution failed');
    });

    it('should use custom verify command', async () => {
      const mockExecSync = vi.mocked(childProcess.execSync);
      mockExecSync.mockReturnValue('coverage: 75.0% of statements' as any);

      const feature: Feature = {
        id: 'feature-1',
        description: 'Test feature',
        status: 'in_progress',
        attempts: 0,
        validation: {
          enabled: true,
          coverageTarget: 50,
          testPassRequired: false,
          enforceBlocking: true,
          verifyCommand: 'go test -cover ./custom/path',
        },
      };

      await validateFeature(feature, '/test/project');

      expect(mockExecSync).toHaveBeenCalledWith(
        'go test -cover ./custom/path',
        expect.objectContaining({ cwd: '/test/project' })
      );
    });

    it('should validate git packages when specified', async () => {
      const feature: Feature = {
        id: 'feature-1',
        description: 'Test feature',
        status: 'in_progress',
        attempts: 0,
        validation: {
          enabled: true,
          testPassRequired: false,
          enforceBlocking: true,
          expectedPackages: ['internal/agent', 'internal/tools'],
        },
        gitVerification: {
          beforeHash: 'abc123',
          afterHash: 'def456',
          filesChanged: ['internal/agent/agent.go', 'internal/tools/bash.go'],
          linesAdded: 50,
          linesDeleted: 10,
          diffChecksum: 'checksum123',
        },
      };

      const result = await validateFeature(feature, '/test/project');

      expect(result.checks.some(c => c.name === 'git-packages')).toBe(true);
    });

    it('should handle multiple validation checks', async () => {
      const mockExecSync = vi.mocked(childProcess.execSync);
      mockExecSync
        .mockReturnValueOnce('coverage: 55.0% of statements' as any) // Coverage check
        .mockReturnValueOnce('PASS\n--- PASS: TestFoo (0.00s)' as any); // Test check

      const feature: Feature = {
        id: 'feature-1',
        description: 'Test feature',
        status: 'in_progress',
        attempts: 0,
        validation: {
          enabled: true,
          coverageTarget: 50,
          testPassRequired: true,
          enforceBlocking: true,
          expectedPackages: ['internal/agent'],
        },
        gitVerification: {
          beforeHash: 'abc123',
          afterHash: 'def456',
          filesChanged: ['internal/agent/agent.go'],
          linesAdded: 50,
          linesDeleted: 10,
          diffChecksum: 'checksum123',
        },
      };

      const result = await validateFeature(feature, '/test/project');

      expect(result.passed).toBe(true);
      expect(result.checks).toHaveLength(3); // coverage, tests, git-packages
      expect(result.checks.every(c => c.passed)).toBe(true);
    });

    it('should parse multiple coverage lines and average them', async () => {
      const mockExecSync = vi.mocked(childProcess.execSync);
      mockExecSync.mockReturnValue(
        'coverage: 50.0% of statements\ncoverage: 60.0% of statements\ncoverage: 70.0% of statements' as any
      );

      const feature: Feature = {
        id: 'feature-1',
        description: 'Test feature',
        status: 'in_progress',
        attempts: 0,
        validation: {
          enabled: true,
          coverageTarget: 55,
          testPassRequired: false,
          enforceBlocking: true,
        },
      };

      const result = await validateFeature(feature, '/test/project');

      expect(result.checks[0].actual).toBe(60); // (50 + 60 + 70) / 3
      expect(result.checks[0].passed).toBe(true);
    });

    it('should handle zero coverage gracefully', async () => {
      const mockExecSync = vi.mocked(childProcess.execSync);
      mockExecSync.mockReturnValue('no coverage output' as any);

      const feature: Feature = {
        id: 'feature-1',
        description: 'Test feature',
        status: 'in_progress',
        attempts: 0,
        validation: {
          enabled: true,
          coverageTarget: 50,
          testPassRequired: false,
          enforceBlocking: true,
        },
      };

      const result = await validateFeature(feature, '/test/project');

      expect(result.checks[0].actual).toBe(0);
      expect(result.checks[0].passed).toBe(false);
    });

    it('should handle command timeout', async () => {
      const mockExecSync = vi.mocked(childProcess.execSync);
      mockExecSync.mockImplementation(() => {
        throw new Error('Timeout exceeded');
      });

      const feature: Feature = {
        id: 'feature-1',
        description: 'Test feature',
        status: 'in_progress',
        attempts: 0,
        validation: {
          enabled: true,
          coverageTarget: 50,
          testPassRequired: false,
          enforceBlocking: true,
        },
      };

      const result = await validateFeature(feature, '/test/project');

      expect(result.checks[0].passed).toBe(false);
      expect(result.checks[0].details).toContain('Coverage measurement failed');
    });

    it('should use expected packages in coverage command', async () => {
      const mockExecSync = vi.mocked(childProcess.execSync);
      mockExecSync.mockReturnValue('coverage: 50.0% of statements' as any);

      const feature: Feature = {
        id: 'feature-1',
        description: 'Test feature',
        status: 'in_progress',
        attempts: 0,
        validation: {
          enabled: true,
          coverageTarget: 50,
          testPassRequired: false,
          enforceBlocking: true,
          expectedPackages: ['internal/agent', 'internal/tools'],
        },
      };

      await validateFeature(feature, '/test/project');

      expect(mockExecSync).toHaveBeenCalledWith(
        'go test -cover internal/agent internal/tools',
        expect.any(Object)
      );
    });
  });
});
