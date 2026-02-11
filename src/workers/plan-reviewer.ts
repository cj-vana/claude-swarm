/**
 * Plan Reviewer - Auto-approval engine for worker-produced plans
 *
 * Evaluates plans produced by plan-phase workers against configurable
 * approval criteria. Orchestrator auto-approves plans that meet the
 * threshold (no human in the loop).
 *
 * Scoring algorithm:
 * - Has test strategy: +25
 * - Has risk assessment: +20
 * - Lists specific files: +20
 * - Reasonable step count (3-20): +15
 * - References existing patterns/utils: +10
 * - Has clear success criteria: +10
 * - Penalty: no steps (-50), no files (-30), vague descriptions (-20)
 * - Threshold: score >= 50 = approved
 */

import type { Feature } from "../state/manager.js";
import type { VerificationSummary } from "./verification-runner.js";

/**
 * WorkerPlan - Structured plan output from a plan-phase worker
 */
export interface WorkerPlan {
  featureId: string;
  summary: string;
  steps: Array<{
    description: string;
    files: string[];
    action: string;
  }>;
  risksIdentified: string[];
  testStrategy: string;
  estimatedComplexity: "low" | "medium" | "high";
}

/**
 * ApprovalCriteria - Configurable criteria for auto-approving plans
 */
export interface ApprovalCriteria {
  requireTestStrategy: boolean;      // default: true
  requireRiskAssessment: boolean;    // default: true
  maxSteps: number;                  // default: 20
  requireFileList: boolean;          // default: true
  customRules?: string[];            // e.g. "reject plans that modify the database schema"
}

/**
 * PlanReview - Result of auto-reviewing a worker plan
 */
export interface PlanReview {
  approved: boolean;
  score: number;           // 0-100
  feedback: string;        // Why approved/rejected
  suggestions: string[];   // Improvements for re-planning
}

/**
 * QualityScore - Post-completion quality assessment
 */
export interface QualityScore {
  score: number;
  breakdown: Record<string, number>;
  grade: "A" | "B" | "C" | "D" | "F";
}

/**
 * Default approval criteria
 */
export const DEFAULT_APPROVAL_CRITERIA: ApprovalCriteria = {
  requireTestStrategy: true,
  requireRiskAssessment: true,
  maxSteps: 20,
  requireFileList: true,
};

/**
 * Default approval threshold
 */
const DEFAULT_THRESHOLD = 50;

/**
 * PlanReviewer - Auto-approval engine for worker plans
 */
export class PlanReviewer {
  /**
   * Review a worker-produced plan and decide whether to approve it
   */
  reviewPlan(
    plan: WorkerPlan,
    feature: Feature,
    criteria: ApprovalCriteria = DEFAULT_APPROVAL_CRITERIA,
    threshold: number = DEFAULT_THRESHOLD
  ): PlanReview {
    let score = 0;
    const suggestions: string[] = [];
    const reasons: string[] = [];

    // Check test strategy (+25)
    if (plan.testStrategy && plan.testStrategy.trim().length > 10) {
      score += 25;
      reasons.push("Has test strategy (+25)");
    } else {
      if (criteria.requireTestStrategy) {
        suggestions.push("Add a detailed test strategy describing how to verify the implementation");
      }
      reasons.push("Missing or vague test strategy (+0)");
    }

    // Check risk assessment (+20)
    if (plan.risksIdentified && plan.risksIdentified.length > 0) {
      score += 20;
      reasons.push(`Has risk assessment (${plan.risksIdentified.length} risks identified) (+20)`);
    } else {
      if (criteria.requireRiskAssessment) {
        suggestions.push("Identify potential risks and mitigation strategies");
      }
      reasons.push("No risks identified (+0)");
    }

    // Check file list (+20)
    const allFiles = new Set<string>();
    for (const step of plan.steps) {
      for (const file of step.files) {
        allFiles.add(file);
      }
    }
    if (allFiles.size > 0) {
      score += 20;
      reasons.push(`Lists ${allFiles.size} specific files (+20)`);
    } else {
      if (criteria.requireFileList) {
        suggestions.push("List specific files that will be created or modified in each step");
      }
      reasons.push("No files listed (-0)");
    }

    // Check step count (+15 for reasonable, penalties for extremes)
    if (plan.steps.length === 0) {
      score -= 50;
      suggestions.push("Plan must include implementation steps");
      reasons.push("No steps defined (-50)");
    } else if (plan.steps.length >= 3 && plan.steps.length <= criteria.maxSteps) {
      score += 15;
      reasons.push(`Reasonable step count: ${plan.steps.length} (+15)`);
    } else if (plan.steps.length < 3) {
      score += 5;
      suggestions.push("Consider breaking the plan into more detailed steps (at least 3)");
      reasons.push(`Few steps: ${plan.steps.length} (+5)`);
    } else {
      score += 5;
      suggestions.push(`Plan has ${plan.steps.length} steps, exceeding max of ${criteria.maxSteps}. Consider consolidating.`);
      reasons.push(`Too many steps: ${plan.steps.length} (+5)`);
    }

    // Check for references to existing patterns/utils (+10)
    const patternKeywords = [
      "existing", "pattern", "convention", "reuse", "similar to",
      "following", "consistent", "utils", "helper", "module",
    ];
    const summaryLower = (plan.summary + " " + plan.steps.map(s => s.description).join(" ")).toLowerCase();
    const referencesPatterns = patternKeywords.some(kw => summaryLower.includes(kw));
    if (referencesPatterns) {
      score += 10;
      reasons.push("References existing patterns/utilities (+10)");
    } else {
      suggestions.push("Consider referencing existing patterns and utilities in the codebase");
      reasons.push("No references to existing patterns (+0)");
    }

    // Check for clear success criteria (+10)
    const successKeywords = [
      "success", "criteria", "verify", "validation", "test",
      "pass", "complete", "done when", "acceptance",
    ];
    const hasSuccessCriteria = successKeywords.some(kw => summaryLower.includes(kw));
    if (hasSuccessCriteria) {
      score += 10;
      reasons.push("Has clear success criteria (+10)");
    } else {
      suggestions.push("Add clear success criteria to the plan summary");
      reasons.push("No clear success criteria (+0)");
    }

    // Penalty: vague descriptions (-20)
    const vaguePatterns = [
      /\bsomehow\b/i, /\bmaybe\b/i, /\bpossibly\b/i,
      /\btry to\b/i, /\bmight\b/i, /\bnot sure\b/i,
    ];
    const hasVague = plan.steps.some(step =>
      vaguePatterns.some(p => p.test(step.description))
    );
    if (hasVague) {
      score -= 20;
      suggestions.push("Remove vague language from step descriptions. Be specific about what will be done.");
      reasons.push("Contains vague descriptions (-20)");
    }

    // Penalty: no files at all (-30)
    if (allFiles.size === 0 && plan.steps.length > 0) {
      score -= 30;
      reasons.push("Steps exist but no files listed (-30)");
    }

    // Clamp score to 0-100
    score = Math.max(0, Math.min(100, score));

    const approved = score >= threshold;
    const feedback = approved
      ? `Plan approved (score: ${score}/${threshold} threshold). ${reasons.join("; ")}`
      : `Plan rejected (score: ${score}/${threshold} threshold). ${reasons.join("; ")}`;

    return {
      approved,
      score,
      feedback,
      suggestions: approved ? [] : suggestions,
    };
  }

