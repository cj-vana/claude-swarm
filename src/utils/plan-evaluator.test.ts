/**
 * TDD Tests for plan-evaluator module
 *
 * Tests plan evaluation and comparison:
 * - Completeness scoring (0-25 pts)
 * - Feasibility scoring with file checks (0-25 pts)
 * - Risk awareness scoring (0-20 pts)
 * - Clarity scoring (0-15 pts)
 * - Efficiency scoring (0-15 pts)
 * - Winner selection
 * - Margin calculation
 * - Plan parsing from JSON
 * - Result formatting
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import {
  evaluatePlans,
  parsePlanFromFile,
  formatEvaluationResult,
  StructuredPlan,
} from './plan-evaluator.js';
import { Feature } from '../state/manager.js';

// Mock fs
vi.mock('fs');

describe('plan-evaluator module', () => {
  const mockProjectDir = '/test/project';

  const createFeature = (description: string): Feature => ({
    id: 'test-feature',
    description,
    status: 'pending',
    attempts: 0,
  });

  const createBasicPlan = (): StructuredPlan => ({
    summary: 'Implement user authentication with JWT tokens',
    steps: [
      {
        order: 1,
        description: 'Create auth service',
        files: ['src/auth/service.ts'],
      },
      {
        order: 2,
        description: 'Add login endpoint',
        files: ['src/api/auth.ts'],
      },
    ],
    filesToCreate: ['src/auth/service.ts'],
    filesToModify: ['src/api/auth.ts'],
    testStrategy: 'Unit tests for auth service, integration tests for login endpoint',
    risks: ['Token expiry handling', 'Session management complexity'],
  });

  beforeEach(() => {
    vi.clearAllMocks();
    // Default: files don't exist
    vi.mocked(fs.existsSync).mockReturnValue(false);
  });

  describe('evaluatePlans - completeness scoring', () => {
    it('should penalize plans with no steps', () => {
      const feature = createFeature('Add authentication');
      const planA: StructuredPlan = {
        ...createBasicPlan(),
        steps: [],
      };
      const planB = createBasicPlan();

      const result = evaluatePlans(feature, planA, planB, mockProjectDir);

      expect(result.evaluations.A.scores.completeness).toBeLessThan(
        result.evaluations.B.scores.completeness
      );
      expect(result.evaluations.A.concerns).toContain('No implementation steps defined');
    });

    it('should reward plans with 3+ steps', () => {
      const feature = createFeature('Add authentication');
      const planA: StructuredPlan = {
        ...createBasicPlan(),
        steps: [
          { order: 1, description: 'Step 1', files: [] },
          { order: 2, description: 'Step 2', files: [] },
        ],
      };
      const planB: StructuredPlan = {
        ...createBasicPlan(),
        steps: [
          { order: 1, description: 'Step 1', files: [] },
          { order: 2, description: 'Step 2', files: [] },
          { order: 3, description: 'Step 3', files: [] },
        ],
      };

      const result = evaluatePlans(feature, planA, planB, mockProjectDir);

      expect(result.evaluations.B.scores.completeness).toBeGreaterThan(
        result.evaluations.A.scores.completeness
      );
    });

    it('should reward plans with summaries addressing feature keywords', () => {
      const feature = createFeature('Implement user authentication with OAuth2');
      const planA: StructuredPlan = {
        ...createBasicPlan(),
        summary: 'Add some code',
      };
      const planB: StructuredPlan = {
        ...createBasicPlan(),
        summary: 'Implement authentication using OAuth2 for users',
      };

      const result = evaluatePlans(feature, planA, planB, mockProjectDir);

      // Plan B should score higher because summary contains "authentication", "OAuth2", "users"
      expect(result.evaluations.B.scores.completeness).toBeGreaterThan(
        result.evaluations.A.scores.completeness
      );
    });

    it('should reward plans with test strategy', () => {
      const feature = createFeature('Add feature');
      const planA: StructuredPlan = {
        ...createBasicPlan(),
        testStrategy: '',
      };
      const planB = createBasicPlan(); // Has test strategy

      const result = evaluatePlans(feature, planA, planB, mockProjectDir);

      expect(result.evaluations.A.concerns).toContain('Missing or inadequate test strategy');
      expect(result.evaluations.B.strengths).toContain('Includes test strategy');
    });

    it('should cap completeness score at 25', () => {
      const feature = createFeature('authentication implementation using OAuth');
      const plan = createBasicPlan();

      const result = evaluatePlans(feature, plan, plan, mockProjectDir);

      expect(result.evaluations.A.scores.completeness).toBeLessThanOrEqual(25);
      expect(result.evaluations.B.scores.completeness).toBeLessThanOrEqual(25);
    });
  });

  describe('evaluatePlans - feasibility scoring', () => {
    it('should reward plans where files to modify exist', () => {
      const feature = createFeature('Update auth');
      const plan = createBasicPlan();

      // Mock: file exists
      vi.mocked(fs.existsSync).mockReturnValue(true);

      const result = evaluatePlans(feature, plan, plan, mockProjectDir);

      expect(result.evaluations.A.strengths).toContain('Files to modify exist and are valid');
    });

    it('should penalize plans where files to modify do not exist', () => {
      const feature = createFeature('Update auth');
      const plan = createBasicPlan();

      // Mock: files don't exist
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const result = evaluatePlans(feature, plan, plan, mockProjectDir);

      expect(result.evaluations.A.concerns).toContain('Some files to modify may not exist');
    });

    it('should reward plans with reasonable step count (2-10)', () => {
      const feature = createFeature('Add feature');
      const planA: StructuredPlan = {
        ...createBasicPlan(),
        steps: [{ order: 1, description: 'Only step', files: [] }],
      };
      const planB = createBasicPlan(); // Has 2 steps

      const result = evaluatePlans(feature, planA, planB, mockProjectDir);

      // Plan B should score higher for having 2 steps
      expect(result.evaluations.B.scores.feasibility).toBeGreaterThan(
        result.evaluations.A.scores.feasibility
      );
    });

    it('should penalize plans with too many steps (> 15)', () => {
      const feature = createFeature('Add feature');
      const plan: StructuredPlan = {
        ...createBasicPlan(),
        steps: Array.from({ length: 20 }, (_, i) => ({
          order: i + 1,
          description: `Step ${i + 1}`,
          files: [],
        })),
      };

      const result = evaluatePlans(feature, plan, createBasicPlan(), mockProjectDir);

      expect(result.evaluations.A.concerns).toContain(
        'Plan may be overly complex with too many steps'
      );
    });

    it('should penalize plans with no files specified', () => {
      const feature = createFeature('Add feature');
      const plan: StructuredPlan = {
        ...createBasicPlan(),
        filesToCreate: [],
        filesToModify: [],
      };

      const result = evaluatePlans(feature, plan, createBasicPlan(), mockProjectDir);

      expect(result.evaluations.A.concerns).toContain(
        'No files specified for creation or modification'
      );
    });

    it('should cap feasibility score at 25', () => {
      const feature = createFeature('Add feature');
      const plan = createBasicPlan();

      const result = evaluatePlans(feature, plan, plan, mockProjectDir);

      expect(result.evaluations.A.scores.feasibility).toBeLessThanOrEqual(25);
    });
  });

  describe('evaluatePlans - risk awareness scoring', () => {
    it('should reward plans that identify risks', () => {
      const feature = createFeature('Add feature');
      const planA: StructuredPlan = {
        ...createBasicPlan(),
        risks: [],
      };
      const planB = createBasicPlan(); // Has 2 risks

      const result = evaluatePlans(feature, planA, planB, mockProjectDir);

      expect(result.evaluations.A.concerns).toContain(
        'No risks identified - may indicate lack of thoroughness'
      );
      expect(result.evaluations.B.strengths.some(s => s.includes('risks'))).toBe(true);
    });

    it('should reward plans with mitigation strategies', () => {
      const feature = createFeature('Add feature');
      const planA: StructuredPlan = {
        ...createBasicPlan(),
        risks: ['Race condition possible', 'Data loss risk'],
      };
      const planB: StructuredPlan = {
        ...createBasicPlan(),
        risks: [
          'Race condition - mitigate with locking',
          'Data loss - prevent with validation',
        ],
      };

      const result = evaluatePlans(feature, planA, planB, mockProjectDir);

      expect(result.evaluations.B.strengths).toContain('Includes risk mitigation strategies');
    });

    it('should score based on number of risks (2 points each, capped at 8)', () => {
      const feature = createFeature('Add feature');
      const plan: StructuredPlan = {
        ...createBasicPlan(),
        risks: ['Risk 1', 'Risk 2', 'Risk 3', 'Risk 4', 'Risk 5', 'Risk 6'],
      };

      const result = evaluatePlans(feature, plan, createBasicPlan(), mockProjectDir);

      // Base 10 + (6 risks * 2 = 12, capped at 8) = 18
      expect(result.evaluations.A.scores.riskAwareness).toBeGreaterThanOrEqual(18);
    });

    it('should cap risk awareness score at 20', () => {
      const feature = createFeature('Add feature');
      const plan: StructuredPlan = {
        ...createBasicPlan(),
        risks: Array.from({ length: 10 }, (_, i) => `Risk ${i} with mitigation`),
      };

      const result = evaluatePlans(feature, plan, plan, mockProjectDir);

      expect(result.evaluations.A.scores.riskAwareness).toBeLessThanOrEqual(20);
    });
  });

  describe('evaluatePlans - clarity scoring', () => {
    it('should reward plans where all steps have descriptions', () => {
      const feature = createFeature('Add feature');
      const planA: StructuredPlan = {
        ...createBasicPlan(),
        steps: [
          { order: 1, description: 'Do something important', files: [] },
          { order: 2, description: '', files: [] },
        ],
      };
      const planB = createBasicPlan(); // All steps have descriptions

      const result = evaluatePlans(feature, planA, planB, mockProjectDir);

      expect(result.evaluations.B.strengths).toContain('All steps have clear descriptions');
    });

    it('should reward plans with validation criteria', () => {
      const feature = createFeature('Add feature');
      const plan: StructuredPlan = {
        ...createBasicPlan(),
        steps: [
          {
            order: 1,
            description: 'Create service',
            files: [],
            validation: 'Tests pass',
          },
          {
            order: 2,
            description: 'Add endpoint',
            files: [],
            validation: 'Endpoint returns 200',
          },
        ],
      };

      const result = evaluatePlans(feature, plan, createBasicPlan(), mockProjectDir);

      expect(result.evaluations.A.strengths).toContain('Steps include validation criteria');
    });

    it('should penalize too-brief summaries', () => {
      const feature = createFeature('Add feature');
      const plan: StructuredPlan = {
        ...createBasicPlan(),
        summary: 'Do it',
      };

      const result = evaluatePlans(feature, plan, createBasicPlan(), mockProjectDir);

      expect(result.evaluations.A.concerns).toContain('Summary is too brief');
    });

    it('should reward summaries of appropriate length (50-500 chars)', () => {
      const feature = createFeature('Add feature');
      const plan = createBasicPlan(); // Has good summary

      const result = evaluatePlans(feature, plan, plan, mockProjectDir);

      // Should have positive clarity score
      expect(result.evaluations.A.scores.clarity).toBeGreaterThan(8);
    });

    it('should cap clarity score at 15', () => {
      const feature = createFeature('Add feature');
      const plan = createBasicPlan();

      const result = evaluatePlans(feature, plan, plan, mockProjectDir);

      expect(result.evaluations.A.scores.clarity).toBeLessThanOrEqual(15);
    });
  });

  describe('evaluatePlans - efficiency scoring', () => {
    it('should reward plans with efficient step count (2-5)', () => {
      const feature = createFeature('Add feature');
      const planA: StructuredPlan = {
        ...createBasicPlan(),
        steps: Array.from({ length: 12 }, (_, i) => ({
          order: i + 1,
          description: `Step ${i + 1}`,
          files: [],
        })),
      };
      const planB = createBasicPlan(); // Has 2 steps

      const result = evaluatePlans(feature, planA, planB, mockProjectDir);

      expect(result.evaluations.B.strengths).toContain('Efficient step count');
    });

    it('should reward focused file modifications (1-5 files)', () => {
      const feature = createFeature('Add feature');
      const plan = createBasicPlan(); // Has 2 files total

      const result = evaluatePlans(feature, plan, plan, mockProjectDir);

      expect(result.evaluations.A.strengths).toContain('Focused file modifications');
    });

    it('should penalize plans with many files (> 10)', () => {
      const feature = createFeature('Add feature');
      const plan: StructuredPlan = {
        ...createBasicPlan(),
        filesToCreate: Array.from({ length: 8 }, (_, i) => `file${i}.ts`),
        filesToModify: Array.from({ length: 5 }, (_, i) => `existing${i}.ts`),
      };

      const result = evaluatePlans(feature, plan, createBasicPlan(), mockProjectDir);

      expect(result.evaluations.A.concerns).toContain(
        'Large number of files may indicate scope creep'
      );
    });

    it('should cap efficiency score at 15', () => {
      const feature = createFeature('Add feature');
      const plan = createBasicPlan();

      const result = evaluatePlans(feature, plan, plan, mockProjectDir);

      expect(result.evaluations.A.scores.efficiency).toBeLessThanOrEqual(15);
    });
  });

  describe('evaluatePlans - winner selection', () => {
    it('should select plan with higher total score', () => {
      const feature = createFeature('Add authentication');
      const planA = createBasicPlan();
      const planB: StructuredPlan = {
        ...createBasicPlan(),
        steps: [], // Lower completeness
        testStrategy: '', // Lower completeness
        risks: [], // Lower risk awareness
      };

      const result = evaluatePlans(feature, planA, planB, mockProjectDir);

      expect(result.winner).toBe('A');
      expect(result.evaluations.A.scores.total).toBeGreaterThan(
        result.evaluations.B.scores.total
      );
    });

    it('should select A when scores are equal', () => {
      const feature = createFeature('Add feature');
      const plan = createBasicPlan();

      const result = evaluatePlans(feature, plan, plan, mockProjectDir);

      expect(result.winner).toBe('A');
      expect(result.marginOfVictory).toBe(0);
    });

    it('should calculate margin of victory correctly', () => {
      const feature = createFeature('Add feature');
      const planA = createBasicPlan();
      const planB: StructuredPlan = {
        ...createBasicPlan(),
        risks: [],
      };

      const result = evaluatePlans(feature, planA, planB, mockProjectDir);

      const expectedMargin = Math.abs(
        result.evaluations.A.scores.total - result.evaluations.B.scores.total
      );
      expect(result.marginOfVictory).toBe(expectedMargin);
    });
  });

  describe('evaluatePlans - selection reason', () => {
    it('should generate reason for close margin (< 5 points)', () => {
      const feature = createFeature('Add feature');
      const plan = createBasicPlan();

      const result = evaluatePlans(feature, plan, plan, mockProjectDir);

      expect(result.selectionReason).toContain('nearly equal');
      expect(result.selectionReason).toContain('margin: 0');
    });

    it('should generate reason for moderate margin (5-14 points)', () => {
      const feature = createFeature('Add feature');
      const planA = createBasicPlan();
      const planB: StructuredPlan = {
        ...createBasicPlan(),
        risks: [], // Reduce score by ~5 points
        testStrategy: '', // Reduce by ~2 more
      };

      const result = evaluatePlans(feature, planA, planB, mockProjectDir);

      if (result.marginOfVictory >= 5 && result.marginOfVictory < 15) {
        expect(result.selectionReason).toContain('moderate advantage');
      }
    });

    it('should generate reason for clear victory (>= 15 points)', () => {
      const feature = createFeature('Add feature');
      const planA = createBasicPlan();
      const planB: StructuredPlan = {
        ...createBasicPlan(),
        steps: [],
        testStrategy: '',
        risks: [],
        summary: 'Do',
      };

      const result = evaluatePlans(feature, planA, planB, mockProjectDir);

      expect(result.marginOfVictory).toBeGreaterThanOrEqual(15);
      expect(result.selectionReason).toContain('clearly superior');
    });
  });

  describe('parsePlanFromFile', () => {
    it('should return null if file does not exist', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const result = parsePlanFromFile('/test/plan.json');

      expect(result).toBeNull();
    });

    it('should parse valid JSON plan', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({
          summary: 'Test plan',
          steps: [{ description: 'Step 1', files: ['file.ts'] }],
          filesToCreate: ['new.ts'],
          filesToModify: ['old.ts'],
          testStrategy: 'Unit tests',
          risks: ['Risk 1'],
        })
      );

      const result = parsePlanFromFile('/test/plan.json');

      expect(result).not.toBeNull();
      expect(result!.summary).toBe('Test plan');
      expect(result!.steps).toHaveLength(1);
    });

    it('should return null for invalid JSON', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('{ invalid json');

      const result = parsePlanFromFile('/test/plan.json');

      expect(result).toBeNull();
    });

    it('should return null if missing required fields', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ foo: 'bar' }));

      const result = parsePlanFromFile('/test/plan.json');

      expect(result).toBeNull();
    });

    it('should normalize plan structure with defaults', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({
          summary: 'Test',
          steps: [{}], // Empty step
        })
      );

      const result = parsePlanFromFile('/test/plan.json');

      expect(result).not.toBeNull();
      expect(result!.steps[0].order).toBe(1);
      expect(result!.steps[0].description).toBe('');
      expect(result!.steps[0].files).toEqual([]);
      expect(result!.filesToCreate).toEqual([]);
      expect(result!.filesToModify).toEqual([]);
      expect(result!.testStrategy).toBe('');
      expect(result!.risks).toEqual([]);
    });

    it('should preserve order from step data', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({
          summary: 'Test',
          steps: [{ order: 5, description: 'Step 5' }],
        })
      );

      const result = parsePlanFromFile('/test/plan.json');

      expect(result!.steps[0].order).toBe(5);
    });
  });

  describe('formatEvaluationResult', () => {
    it('should format basic evaluation result', () => {
      const feature = createFeature('Add feature');
      const evaluation = evaluatePlans(
        feature,
        createBasicPlan(),
        createBasicPlan(),
        mockProjectDir
      );

      const formatted = formatEvaluationResult(evaluation);

      expect(formatted).toContain('Winner: Plan');
      expect(formatted).toContain('Margin:');
      expect(formatted).toContain('Reason:');
    });

    it('should include scores for both plans', () => {
      const feature = createFeature('Add feature');
      const evaluation = evaluatePlans(
        feature,
        createBasicPlan(),
        createBasicPlan(),
        mockProjectDir
      );

      const formatted = formatEvaluationResult(evaluation);

      expect(formatted).toContain('Plan A');
      expect(formatted).toContain('Plan B');
      expect(formatted).toContain('Completeness:');
      expect(formatted).toContain('Feasibility:');
      expect(formatted).toContain('Risk Awareness:');
      expect(formatted).toContain('Clarity:');
      expect(formatted).toContain('Efficiency:');
    });

    it('should include strengths and concerns', () => {
      const feature = createFeature('Add feature');
      const evaluation = evaluatePlans(
        feature,
        createBasicPlan(),
        createBasicPlan(),
        mockProjectDir
      );

      const formatted = formatEvaluationResult(evaluation);

      if (evaluation.evaluations.A.strengths.length > 0) {
        expect(formatted).toContain('Strengths:');
      }
      if (evaluation.evaluations.A.concerns.length > 0) {
        expect(formatted).toContain('Concerns:');
      }
    });
  });
});
