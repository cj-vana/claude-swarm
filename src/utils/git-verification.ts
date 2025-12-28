/**
 * Git-based change verification for worker output
 *
 * Provides checksummed verification of worker changes without tmux dependency:
 * - Capture git state before/after worker execution
 * - Calculate SHA-256 checksum of changes
 * - Track files modified, lines added/deleted
 * - Verify changes match expected packages
 */

import { execSync } from "child_process";
import * as crypto from "crypto";
import { GitVerification } from "../state/manager.js";

/**
 * Capture current git state (hash of HEAD)
 */
export function captureGitState(projectDir: string): string {
  try {
    const hash = execSync("git rev-parse HEAD", {
      cwd: projectDir,
      encoding: "utf-8",
    }).trim();
    return hash;
  } catch (error) {
    throw new Error(
      `Failed to capture git state: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Calculate verification checksum for changes between two git states
 */
export function calculateGitVerification(
  projectDir: string,
  beforeHash: string,
  afterHash?: string
): GitVerification {
  try {
    // If afterHash not provided, compare beforeHash to current working tree
    const compareTarget = afterHash || "HEAD";

    // Get diff statistics
    const diffStat = execSync(
      `git diff ${beforeHash}${afterHash ? `.${afterHash}` : ""} --numstat`,
      {
        cwd: projectDir,
        encoding: "utf-8",
      }
    );

    // Get list of changed files
    const filesChanged = execSync(
      `git diff ${beforeHash}${afterHash ? `.${afterHash}` : ""} --name-only`,
      {
        cwd: projectDir,
        encoding: "utf-8",
      }
    )
      .trim()
      .split("\n")
      .filter((f) => f.length > 0);

    // Parse numstat output to calculate total lines added/deleted
    let linesAdded = 0;
    let linesDeleted = 0;

    const lines = diffStat.trim().split("\n");
    for (const line of lines) {
      if (!line) continue;
      const parts = line.split("\t");
      if (parts.length < 3) continue;

      const added = parts[0] === "-" ? 0 : parseInt(parts[0], 10);
      const deleted = parts[1] === "-" ? 0 : parseInt(parts[1], 10);

      linesAdded += added;
      linesDeleted += deleted;
    }

    // Get full diff for checksum
    const fullDiff = execSync(
      `git diff ${beforeHash}${afterHash ? `.${afterHash}` : ""}`,
      {
        cwd: projectDir,
        encoding: "utf-8",
      }
    );

    // Calculate SHA-256 checksum of diff
    const diffChecksum = crypto
      .createHash("sha256")
      .update(fullDiff)
      .digest("hex");

    // Get current HEAD hash if afterHash not provided
    const finalAfterHash =
      afterHash || execSync("git rev-parse HEAD", {
        cwd: projectDir,
        encoding: "utf-8",
      }).trim();

    return {
      beforeHash,
      afterHash: finalAfterHash,
      filesChanged,
      linesAdded,
      linesDeleted,
      diffChecksum,
    };
  } catch (error) {
    throw new Error(
      `Failed to calculate git verification: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Verify that git changes match expected packages
 * Returns true if at least one changed file is in expected packages
 */
export function verifyExpectedPackages(
  verification: GitVerification,
  expectedPackages: string[]
): { matched: boolean; details: string } {
  if (!expectedPackages || expectedPackages.length === 0) {
    return {
      matched: true,
      details: "No package constraints specified",
    };
  }

  // Check if any changed file is in expected packages
  const matchedFiles = verification.filesChanged.filter((file) =>
    expectedPackages.some((pkg) =>
      file === pkg || file.startsWith(pkg + "/")
    )
  );

  const matched = matchedFiles.length > 0;

  if (matched) {
    return {
      matched: true,
      details: `${matchedFiles.length}/${verification.filesChanged.length} files match expected packages: ${expectedPackages.join(", ")}`,
    };
  } else {
    return {
      matched: false,
      details: `No files in expected packages. Expected: ${expectedPackages.join(", ")}. Changed: ${verification.filesChanged.slice(0, 5).join(", ")}${verification.filesChanged.length > 5 ? "..." : ""}`,
    };
  }
}

/**
 * Format git verification for display
 */
export function formatGitVerification(
  verification: GitVerification
): string {
  const lines = [
    `📝 Git Verification:`,
    `   Before: ${verification.beforeHash.slice(0, 8)}`,
    `   After:  ${verification.afterHash.slice(0, 8)}`,
    `   Files:  ${verification.filesChanged.length} changed`,
    `   Lines:  +${verification.linesAdded} -${verification.linesDeleted}`,
    `   Checksum: ${verification.diffChecksum.slice(0, 16)}...`,
  ];

  if (verification.filesChanged.length > 0) {
    lines.push(`   Changed files:`);
    const displayFiles = verification.filesChanged.slice(0, 5);
    for (const file of displayFiles) {
      lines.push(`     - ${file}`);
    }
    if (verification.filesChanged.length > 5) {
      lines.push(
        `     ... and ${verification.filesChanged.length - 5} more`
      );
    }
  }

  return lines.join("\n");
}
