/**
 * Review Manager - Orchestrates post-completion code and architecture reviews
 *
 * Key responsibilities:
 * - Build review prompts with appropriate context
 * - Delegate file tracking to WorkerManager (git-based with log parsing fallback)
 * - Start and monitor review workers
 * - Aggregate review findings into the progress log
 *
 * Security:
 * - Review workers have read-only access + Write for findings file
 * - Prompts are passed via files, not shell strings
 */

import {
  Feature,
  OrchestratorState,
  ReviewWorker,
  ReviewFindings,
  ReviewConfig,
  AggregatedReview,
} from "../state/manager.js";
import { WorkerManager } from "./manager.js";
import { sanitizeOutput } from "../utils/security.js";

/**
 * Context gathered for review workers
 */
export interface ReviewContext {
  modifiedFiles: string[];
  allFeatures: Feature[];
  taskDescription: string;
  sessionStartTime: string;
  projectDir: string;
}

/**
 * Default review configuration
 */
export const DEFAULT_REVIEW_CONFIG: ReviewConfig = {
  enabled: true,
  skipOnFailure: false,
  codeReviewEnabled: true,
  architectureReviewEnabled: true,
  autoTrigger: true, // Automatically start reviews when all features complete
};

/**
 * Severity ordering for comparison (lowest to highest)
 */
export const REVIEW_SEVERITY_ORDER = [
  "clean",
  "minor",
  "moderate",
  "major",
  "critical",
] as const;

export type ReviewSeverity = (typeof REVIEW_SEVERITY_ORDER)[number];

export class ReviewManager {
  private projectDir: string;

  constructor(projectDir: string) {
    this.projectDir = projectDir;
  }

  /**
   * Build the code review prompt
   */
  buildCodeReviewPrompt(context: ReviewContext): string {
    const fileList =
      context.modifiedFiles.length > 0
        ? context.modifiedFiles.map((f) => `- ${f}`).join("\n")
        : "Review all recently modified files using git diff or file timestamps.";

    const featureList = context.allFeatures
      .map((f) => `- ${f.id}: ${f.description} (${f.status})`)
      .join("\n");

    return `You are a code review worker. Your task is to review the code changes made during this orchestration session.

## Session Context
Task: ${sanitizeOutput(context.taskDescription, 1000)}
Session started: ${context.sessionStartTime}
Features implemented: ${context.allFeatures.length}

${featureList}

## Files to Review
${fileList}

## Review Focus Areas
1. **Code Quality**: Naming, readability, maintainability
2. **Bug Detection**: Logic errors, edge cases, null checks
3. **Security**: Input validation, injection vulnerabilities
4. **Test Coverage**: Missing tests, untested edge cases
5. **Code Patterns**: Consistency with existing patterns
6. **Performance**: Obvious inefficiencies, N+1 queries

## Instructions
1. Use Read, Glob, and Grep to examine the codebase
2. Focus on files modified during this session
3. Look for patterns of issues, not just individual problems
4. Provide actionable suggestions

## Output Format
Create a file at: .claude/orchestrator/workers/code-review.findings.json

The JSON must follow this structure:
{
  "summary": "One paragraph overview of code quality",
  "severity": "clean" | "minor" | "moderate" | "major" | "critical",
  "issues": [
    {
      "category": "bug" | "security" | "style" | "performance" | "test-coverage" | "maintainability",
      "severity": "info" | "warning" | "error",
      "file": "path/to/file.ts",
      "line": 42,
      "message": "Description of the issue",
      "suggestion": "How to fix it"
    }
  ],
  "recommendations": ["High-level recommendation 1", "..."]
}

Begin your review now. Write the findings JSON file when complete.`;
  }

