/**
 * Structured prompt templates with validation criteria
 *
 * Creates worker prompts that include:
 * - Clear success criteria with metrics
 * - Validation commands
 * - Current vs target status
 * - Guidance from previous failures
 */

import { Feature, ValidationConfig } from "../state/manager.js";

export interface PromptCriterion {
  name: string;
  description: string;
  metric: string; // "coverage", "tests", "files"
  operator: string; // ">=", "==", "in"
  target: number | string | string[];
  current?: number | string | string[];
  passed: boolean;
}

export interface PromptData {
  task: string;
  successCriteria: PromptCriterion[];
  validationCommand: string;
  currentAttempt: number;
  maxAttempts: number;
  guidance?: string;
  previousError?: string;
}

/**
 * Generate success criteria from validation config
 */
export function generateSuccessCriteria(
  feature: Feature
): PromptCriterion[] {
  const criteria: PromptCriterion[] = [];

  if (!feature.validation || !feature.validation.enabled) {
    return criteria;
  }

  const config = feature.validation;

  // Coverage criterion
  if (config.coverageTarget !== undefined && config.coverageTarget > 0) {
    const currentCoverage = feature.validationResult?.checks.find(
      (c) => c.name === "coverage"
    )?.actual;

    criteria.push({
      name: "Test Coverage",
      description: `Achieve ${config.coverageTarget}% test coverage for modified code`,
      metric: "coverage",
      operator: ">=",
      target: config.coverageTarget,
      current: currentCoverage,
      passed: currentCoverage !== undefined
        ? currentCoverage >= config.coverageTarget
        : false,
    });
  }

  // Test pass criterion
  if (config.testPassRequired) {
    const testsPassed = feature.validationResult?.checks.find(
      (c) => c.name === "tests"
    )?.passed;

    criteria.push({
      name: "Tests Pass",
      description: "All tests must pass without errors",
      metric: "tests",
      operator: "==",
      target: "PASS",
      current: testsPassed ? "PASS" : "FAIL",
      passed: testsPassed ?? false,
    });
  }

  // Package verification criterion
  if (
    config.expectedPackages &&
    config.expectedPackages.length > 0
  ) {
    const gitCheck = feature.validationResult?.checks.find(
      (c) => c.name === "git-packages"
    );

    criteria.push({
      name: "Modified Packages",
      description: `Changes must be in expected packages: ${config.expectedPackages.join(", ")}`,
      metric: "files",
      operator: "in",
      target: config.expectedPackages,
      current: feature.gitVerification?.filesChanged,
      passed: gitCheck?.passed ?? false,
    });
  }

  return criteria;
}

/**
 * Generate validation command from config
 */
export function generateValidationCommand(
  feature: Feature
): string {
  if (!feature.validation) {
    return "# No validation configured";
  }

  const config = feature.validation;

  if (config.verifyCommand) {
    return config.verifyCommand;
  }

  // Generate default command
  const parts: string[] = [];

  if (config.coverageTarget !== undefined && config.coverageTarget > 0) {
    if (config.expectedPackages && config.expectedPackages.length > 0) {
      parts.push(
        `go test -cover ${config.expectedPackages.join(" ")}`
      );
    } else {
      parts.push("go test -cover ./...");
    }
  }

  if (config.testPassRequired && parts.length === 0) {
    if (config.expectedPackages && config.expectedPackages.length > 0) {
      parts.push(`go test ${config.expectedPackages.join(" ")}`);
    } else {
      parts.push("go test ./...");
    }
  }

  return parts.join(" && ") || "# No validation command needed";
}

/**
 * Build structured prompt with validation context
 */
