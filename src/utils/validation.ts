/**
 * Validation utilities for feature completion verification
 *
 * Implements blocking validation to prevent false completions:
 * - Coverage measurement via `go test -cover`
 * - Test execution verification
 * - Enforcement of validation rules
 */

import { execSync } from "child_process";
import * as path from "path";
import {
  Feature,
  ValidationConfig,
  ValidationResult,
  ValidationCheck,
} from "../state/manager.js";
import { verifyExpectedPackages } from "./git-verification.js";

/**
 * Validate a feature's completion criteria
 * Returns ValidationResult with passed=false if validation fails
 */
export async function validateFeature(
  feature: Feature,
  projectDir: string
): Promise<ValidationResult> {
  const checks: ValidationCheck[] = [];
  let overallPassed = true;
  let errorMessage: string | undefined;

  // Skip validation if not enabled
  if (!feature.validation?.enabled) {
    return {
      passed: true,
      checks: [],
      timestamp: new Date().toISOString(),
    };
  }

  const config = feature.validation;

  // Check 1: Coverage target
  if (config.coverageTarget !== undefined && config.coverageTarget > 0) {
    const coverageCheck = await measureCoverage(
      projectDir,
      config.verifyCommand,
      config.expectedPackages,
      config.coverageTarget
    );
    checks.push(coverageCheck);

    if (!coverageCheck.passed && config.enforceBlocking) {
      overallPassed = false;
      errorMessage = coverageCheck.details || "Coverage below target";
    }
  }

  // Check 2: Tests must pass
  if (config.testPassRequired) {
    const testCheck = await runTests(
      projectDir,
      config.verifyCommand,
      config.expectedPackages
    );
    checks.push(testCheck);

    if (!testCheck.passed && config.enforceBlocking) {
      overallPassed = false;
      errorMessage = testCheck.details || "Tests failed";
    }
  }

  // Check 3: Git verification - verify changes match expected packages
  if (
    feature.gitVerification &&
    config.expectedPackages &&
    config.expectedPackages.length > 0
  ) {
    const gitCheck = verifyExpectedPackages(
      feature.gitVerification,
      config.expectedPackages
    );

    checks.push({
      name: "git-packages",
      passed: gitCheck.matched,
      details: gitCheck.details,
    });

    if (!gitCheck.matched && config.enforceBlocking) {
      overallPassed = false;
      errorMessage = gitCheck.details;
    }
  }

  return {
    passed: overallPassed,
    checks,
    error: errorMessage,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Measure test coverage for specified packages
 */
async function measureCoverage(
  projectDir: string,
  verifyCommand: string | undefined,
  expectedPackages: string[] | undefined,
  targetCoverage: number
): Promise<ValidationCheck> {
  try {
    // Determine coverage command
    let command: string;
    if (verifyCommand) {
      command = verifyCommand;
    } else if (expectedPackages && expectedPackages.length > 0) {
      // Default: go test -cover for specified packages
      const packages = expectedPackages.join(" ");
      command = `go test -cover ${packages}`;
    } else {
      command = "go test -cover ./...";
    }

    // Run coverage measurement
    const output = execSync(command, {
      cwd: projectDir,
      encoding: "utf-8",
      timeout: 60000, // 60s timeout
    });

    // Parse coverage from output
    const coverage = parseCoverageFromOutput(output);

    const passed = coverage >= targetCoverage;

    return {
      name: "coverage",
      passed,
      expected: targetCoverage,
      actual: coverage,
      details: passed
        ? `Coverage ${coverage.toFixed(1)}% meets target ${targetCoverage}%`
        : `Coverage ${coverage.toFixed(1)}% below target ${targetCoverage}%`,
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : String(error);
    return {
      name: "coverage",
      passed: false,
      expected: targetCoverage,
      actual: 0,
      details: `Coverage measurement failed: ${message}`,
    };
  }
}

/**
 * Run tests and verify they pass
 */
async function runTests(
  projectDir: string,
  verifyCommand: string | undefined,
  expectedPackages: string[] | undefined
): Promise<ValidationCheck> {
  try {
    // Determine test command
    let command: string;
    if (verifyCommand) {
      command = verifyCommand;
    } else if (expectedPackages && expectedPackages.length > 0) {
      const packages = expectedPackages.join(" ");
      command = `go test ${packages}`;
    } else {
      command = "go test ./...";
    }

    // Run tests
    const output = execSync(command, {
      cwd: projectDir,
      encoding: "utf-8",
      timeout: 300000, // 5min timeout
    });

    // Parse test results
    const testsPassed = !output.includes("FAIL");
    const testCount = countTests(output);

    return {
      name: "tests",
      passed: testsPassed,
      actual: testCount,
      details: testsPassed
        ? `All ${testCount} tests passed`
        : `Tests failed - see output`,
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : String(error);
    return {
      name: "tests",
      passed: false,
      details: `Test execution failed: ${message}`,
    };
  }
}

/**
 * Parse coverage percentage from go test -cover output
 * Example: "coverage: 42.5% of statements"
 */
function parseCoverageFromOutput(output: string): number {
  const lines = output.split("\n");

  // Look for coverage lines
  const coverageLines = lines.filter((line) =>
    line.includes("coverage:")
  );

  if (coverageLines.length === 0) {
    return 0;
  }

  // Extract percentages and average them
  const percentages: number[] = [];
  for (const line of coverageLines) {
    const match = line.match(/coverage:\s+([\d.]+)%/);
    if (match) {
      percentages.push(parseFloat(match[1]));
    }
  }

  if (percentages.length === 0) {
    return 0;
  }

  // Return average coverage
  const sum = percentages.reduce((a, b) => a + b, 0);
  return sum / percentages.length;
}

/**
 * Count number of tests run from output
 */
function countTests(output: string): number {
  const lines = output.split("\n");
  let count = 0;

  for (const line of lines) {
    // Match lines like "--- PASS: TestFoo (0.00s)"
    if (line.match(/^---\s+(PASS|FAIL):/)) {
      count++;
    }
  }

  return count;
}

/**
 * Create a ValidationConfig with sensible defaults
 */
export function createValidationConfig(
  options: Partial<ValidationConfig> = {}
): ValidationConfig {
  return {
    enabled: options.enabled ?? true,
    coverageTarget: options.coverageTarget,
    testPassRequired: options.testPassRequired ?? true,
    enforceBlocking: options.enforceBlocking ?? true,
    verifyCommand: options.verifyCommand,
    expectedPackages: options.expectedPackages,
  };
}