  /**
   * Build the architecture review prompt
   */
  buildArchitectureReviewPrompt(context: ReviewContext): string {
    const fileList =
      context.modifiedFiles.length > 0
        ? context.modifiedFiles.map((f) => `- ${f}`).join("\n")
        : "Analyze architectural changes using git diff and project structure.";

    const featureList = context.allFeatures
      .map((f) => `- ${f.id}: ${f.description} (${f.status})`)
      .join("\n");

    return `You are an architecture review worker. Your task is to review the architectural decisions and design patterns in the code changes made during this orchestration session.

## Session Context
Task: ${sanitizeOutput(context.taskDescription, 1000)}
Session started: ${context.sessionStartTime}
Features implemented: ${context.allFeatures.length}

${featureList}

## Files Modified
${fileList}

## Review Focus Areas
1. **Design Patterns**: Appropriate use of patterns, anti-patterns
2. **Coupling**: Dependencies between modules, tight coupling issues
3. **Separation of Concerns**: Single responsibility, clear boundaries
4. **Scalability**: Design decisions that may impact scale
5. **Maintainability**: Complexity, technical debt introduced
6. **Consistency**: Alignment with existing architecture

## Instructions
1. Explore the codebase structure and patterns
2. Understand the existing architecture (check CLAUDE.md, README)
3. Evaluate how new code fits into the architecture
4. Identify any architectural drift or violations

## Output Format
Create a file at: .claude/orchestrator/workers/architecture-review.findings.json

The JSON must follow this structure:
{
  "summary": "One paragraph overview of architectural quality",
  "severity": "clean" | "minor" | "moderate" | "major" | "critical",
  "issues": [
    {
      "category": "coupling" | "abstraction" | "pattern" | "scalability" | "consistency" | "complexity",
      "severity": "info" | "warning" | "error",
      "file": "path/to/file.ts (optional)",
      "message": "Description of the architectural issue",
      "suggestion": "Recommended architectural change"
    }
  ],
  "recommendations": ["High-level architectural recommendation 1", "..."]
}

Begin your architectural review now. Write the findings JSON file when complete.`;
  }

  /**
   * Start review workers based on configuration.
   * Delegates file tracking to WorkerManager for unified git-based tracking.
   *
   * @param state - Current orchestrator state
   * @param workers - Worker manager for starting review workers and getting modified files
   * @param config - Review configuration
   * @returns Array of started review workers
   */
  async startReviews(
    state: OrchestratorState,
    workers: WorkerManager,
    config: ReviewConfig = DEFAULT_REVIEW_CONFIG
  ): Promise<ReviewWorker[]> {
    // Delegate file tracking to WorkerManager for unified git-based tracking
    const context: ReviewContext = {
      modifiedFiles: await workers.getAllModifiedFiles(),
      allFeatures: state.features,
      taskDescription: state.taskDescription,
      sessionStartTime: state.startTime,
      projectDir: this.projectDir,
    };

    const reviewWorkers: ReviewWorker[] = [];
    const errors: string[] = [];

    // Start code review worker if enabled
    if (config.codeReviewEnabled) {
      const codePrompt = this.buildCodeReviewPrompt(context);
      const result = await workers.startReviewWorker("code", codePrompt);

      if (result.success && result.sessionName) {
        reviewWorkers.push({
          type: "code",
          workerId: result.sessionName,
          sessionName: result.sessionName,
          status: "running",
          startedAt: new Date().toISOString(),
        });
      } else {
        const errorMsg = `Failed to start code review worker: ${result.error || "Unknown error"}`;
        console.error(errorMsg);
        errors.push(errorMsg);
      }
    }

    // Start architecture review worker if enabled
    if (config.architectureReviewEnabled) {
      const archPrompt = this.buildArchitectureReviewPrompt(context);
      const result = await workers.startReviewWorker("architecture", archPrompt);

      if (result.success && result.sessionName) {
        reviewWorkers.push({
          type: "architecture",
          workerId: result.sessionName,
          sessionName: result.sessionName,
          status: "running",
          startedAt: new Date().toISOString(),
        });
      } else {
        const errorMsg = `Failed to start architecture review worker: ${result.error || "Unknown error"}`;
        console.error(errorMsg);
        errors.push(errorMsg);
      }
    }

    // Log any errors that occurred
    if (errors.length > 0) {
      console.error(`Review startup errors: ${errors.join("; ")}`);
    }

    return reviewWorkers;
  }

