/**
 * TDD Tests for workers/confidence module
 *
 * Tests worker confidence monitoring:
 * - Tool activity analysis (healthy cycles, stuck loops, idle)
 * - Output analysis (errors, success, frustration)
 * - Self-reported confidence reading
 * - Aggregated scoring with weights
 * - Alert generation
 * - Trend detection
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import {
  analyzeToolActivity,
  analyzeOutput,
  readSelfReportedConfidence,
  calculateAggregatedConfidence,
  getWorkerConfidence,
  formatConfidenceResult,
  ConfidenceSignals,
} from './confidence.js';

// Mock fs
vi.mock('fs');

describe('workers/confidence module', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('analyzeToolActivity', () => {
    it('should detect healthy Read-Edit-Test cycles', () => {
      const log = 'Read file.ts\\nEdit file.ts\\nnpm test passed';
      const result = analyzeToolActivity(log, Date.now());

      expect(result.patterns.healthyCycles).toBeGreaterThan(0);
      expect(result.score).toBeGreaterThan(70); // Base + bonus
    });

    it('should detect stuck Read loops', () => {
      const log = 'Read file.ts\\nRead other.ts\\nRead another.ts\\nRead more.ts';
      const result = analyzeToolActivity(log, Date.now());

      expect(result.patterns.stuckLoops).toBeGreaterThan(0);
      expect(result.score).toBeLessThan(70); // Base - penalty
    });

    it('should detect error recoveries', () => {
      const log = 'Error: failed\\nsuccessfully completed';
      const result = analyzeToolActivity(log, Date.now());

      expect(result.patterns.errorRecoveries).toBe(1);
    });

    it('should penalize idle time (> 60 seconds)', () => {
      const twoMinutesAgo = Date.now() - (120 * 1000);
      const result = analyzeToolActivity('activity', twoMinutesAgo);

      expect(result.lastActivityAge).toBeGreaterThan(60);
      expect(result.score).toBeLessThan(70); // Idle penalty
    });

    it('should detect idle periods (> 3 minutes)', () => {
      const fourMinutesAgo = Date.now() - (240 * 1000);
      const result = analyzeToolActivity('activity', fourMinutesAgo);

      expect(result.patterns.idlePeriods).toBe(1);
    });

    it('should cap score at 100', () => {
      // Many healthy cycles
      const log = Array(20).fill('Read file\\nEdit file\\nnpm test').join('\\n');
      const result = analyzeToolActivity(log, Date.now());

      expect(result.score).toBeLessThanOrEqual(100);
    });

    it('should cap score at 0', () => {
      // Many stuck loops + long idle
      const log = Array(10).fill('Read file\\nRead other\\nRead more\\nRead again').join('\\n');
      const veryOld = Date.now() - (600 * 1000); // 10 minutes
      const result = analyzeToolActivity(log, veryOld);

      expect(result.score).toBeGreaterThanOrEqual(0);
    });

    it('should analyze last 100 lines only', () => {
      // 200 lines, but only last 100 analyzed
      const lines = Array(200).fill('line');
      const log = lines.join('\\n');
      const result = analyzeToolActivity(log, Date.now());

      // Should work without errors
      expect(result).toBeDefined();
    });
  });

  describe('analyzeOutput', () => {
    it('should count error patterns', () => {
      const log = 'Error: failed\\nerror in code\\nCannot find module\\nexit code: 1';
      const result = analyzeOutput(log);

      expect(result.indicators.errorCount).toBeGreaterThan(0);
      expect(result.score).toBeLessThan(70); // Penalty
    });

    it('should count retry patterns', () => {
      const log = 'trying again\\nLet me try\\nAttempt 2';
      const result = analyzeOutput(log);

      expect(result.indicators.retryCount).toBeGreaterThan(0);
    });

    it('should count success indicators', () => {
      const log = 'Tests passed successfully\\nBuild succeeded\\nNo errors found';
      const result = analyzeOutput(log);

      expect(result.indicators.successIndicators).toBeGreaterThan(0);
      expect(result.score).toBeGreaterThan(70); // Bonus
    });

    it('should detect frustration indicators', () => {
      const log = "I'm stuck\\nThis is difficult\\nI can't figure this out";
      const result = analyzeOutput(log);

      expect(result.indicators.frustrationIndicators).toBeGreaterThan(0);
      expect(result.score).toBeLessThan(70); // Heavy penalty
    });

    it('should detect completion indicators', () => {
      const log = 'Feature is complete\\nAll tests pass\\nTask complete';
      const result = analyzeOutput(log);

      expect(result.indicators.completionIndicators).toBeGreaterThan(0);
      expect(result.score).toBeGreaterThan(70); // Large bonus
    });

    it('should cap error count at 10 for display', () => {
      const log = Array(30).fill('error: failed').join('\\n');
      const result = analyzeOutput(log);

      expect(result.indicators.errorCount).toBe(10);
    });

    it('should cap score between 0 and 100', () => {
      const manyErrors = Array(20).fill('error failed exception').join('\\n');
      const manySuccesses = Array(20).fill('successfully completed done').join('\\n');

      const badResult = analyzeOutput(manyErrors);
      const goodResult = analyzeOutput(manySuccesses);

      expect(badResult.score).toBeGreaterThanOrEqual(0);
      expect(badResult.score).toBeLessThanOrEqual(100);
      expect(goodResult.score).toBeGreaterThanOrEqual(0);
      expect(goodResult.score).toBeLessThanOrEqual(100);
    });
  });

  describe('readSelfReportedConfidence', () => {
    it('should return null if file does not exist', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const result = readSelfReportedConfidence('/test', 'feature-1');

      expect(result).toBeNull();
    });

    it('should read valid confidence value', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('75');

      const result = readSelfReportedConfidence('/test', 'feature-1');

      expect(result).toBe(75);
    });

    it('should handle confidence with whitespace', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('  80\\n');

      const result = readSelfReportedConfidence('/test', 'feature-1');

      expect(result).toBe(80);
    });

    it('should return null for invalid numbers', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('not a number');

      const result = readSelfReportedConfidence('/test', 'feature-1');

      expect(result).toBeNull();
    });

    it('should return null for negative numbers', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('-10');

      const result = readSelfReportedConfidence('/test', 'feature-1');

      expect(result).toBeNull();
    });

    it('should return null for numbers > 100', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('150');

      const result = readSelfReportedConfidence('/test', 'feature-1');

      expect(result).toBeNull();
    });

    it('should return null on read error', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockImplementation(() => {
        throw new Error('Permission denied');
      });

      const result = readSelfReportedConfidence('/test', 'feature-1');

      expect(result).toBeNull();
    });
  });

  describe('calculateAggregatedConfidence', () => {
    const createSignals = (overrides: Partial<ConfidenceSignals> = {}): ConfidenceSignals => ({
      toolActivity: {
        score: 70,
        patterns: { healthyCycles: 0, stuckLoops: 0, idlePeriods: 0, errorRecoveries: 0 },
        lastActivityAge: 30,
      },
      selfReported: null,
      outputAnalysis: {
        score: 70,
        indicators: {
          errorCount: 0,
          retryCount: 0,
          successIndicators: 0,
          frustrationIndicators: 0,
          completionIndicators: 0,
        },
      },
      ...overrides,
    });

    it('should calculate weighted score with all signals', () => {
      const signals = createSignals({
        toolActivity: { ...createSignals().toolActivity, score: 80 },
        selfReported: 70,
        outputAnalysis: { ...createSignals().outputAnalysis, score: 60 },
      });

      const result = calculateAggregatedConfidence(signals);
      expect(result.score).toBe(71);
    it('should redistribute weights when self-reported is null', () => {
      const signals = createSignals({
        toolActivity: { ...createSignals().toolActivity, score: 80 },
        selfReported: null,
        outputAnalysis: { ...createSignals().outputAnalysis, score: 60 },
      });

      const result = calculateAggregatedConfidence(signals);

      // 80 * 0.5 + 60 * 0.5 = 40 + 30 = 70
      expect(result.score).toBe(70);
    });

    it('should classify score levels correctly', () => {
      const tests = [
        { score: 90, expected: 'high' },
        { score: 60, expected: 'medium' },
        { score: 35, expected: 'low' },
        { score: 20, expected: 'critical' },
      ];

      for (const test of tests) {
        const signals = createSignals({
          toolActivity: { ...createSignals().toolActivity, score: test.score },
          outputAnalysis: { ...createSignals().outputAnalysis, score: test.score },
        });

        const result = calculateAggregatedConfidence(signals);

        expect(result.level).toBe(test.expected);
      }
    });

    it('should detect improving trend', () => {
      const signals = createSignals({
        toolActivity: { ...createSignals().toolActivity, score: 80 },
        outputAnalysis: { ...createSignals().outputAnalysis, score: 80 },
      });

      const result = calculateAggregatedConfidence(signals, 60);

      expect(result.trend).toBe('improving');
      expect(result.score).toBeGreaterThan(75); // +5 boost
    });

    it('should detect declining trend', () => {
      const signals = createSignals({
        toolActivity: { ...createSignals().toolActivity, score: 50 },
        outputAnalysis: { ...createSignals().outputAnalysis, score: 50 },
      });

      const result = calculateAggregatedConfidence(signals, 70);

      expect(result.trend).toBe('declining');
      expect(result.score).toBeLessThan(50); // -5 penalty
    });

    it('should detect stable trend', () => {
      const signals = createSignals();

      const result = calculateAggregatedConfidence(signals, 69);

      expect(result.trend).toBe('stable');
    });

    it('should generate idle alert', () => {
      const signals = createSignals({
        toolActivity: { ...createSignals().toolActivity, lastActivityAge: 200 },
      });

      const result = calculateAggregatedConfidence(signals);

      const idleAlert = result.alerts.find(a => a.type === 'idle');
      expect(idleAlert).toBeDefined();
      expect(idleAlert!.severity).toBe('warning');
    });

    it('should generate critical idle alert for long idle', () => {
      const signals = createSignals({
        toolActivity: { ...createSignals().toolActivity, lastActivityAge: 400 },
      });

      const result = calculateAggregatedConfidence(signals);

      const idleAlert = result.alerts.find(a => a.type === 'idle');
      expect(idleAlert!.severity).toBe('critical');
    });

    it('should generate stuck loop alert', () => {
      const signals = createSignals({
        toolActivity: {
          ...createSignals().toolActivity,
          patterns: { ...createSignals().toolActivity.patterns, stuckLoops: 2 },
        },
      });

      const result = calculateAggregatedConfidence(signals);

      const loopAlert = result.alerts.find(a => a.type === 'stuck_loop');
      expect(loopAlert).toBeDefined();
    });

    it('should generate high errors alert', () => {
      const signals = createSignals({
        outputAnalysis: {
          ...createSignals().outputAnalysis,
          indicators: { ...createSignals().outputAnalysis.indicators, errorCount: 5 },
        },
      });

      const result = calculateAggregatedConfidence(signals);

      const errorAlert = result.alerts.find(a => a.type === 'high_errors');
      expect(errorAlert).toBeDefined();
    });

    it('should generate low self-reported confidence alert', () => {
      const signals = createSignals({
        selfReported: 25,
      });

      const result = calculateAggregatedConfidence(signals);

      const selfAlert = result.alerts.find(a => a.type === 'self_reported_low');
      expect(selfAlert).toBeDefined();
    });

    it('should generate declining trend alert', () => {
      const signals = createSignals({
        toolActivity: { ...createSignals().toolActivity, score: 40 },
        outputAnalysis: { ...createSignals().outputAnalysis, score: 40 },
      });

      const result = calculateAggregatedConfidence(signals, 70);

      const trendAlert = result.alerts.find(a => a.type === 'declining_trend');
      expect(trendAlert).toBeDefined();
    });
  });

  describe('getWorkerConfidence', () => {
    it('should return null if log file does not exist', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const result = getWorkerConfidence('/test', 'feature-1');

      expect(result).toBeNull();
    });

    it('should integrate all signals', () => {
      vi.mocked(fs.existsSync).mockImplementation((path) => {
        return path.toString().includes('.log') || path.toString().includes('.confidence');
      });
      vi.mocked(fs.readFileSync).mockImplementation((path) => {
        if (path.toString().includes('.log')) {
          return 'Read file\\nEdit file\\nnpm test passed\\nSuccessfully completed';
        }
        return '75'; // confidence file
      });
      vi.mocked(fs.statSync).mockReturnValue({ mtimeMs: Date.now() } as any);

      const result = getWorkerConfidence('/test', 'feature-1');

      expect(result).not.toBeNull();
      expect(result!.signals.selfReported).toBe(75);
      expect(result!.score).toBeGreaterThan(0);
    });

    it('should return null on error', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockImplementation(() => {
        throw new Error('Read error');
      });

      const result = getWorkerConfidence('/test', 'feature-1');

      expect(result).toBeNull();
    });
  });

  describe('formatConfidenceResult', () => {
    it('should format basic confidence result', () => {
      const confidence = calculateAggregatedConfidence({
        toolActivity: {
          score: 70,
          patterns: { healthyCycles: 2, stuckLoops: 0, idlePeriods: 0, errorRecoveries: 1 },
          lastActivityAge: 30,
        },
        selfReported: 75,
        outputAnalysis: {
          score: 80,
          indicators: {
            errorCount: 1,
            retryCount: 0,
            successIndicators: 2,
            frustrationIndicators: 0,
            completionIndicators: 0,
          },
        },
      });

      const formatted = formatConfidenceResult(confidence);

      expect(formatted).toContain('Confidence:');
      expect(formatted).toContain('Signals:');
      expect(formatted).toContain('Tool Activity:');
      expect(formatted).toContain('Self-Reported:');
      expect(formatted).toContain('Output Analysis:');
    });

    it('should show "not available" for missing self-reported', () => {
      const confidence = calculateAggregatedConfidence({
        toolActivity: {
          score: 70,
          patterns: { healthyCycles: 0, stuckLoops: 0, idlePeriods: 0, errorRecoveries: 0 },
          lastActivityAge: 30,
        },
        selfReported: null,
        outputAnalysis: {
          score: 70,
          indicators: {
            errorCount: 0,
            retryCount: 0,
            successIndicators: 0,
            frustrationIndicators: 0,
            completionIndicators: 0,
          },
        },
      });

      const formatted = formatConfidenceResult(confidence);

      expect(formatted).toContain('Self-Reported: not available');
    });

    it('should include alerts when present', () => {
      const confidence = calculateAggregatedConfidence({
        toolActivity: {
          score: 40,
          patterns: { healthyCycles: 0, stuckLoops: 2, idlePeriods: 1, errorRecoveries: 0 },
          lastActivityAge: 250,
        },
        selfReported: null,
        outputAnalysis: {
          score: 40,
          indicators: {
            errorCount: 5,
            retryCount: 0,
            successIndicators: 0,
            frustrationIndicators: 0,
            completionIndicators: 0,
          },
        },
      });

      const formatted = formatConfidenceResult(confidence);

      expect(formatted).toContain('Alerts:');
    });
  });
});