  /**
   * Parse a worker plan from a JSON file content
   * Returns null if the content is not valid JSON or doesn't match the expected format
   */
  parsePlan(content: string, featureId: string): WorkerPlan | null {
    try {
      const parsed = JSON.parse(content);

      // Map from the plan file format to WorkerPlan
      const plan: WorkerPlan = {
        featureId,
        summary: parsed.summary || "",
        steps: [],
        risksIdentified: parsed.risks || parsed.risksIdentified || [],
        testStrategy: parsed.testStrategy || "",
        estimatedComplexity: parsed.estimatedComplexity || "medium",
      };

      // Parse steps from the plan file format
      if (Array.isArray(parsed.steps)) {
        plan.steps = parsed.steps.map((step: any) => ({
          description: step.description || "",
          files: [
            ...(step.files || []),
            ...(step.filesToCreate || []),
            ...(step.filesToModify || []),
          ],
          action: step.validation || step.action || "",
        }));
      }

      // Also pull in top-level file lists if present
      if (parsed.filesToCreate || parsed.filesToModify) {
        const topLevelFiles = [
          ...(parsed.filesToCreate || []),
          ...(parsed.filesToModify || []),
        ];
        // Add to first step or create a step if none exist
        if (plan.steps.length > 0) {
          for (const file of topLevelFiles) {
            if (!plan.steps[0].files.includes(file)) {
              plan.steps[0].files.push(file);
            }
          }
        }
      }

      return plan;
    } catch {
      return null;
    }
  }

  /**
   * Assess quality of a completed feature
   */
  assessQuality(
    feature: Feature,
    verificationPassed: boolean,
    planUsed: boolean,
    iterationCount: number,
    planStepCount?: number
  ): QualityScore {
    const breakdown: Record<string, number> = {};
    let score = 0;

    // All verification passed: +40
    if (verificationPassed) {
      breakdown["verification_passed"] = 40;
      score += 40;
    } else {
      breakdown["verification_passed"] = 0;
    }

    // Completed within plan steps: +20
    if (planUsed && planStepCount) {
      breakdown["followed_plan"] = 20;
      score += 20;
    } else if (!planUsed) {
      // No plan used - neutral
      breakdown["followed_plan"] = 10;
      score += 10;
    } else {
      breakdown["followed_plan"] = 0;
    }

    // No re-plans needed: +15
    const planAttempts = feature.planAttempts || 0;
    if (planAttempts <= 1) {
      breakdown["no_replans"] = 15;
      score += 15;
    } else {
      breakdown["no_replans"] = Math.max(0, 15 - (planAttempts - 1) * 5);
      score += breakdown["no_replans"];
    }

    // Low iteration count: +10
    if (iterationCount <= 3) {
      breakdown["low_iterations"] = 10;
      score += 10;
    } else if (iterationCount <= 10) {
      breakdown["low_iterations"] = 5;
      score += 5;
    } else {
      breakdown["low_iterations"] = 0;
    }

    // Feature completed successfully: +15
    if (feature.status === "completed") {
      breakdown["completed"] = 15;
      score += 15;
    } else {
      breakdown["completed"] = 0;
    }

    score = Math.max(0, Math.min(100, score));

    let grade: QualityScore["grade"];
    if (score >= 90) grade = "A";
    else if (score >= 75) grade = "B";
    else if (score >= 60) grade = "C";
    else if (score >= 40) grade = "D";
    else grade = "F";

    return { score, breakdown, grade };
  }
}
