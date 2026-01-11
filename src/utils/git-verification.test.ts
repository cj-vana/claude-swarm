/**
 * TDD Tests for git-verification module
 *
 * Tests git-based change verification including:
 * - Git state capture
 * - Diff calculation and checksum generation
 * - File change tracking
 * - Package verification
 * - Error handling and edge cases
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  captureGitState,
  calculateGitVerification,
  verifyExpectedPackages,
  formatGitVerification,
} from './git-verification.js';
import { GitVerification } from '../state/manager.js';
import * as childProcess from 'child_process';
import * as crypto from 'crypto';

// Mock child_process.execSync
vi.mock('child_process', () => ({
  execSync: vi.fn(),
}));

describe('git-verification module', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('captureGitState', () => {
    it('should capture current git hash', () => {
      const mockExecSync = vi.mocked(childProcess.execSync);
      mockExecSync.mockReturnValue('abc123def456789' as any);

      const hash = captureGitState('/test/project');

      expect(hash).toBe('abc123def456789');
      expect(mockExecSync).toHaveBeenCalledWith(
        'git rev-parse HEAD',
        expect.objectContaining({ cwd: '/test/project', encoding: 'utf-8' })
      );
    });

    it('should trim whitespace from git output', () => {
      const mockExecSync = vi.mocked(childProcess.execSync);
      mockExecSync.mockReturnValue('  abc123def456789\n' as any);

      const hash = captureGitState('/test/project');

      expect(hash).toBe('abc123def456789');
    });

    it('should throw error when git command fails', () => {
      const mockExecSync = vi.mocked(childProcess.execSync);
      mockExecSync.mockImplementation(() => {
        throw new Error('not a git repository');
      });

      expect(() => captureGitState('/test/project')).toThrow(
        'Failed to capture git state'
      );
    });
  });

  describe('calculateGitVerification', () => {
    it('should calculate full verification with two hashes', () => {
      const mockExecSync = vi.mocked(childProcess.execSync);

      // Mock numstat output
      mockExecSync.mockReturnValueOnce(
        '50\t10\tinternal/agent/agent.go\n20\t5\tinternal/tools/bash.go\n' as any
      );

      // Mock name-only output
      mockExecSync.mockReturnValueOnce(
        'internal/agent/agent.go\ninternal/tools/bash.go\n' as any
      );

      // Mock full diff output
      const diffContent = '+++ new code\n--- old code';
      mockExecSync.mockReturnValueOnce(diffContent as any);

      const verification = calculateGitVerification(
        '/test/project',
        'abc123',
        'def456'
      );

      expect(verification.beforeHash).toBe('abc123');
      expect(verification.afterHash).toBe('def456');
      expect(verification.filesChanged).toEqual([
        'internal/agent/agent.go',
        'internal/tools/bash.go',
      ]);
      expect(verification.linesAdded).toBe(70); // 50 + 20
      expect(verification.linesDeleted).toBe(15); // 10 + 5
      expect(verification.diffChecksum).toHaveLength(64); // SHA-256 hex length
    });

    it('should use HEAD when afterHash not provided', () => {
      const mockExecSync = vi.mocked(childProcess.execSync);

      // Mock numstat
      mockExecSync.mockReturnValueOnce('10\t5\tfile.go\n' as any);

      // Mock name-only
      mockExecSync.mockReturnValueOnce('file.go\n' as any);

      // Mock full diff
      mockExecSync.mockReturnValueOnce('diff content' as any);

      // Mock git rev-parse HEAD for afterHash
      mockExecSync.mockReturnValueOnce('current-head-hash' as any);

      const verification = calculateGitVerification(
        '/test/project',
        'abc123'
      );

      expect(verification.beforeHash).toBe('abc123');
      expect(verification.afterHash).toBe('current-head-hash');
    });

    it('should handle binary files with - markers', () => {
      const mockExecSync = vi.mocked(childProcess.execSync);

      // Mock numstat with binary file
      mockExecSync.mockReturnValueOnce(
        '10\t5\tfile.go\n-\t-\timage.png\n' as any
      );

      // Mock name-only
      mockExecSync.mockReturnValueOnce('file.go\nimage.png\n' as any);

      // Mock full diff
      mockExecSync.mockReturnValueOnce('diff content' as any);

      // Mock HEAD hash
      mockExecSync.mockReturnValueOnce('def456' as any);

      const verification = calculateGitVerification(
        '/test/project',
        'abc123'
      );

      expect(verification.linesAdded).toBe(10); // Only counts file.go
      expect(verification.linesDeleted).toBe(5);
      expect(verification.filesChanged).toHaveLength(2);
    });

    it('should handle empty diff', () => {
      const mockExecSync = vi.mocked(childProcess.execSync);

      // Mock empty numstat
      mockExecSync.mockReturnValueOnce('' as any);

      // Mock empty name-only
      mockExecSync.mockReturnValueOnce('\n' as any);

      // Mock empty diff
      mockExecSync.mockReturnValueOnce('' as any);

      // Mock HEAD hash
      mockExecSync.mockReturnValueOnce('def456' as any);

      const verification = calculateGitVerification(
        '/test/project',
        'abc123'
      );

      expect(verification.filesChanged).toEqual([]);
      expect(verification.linesAdded).toBe(0);
      expect(verification.linesDeleted).toBe(0);
    });

    it('should calculate correct checksum for diff', () => {
      const mockExecSync = vi.mocked(childProcess.execSync);

      const testDiff = 'test diff content';

      // Mock numstat
      mockExecSync.mockReturnValueOnce('10\t5\tfile.go\n' as any);

      // Mock name-only
      mockExecSync.mockReturnValueOnce('file.go\n' as any);

      // Mock full diff
      mockExecSync.mockReturnValueOnce(testDiff as any);

      // Mock HEAD hash
      mockExecSync.mockReturnValueOnce('def456' as any);

      const verification = calculateGitVerification(
        '/test/project',
        'abc123'
      );

      // Calculate expected checksum
      const expectedChecksum = crypto
        .createHash('sha256')
        .update(testDiff)
        .digest('hex');

      expect(verification.diffChecksum).toBe(expectedChecksum);
    });

    it('should throw error when git command fails', () => {
      const mockExecSync = vi.mocked(childProcess.execSync);
      mockExecSync.mockImplementation(() => {
        throw new Error('git diff failed');
      });

      expect(() =>
        calculateGitVerification('/test/project', 'abc123', 'def456')
      ).toThrow('Failed to calculate git verification');
    });

    it('should handle large number of changed files', () => {
      const mockExecSync = vi.mocked(childProcess.execSync);

      // Create 100 files
      const files = Array.from({ length: 100 }, (_, i) => `file${i}.go`);
      const numstatLines = files.map(f => `10\t5\t${f}`).join('\n');
      const nameOnlyLines = files.join('\n') + '\n';

      mockExecSync.mockReturnValueOnce(numstatLines as any);
      mockExecSync.mockReturnValueOnce(nameOnlyLines as any);
      mockExecSync.mockReturnValueOnce('diff content' as any);
      mockExecSync.mockReturnValueOnce('def456' as any);

      const verification = calculateGitVerification(
        '/test/project',
        'abc123'
      );

      expect(verification.filesChanged).toHaveLength(100);
      expect(verification.linesAdded).toBe(1000); // 100 * 10
      expect(verification.linesDeleted).toBe(500); // 100 * 5
    });
  });

  describe('verifyExpectedPackages', () => {
    it('should match when files are in expected packages', () => {
      const verification: GitVerification = {
        beforeHash: 'abc123',
        afterHash: 'def456',
        filesChanged: [
          'internal/agent/agent.go',
          'internal/agent/coordinator.go',
        ],
        linesAdded: 50,
        linesDeleted: 10,
        diffChecksum: 'checksum123',
      };

      const result = verifyExpectedPackages(verification, [
        'internal/agent',
        'internal/tools',
      ]);

      expect(result.matched).toBe(true);
      expect(result.details).toContain('2/2 files match');
    });

    it('should not match when files are not in expected packages', () => {
      const verification: GitVerification = {
        beforeHash: 'abc123',
        afterHash: 'def456',
        filesChanged: ['internal/db/models.go', 'internal/tui/tui.go'],
        linesAdded: 50,
        linesDeleted: 10,
        diffChecksum: 'checksum123',
      };

      const result = verifyExpectedPackages(verification, [
        'internal/agent',
        'internal/tools',
      ]);

      expect(result.matched).toBe(false);
      expect(result.details).toContain('No files in expected packages');
      expect(result.details).toContain('internal/agent');
    });

    it('should match partial files', () => {
      const verification: GitVerification = {
        beforeHash: 'abc123',
        afterHash: 'def456',
        filesChanged: [
          'internal/agent/agent.go',
          'internal/db/models.go',
          'internal/tui/tui.go',
        ],
        linesAdded: 50,
        linesDeleted: 10,
        diffChecksum: 'checksum123',
      };

      const result = verifyExpectedPackages(verification, ['internal/agent']);

      expect(result.matched).toBe(true);
      expect(result.details).toContain('1/3 files match');
    });

    it('should return true when no packages specified', () => {
      const verification: GitVerification = {
        beforeHash: 'abc123',
        afterHash: 'def456',
        filesChanged: ['any/file.go'],
        linesAdded: 50,
        linesDeleted: 10,
        diffChecksum: 'checksum123',
      };

      const result = verifyExpectedPackages(verification, []);

      expect(result.matched).toBe(true);
      expect(result.details).toContain('No package constraints');
    });

    it('should handle empty file changes', () => {
      const verification: GitVerification = {
        beforeHash: 'abc123',
        afterHash: 'def456',
        filesChanged: [],
        linesAdded: 0,
        linesDeleted: 0,
        diffChecksum: 'checksum123',
      };

      const result = verifyExpectedPackages(verification, ['internal/agent']);

      expect(result.matched).toBe(false);
      expect(result.details).toContain('No files in expected packages');
    });

    it('should truncate long file lists in details', () => {
      const manyFiles = Array.from({ length: 20 }, (_, i) => `file${i}.go`);
      const verification: GitVerification = {
        beforeHash: 'abc123',
        afterHash: 'def456',
        filesChanged: manyFiles,
        linesAdded: 50,
        linesDeleted: 10,
        diffChecksum: 'checksum123',
      };

      const result = verifyExpectedPackages(verification, ['internal/agent']);

      expect(result.details).toContain('...');
    });

    it('should match nested package paths', () => {
      const verification: GitVerification = {
        beforeHash: 'abc123',
        afterHash: 'def456',
        filesChanged: ['internal/agent/delegation/manager.go'],
        linesAdded: 50,
        linesDeleted: 10,
        diffChecksum: 'checksum123',
      };

      const result = verifyExpectedPackages(verification, ['internal/agent']);

      expect(result.matched).toBe(true);
    });
  });

  describe('formatGitVerification', () => {
    it('should format verification for display', () => {
      const verification: GitVerification = {
        beforeHash: 'abc123def456789012345678',
        afterHash: 'def456abc123789012345678',
        filesChanged: ['file1.go', 'file2.go'],
        linesAdded: 50,
        linesDeleted: 10,
        diffChecksum: 'checksum1234567890abcdef',
      };

      const formatted = formatGitVerification(verification);

      expect(formatted).toContain('Git Verification');
      expect(formatted).toContain('abc123de'); // Truncated beforeHash
      expect(formatted).toContain('def456ab'); // Truncated afterHash
      expect(formatted).toContain('2 changed');
      expect(formatted).toContain('+50');
      expect(formatted).toContain('-10');
      expect(formatted).toContain('checksum12345678'); // Truncated checksum
      expect(formatted).toContain('file1.go');
      expect(formatted).toContain('file2.go');
    });

    it('should truncate file list after 5 files', () => {
      const verification: GitVerification = {
        beforeHash: 'abc123',
        afterHash: 'def456',
        filesChanged: [
          'file1.go',
          'file2.go',
          'file3.go',
          'file4.go',
          'file5.go',
          'file6.go',
          'file7.go',
        ],
        linesAdded: 50,
        linesDeleted: 10,
        diffChecksum: 'checksum123',
      };

      const formatted = formatGitVerification(verification);

      expect(formatted).toContain('file1.go');
      expect(formatted).toContain('file5.go');
      expect(formatted).not.toContain('file6.go');
      expect(formatted).toContain('... and 2 more');
    });

    it('should handle empty file list', () => {
      const verification: GitVerification = {
        beforeHash: 'abc123',
        afterHash: 'def456',
        filesChanged: [],
        linesAdded: 0,
        linesDeleted: 0,
        diffChecksum: 'checksum123',
      };

      const formatted = formatGitVerification(verification);

      expect(formatted).toContain('0 changed');
      expect(formatted).not.toContain('Changed files');
    });

    it('should format zero line changes correctly', () => {
      const verification: GitVerification = {
        beforeHash: 'abc123',
        afterHash: 'def456',
        filesChanged: ['README.md'],
        linesAdded: 0,
        linesDeleted: 0,
        diffChecksum: 'checksum123',
      };

      const formatted = formatGitVerification(verification);

      expect(formatted).toContain('+0 -0');
    });
  });
});
