/**
 * TDD Tests for security module
 *
 * Tests security-critical functions:
 * - Path validation and traversal prevention
 * - Feature ID validation
 * - Session name validation
 * - Shell quoting
 * - Command allowlist enforcement
 * - Output sanitization
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  validateProjectDir,
  validateFeatureId,
  validateSessionName,
  shellQuote,
  validateCommand,
  sanitizeOutput,
} from './security.js';

// Mock fs and os
vi.mock('fs');
vi.mock('os');

describe('security module', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('validateProjectDir', () => {
    it('should accept valid project directory', () => {
      const mockPath = '/home/user/project';
      vi.mocked(fs.realpathSync).mockReturnValue(mockPath);
      vi.mocked(fs.statSync).mockReturnValue({
        isDirectory: () => true,
      } as any);

      const result = validateProjectDir(mockPath);
      expect(result).toBe(mockPath);
    });

    it('should resolve .. and . components', () => {
      const inputPath = '/home/user/../user/./project';
      const mockRealPath = '/home/user/project';
      vi.mocked(fs.realpathSync).mockReturnValue(mockRealPath);
      vi.mocked(fs.statSync).mockReturnValue({
        isDirectory: () => true,
      } as any);

      const result = validateProjectDir(inputPath);
      expect(result).toBe(mockRealPath);
    });

    it('should throw if directory does not exist', () => {
      vi.mocked(fs.realpathSync).mockImplementation(() => {
        throw new Error('ENOENT');
      });

      expect(() => validateProjectDir('/nonexistent')).toThrow(
        'Project directory does not exist'
      );
    });

    it('should throw if path is not a directory', () => {
      const mockPath = '/home/user/file.txt';
      vi.mocked(fs.realpathSync).mockReturnValue(mockPath);
      vi.mocked(fs.statSync).mockReturnValue({
        isDirectory: () => false,
      } as any);

      expect(() => validateProjectDir(mockPath)).toThrow(
        'Project path is not a directory'
      );
    });

    it('should reject /etc directory', () => {
      vi.mocked(fs.realpathSync).mockReturnValue('/etc');
      vi.mocked(fs.statSync).mockReturnValue({
        isDirectory: () => true,
      } as any);

      expect(() => validateProjectDir('/etc')).toThrow(
        'Cannot use system directory as project: /etc'
      );
    });

    it('should reject /usr directory', () => {
      vi.mocked(fs.realpathSync).mockReturnValue('/usr');
      vi.mocked(fs.statSync).mockReturnValue({
        isDirectory: () => true,
      } as any);

      expect(() => validateProjectDir('/usr')).toThrow(
        'Cannot use system directory as project: /usr'
      );
    });

    it('should reject /tmp directory', () => {
      vi.mocked(fs.realpathSync).mockReturnValue('/tmp');
      vi.mocked(fs.statSync).mockReturnValue({
        isDirectory: () => true,
      } as any);

      expect(() => validateProjectDir('/tmp')).toThrow(
        'Cannot use system directory as project: /tmp'
      );
    });

    it('should reject Windows system directories', () => {
      vi.mocked(fs.realpathSync).mockReturnValue('C:\\Windows');
      vi.mocked(fs.statSync).mockReturnValue({
        isDirectory: () => true,
      } as any);

      expect(() => validateProjectDir('C:\\Windows')).toThrow(
        'Cannot use system directory as project'
      );
    });

    it('should prevent symlink escape to /etc', () => {
      // Symlink points to /home/user/project but resolves to /etc/evil
      vi.mocked(fs.realpathSync).mockReturnValue('/etc/evil');
      vi.mocked(fs.statSync).mockReturnValue({
        isDirectory: () => true,
      } as any);

      expect(() => validateProjectDir('/home/user/project')).toThrow(
        'Cannot use system directory as project: /etc'
      );
    });

    it('should allow nested directories in allowed paths', () => {
      const mockPath = '/home/user/projects/my-app/nested';
      vi.mocked(fs.realpathSync).mockReturnValue(mockPath);
      vi.mocked(fs.statSync).mockReturnValue({
        isDirectory: () => true,
      } as any);

      const result = validateProjectDir(mockPath);
      expect(result).toBe(mockPath);
    });

    it('should handle case-insensitive checks', () => {
      vi.mocked(fs.realpathSync).mockReturnValue('/ETC/something');
      vi.mocked(fs.statSync).mockReturnValue({
        isDirectory: () => true,
      } as any);

      expect(() => validateProjectDir('/ETC/something')).toThrow(
        'Cannot use system directory as project'
      );
    });
  });

  describe('validateFeatureId', () => {
    it('should accept valid feature IDs', () => {
      expect(validateFeatureId('feature-1')).toBe('feature-1');
      expect(validateFeatureId('feature_2')).toBe('feature_2');
      expect(validateFeatureId('ABC-123')).toBe('ABC-123');
      expect(validateFeatureId('test_feature-99')).toBe('test_feature-99');
    });

    it('should reject feature IDs with special characters', () => {
      expect(() => validateFeatureId('feature.1')).toThrow('Invalid feature ID');
      expect(() => validateFeatureId('feature@1')).toThrow('Invalid feature ID');
      expect(() => validateFeatureId('feature 1')).toThrow('Invalid feature ID');
      expect(() => validateFeatureId('feature/1')).toThrow('Invalid feature ID');
      expect(() => validateFeatureId('feature\\1')).toThrow('Invalid feature ID');
    });

    it('should reject feature IDs with newlines', () => {
      expect(() => validateFeatureId('feature\n1')).toThrow('Invalid feature ID');
      expect(() => validateFeatureId('feature\r1')).toThrow('Invalid feature ID');
    });

    it('should reject feature IDs with shell metacharacters', () => {
      expect(() => validateFeatureId('feature;1')).toThrow('Invalid feature ID');
      expect(() => validateFeatureId('feature$1')).toThrow('Invalid feature ID');
      expect(() => validateFeatureId('feature`1')).toThrow('Invalid feature ID');
      expect(() => validateFeatureId('feature|1')).toThrow('Invalid feature ID');
    });

    it('should reject feature IDs that are too long', () => {
      const longId = 'a'.repeat(65);
      expect(() => validateFeatureId(longId)).toThrow('Feature ID too long');
    });

    it('should accept feature ID at exactly 64 characters', () => {
      const maxId = 'a'.repeat(64);
      expect(validateFeatureId(maxId)).toBe(maxId);
    });

    it('should reject empty feature IDs', () => {
      expect(() => validateFeatureId('')).toThrow('Invalid feature ID');
    });
  });

  describe('validateSessionName', () => {
    it('should accept valid worker session names', () => {
      expect(validateSessionName('cc-worker-feature-1-abc123')).toBe(true);
      expect(validateSessionName('cc-worker-test-feature-xyz789')).toBe(true);
    });

    it('should accept valid planner session names', () => {
      expect(validateSessionName('cc-planner-feature-1-abc123')).toBe(true);
      expect(validateSessionName('cc-planner-test-feature-xyz789')).toBe(true);
    });

    it('should reject invalid prefixes', () => {
      expect(validateSessionName('worker-feature-1-abc123')).toBe(false);
      expect(validateSessionName('cc-invalid-feature-1-abc123')).toBe(false);
      expect(validateSessionName('custom-worker-feature-1-abc123')).toBe(false);
    });

    it('should reject sessions without proper format', () => {
      expect(validateSessionName('cc-worker-feature-1')).toBe(false); // Missing hash
      expect(validateSessionName('cc-worker-abc123')).toBe(false); // Too short
      expect(validateSessionName('cc-worker')).toBe(false);
    });

    it('should reject sessions with special characters', () => {
      expect(validateSessionName('cc-worker-feature@1-abc123')).toBe(false);
      expect(validateSessionName('cc-worker-feature.1-abc123')).toBe(false);
      expect(validateSessionName('cc-worker-feature 1-abc123')).toBe(false);
    });

    it('should require lowercase hex suffix', () => {
      expect(validateSessionName('cc-worker-feature-1-ABC123')).toBe(false);
      expect(validateSessionName('cc-worker-feature-1-abc123')).toBe(true);
    });
  });

  describe('shellQuote', () => {
    it('should quote simple strings', () => {
      expect(shellQuote('hello')).toBe("'hello'");
      expect(shellQuote('test123')).toBe("'test123'");
    });

    it('should escape single quotes', () => {
      expect(shellQuote("it's")).toBe("'it'\"'\"'s'");
      expect(shellQuote("can't")).toBe("'can'\"'\"'t'");
    });

    it('should handle multiple single quotes', () => {
      expect(shellQuote("'multiple' 'quotes'")).toBe(
        "''\"'\"'multiple'\"'\"' '\"'\"'quotes'\"'\"''"
      );
    });

    it('should escape shell metacharacters safely', () => {
      // All these should be safely quoted
      expect(shellQuote('$(whoami)')).toBe("'$(whoami)'");
      expect(shellQuote('`ls`')).toBe("'`ls`'");
      expect(shellQuote('foo; rm -rf /')).toBe("'foo; rm -rf /'");
      expect(shellQuote('foo && bar')).toBe("'foo && bar'");
      expect(shellQuote('foo | bar')).toBe("'foo | bar'");
    });

    it('should handle empty string', () => {
      expect(shellQuote('')).toBe("''");
    });

    it('should handle strings with spaces', () => {
      expect(shellQuote('hello world')).toBe("'hello world'");
      expect(shellQuote('  spaces  ')).toBe("'  spaces  '");
    });

    it('should handle newlines', () => {
      expect(shellQuote('line1\nline2')).toBe("'line1\nline2'");
    });
  });

  describe('validateCommand', () => {
    describe('allowed commands', () => {
      it('should allow npm test', () => {
        expect(validateCommand('npm test')).toBe('npm test');
        expect(validateCommand('npm run test')).toBe('npm run test');
        expect(validateCommand('npm run lint')).toBe('npm run lint');
        expect(validateCommand('npm run build')).toBe('npm run build');
      });

      it('should allow yarn commands', () => {
        expect(validateCommand('yarn test')).toBe('yarn test');
        expect(validateCommand('yarn lint')).toBe('yarn lint');
        expect(validateCommand('yarn build')).toBe('yarn build');
      });

      it('should allow pnpm commands', () => {
        expect(validateCommand('pnpm test')).toBe('pnpm test');
        expect(validateCommand('pnpm run test')).toBe('pnpm run test');
      });

      it('should allow npx test frameworks', () => {
        expect(validateCommand('npx vitest')).toBe('npx vitest');
        expect(validateCommand('npx jest')).toBe('npx jest');
        expect(validateCommand('npx playwright test')).toBe('npx playwright test');
      });

      it('should allow pytest', () => {
        expect(validateCommand('pytest')).toBe('pytest');
        expect(validateCommand('pytest tests/')).toBe('pytest tests/');
        expect(validateCommand('python -m pytest')).toBe('python -m pytest');
        expect(validateCommand('python3 -m pytest')).toBe('python3 -m pytest');
      });

      it('should allow cargo commands', () => {
        expect(validateCommand('cargo test')).toBe('cargo test');
        expect(validateCommand('cargo check')).toBe('cargo check');
        expect(validateCommand('cargo clippy')).toBe('cargo clippy');
        expect(validateCommand('cargo build')).toBe('cargo build');
      });

      it('should allow go commands', () => {
        expect(validateCommand('go test')).toBe('go test');
        expect(validateCommand('go test ./...')).toBe('go test ./...');
        expect(validateCommand('go vet')).toBe('go vet');
        expect(validateCommand('go build')).toBe('go build');
      });

      it('should allow make commands', () => {
        expect(validateCommand('make')).toBe('make');
        expect(validateCommand('make test')).toBe('make test');
        expect(validateCommand('make lint')).toBe('make lint');
      });

      it('should trim whitespace', () => {
        expect(validateCommand('  npm test  ')).toBe('npm test');
        expect(() => validateCommand('\nnpm test\n')).toThrow(); // Newlines not allowed
      });
    });

    describe('dangerous patterns', () => {
      it('should reject commands with &&', () => {
        expect(() => validateCommand('npm test && echo hi')).toThrow(
          'Command contains disallowed shell operator: &&'
        );
      });

      it('should reject commands with ||', () => {
        expect(() => validateCommand('npm test || echo hi')).toThrow(
          'Command contains disallowed shell operator: ||'
        );
      });

      it('should reject commands with ;', () => {
        expect(() => validateCommand('npm test; rm -rf /')).toThrow(
          'Command contains disallowed shell operator: ;'
        );
      });

      it('should reject commands with |', () => {
        expect(() => validateCommand('npm test | grep fail')).toThrow(
          'Command contains disallowed shell operator: |'
        );
      });

      it('should reject commands with $( )', () => {
        expect(() => validateCommand('npm test $(whoami)')).toThrow(
          'Command contains disallowed shell operator: $('
        );
      });

      it('should reject commands with backticks', () => {
        expect(() => validateCommand('npm test `ls`')).toThrow(
          'Command contains disallowed shell operator: `'
        );
      });

      it('should reject commands with redirects', () => {
        expect(() => validateCommand('npm test > output.txt')).toThrow(
          'Command contains disallowed shell operator: >'
        );
        expect(() => validateCommand('npm test < input.txt')).toThrow(
          'Command contains disallowed shell operator: <'
        );
      });

      it('should reject commands with background &', () => {
        expect(() => validateCommand('npm test &')).toThrow(
          'Command contains disallowed shell operator: &'
        );
      });

      it('should reject commands with newlines', () => {
        expect(() => validateCommand('npm test\nrm -rf /')).toThrow(
          'Command contains disallowed shell operator'
        );
      });
    });

    describe('disallowed commands', () => {
      it('should reject arbitrary shell commands', () => {
        expect(() => validateCommand('rm -rf /')).toThrow(
          'Command not in allowed list'
        );
        expect(() => validateCommand('curl http://evil.com')).toThrow(
          'Command not in allowed list'
        );
        expect(() => validateCommand('sh -c "evil"')).toThrow(
          'Command not in allowed list'
        );
      });

      it('should reject npm install', () => {
        expect(() => validateCommand('npm install')).toThrow(
          'Command not in allowed list'
        );
      });

      it('should reject npm publish', () => {
        expect(() => validateCommand('npm publish')).toThrow(
          'Command not in allowed list'
        );
      });

      it('should reject cargo publish', () => {
        expect(() => validateCommand('cargo publish')).toThrow(
          'Command not in allowed list'
        );
      });
    });
  });

  describe('sanitizeOutput', () => {
    beforeEach(() => {
      vi.mocked(os.homedir).mockReturnValue('/home/testuser');
    });

    it('should replace home directory with ~', () => {
      const output = 'File at /home/testuser/project/file.txt';
      const sanitized = sanitizeOutput(output);
      expect(sanitized).toBe('File at ~/project/file.txt');
    });

    it('should replace multiple occurrences of home directory', () => {
      const output = '/home/testuser/a and /home/testuser/b';
      const sanitized = sanitizeOutput(output);
      expect(sanitized).toBe('~/a and ~/b');
    });

    it('should truncate long output', () => {
      const longOutput = 'a'.repeat(6000);
      const sanitized = sanitizeOutput(longOutput);
      expect(sanitized.length).toBeLessThan(6000);
      expect(sanitized).toContain('... (truncated)');
    });

    it('should respect custom maxLength', () => {
      const output = 'a'.repeat(200);
      const sanitized = sanitizeOutput(output, 100);
      expect(sanitized.length).toBeLessThanOrEqual(120); // 100 + "... (truncated)"
      expect(sanitized).toContain('... (truncated)');
    });

    it('should not truncate short output', () => {
      const output = 'short message';
      const sanitized = sanitizeOutput(output);
      expect(sanitized).toBe('short message');
      expect(sanitized).not.toContain('truncated');
    });

    it('should handle empty output', () => {
      const sanitized = sanitizeOutput('');
      expect(sanitized).toBe('');
    });

    it('should handle output exactly at maxLength', () => {
      const output = 'a'.repeat(5000);
      const sanitized = sanitizeOutput(output, 5000);
      expect(sanitized).toBe(output);
      expect(sanitized).not.toContain('truncated');
    });
  });
});