export function buildStructuredPrompt(
  feature: Feature,
  customContext?: string
): string {
  const criteria = generateSuccessCriteria(feature);
  const validationCmd = generateValidationCommand(feature);

  const parts: string[] = [];

  // Header
  parts.push("# Your Task");
  parts.push("");
  parts.push(feature.description);
  parts.push("");

  // Custom context
  if (customContext) {
    parts.push("## Additional Context");
    parts.push("");
    parts.push(customContext);
    parts.push("");
  }

  // Success criteria
  if (criteria.length > 0) {
    parts.push("## Success Criteria (MUST achieve ALL)");
    parts.push("");

    for (const criterion of criteria) {
      const checkbox = criterion.passed ? "[x]" : "[ ]";
      parts.push(`${checkbox} **${criterion.name}**: ${criterion.description}`);

      // Show requirement
      const targetStr = Array.isArray(criterion.target)
        ? criterion.target.join(", ")
        : criterion.target;
      parts.push(`   - Required: ${criterion.metric} ${criterion.operator} ${targetStr}`);

      // Show current status
      if (criterion.current !== undefined) {
        const currentStr = Array.isArray(criterion.current)
          ? criterion.current.slice(0, 3).join(", ") +
            (criterion.current.length > 3 ? "..." : "")
          : criterion.current;
        const status = criterion.passed ? "✅ MET" : "⚠️ NOT MET";
        parts.push(`   - Current: ${currentStr} ${status}`);
      }

      parts.push("");
    }
  }

  // Validation command
  if (validationCmd !== "# No validation command needed") {
    parts.push("## Validation Command");
    parts.push("");
    parts.push("After implementing changes, run this command to verify:");
    parts.push("");
    parts.push("```bash");
    parts.push(validationCmd);
    parts.push("```");
    parts.push("");
    parts.push(
      "⚠️ The orchestrator will run this automatically when you complete. If validation fails, you'll be asked to retry with guidance."
    );
    parts.push("");
  }

  // Retry guidance
  if (feature.attempts > 0) {
    parts.push("## Retry Guidance");
    parts.push("");
    parts.push(
      `This is attempt ${feature.attempts + 1}/${feature.maxRetries || 3}.`
    );

    if (feature.lastError) {
      parts.push("");
      parts.push("**Previous failure reason:**");
      parts.push("");
      parts.push("```");
      parts.push(feature.lastError);
      parts.push("```");
      parts.push("");
      parts.push("Address this issue in your implementation.");
    }

    parts.push("");
  }

  // Implementation guidance
  parts.push("## Implementation Guidelines");
  parts.push("");
  parts.push("1. Read existing code before modifying");
  parts.push("2. Make targeted changes to meet success criteria");
  parts.push("3. Run validation command to verify");
  parts.push("4. Only mark complete when all criteria are met");
  parts.push("");

  // Expected packages context
  if (
    feature.validation?.expectedPackages &&
    feature.validation.expectedPackages.length > 0
  ) {
    parts.push("## Target Packages");
    parts.push("");
    parts.push("Focus your changes on these packages:");
    parts.push("");
    for (const pkg of feature.validation.expectedPackages) {
      parts.push(`- ${pkg}`);
    }
    parts.push("");
  }

  return parts.join("\n");
}

/**
 * Build retry prompt with failure analysis
 */
export function buildRetryPrompt(
  feature: Feature,
  validationFailures: string[]
): string {
  const parts: string[] = [];

  parts.push("# Retry Required - Validation Failed");
  parts.push("");
  parts.push(`Attempt ${feature.attempts}/${feature.maxRetries || 3} did not meet success criteria.`);
  parts.push("");

  parts.push("## Validation Failures");
  parts.push("");
  for (const failure of validationFailures) {
    parts.push(`❌ ${failure}`);
  }
  parts.push("");

  parts.push("## What to Fix");
  parts.push("");

  const criteria = generateSuccessCriteria(feature);
  const failedCriteria = criteria.filter((c) => !c.passed);

  for (const criterion of failedCriteria) {
    parts.push(`**${criterion.name}**`);

    const targetStr = Array.isArray(criterion.target)
      ? criterion.target.join(", ")
      : criterion.target;
    const currentStr = criterion.current
      ? Array.isArray(criterion.current)
        ? criterion.current.slice(0, 3).join(", ")
        : criterion.current
      : "N/A";

    parts.push(`- Target: ${criterion.metric} ${criterion.operator} ${targetStr}`);
    parts.push(`- Current: ${currentStr}`);
    parts.push(`- Gap: ${criterion.description}`);
    parts.push("");
  }

  const validationCmd = generateValidationCommand(feature);
  if (validationCmd !== "# No validation command needed") {
    parts.push("## Verify Your Fix");
    parts.push("");
    parts.push("```bash");
    parts.push(validationCmd);
    parts.push("```");
    parts.push("");
  }

  return parts.join("\n");
}
