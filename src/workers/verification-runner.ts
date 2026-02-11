/**
 * Verification Runner - Enforced test-as-supervisor for worker output
 *
 * Runs configured verification commands after worker completion and
 * returns structured results. Integrates with the completion monitor
 * to auto-reject and retry failed workers.
 *
 * Inspired by the "test as supervisor" pattern from "Building a C compiler
 * with parallel Claudes" where tests continuously validate without human oversight.
 */

import { exec } from "child_process";
import { promisify } from "util";
import { validateCommand } from "../utils/security.js";

const execAsync = promisify(exec);

export interface VerificationResult {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  passed: boolean;
  duration: number;
}

export interface VerificationSummary {
  allPassed: boolean;
  results: VerificationResult[];
  totalDuration: number;
  failedCount: number;
  passedCount: number;
}

/**
 * Maximum output to capture per command to avoid memory issues
 */
const MAX_OUTPUT_LENGTH = 10000;

/**
 * Default timeout per verification command (2 minutes)
 */
const DEFAULT_TIMEOUT_MS = 120000;

export class VerificationRunner {
  /**
   * Run all verification commands against a working directory.
   * Each command is validated against the security allowlist before execution.
   */
  async runVerification(
    commands: string[],
    workingDir: string,
    timeoutMs: number = DEFAULT_TIMEOUT_MS
  ): Promise<VerificationSummary> {
    const results: VerificationResult[] = [];
    const totalStart = Date.now();

    for (const command of commands) {
      // Validate command against security allowlist
      try {
        validateCommand(command);
      } catch (error: any) {
        results.push({
          command,
          exitCode: -1,
          stdout: "",
          stderr: `Command validation failed: ${error.message}`,
          passed: false,
          duration: 0,
        });
        continue;
      }

      const start = Date.now();
      try {
        const { stdout, stderr } = await execAsync(command, {
          cwd: workingDir,
          timeout: timeoutMs,
          maxBuffer: 1024 * 1024 * 10, // 10MB buffer
        });

        results.push({
          command,
          exitCode: 0,
          stdout: truncateOutput(stdout),
          stderr: truncateOutput(stderr),
          passed: true,
          duration: Date.now() - start,
        });
      } catch (error: any) {
        results.push({
          command,
          exitCode: error.code ?? 1,
          stdout: truncateOutput(error.stdout || ""),
          stderr: truncateOutput(error.stderr || error.message || ""),
          passed: false,
          duration: Date.now() - start,
        });
      }
    }

    const failedCount = results.filter((r) => !r.passed).length;

    return {
      allPassed: failedCount === 0,
      results,
      totalDuration: Date.now() - totalStart,
      failedCount,
      passedCount: results.length - failedCount,
    };
  }

  /**
   * Format verification results as a concise string for inclusion in retry prompts.
   * Only includes failed commands to avoid context pollution.
   */
  formatForRetry(summary: VerificationSummary): string {
    if (summary.allPassed) {
      return "All verification commands passed.";
    }

    const lines: string[] = [
      `Verification failed: ${summary.failedCount}/${summary.results.length} commands failed.`,
      "",
    ];

    for (const result of summary.results) {
      if (!result.passed) {
        lines.push(`Command: \`${result.command}\``);
        lines.push(`Exit code: ${result.exitCode}`);

        // Include truncated stderr for context
        if (result.stderr) {
          const stderrPreview = result.stderr.slice(0, 500);
          lines.push(`Error output:\n\`\`\`\n${stderrPreview}\n\`\`\``);
        }

        lines.push("");
      }
    }

    return lines.join("\n");
  }
}

/**
 * Truncate output to prevent memory bloat
 */
function truncateOutput(output: string): string {
  if (output.length <= MAX_OUTPUT_LENGTH) return output;
  return output.slice(0, MAX_OUTPUT_LENGTH) + `\n... (truncated, ${output.length} total chars)`;
}
