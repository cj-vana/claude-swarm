/**
 * Plan Evaluator - Compares and scores competing implementation plans
 *
 * Used in competitive planning mode to select the winning plan.
 * Two workers each create a StructuredPlan, and this module evaluates them
 * against criteria to determine which should proceed to implementation.
 *
 * Scoring Criteria (100 points total):
 * - Completeness (25): Does the plan cover all requirements?
 * - Feasibility (25): Is the plan realistic and achievable?
 * - Risk Awareness (20): Does it identify and mitigate risks?
 * - Clarity (15): Is the plan clear and well-structured?
 * - Efficiency (15): Is the approach efficient?
 */

import * as fs from "fs";
import * as path from "path";
import { Feature } from "../state/manager.js";

export interface PlanStep {
  order: number;
  description: string;
  files: string[];
  validation?: string;
}

export interface StructuredPlan {
  summary: string;
  steps: PlanStep[];
  filesToCreate: string[];
  filesToModify: string[];
  testStrategy: string;
  risks: string[];
  estimatedComplexity?: "low" | "medium" | "high";
  dependencies?: string[];
}

export interface PlanSubmission {
  workerId: string;
  submittedAt: string;
  plan: StructuredPlan;
  evaluationScore?: number;
}

export interface PlanScores {
  completeness: number; // 0-25
  feasibility: number; // 0-25
  riskAwareness: number; // 0-20
  clarity: number; // 0-15
  efficiency: number; // 0-15
  total: number; // 0-100
}

export interface PlanEvaluation {
  planId: "A" | "B";
  scores: PlanScores;
  concerns: string[];
  strengths: string[];
}

export interface EvaluationResult {
  winner: "A" | "B";
  evaluations: {
    A: PlanEvaluation;
    B: PlanEvaluation;
  };
  selectionReason: string;
  marginOfVictory: number;
}

/**
 * Evaluate a single plan against the feature requirements
 */
function evaluatePlan(
  plan: StructuredPlan,
  feature: Feature,
  projectDir: string,
  planId: "A" | "B"
): PlanEvaluation {
  const concerns: string[] = [];
  const strengths: string[] = [];

  // 1. Completeness Score (0-25)
  let completeness = 15; // Base score

  // Check if plan has meaningful steps
  if (plan.steps.length === 0) {
    completeness -= 10;
    concerns.push("No implementation steps defined");
  } else if (plan.steps.length >= 3) {
    completeness += 5;
    strengths.push("Well-structured multi-step approach");
  }

  // Check if summary addresses the feature
  const featureKeywords = feature.description
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 4);
  const summaryLower = plan.summary.toLowerCase();
  const keywordMatches = featureKeywords.filter((kw) =>
    summaryLower.includes(kw)
  );
  if (keywordMatches.length >= 2) {
    completeness += 3;
    strengths.push("Summary directly addresses feature requirements");
  }

  // Check for test strategy
  if (plan.testStrategy && plan.testStrategy.length > 20) {
    completeness += 2;
    strengths.push("Includes test strategy");
  } else {
    concerns.push("Missing or inadequate test strategy");
  }

  completeness = Math.max(0, Math.min(25, completeness));

  // 2. Feasibility Score (0-25)
  let feasibility = 15; // Base score

  // Check if mentioned files exist (sample check)
  const allFiles = [...plan.filesToCreate, ...plan.filesToModify];
  const filesWithExtensions = allFiles.filter((f) =>
    /\.(ts|js|tsx|jsx|json|md|py|rs|go|css|scss|html)$/i.test(f)
  );

  if (filesWithExtensions.length > 0) {
    // Check a sample of files to modify - they should exist
    const filesToCheck = plan.filesToModify.slice(0, 3);
    let existingCount = 0;
    for (const file of filesToCheck) {
      const fullPath = path.join(projectDir, file);
      if (fs.existsSync(fullPath)) {
        existingCount++;
      }
    }
    if (filesToCheck.length > 0 && existingCount === filesToCheck.length) {
      feasibility += 5;
      strengths.push("Files to modify exist and are valid");
    } else if (filesToCheck.length > 0 && existingCount === 0) {
      feasibility -= 5;
      concerns.push("Some files to modify may not exist");
    }
  }

  // Check for reasonable step count (not too few, not too many)
  if (plan.steps.length >= 2 && plan.steps.length <= 10) {
    feasibility += 3;
  } else if (plan.steps.length > 15) {
    feasibility -= 3;
    concerns.push("Plan may be overly complex with too many steps");
  }

  // Penalize if no files are specified
  if (allFiles.length === 0) {
    feasibility -= 8;
    concerns.push("No files specified for creation or modification");
  } else {
    feasibility += 2;
  }

  feasibility = Math.max(0, Math.min(25, feasibility));

  // 3. Risk Awareness Score (0-20)
  let riskAwareness = 10; // Base score

  if (plan.risks && plan.risks.length > 0) {
    riskAwareness += Math.min(8, plan.risks.length * 2);
    strengths.push(`Identifies ${plan.risks.length} potential risks`);

    // Check if risks mention mitigation
    const mitigationKeywords = [
      "mitigat",
      "prevent",
      "avoid",
      "handle",
      "fallback",
      "rollback",
    ];
    const hasMitigation = plan.risks.some((risk) =>
      mitigationKeywords.some((kw) => risk.toLowerCase().includes(kw))
    );
    if (hasMitigation) {
      riskAwareness += 2;
      strengths.push("Includes risk mitigation strategies");
    }
  } else {
    riskAwareness -= 5;
    concerns.push("No risks identified - may indicate lack of thoroughness");
  }

  riskAwareness = Math.max(0, Math.min(20, riskAwareness));

  // 4. Clarity Score (0-15)
  let clarity = 8; // Base score

  // Check if steps have descriptions
  const stepsWithDescriptions = plan.steps.filter(
    (s) => s.description && s.description.length > 10
  );
  if (stepsWithDescriptions.length === plan.steps.length && plan.steps.length > 0) {
    clarity += 4;
    strengths.push("All steps have clear descriptions");
  }

  // Check if steps have validation criteria
  const stepsWithValidation = plan.steps.filter(
    (s) => s.validation && s.validation.length > 0
  );
  if (stepsWithValidation.length >= plan.steps.length / 2) {
    clarity += 3;
    strengths.push("Steps include validation criteria");
  }

  // Check summary length (not too short, not too long)
  if (plan.summary.length >= 50 && plan.summary.length <= 500) {
    clarity += 2;
  } else if (plan.summary.length < 20) {
    clarity -= 3;
    concerns.push("Summary is too brief");
  }

  clarity = Math.max(0, Math.min(15, clarity));

  // 5. Efficiency Score (0-15)
  let efficiency = 10; // Base score

  // Fewer steps (when appropriate) indicates efficiency
  if (plan.steps.length >= 2 && plan.steps.length <= 5) {
    efficiency += 3;
    strengths.push("Efficient step count");
  } else if (plan.steps.length > 10) {
    efficiency -= 2;
  }

  // Fewer files to modify (when appropriate) indicates focused changes
  const totalFiles = plan.filesToCreate.length + plan.filesToModify.length;
  if (totalFiles >= 1 && totalFiles <= 5) {
    efficiency += 2;
    strengths.push("Focused file modifications");
  } else if (totalFiles > 10) {
    efficiency -= 2;
    concerns.push("Large number of files may indicate scope creep");
  }

  efficiency = Math.max(0, Math.min(15, efficiency));

  const total = completeness + feasibility + riskAwareness + clarity + efficiency;

  return {
    planId,
    scores: {
      completeness,
      feasibility,
      riskAwareness,
      clarity,
      efficiency,
      total,
    },
    concerns,
    strengths,
  };
}

