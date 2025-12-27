/**
 * Fresh Repo Detector - Identifies repositories that need initial setup
 *
 * This module uses a scoring heuristic to determine if a repository
 * is "fresh" (newly created or lacking common configuration files).
 *
 * Scoring breakdown:
 * - No CLAUDE.md:           +25 points
 * - No .github/workflows:   +25 points
 * - No issue templates:     +15 points
 * - No release config:      +15 points
 * - No dependabot/renovate: +10 points
 *
 * Total possible: 90 points
 * Threshold: Score >= 50 indicates a fresh repo needing setup
 */

import * as fs from "fs";
import * as path from "path";
import { validateProjectDir } from "../utils/security.js";

// ============================================================================
// Types and Interfaces
// ============================================================================

/**
 * Individual check result with score contribution
 */
export interface FreshnessCheck {
  /** Name of the check */
  name: string;
  /** Files or directories checked */
  paths: string[];
  /** Whether the check passed (item is missing) */
  missing: boolean;
  /** Points contributed to freshness score */
  points: number;
  /** Maximum possible points for this check */
  maxPoints: number;
}

/**
 * Result of freshness detection
 */
export interface FreshnessResult {
  /** Total freshness score (higher = more fresh/unconfigured) */
  score: number;
  /** Maximum possible score */
  maxScore: number;
  /** Whether the repo is considered "fresh" (score >= threshold) */
  isFresh: boolean;
  /** Threshold used for determination */
  threshold: number;
  /** Individual check results */
  checks: FreshnessCheck[];
  /** Summary of what's missing */
  missingSummary: string[];
  /** Summary of what's already configured */
  configuredSummary: string[];
  /** Timestamp of the detection */
  detectedAt: string;
}

// ============================================================================
// Check Definitions
// ============================================================================

/**
 * Definition of a freshness check
 */
interface CheckDefinition {
  name: string;
  description: string;
  paths: string[];
  points: number;
}

/**
 * All freshness checks with their point values
 */
const FRESHNESS_CHECKS: CheckDefinition[] = [
  {
    name: "CLAUDE.md",
    description: "Claude Code project instructions",
    paths: ["CLAUDE.md", ".claude/CLAUDE.md"],
    points: 25,
  },
  {
    name: "GitHub Workflows",
    description: "GitHub Actions CI/CD workflows",
    paths: [".github/workflows"],
    points: 25,
  },
  {
    name: "Issue Templates",
    description: "GitHub issue templates for bug reports and features",
    paths: [
      ".github/ISSUE_TEMPLATE",
      ".github/ISSUE_TEMPLATE.md",
      ".github/issue_template.md",
    ],
    points: 15,
  },
  {
    name: "Release Config",
    description: "Release automation configuration",
    paths: [
      ".github/release.yml",
      ".releaserc",
      ".releaserc.js",
      ".releaserc.json",
      ".releaserc.yaml",
      "release.config.js",
      "release.config.cjs",
    ],
    points: 15,
  },
  {
    name: "Dependency Updates",
    description: "Automated dependency update configuration",
    paths: [
      ".github/dependabot.yml",
      ".github/dependabot.yaml",
      "renovate.json",
      "renovate.json5",
      ".renovaterc",
      ".renovaterc.json",
    ],
    points: 10,
  },
];

// ============================================================================
// Detection Functions
// ============================================================================

/**
 * Check if any of the given paths exist in the project directory
 */
function checkPathsExist(projectDir: string, paths: string[]): boolean {
  for (const checkPath of paths) {
    const fullPath = path.join(projectDir, checkPath);
    try {
      if (fs.existsSync(fullPath)) {
        return true;
      }
    } catch {
      // Ignore access errors, treat as not existing
    }
  }
  return false;
}

/**
 * Run a single freshness check
 */
function runCheck(projectDir: string, check: CheckDefinition): FreshnessCheck {
  const exists = checkPathsExist(projectDir, check.paths);

  return {
    name: check.name,
    paths: check.paths,
    missing: !exists,
    points: exists ? 0 : check.points,
    maxPoints: check.points,
  };
}

/**
 * Detect if a repository is "fresh" (lacking common configuration)
 *
 * @param projectDir - Path to the project directory
 * @param threshold - Score threshold for considering repo as fresh (default: 50)
 * @returns FreshnessResult with score and check details
 *
 * @example
 * ```typescript
 * const result = await detectFreshness('/path/to/project');
 * if (result.isFresh) {
 *   console.log('This repo needs setup:', result.missingSummary);
 * }
 * ```
 */
export async function detectFreshness(
  projectDir: string,
  threshold: number = 50
): Promise<FreshnessResult> {
  // Validate and normalize project directory
  const validatedDir = validateProjectDir(projectDir);

  // Run all checks
  const checks: FreshnessCheck[] = [];
  let totalScore = 0;
  let maxScore = 0;
  const missingSummary: string[] = [];
  const configuredSummary: string[] = [];

  for (const checkDef of FRESHNESS_CHECKS) {
    const result = runCheck(validatedDir, checkDef);
    checks.push(result);
    totalScore += result.points;
    maxScore += result.maxPoints;

    if (result.missing) {
      missingSummary.push(checkDef.description);
    } else {
      configuredSummary.push(checkDef.description);
    }
  }

  return {
    score: totalScore,
    maxScore,
    isFresh: totalScore >= threshold,
    threshold,
    checks,
    missingSummary,
    configuredSummary,
    detectedAt: new Date().toISOString(),
  };
}

/**
 * Format freshness result for display
 */
export function formatFreshnessResult(result: FreshnessResult): string {
  const lines: string[] = [];

  // Header
  lines.push(`Freshness Score: ${result.score}/${result.maxScore}`);
  lines.push(`Status: ${result.isFresh ? "Fresh (needs setup)" : "Configured"}`);
  lines.push("");

  // Check breakdown
  lines.push("Checks:");
  for (const check of result.checks) {
    const status = check.missing ? "Missing" : "Present";
    const points = check.missing ? `+${check.points}` : "0";
    lines.push(`  [${status}] ${check.name}: ${points}/${check.maxPoints} pts`);
  }

  // Summaries
  if (result.missingSummary.length > 0) {
    lines.push("");
    lines.push("Missing configurations:");
    for (const item of result.missingSummary) {
      lines.push(`  - ${item}`);
    }
  }

  if (result.configuredSummary.length > 0) {
    lines.push("");
    lines.push("Already configured:");
    for (const item of result.configuredSummary) {
      lines.push(`  - ${item}`);
    }
  }

  return lines.join("\n");
}

/**
 * Get a list of recommended setup actions based on freshness result
 */
export function getSetupRecommendations(result: FreshnessResult): string[] {
  const recommendations: string[] = [];

  for (const check of result.checks) {
    if (check.missing) {
      switch (check.name) {
        case "CLAUDE.md":
          recommendations.push("Create CLAUDE.md with project-specific instructions for Claude Code");
          break;
        case "GitHub Workflows":
          recommendations.push("Set up GitHub Actions workflows for CI/CD");
          break;
        case "Issue Templates":
          recommendations.push("Add issue templates for bug reports and feature requests");
          break;
        case "Release Config":
          recommendations.push("Configure automated releases with semantic versioning");
          break;
        case "Dependency Updates":
          recommendations.push("Enable automated dependency updates with Dependabot or Renovate");
          break;
      }
    }
  }

  return recommendations;
}
