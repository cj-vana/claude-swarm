/**
 * Feature validation utilities
 *
 * Validates feature completion by running verification commands and checking
 * coverage targets, test pass requirements, and expected package coverage.
 */

import { exec } from "child_process";
import { promisify } from "util";
import type { Feature, ValidationResult, ValidationCheck } from "../state/manager.js";

const execAsync = promisify(exec);

/**
 * Validate a completed feature by running configured validation checks
 */
export async function validateFeature(
  feature: Feature,
  projectDir: string
): Promise<ValidationResult> {
  const checks: ValidationCheck[] = [];
  const config = feature.validation;

  if (!config || !config.enabled) {
    return {
      passed: true,
      checks: [],
      timestamp: new Date().toISOString(),
    };
  }

  // Run verification command if specified
  if (config.verifyCommand) {
    try {
      const { stdout, stderr } = await execAsync(config.verifyCommand, {
        cwd: projectDir,
        timeout: 120000, // 2 minute timeout
      });

      // Parse coverage from output if coverage target is set
      if (config.coverageTarget !== undefined) {
        const coverageMatch = stdout.match(/coverage:\s*([\d.]+)%/i) ||
                              stdout.match(/(\d+\.?\d*)%\s*(?:of statements|coverage)/i);

        if (coverageMatch) {
          const actualCoverage = parseFloat(coverageMatch[1]);
          const passed = actualCoverage >= config.coverageTarget;

          checks.push({
            name: "coverage",
            passed,
            expected: config.coverageTarget,
            actual: actualCoverage,
            details: passed
              ? `Coverage ${actualCoverage}% meets target ${config.coverageTarget}%`
              : `Coverage ${actualCoverage}% below target ${config.coverageTarget}%`,
          });
        }
      }

      // Check for expected packages in output
      if (config.expectedPackages && config.expectedPackages.length > 0) {
        for (const pkg of config.expectedPackages) {
          const found = stdout.includes(pkg) || stderr.includes(pkg);
          checks.push({
            name: `package:${pkg}`,
            passed: found,
            details: found
              ? `Package ${pkg} found in output`
              : `Package ${pkg} not found in verification output`,
          });
        }
      }

      // If test pass required, check exit code (we got here so it passed)
      if (config.testPassRequired) {
        checks.push({
          name: "tests",
          passed: true,
          details: "Verification command completed successfully",
        });
      }

    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      // Command failed - tests did not pass
      if (config.testPassRequired) {
        checks.push({
          name: "tests",
          passed: false,
          details: `Verification command failed: ${message.substring(0, 200)}`,
        });
      }
    }
  }

  // Determine overall pass/fail
  const passed = checks.length === 0 || checks.every(c => c.passed);

  return {
    passed,
    checks,
    timestamp: new Date().toISOString(),
  };
}