/**
 * Compare two plans and select a winner
 */
export function evaluatePlans(
  feature: Feature,
  planA: StructuredPlan,
  planB: StructuredPlan,
  projectDir: string
): EvaluationResult {
  const evalA = evaluatePlan(planA, feature, projectDir, "A");
  const evalB = evaluatePlan(planB, feature, projectDir, "B");

  const winner: "A" | "B" = evalA.scores.total >= evalB.scores.total ? "A" : "B";
  const marginOfVictory = Math.abs(evalA.scores.total - evalB.scores.total);

  // Generate selection reason
  let selectionReason: string;
  if (marginOfVictory < 5) {
    selectionReason = `Plans are nearly equal (margin: ${marginOfVictory}). Plan ${winner} selected based on slight advantages.`;
  } else if (marginOfVictory < 15) {
    const winnerEval = winner === "A" ? evalA : evalB;
    const topStrength = winnerEval.strengths[0] || "overall quality";
    selectionReason = `Plan ${winner} selected with moderate advantage (margin: ${marginOfVictory}). Key strength: ${topStrength}`;
  } else {
    const winnerEval = winner === "A" ? evalA : evalB;
    selectionReason = `Plan ${winner} clearly superior (margin: ${marginOfVictory}). Strengths: ${winnerEval.strengths.slice(0, 2).join(", ")}`;
  }

  return {
    winner,
    evaluations: {
      A: evalA,
      B: evalB,
    },
    selectionReason,
    marginOfVictory,
  };
}

/**
 * Parse a plan from a JSON file
 */
export function parsePlanFromFile(filePath: string): StructuredPlan | null {
  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }

    const content = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(content);

    // Validate required fields
    if (!parsed.summary || !Array.isArray(parsed.steps)) {
      return null;
    }

    // Normalize the plan structure
    return {
      summary: parsed.summary || "",
      steps: (parsed.steps || []).map(
        (step: Partial<PlanStep>, index: number) => ({
          order: step.order ?? index + 1,
          description: step.description || "",
          files: step.files || [],
          validation: step.validation,
        })
      ),
      filesToCreate: parsed.filesToCreate || [],
      filesToModify: parsed.filesToModify || [],
      testStrategy: parsed.testStrategy || "",
      risks: parsed.risks || [],
      estimatedComplexity: parsed.estimatedComplexity,
      dependencies: parsed.dependencies,
    };
  } catch {
    return null;
  }
}

/**
 * Format evaluation result for display
 */
export function formatEvaluationResult(result: EvaluationResult): string {
  const lines: string[] = [];

  lines.push(`Winner: Plan ${result.winner}`);
  lines.push(`Margin: ${result.marginOfVictory} points`);
  lines.push(`Reason: ${result.selectionReason}`);
  lines.push("");

  for (const planId of ["A", "B"] as const) {
    const evaluation = result.evaluations[planId];
    lines.push(`--- Plan ${planId} (${evaluation.scores.total}/100) ---`);
    lines.push(
      `  Completeness: ${evaluation.scores.completeness}/25`
    );
    lines.push(`  Feasibility: ${evaluation.scores.feasibility}/25`);
    lines.push(`  Risk Awareness: ${evaluation.scores.riskAwareness}/20`);
    lines.push(`  Clarity: ${evaluation.scores.clarity}/15`);
    lines.push(`  Efficiency: ${evaluation.scores.efficiency}/15`);

    if (evaluation.strengths.length > 0) {
      lines.push(`  Strengths: ${evaluation.strengths.join("; ")}`);
    }
    if (evaluation.concerns.length > 0) {
      lines.push(`  Concerns: ${evaluation.concerns.join("; ")}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}