  /**
   * Check the status of review workers and update findings
   */
  async checkReviewStatus(
    reviewWorkers: ReviewWorker[],
    workers: WorkerManager
  ): Promise<{ allDone: boolean; reviewWorkers: ReviewWorker[] }> {
    let allDone = true;

    for (const reviewer of reviewWorkers) {
      if (reviewer.status === "running") {
        const result = await workers.checkReviewWorker(reviewer.type);

        if (result.status === "completed" || result.status === "crashed") {
          reviewer.status = result.status === "completed" ? "completed" : "failed";
          reviewer.completedAt = new Date().toISOString();

          // Try to read findings file
          if (result.status === "completed") {
            const findings = workers.readReviewFindings(reviewer.type);
            reviewer.findings = findings ?? undefined;
          }
        } else {
          allDone = false;
        }
      }
    }

    return { allDone, reviewWorkers };
  }

  /**
   * Aggregate review findings into a summary
   */
  aggregateReviews(reviewWorkers: ReviewWorker[]): AggregatedReview {
    const codeReview = reviewWorkers.find((r) => r.type === "code");
    const archReview = reviewWorkers.find((r) => r.type === "architecture");

    const overallAssessment = this.generateOverallAssessment(
      codeReview?.findings,
      archReview?.findings
    );

    return {
      completedAt: new Date().toISOString(),
      codeReview: codeReview?.findings,
      architectureReview: archReview?.findings,
      overallAssessment,
    };
  }

  /**
   * Generate overall assessment from review findings
   */
  private generateOverallAssessment(
    code?: ReviewFindings,
    arch?: ReviewFindings
  ): string {
    const severities = [code?.severity, arch?.severity].filter(Boolean) as string[];

    if (severities.length === 0) {
      return "Reviews did not produce findings.";
    }

    // Use shared severity ordering constant
    const worst = severities.reduce((a, b) =>
      REVIEW_SEVERITY_ORDER.indexOf(a as ReviewSeverity) >
      REVIEW_SEVERITY_ORDER.indexOf(b as ReviewSeverity)
        ? a
        : b
    );

    // Safely handle issues arrays with explicit array validation
    const codeIssues = Array.isArray(code?.issues) ? code.issues : [];
    const archIssues = Array.isArray(arch?.issues) ? arch.issues : [];

    const totalIssues = codeIssues.length + archIssues.length;

    const errorCount =
      codeIssues.filter((i) => i.severity === "error").length +
      archIssues.filter((i) => i.severity === "error").length;

    const warningCount =
      codeIssues.filter((i) => i.severity === "warning").length +
      archIssues.filter((i) => i.severity === "warning").length;

    let assessment = `Overall assessment: ${worst}. Found ${totalIssues} issue(s)`;

    if (errorCount > 0 || warningCount > 0) {
      const parts: string[] = [];
      if (errorCount > 0) parts.push(`${errorCount} error(s)`);
      if (warningCount > 0) parts.push(`${warningCount} warning(s)`);
      assessment += ` (${parts.join(", ")})`;
    }

    assessment += " across code quality and architecture reviews.";

    return assessment;
  }

  /**
   * Format review findings for progress log
   */
  formatReviewsForLog(aggregatedReview: AggregatedReview): string[] {
    const logs: string[] = [];
    const timestamp = new Date().toISOString();

    if (aggregatedReview.codeReview) {
      const cr = aggregatedReview.codeReview;
      logs.push(
        `[${timestamp}] Code Review: ${cr.severity} - ${cr.issues.length} issue(s)`
      );
      if (cr.summary) {
        logs.push(`[${timestamp}]   Summary: ${sanitizeOutput(cr.summary, 200)}`);
      }
    }

    if (aggregatedReview.architectureReview) {
      const ar = aggregatedReview.architectureReview;
      logs.push(
        `[${timestamp}] Architecture Review: ${ar.severity} - ${ar.issues.length} issue(s)`
      );
      if (ar.summary) {
        logs.push(`[${timestamp}]   Summary: ${sanitizeOutput(ar.summary, 200)}`);
      }
    }

    logs.push(`[${timestamp}] ${aggregatedReview.overallAssessment}`);

    return logs;
  }
}
