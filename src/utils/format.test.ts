/**
 * TDD Tests for format module
 *
 * Tests formatting utilities:
 * - Duration formatting
 * - String truncation
 * - Progress bars
 * - Percentage formatting
 * - Average calculation
 */

import { describe, it, expect } from 'vitest';
import {
  formatDuration,
  truncate,
  progressBar,
  formatPercent,
  calculateAverage,
  formatDurationMs,
} from './format.js';

describe('format module', () => {
  describe('formatDuration', () => {
    it('should format seconds', () => {
      const start = new Date('2024-01-01T00:00:00Z');
      const end = new Date('2024-01-01T00:00:30Z');
      expect(formatDuration(start, end)).toBe('30s');
    });

    it('should format minutes and seconds', () => {
      const start = new Date('2024-01-01T00:00:00Z');
      const end = new Date('2024-01-01T00:02:30Z');
      expect(formatDuration(start, end)).toBe('2m 30s');
    });

    it('should format hours and minutes', () => {
      const start = new Date('2024-01-01T00:00:00Z');
      const end = new Date('2024-01-01T03:15:00Z');
      expect(formatDuration(start, end)).toBe('3h 15m');
    });

    it('should format days, hours, and minutes', () => {
      const start = new Date('2024-01-01T00:00:00Z');
      const end = new Date('2024-01-03T05:25:00Z');
      expect(formatDuration(start, end)).toBe('2d 5h 25m');
    });

    it('should handle zero duration', () => {
      const start = new Date('2024-01-01T00:00:00Z');
      const end = new Date('2024-01-01T00:00:00Z');
      expect(formatDuration(start, end)).toBe('0s');
    });

    it('should handle exactly 1 minute', () => {
      const start = new Date('2024-01-01T00:00:00Z');
      const end = new Date('2024-01-01T00:01:00Z');
      expect(formatDuration(start, end)).toBe('1m 0s');
    });

    it('should handle exactly 1 hour', () => {
      const start = new Date('2024-01-01T00:00:00Z');
      const end = new Date('2024-01-01T01:00:00Z');
      expect(formatDuration(start, end)).toBe('1h 0m');
    });

    it('should handle exactly 1 day', () => {
      const start = new Date('2024-01-01T00:00:00Z');
      const end = new Date('2024-01-02T00:00:00Z');
      expect(formatDuration(start, end)).toBe('1d 0h 0m');
    });

    it('should handle complex duration', () => {
      const start = new Date('2024-01-01T00:00:00Z');
      const end = new Date('2024-01-05T13:42:17Z');
      expect(formatDuration(start, end)).toBe('4d 13h 42m');
    });
  });

  describe('truncate', () => {
    it('should not truncate short strings', () => {
      expect(truncate('hello', 10)).toBe('hello');
      expect(truncate('test', 10)).toBe('test');
    });

    it('should truncate long strings', () => {
      expect(truncate('hello world this is a long string', 15)).toBe('hello world ...');
    });

    it('should handle string exactly at maxLength', () => {
      expect(truncate('12345678901234567890', 20)).toBe('12345678901234567890');
    });

    it('should handle string one character over', () => {
      expect(truncate('123456789012345678901', 20)).toBe('12345678901234567...');
    });

    it('should handle very short maxLength', () => {
      expect(truncate('hello world', 5)).toBe('he...');
    });

    it('should handle maxLength of 3 (edge case)', () => {
      expect(truncate('hello', 3)).toBe('...');
    });

    it('should handle empty string', () => {
      expect(truncate('', 10)).toBe('');
    });

    it('should preserve special characters before truncation', () => {
      expect(truncate('hello\nworld\ttabs', 10)).toBe('hello\nw...');
    });
  });

  describe('progressBar', () => {
    it('should show empty progress bar', () => {
      expect(progressBar(0, 100, 10)).toBe('[░░░░░░░░░░] 0/100');
    });

    it('should show full progress bar', () => {
      expect(progressBar(100, 100, 10)).toBe('[██████████] 100/100');
    });

    it('should show half progress', () => {
      expect(progressBar(50, 100, 10)).toBe('[█████░░░░░] 50/100');
    });

    it('should show 25% progress', () => {
      expect(progressBar(25, 100, 20)).toBe('[█████░░░░░░░░░░░░░░░] 25/100');
    });

    it('should show 75% progress', () => {
      expect(progressBar(75, 100, 20)).toBe('[███████████████░░░░░] 75/100');
    });

    it('should handle total of 0', () => {
      expect(progressBar(0, 0, 10)).toBe('[░░░░░░░░░░] 0/0');
    });

    it('should handle current greater than total', () => {
      expect(progressBar(150, 100, 10)).toBe('[██████████] 150/100');
    });

    it('should use default width of 20', () => {
      const result = progressBar(50, 100);
      expect(result).toContain('[');
      expect(result).toContain('] 50/100');
      expect(result.match(/[█░]/g)?.length).toBe(20);
    });

    it('should handle small width', () => {
      expect(progressBar(50, 100, 4)).toBe('[██░░] 50/100');
    });

    it('should handle width of 1', () => {
      expect(progressBar(0, 100, 1)).toBe('[░] 0/100');
      expect(progressBar(100, 100, 1)).toBe('[█] 100/100');
    });

    it('should round progress correctly', () => {
      // 33/100 = 0.33 * 10 = 3.3 -> rounds to 3
      expect(progressBar(33, 100, 10)).toBe('[███░░░░░░░] 33/100');
      // 66/100 = 0.66 * 10 = 6.6 -> rounds to 7
      expect(progressBar(66, 100, 10)).toBe('[███████░░░] 66/100');
    });
  });

  describe('formatPercent', () => {
    it('should format percentages with default 1 decimal', () => {
      expect(formatPercent(0.5)).toBe('50.0%');
      expect(formatPercent(0.25)).toBe('25.0%');
      expect(formatPercent(0.75)).toBe('75.0%');
    });

    it('should format percentages with custom decimals', () => {
      expect(formatPercent(0.5, 0)).toBe('50%');
      expect(formatPercent(0.5, 2)).toBe('50.00%');
      expect(formatPercent(0.5, 3)).toBe('50.000%');
    });

    it('should handle 0%', () => {
      expect(formatPercent(0)).toBe('0.0%');
      expect(formatPercent(0, 0)).toBe('0%');
    });

    it('should handle 100%', () => {
      expect(formatPercent(1)).toBe('100.0%');
      expect(formatPercent(1, 0)).toBe('100%');
    });

    it('should handle values greater than 1', () => {
      expect(formatPercent(1.5)).toBe('150.0%');
      expect(formatPercent(2.0)).toBe('200.0%');
    });

    it('should handle small percentages', () => {
      expect(formatPercent(0.001, 1)).toBe('0.1%');
      expect(formatPercent(0.001, 2)).toBe('0.10%');
      expect(formatPercent(0.001, 3)).toBe('0.100%');
    });

    it('should handle Infinity', () => {
      expect(formatPercent(Infinity)).toBe('N/A');
      expect(formatPercent(-Infinity)).toBe('N/A');
    });

    it('should handle NaN', () => {
      expect(formatPercent(NaN)).toBe('N/A');
    });

    it('should handle negative percentages', () => {
      expect(formatPercent(-0.5)).toBe('-50.0%');
      expect(formatPercent(-0.25, 0)).toBe('-25%');
    });

    it('should round correctly', () => {
      expect(formatPercent(0.555, 1)).toBe('55.5%');
      expect(formatPercent(0.556, 1)).toBe('55.6%');
      expect(formatPercent(0.5555, 2)).toBe('55.55%');
      expect(formatPercent(0.5556, 2)).toBe('55.56%');
    });
  });

  describe('calculateAverage', () => {
    it('should calculate average of numbers', () => {
      expect(calculateAverage([1, 2, 3, 4, 5])).toBe(3);
      expect(calculateAverage([10, 20, 30])).toBe(20);
    });

    it('should handle single number', () => {
      expect(calculateAverage([42])).toBe(42);
    });

    it('should handle empty array', () => {
      expect(calculateAverage([])).toBe(0);
    });

    it('should handle negative numbers', () => {
      expect(calculateAverage([-1, -2, -3])).toBe(-2);
      expect(calculateAverage([- 5, 5])).toBe(0);
    });

    it('should handle decimals', () => {
      expect(calculateAverage([1.5, 2.5, 3.5])).toBeCloseTo(2.5);
      expect(calculateAverage([0.1, 0.2, 0.3])).toBeCloseTo(0.2);
    });

    it('should handle large numbers', () => {
      expect(calculateAverage([1000000, 2000000, 3000000])).toBe(2000000);
    });

    it('should handle zero values', () => {
      expect(calculateAverage([0, 0, 0])).toBe(0);
      expect(calculateAverage([0, 10])).toBe(5);
    });

    it('should handle non-integer averages', () => {
      expect(calculateAverage([1, 2])).toBe(1.5);
      expect(calculateAverage([1, 2, 3])).toBe(2);
    });
  });

  describe('formatDurationMs', () => {
    it('should format milliseconds to seconds', () => {
      expect(formatDurationMs(5000)).toBe('5s');
      expect(formatDurationMs(30000)).toBe('30s');
    });

    it('should format minutes and seconds', () => {
      expect(formatDurationMs(150000)).toBe('2m 30s'); // 2.5 minutes
      expect(formatDurationMs(90000)).toBe('1m 30s'); // 1.5 minutes
    });

    it('should format hours and minutes', () => {
      expect(formatDurationMs(11700000)).toBe('3h 15m'); // 3.25 hours
      expect(formatDurationMs(7200000)).toBe('2h 0m'); // exactly 2 hours
    });

    it('should format days, hours, and minutes', () => {
      expect(formatDurationMs(192300000)).toBe('2d 5h 25m'); // ~2.22 days
      expect(formatDurationMs(86400000)).toBe('1d 0h 0m'); // exactly 1 day
    });

    it('should handle zero duration', () => {
      expect(formatDurationMs(0)).toBe('0s');
    });

    it('should handle sub-second durations', () => {
      expect(formatDurationMs(999)).toBe('0s');
      expect(formatDurationMs(500)).toBe('0s');
    });

    it('should handle negative values', () => {
      expect(formatDurationMs(-1000)).toBe('N/A');
    });

    it('should handle Infinity', () => {
      expect(formatDurationMs(Infinity)).toBe('N/A');
      expect(formatDurationMs(-Infinity)).toBe('N/A');
    });

    it('should handle NaN', () => {
      expect(formatDurationMs(NaN)).toBe('N/A');
    });

    it('should handle exactly 1 minute', () => {
      expect(formatDurationMs(60000)).toBe('1m 0s');
    });

    it('should handle exactly 1 hour', () => {
      expect(formatDurationMs(3600000)).toBe('1h 0m');
    });

    it('should handle large durations', () => {
      expect(formatDurationMs(432000000)).toBe('5d 0h 0m'); // exactly 5 days
    });

    it('should floor seconds (not round)', () => {
      expect(formatDurationMs(5999)).toBe('5s'); // 5.999 seconds -> 5s
      expect(formatDurationMs(1500)).toBe('1s'); // 1.5 seconds -> 1s
    });
  });
});
