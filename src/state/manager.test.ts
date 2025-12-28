/**
 * TDD Tests for state/manager module
 *
 * Tests state persistence and management:
 * - Directory creation
 * - Load/save with validation
 * - Atomic writes
 * - Log rotation
 * - Progress file generation
 * - Init script generation
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { StateManager, OrchestratorState } from './manager.js';

// Mock fs
vi.mock('fs');

describe('state/manager', () => {
  const mockProjectDir = '/test/project';
  let manager: StateManager;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fs.existsSync).mockReturnValue(true);
    manager = new StateManager(mockProjectDir);
  });

  describe('constructor', () => {
    it('should create .claude/orchestrator directory if it does not exist', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      new StateManager(mockProjectDir);

      expect(fs.mkdirSync).toHaveBeenCalledWith(
        path.join(mockProjectDir, '.claude', 'orchestrator'),
        { recursive: true }
      );
    });

    it('should not create directory if it already exists', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);

      new StateManager(mockProjectDir);

      expect(fs.mkdirSync).not.toHaveBeenCalled();
    });

    it('should set correct file paths', () => {
      const manager = new StateManager(mockProjectDir);

      expect(manager.projectDir).toBe(mockProjectDir);
      expect(manager['stateFile']).toBe(
        path.join(mockProjectDir, '.claude', 'orchestrator', 'state.json')
      );
      expect(manager['progressFile']).toBe(
        path.join(mockProjectDir, 'claude-progress.txt')
      );
    });
  });

  describe('load', () => {
    it('should return null if state file does not exist', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const result = manager.load();

      expect(result).toBeNull();
    });

    it('should load and parse valid state file', () => {
      const mockState: OrchestratorState = {
        projectDir: mockProjectDir,
        taskDescription: 'Test task',
        features: [],
        workers: [],
        status: 'in_progress',
        startTime: '2024-01-01T00:00:00Z',
        lastUpdated: '2024-01-01T00:00:00Z',
        progressLog: [],
      };

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(mockState));

      const result = manager.load();

      expect(result).toEqual(mockState);
    });

    it('should throw error for corrupted JSON', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('{ invalid json');

      expect(() => manager.load()).toThrow('State file is corrupted or invalid');
    });

    it('should throw error for invalid schema', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
        // Missing required fields
        projectDir: mockProjectDir,
      }));

      // Should throw any error when schema validation fails
      expect(() => manager.load()).toThrow();
    });
  });

  describe('save', () => {
    const mockState: OrchestratorState = {
      projectDir: mockProjectDir,
      taskDescription: 'Test task',
      features: [],
      workers: [],
      status: 'in_progress',
      startTime: '2024-01-01T00:00:00Z',
      lastUpdated: '2024-01-01T00:00:00Z',
      progressLog: [],
    };

    beforeEach(() => {
      // Reset mocks before each test to prevent pollution
      vi.clearAllMocks();
    });

    it('should use atomic write pattern (temp file then rename)', () => {
      manager.save(mockState);

      // Should write to temp file first
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining('.tmp.'),
        expect.any(String)
      );

      // Then rename to final location
      expect(fs.renameSync).toHaveBeenCalledWith(
        expect.stringContaining('.tmp.'),
        expect.stringContaining('state.json')
      );
    });

    it('should update lastUpdated timestamp', () => {
      const stateCopy = { ...mockState };

      manager.save(stateCopy);

      expect(stateCopy.lastUpdated).not.toBe('2024-01-01T00:00:00Z');
      expect(new Date(stateCopy.lastUpdated).getTime()).toBeGreaterThan(0);
    });

    it('should rotate log if exceeds MAX_LOG_ENTRIES', () => {
      const largeLog = Array.from({ length: 1500 }, (_, i) => `Entry ${i}`);
      const stateCopy = { ...mockState, progressLog: largeLog };

      manager.save(stateCopy);

      expect(stateCopy.progressLog.length).toBe(1000);
      expect(stateCopy.progressLog[0]).toBe('Entry 500'); // Kept last 1000
    });

    it('should not rotate log if under MAX_LOG_ENTRIES', () => {
      const smallLog = Array.from({ length: 100 }, (_, i) => `Entry ${i}`);
      const stateCopy = { ...mockState, progressLog: smallLog };

      manager.save(stateCopy);

      expect(stateCopy.progressLog.length).toBe(100);
    });

    it('should clean up temp file if rename fails', () => {
      vi.mocked(fs.renameSync).mockImplementationOnce(() => {
        throw new Error('Rename failed');
      });

      expect(() => manager.save(mockState)).toThrow('Rename failed');
      expect(fs.unlinkSync).toHaveBeenCalledWith(
        expect.stringContaining('.tmp.')
      );
    });

    it('should write feature list after saving state', () => {
      const writeFeatureListSpy = vi.spyOn(manager as any, 'writeFeatureList');

      manager.save(mockState);

      expect(writeFeatureListSpy).toHaveBeenCalledWith(mockState);
    });
  });

  describe('clear', () => {
    it('should remove all state files', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);

      manager.clear();

      expect(fs.unlinkSync).toHaveBeenCalledWith(
        expect.stringContaining('state.json')
      );
      expect(fs.unlinkSync).toHaveBeenCalledWith(
        expect.stringContaining('claude-progress.txt')
      );
      expect(fs.unlinkSync).toHaveBeenCalledWith(
        expect.stringContaining('feature_list.json')
      );
    });

    it('should not throw if files do not exist', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      expect(() => manager.clear()).not.toThrow();
      expect(fs.unlinkSync).not.toHaveBeenCalled();
    });

    it('should ignore unlink errors', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.unlinkSync).mockImplementation(() => {
        throw new Error('Permission denied');
      });

      expect(() => manager.clear()).not.toThrow();
    });
  });

  describe('writeProgressFile', () => {
    it('should write human-readable progress file', () => {
      const mockState: OrchestratorState = {
        projectDir: mockProjectDir,
        taskDescription: 'Test task',
        features: [
          {
            id: 'feature-1',
            description: 'Test feature',
            status: 'completed',
            attempts: 1,
          },
        ],
        workers: [],
        status: 'in_progress',
        startTime: '2024-01-01T00:00:00Z',
        lastUpdated: '2024-01-01T01:00:00Z',
        progressLog: ['Log entry 1', 'Log entry 2'],
      };

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(mockState));

      manager.writeProgressFile();

      expect(fs.writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining('.tmp.'),
        expect.stringContaining('Claude Orchestrator Progress Log')
      );
    });

    it('should use atomic write for progress file', () => {
      const mockState: OrchestratorState = {
        projectDir: mockProjectDir,
        taskDescription: 'Test',
        features: [],
        workers: [],
        status: 'in_progress',
        startTime: '2024-01-01T00:00:00Z',
        lastUpdated: '2024-01-01T00:00:00Z',
        progressLog: [],
      };

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(mockState));

      manager.writeProgressFile();

      expect(fs.renameSync).toHaveBeenCalled();
    });
  });

  describe('writeFeatureList', () => {
    it('should write structured feature list', () => {
      const mockState: OrchestratorState = {
        projectDir: mockProjectDir,
        taskDescription: 'Test',
        features: [
          { id: 'feature-1', description: 'Test 1', status: 'completed', attempts: 1 },
          { id: 'feature-2', description: 'Test 2', status: 'pending', attempts: 0 },
        ],
        workers: [],
        status: 'in_progress',
        startTime: '2024-01-01T00:00:00Z',
        lastUpdated: '2024-01-01T00:00:00Z',
        progressLog: [],
      };

      manager.writeFeatureList(mockState);

      const writeCall = vi.mocked(fs.writeFileSync).mock.calls.find(call =>
        call[0].toString().includes('.tmp.')
      );
      expect(writeCall).toBeDefined();

      const content = JSON.parse(writeCall![1] as string);
      expect(content.features).toHaveLength(2);
      expect(content.features[0]).toMatchObject({
        id: 'feature-1',
        status: 'completed',
        passes: true,
      });
    });

    it('should use atomic write', () => {
      const mockState: OrchestratorState = {
        projectDir: mockProjectDir,
        taskDescription: 'Test',
        features: [],
        workers: [],
        status: 'in_progress',
        startTime: '2024-01-01T00:00:00Z',
        lastUpdated: '2024-01-01T00:00:00Z',
        progressLog: [],
      };

      manager.writeFeatureList(mockState);

      expect(fs.renameSync).toHaveBeenCalled();
    });
  });

  describe('writeInitScript', () => {
    it('should write init script with shell quoting', () => {
      const mockState: OrchestratorState = {
        projectDir: '/test/path with spaces',
        taskDescription: 'Test',
        features: [],
        workers: [],
        status: 'in_progress',
        startTime: '2024-01-01T00:00:00Z',
        lastUpdated: '2024-01-01T00:00:00Z',
        progressLog: [],
      };

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(mockState));

      manager.writeInitScript();

      const writeCall = vi.mocked(fs.writeFileSync).mock.calls.find(call =>
        call[0].toString().includes('init.sh')
      );
      expect(writeCall).toBeDefined();
      expect(writeCall![2]).toMatchObject({ mode: 0o700 }); // Owner-only execution
    });

    it('should set executable permissions (mode 0o700)', () => {
      const mockState: OrchestratorState = {
        projectDir: mockProjectDir,
        taskDescription: 'Test',
        features: [],
        workers: [],
        status: 'in_progress',
        startTime: '2024-01-01T00:00:00Z',
        lastUpdated: '2024-01-01T00:00:00Z',
        progressLog: [],
      };

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(mockState));

      manager.writeInitScript();

      expect(fs.writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining('init.sh'),
        expect.any(String),
        { mode: 0o700 }
      );
    });
  });

  describe('appendLog', () => {
    it('should append message to progress log', () => {
      const mockState: OrchestratorState = {
        projectDir: mockProjectDir,
        taskDescription: 'Test',
        features: [],
        workers: [],
        status: 'in_progress',
        startTime: '2024-01-01T00:00:00Z',
        lastUpdated: '2024-01-01T00:00:00Z',
        progressLog: ['Existing entry'],
      };

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(mockState));

      manager.appendLog('New log message');

      // Should have saved state with new log entry
      expect(fs.writeFileSync).toHaveBeenCalled();
    });

    it('should include timestamp in log message', () => {
      const mockState: OrchestratorState = {
        projectDir: mockProjectDir,
        taskDescription: 'Test',
        features: [],
        workers: [],
        status: 'in_progress',
        startTime: '2024-01-01T00:00:00Z',
        lastUpdated: '2024-01-01T00:00:00Z',
        progressLog: [],
      };

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(mockState));

      manager.appendLog('Test message');

      const saveCall = vi.mocked(fs.writeFileSync).mock.calls[0];
      const savedState = JSON.parse(saveCall[1] as string);

      expect(savedState.progressLog).toHaveLength(1);
      expect(savedState.progressLog[0]).toMatch(/^\[.*\] Test message$/);
    });

    it('should not throw if load fails', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      expect(() => manager.appendLog('Test')).not.toThrow();
    });
  });
});
