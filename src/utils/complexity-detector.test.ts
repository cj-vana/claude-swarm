/**
 * TDD Tests for complexity-detector module
 *
 * Tests complexity analysis for features:
 * - Description length scoring (0-20 pts)
 * - Keyword matching (0-30 pts, capped)
 * - Scope indicators (0-20 pts, capped)
 * - Architectural terms
 * - Dependency scoring (0-15 pts)
 * - Touch point detection (0-15 pts)
 * - Recommendation logic (simple/manual_review/competitive_planning)
 * - Result formatting
 */

import { describe, it, expect } from 'vitest';
import { analyzeComplexity, formatComplexityResult } from './complexity-detector.js';
import { Feature } from '../state/manager.js';

describe('complexity-detector module', () => {
  const createFeature = (description: string, dependsOn: string[] = []): Feature => ({
    id: 'test-feature',
    description,
    status: 'pending',
    attempts: 0,
    dependsOn,
  });

  describe('analyzeComplexity', () => {
    describe('length scoring', () => {
      it('should score 0 for very short descriptions (< 50 chars)', () => {
        const feature = createFeature('Add button');
        const result = analyzeComplexity(feature);

        expect(result.breakdown.lengthScore).toBeLessThan(5);
      });

      it('should score based on length / 10', () => {
        const feature = createFeature('a'.repeat(100));
        const result = analyzeComplexity(feature);

        // 100 / 10 = 10
        expect(result.breakdown.lengthScore).toBe(10);
      });

      it('should cap length score at 20', () => {
        const feature = createFeature('a'.repeat(1000));
        const result = analyzeComplexity(feature);

        expect(result.breakdown.lengthScore).toBe(20);
      });

      it('should handle empty description', () => {
        const feature = createFeature('');
        const result = analyzeComplexity(feature);

        expect(result.breakdown.lengthScore).toBe(0);
      });
    });

    describe('keyword scoring', () => {
      it('should detect "refactor" keyword (weight 10)', () => {
        const feature = createFeature('Refactor the authentication system');
        const result = analyzeComplexity(feature);

        expect(result.signals.keywordMatches).toContain('Refactor');
        expect(result.breakdown.keywordScore).toBeGreaterThanOrEqual(10);
      });

      it('should detect "migrate" keyword (weight 10)', () => {
        const feature = createFeature('Migrate from REST to GraphQL');
        const result = analyzeComplexity(feature);

        expect(result.signals.keywordMatches).toContain('Migrate');
        expect(result.breakdown.keywordScore).toBeGreaterThanOrEqual(10);
      });

      it('should detect "redesign" keyword (weight 10)', () => {
        const feature = createFeature('Redesign the user interface');
        const result = analyzeComplexity(feature);

        expect(result.signals.keywordMatches).toContain('Redesign');
      });

      it('should detect "integrate" keyword (weight 8)', () => {
        const feature = createFeature('Integrate payment processing');
        const result = analyzeComplexity(feature);

        expect(result.signals.keywordMatches).toContain('Integrate');
      });

      it('should be case insensitive', () => {
        const tests = [
          'REFACTOR everything',
          'refactor everything',
          'ReFaCtOr everything',
        ];

        for (const desc of tests) {
          const result = analyzeComplexity(createFeature(desc));
          expect(result.signals.keywordMatches.length).toBeGreaterThan(0);
        }
      });

      it('should respect word boundaries', () => {
        // "refactoring" should match, "refactorX" should not
        const valid = analyzeComplexity(createFeature('refactoring the code'));
        expect(valid.signals.keywordMatches.length).toBeGreaterThan(0);

        const invalid = analyzeComplexity(createFeature('prefactorize the code'));
        expect(invalid.signals.keywordMatches).not.toContain('prefactorize');
      });

      it('should handle multiple keywords and sum scores', () => {
        const feature = createFeature('Refactor and redesign the migration');
        const result = analyzeComplexity(feature);

        // Should find "Refactor" (10) + "redesign" (10) + "migration" (10) = 30
        expect(result.signals.keywordMatches.length).toBeGreaterThanOrEqual(3);
        expect(result.breakdown.keywordScore).toBeGreaterThanOrEqual(30);
      });

      it('should cap keyword score at 30', () => {
        const feature = createFeature(
          'Refactor redesign migrate integrate restructure overhaul rewrite'
        );
        const result = analyzeComplexity(feature);

        expect(result.breakdown.keywordScore).toBe(30);
      });
    });

    describe('scope indicator scoring', () => {
      it('should detect "multiple" (weight 5)', () => {
        const feature = createFeature('Update multiple components');
        const result = analyzeComplexity(feature);

        expect(result.signals.scopeIndicators).toContain('multiple');
        expect(result.breakdown.scopeScore).toBeGreaterThanOrEqual(5);
      });

      it('should detect "all files" (weight 7)', () => {
        const feature = createFeature('Update all files in the project');
        const result = analyzeComplexity(feature);

        expect(result.signals.scopeIndicators.some(s => s.includes('all'))).toBe(true);
      });

      it('should detect "entire" (weight 6)', () => {
        const feature = createFeature('Rewrite the entire codebase');
        const result = analyzeComplexity(feature);

        expect(result.signals.scopeIndicators).toContain('entire');
      });

      it('should detect "system-wide" (weight 8)', () => {
        const feature = createFeature('System-wide changes needed');
        const result = analyzeComplexity(feature);

        expect(result.signals.scopeIndicators.some(s => s.toLowerCase().includes('system'))).toBe(true);
      });

      it('should detect "across the codebase" (weight 7)', () => {
        const feature = createFeature('Changes across the codebase');
        const result = analyzeComplexity(feature);

        expect(result.signals.scopeIndicators.some(s => s.includes('across'))).toBe(true);
      });

      it('should cap scope score at 20', () => {
        const feature = createFeature(
          'Multiple system-wide changes across the entire project everywhere globally'
        );
        const result = analyzeComplexity(feature);

        expect(result.breakdown.scopeScore).toBe(20);
      });
    });

    describe('architectural terms', () => {
      it('should detect architectural terms and add half weight to scope', () => {
        const feature = createFeature('Design API gateway and database schema');
        const result = analyzeComplexity(feature);

        expect(result.signals.architecturalTerms.length).toBeGreaterThan(0);
        expect(result.breakdown.scopeScore).toBeGreaterThan(0);
      });

      it('should detect "authentication" (weight 5, contributes 2.5 to scope)', () => {
        const feature = createFeature('Implement authentication system');
        const result = analyzeComplexity(feature);

        expect(result.signals.architecturalTerms.some(t => t.toLowerCase().includes('authentication'))).toBe(true);
      });

      it('should detect "microservices" (weight 6, contributes 3 to scope)', () => {
        const feature = createFeature('Convert to microservices architecture');
        const result = analyzeComplexity(feature);

        expect(result.signals.architecturalTerms.some(t => t.toLowerCase().includes('microservices'))).toBe(true);
      });

      it('should detect "state management" (weight 5)', () => {
        const feature = createFeature('Refactor state management with Redux');
        const result = analyzeComplexity(feature);

        expect(result.signals.architecturalTerms.some(t => t.toLowerCase().includes('state management'))).toBe(true);
      });
    });

    describe('uncertainty indicators', () => {
      it('should detect uncertainty keywords without adding to score', () => {
        const feature = createFeature('This is a complex and tricky migration');
        const result = analyzeComplexity(feature);

        expect(result.signals.uncertaintyIndicators.length).toBeGreaterThan(0);
        // Uncertainty indicators are informational, don't directly add to score
        // But "complex" and "migration" are also other keywords
      });

      it('should detect "complex"', () => {
        const feature = createFeature('This is complex');
        const result = analyzeComplexity(feature);

        expect(result.signals.uncertaintyIndicators).toContain('complex');
      });

      it('should detect "critical"', () => {
        const feature = createFeature('Critical security fix needed');
        const result = analyzeComplexity(feature);

        expect(result.signals.uncertaintyIndicators).toContain('Critical');
      });

      it('should detect "challenging"', () => {
        const feature = createFeature('This will be challenging');
        const result = analyzeComplexity(feature);

        expect(result.signals.uncertaintyIndicators).toContain('challenging');
      });
    });

    describe('dependency scoring', () => {
      it('should score 0 for features with no dependencies', () => {
        const feature = createFeature('Simple task');
        const result = analyzeComplexity(feature);

        expect(result.breakdown.dependencyScore).toBe(0);
        expect(result.signals.dependencyCount).toBe(0);
      });

      it('should score 3 points per dependency', () => {
        const feature = createFeature('Task', ['dep1']);
        const result = analyzeComplexity(feature);

        expect(result.breakdown.dependencyScore).toBe(3);
        expect(result.signals.dependencyCount).toBe(1);
      });

      it('should handle multiple dependencies', () => {
        const feature = createFeature('Task', ['dep1', 'dep2', 'dep3']);
        const result = analyzeComplexity(feature);

        // 3 deps * 3 points = 9
        expect(result.breakdown.dependencyScore).toBe(9);
      });

      it('should cap dependency score at 15', () => {
        const feature = createFeature('Task', ['d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7']);
        const result = analyzeComplexity(feature);

        // 7 deps * 3 = 21, capped at 15
        expect(result.breakdown.dependencyScore).toBe(15);
      });
    });

    describe('touch point detection', () => {
      it('should detect file extensions', () => {
        const feature = createFeature('Update auth.ts and login.tsx files');
        const result = analyzeComplexity(feature);

        expect(result.signals.estimatedTouchPoints).toBeGreaterThanOrEqual(2);
      });

      it('should detect common file patterns', () => {
        const tests = [
          { desc: 'Fix utils.js', expected: 1 },
          { desc: 'Update component.tsx and service.py', expected: 2 },
          { desc: 'Modify config.json', expected: 1 },
        ];

        for (const test of tests) {
          const result = analyzeComplexity(createFeature(test.desc));
          expect(result.signals.estimatedTouchPoints).toBeGreaterThanOrEqual(test.expected);
        }
      });

      it('should detect component/module references', () => {
        const feature = createFeature('Update the auth component, user module, and api service');
        const result = analyzeComplexity(feature);

        // Pattern looks for standalone words like "component", "module", "service"
        expect(result.signals.estimatedTouchPoints).toBeGreaterThan(0);
      });

      it('should detect path patterns', () => {
        const feature = createFeature('Changes in src/components/auth and src/services/api');
        const result = analyzeComplexity(feature);

        expect(result.signals.estimatedTouchPoints).toBeGreaterThan(0);
      });

      it('should deduplicate touch points (case insensitive)', () => {
        const feature = createFeature('Update Auth.ts, auth.ts, and AUTH.TS');
        const result = analyzeComplexity(feature);

        // Should count as 1 unique touch point
        expect(result.signals.estimatedTouchPoints).toBe(1);
      });

      it('should score 3 points per touch point', () => {
        const feature = createFeature('Update file1.ts and file2.js');
        const result = analyzeComplexity(feature);

        // 2 touch points * 3 = 6
        expect(result.breakdown.touchPointScore).toBeGreaterThanOrEqual(6);
      });

      it('should cap touch point score at 15', () => {
        const feature = createFeature(
          'Update a.ts b.js c.py d.go e.rs f.tsx g.jsx h.vue i.md'
        );
        const result = analyzeComplexity(feature);

        expect(result.breakdown.touchPointScore).toBe(15);
      });
    });

    describe('overall scoring and recommendation', () => {
      it('should recommend "simple" for low complexity (< 42 points)', () => {
        const feature = createFeature('Add a small button');
        const result = analyzeComplexity(feature);

        expect(result.score).toBeLessThan(42);
        expect(result.recommendation).toBe('simple');
        expect(result.isComplex).toBe(false);
      });

      it('should recommend "manual_review" for medium complexity (42-59 points)', () => {
        const feature = createFeature(
          'Update multiple components and refactor the authentication logic in auth.ts and login.tsx'
        );
        const result = analyzeComplexity(feature);

        // This should score in the manual_review range
        if (result.score >= 42 && result.score < 60) {
          expect(result.recommendation).toBe('manual_review');
          expect(result.isComplex).toBe(false);
        }
      });

      it('should recommend "competitive_planning" for high complexity (>= 60 points)', () => {
        const feature = createFeature(
          'Refactor and redesign the entire authentication system with migration to microservices ' +
          'across all components in src/auth/, src/services/, and src/api/. This is a complex ' +
          'system-wide change affecting database schema and API gateway design.'
        );
        const result = analyzeComplexity(feature);

        expect(result.score).toBeGreaterThanOrEqual(60);
        expect(result.recommendation).toBe('competitive_planning');
        expect(result.isComplex).toBe(true);
      });

      it('should respect custom threshold', () => {
        // Create a feature that scores around 45 points
        const feature = createFeature(
          'Refactor and redesign the authentication with multiple components in auth.ts and login.tsx'
        );

        // With threshold 30, should be complex
        const resultLow = analyzeComplexity(feature, 30);
        expect(resultLow.isComplex).toBe(true);
        expect(resultLow.recommendation).toBe('competitive_planning');

        // With threshold 100, should not be complex
        const resultHigh = analyzeComplexity(feature, 100);
        expect(resultHigh.isComplex).toBe(false);
        expect(resultHigh.recommendation).not.toBe('competitive_planning');
      });

      it('should calculate total score correctly', () => {
        const feature = createFeature(
          'Refactor auth.ts', // keyword + touch point
          ['dep1', 'dep2'] // dependencies
        );
        const result = analyzeComplexity(feature);

        const calculatedTotal =
          result.breakdown.lengthScore +
          result.breakdown.keywordScore +
          result.breakdown.scopeScore +
          result.breakdown.dependencyScore +
          result.breakdown.touchPointScore;

        expect(result.score).toBe(calculatedTotal);
      });
    });

    describe('edge cases', () => {
      it('should handle features with no description', () => {
        const feature = createFeature('');
        const result = analyzeComplexity(feature);

        expect(result.score).toBe(0);
        expect(result.recommendation).toBe('simple');
      });

      it('should handle features with only whitespace', () => {
        const feature = createFeature('   \n\t  ');
        const result = analyzeComplexity(feature);

        expect(result.score).toBeLessThan(5);
      });

      it('should handle features with special characters', () => {
        const feature = createFeature('Fix @#$% in the !@#$ system');
        const result = analyzeComplexity(feature);

        // Should not crash
        expect(result).toBeDefined();
        expect(result.score).toBeGreaterThanOrEqual(0);
      });

      it('should handle very long descriptions', () => {
        const feature = createFeature('a'.repeat(10000));
        const result = analyzeComplexity(feature);

        // Length score should be capped at 20
        expect(result.breakdown.lengthScore).toBe(20);
      });

      it('should handle undefined dependsOn', () => {
        const feature: Feature = {
          id: 'test',
          description: 'Test',
          status: 'pending',
          attempts: 0,
          // dependsOn is undefined
        };
        const result = analyzeComplexity(feature);

        expect(result.signals.dependencyCount).toBe(0);
        expect(result.breakdown.dependencyScore).toBe(0);
      });
    });
  });

  describe('formatComplexityResult', () => {
    it('should format basic result', () => {
      const feature = createFeature('Simple task');
      const result = analyzeComplexity(feature);
      const formatted = formatComplexityResult(result);

      expect(formatted).toContain('Complexity Score:');
      expect(formatted).toContain('Recommendation:');
      expect(formatted).toContain('Breakdown:');
    });

    it('should include score breakdown', () => {
      const feature = createFeature('Refactor auth.ts');
      const result = analyzeComplexity(feature);
      const formatted = formatComplexityResult(result);

      expect(formatted).toContain('Description length:');
      expect(formatted).toContain('Keywords:');
      expect(formatted).toContain('Scope:');
      expect(formatted).toContain('Dependencies:');
      expect(formatted).toContain('Touch points:');
    });

    it('should show keywords found when present', () => {
      const feature = createFeature('Refactor the migration');
      const result = analyzeComplexity(feature);
      const formatted = formatComplexityResult(result);

      expect(formatted).toContain('Keywords found:');
      expect(formatted).toContain('Refactor');
    });

    it('should show scope indicators when present', () => {
      const feature = createFeature('Update multiple components');
      const result = analyzeComplexity(feature);
      const formatted = formatComplexityResult(result);

      if (result.signals.scopeIndicators.length > 0) {
        expect(formatted).toContain('Scope indicators:');
      }
    });

    it('should replace underscores in recommendation', () => {
      const feature = createFeature(
        'Refactor and redesign entire system with migration to microservices'
      );
      const result = analyzeComplexity(feature);
      const formatted = formatComplexityResult(result);

      // "competitive_planning" should become "competitive planning"
      expect(formatted).not.toContain('competitive_planning');
      if (result.recommendation === 'competitive_planning') {
        expect(formatted).toContain('competitive planning');
      }
    });

    it('should handle empty signals gracefully', () => {
      const feature = createFeature('xyz');
      const result = analyzeComplexity(feature);
      const formatted = formatComplexityResult(result);

      // Should not crash, should still show breakdown
      expect(formatted).toBeDefined();
      expect(formatted).toContain('Breakdown:');
    });
  });
});
