/**
 * Worker Manager - Manages Claude Code worker sessions via tmux
 *
 * Key design principles:
 * - Each worker runs in its own tmux session for isolation
 * - Workers communicate completion via file-based signals + git commits
 * - Orchestrator can monitor worker output without blocking
 * - Graceful handling of worker crashes and timeouts
 *
 * Security:
 * - Prompts are passed via files, not shell strings (prevents injection)
 * - All IDs are validated before use
 * - execFile used instead of exec where possible
 */

import { exec, execFile, spawn } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as path from "path";
import { Feature, StateManager, WorkerStatus } from "../state/manager.js";
import { z } from "zod";
import {
  validateFeatureId,
  validateSessionName,
  shellQuote,
  sanitizeOutput,
  ReviewFindingsSchema,
  StructuredPlanSchema,
} from "../utils/security.js";
import type { ReviewFindings } from "../state/manager.js";
import {
  getWorkerConfidence,
  AggregatedConfidence,
} from "./confidence.js";
import type { EnforcementIntegration, PreSpawnValidationResult, MonitoringResult } from "./enforcement-integration.js";

// Re-export enforcement integration types and factory for convenience
export type { EnforcementIntegration, PreSpawnValidationResult, MonitoringResult } from "./enforcement-integration.js";
export { createEnforcementIntegration } from "./enforcement-integration.js";

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

interface StartWorkerResult {
  success: boolean;
  sessionName?: string;
  error?: string;
  // Enforcement validation info (when enforcement is enabled)
  enforcementValidation?: PreSpawnValidationResult;
}

interface CheckWorkerResult {
  status: "running" | "completed" | "crashed" | "not_found";
  output?: string;
}

export interface HeartbeatInfo {
  status: "running" | "completed" | "crashed" | "not_found";
  lastToolUsed?: string;
  lastFile?: string;
  lastActivity?: string;
  linesWritten: number;
  filesModified: string[];
  runningFor?: string;
  confidence?: AggregatedConfidence;
  // Protocol enforcement info (when enforcement is enabled)
  enforcement?: {
    hasActiveProtocols: boolean;
    alerts: Array<{
      id: string;
      type: string;
      severity: string;
      message: string;
    }>;
    iterationCount: number;
    warningCount: number;
  };
}

export type CompletionCallback = (
  featureId: string,
  status: "completed" | "crashed",
  output?: string
) => void;

export class WorkerManager {
  private projectDir: string;
  private stateManager: StateManager;
  private workerDir: string;
  private monitorInterval: NodeJS.Timeout | null = null;
  private completionCallbacks: CompletionCallback[] = [];
  private lastKnownStatus: Map<string, string> = new Map();
  // Optional enforcement integration for protocol governance
  private enforcement: EnforcementIntegration | null = null;

  constructor(projectDir: string, stateManager: StateManager) {
    this.projectDir = projectDir;
    this.stateManager = stateManager;

    // Directory for worker status files
    this.workerDir = path.join(
      projectDir,
      ".claude",
      "orchestrator",
      "workers"
    );
    if (!fs.existsSync(this.workerDir)) {
      fs.mkdirSync(this.workerDir, { recursive: true });
    }
  }

  /**
   * Set the enforcement integration for protocol governance
   * This is optional - if not set, no enforcement checks are performed
   */
  setEnforcement(enforcement: EnforcementIntegration): void {
    this.enforcement = enforcement;
  }

  /**
   * Get the enforcement integration (if set)
   */
  getEnforcement(): EnforcementIntegration | null {
    return this.enforcement;
  }

  /**
   * Generate a unique session name for a worker
   */
  private generateSessionName(featureId: string): string {
    // Validate feature ID first
    validateFeatureId(featureId);
    const timestamp = Date.now().toString(36);
    return `cc-worker-${featureId}-${timestamp}`;
  }

  /**
   * Extract feature ID from session name
   */
  private extractFeatureId(sessionName: string): string | null {
    const match = sessionName.match(/^cc-worker-(.+?)-[a-z0-9]+$/);
    return match ? match[1] : null;
  }

  /**
   * Read project context files (CLAUDE.md, .clauderc, etc.)
   * Returns combined content or empty string if none found
   */
  private readProjectContext(): string {
    const contextFiles = [
      "CLAUDE.md",
      ".claude/CLAUDE.md",
      ".clauderc",
      ".claude/settings.json",
    ];

    const contents: string[] = [];

    for (const file of contextFiles) {
      const filePath = path.join(this.projectDir, file);
      if (fs.existsSync(filePath)) {
        try {
          const content = fs.readFileSync(filePath, "utf-8");
          // Limit each file to 4000 chars to prevent prompt bloat
          const truncated =
            content.length > 4000
              ? content.substring(0, 4000) + "\n... (truncated)"
              : content;
          contents.push(`### From ${file}:\n${truncated}`);
        } catch {
          // Skip unreadable files silently
        }
      }
    }

    return contents.length > 0
      ? `\n## Project Context Files\n${contents.join("\n\n")}\n`
      : "";
  }

  /**
   * Build the prompt for a worker
   */
  private buildWorkerPrompt(feature: Feature, customPrompt?: string): string {
    const state = this.stateManager.load();
    const taskContext = state?.taskDescription || "";
    const projectContext = this.readProjectContext();

    // Build a focused prompt for the worker
    let prompt = `You are a worker agent focused on implementing a single feature.

## Your Task
${feature.description}

## Orchestration Context
${taskContext}
${projectContext}

## Instructions
1. Focus ONLY on implementing this specific feature
2. Make small, incremental changes
3. Test your changes as you go
4. When you are DONE:
   - Commit your changes following conventional commit format:
     * Use: feat(scope), fix(scope), docs(scope), refactor(scope), test(scope)
     * Example: "feat(auth): add user authentication system"
     * Add footer: "🤖 Committed by claude-swarm worker ${feature.id}"${state?.verificationConfig?.commands?.length ? `
   - Run the following verification commands and ensure they pass:
${state.verificationConfig.commands.map((cmd) => `     * \`${cmd}\``).join("\n")}${state.verificationConfig.failOnError ? "\n     * If any verification command fails, fix the issue before proceeding" : ""}` : ""}
   - Create a file at: .claude/orchestrator/workers/${feature.id}.done
     with a brief summary of what you implemented

## Important
- Do not work on other features
- If you encounter a blocker, document it in the .done file and stop
- Keep changes minimal and focused
- Always commit using conventional commit format with the worker attribution footer
- The .claude/ directory is already gitignored - don't worry about it

## Commit Format Example
\`\`\`bash
# Add only the specific files you changed for this feature
git add src/path/to/file1.ts src/path/to/file2.ts

# Commit with subject and attribution footer
git commit -m "feat(feature-name): implement the feature" -m "🤖 Committed by claude-swarm worker ${feature.id}"
\`\`\`

${customPrompt ? `\n## Additional Context\n${customPrompt}` : ""}

Begin implementing the feature now.`;

    return prompt;
  }

  /**
   * Build a specialized prompt for planning mode workers
   * These workers create implementation plans without writing code
   */
  private buildPlannerPrompt(
    feature: Feature,
    role: "A" | "B",
    customPrompt?: string
  ): string {
    const state = this.stateManager.load();
    const taskContext = state?.taskDescription || "";
    const projectContext = this.readProjectContext();

    // Different perspectives based on role
    const roleGuidance =
      role === "A"
        ? "Consider a straightforward, incremental approach. Focus on minimizing risk and using established patterns."
        : "Consider an alternative or more elegant approach. Look for opportunities to simplify or improve the architecture.";

    const prompt = `You are a planning agent focused on creating an implementation plan for a feature.
Your role is to analyze the codebase and create a detailed plan - DO NOT implement any code.

## Your Task
Create an implementation plan for: ${feature.description}

## Planning Approach
${roleGuidance}

## Orchestration Context
${taskContext}
${projectContext}

## Instructions
1. Explore the codebase to understand the current architecture
2. Identify the files that need to be created or modified
3. Create a step-by-step implementation plan
4. Identify potential risks and how to mitigate them
5. Output your plan as a JSON file

## Output Format
Create a file at: .claude/orchestrator/workers/${feature.id}.plan.json

The JSON must follow this structure:
{
  "summary": "One paragraph overview of the approach",
  "steps": [
    {
      "order": 1,
      "description": "What to do in this step",
      "files": ["src/file1.ts", "src/file2.ts"],
      "validation": "How to verify this step is complete"
    }
  ],
  "filesToCreate": ["src/newfile.ts"],
  "filesToModify": ["src/existing.ts"],
  "testStrategy": "How to test the implementation",
  "risks": ["Risk 1: description and mitigation", "Risk 2: ..."],
  "estimatedComplexity": "low" | "medium" | "high"
}

## Important
- You are in PLANNING mode - do NOT write any implementation code
- Use Read, Glob, and Grep tools to explore the codebase
- Focus on understanding existing patterns and conventions
- Your plan will be evaluated against another planner's approach
- The winning plan will be used for implementation

${customPrompt ? `\n## Additional Context\n${customPrompt}` : ""}

Begin exploring and planning now.`;

    return prompt;
  }

  /**
   * Start a worker in planning mode
   * Returns a unique session name for tracking
   */
  async startPlannerWorker(
    feature: Feature,
    role: "A" | "B",
    customPrompt?: string
  ): Promise<StartWorkerResult> {
    // Validate feature ID
    try {
      validateFeatureId(feature.id);
    } catch (error: any) {
      return {
        success: false,
        error: `Invalid feature ID: ${error.message}`,
      };
    }

    // Use role suffix in session name to distinguish planners
    const timestamp = Date.now().toString(36);
    const sessionName = `cc-planner-${feature.id}-${role.toLowerCase()}-${timestamp}`;
    const prompt = this.buildPlannerPrompt(feature, role, customPrompt);

    // Check if tmux is available
    try {
      await execFileAsync("which", ["tmux"]);
    } catch {
      return {
        success: false,
        error: "tmux is not installed. Please install tmux first.",
      };
    }

    try {
      // Write prompt to a file
      const promptFile = path.join(
        this.workerDir,
        `${feature.id}.planner-${role.toLowerCase()}.prompt`
      );
      fs.writeFileSync(promptFile, prompt, { mode: 0o600 });

      const logFile = path.join(
        this.workerDir,
        `${feature.id}.planner-${role.toLowerCase()}.log`
      );

      // Create wrapper script with read-only tools only
      const wrapperScript = path.join(
        this.workerDir,
        `${feature.id}.planner-${role.toLowerCase()}.sh`
      );
      const scriptContent = `#!/bin/bash
set -e
cd ${shellQuote(this.projectDir)}
PROMPT=$(cat ${shellQuote(promptFile)})
# Prefer claude-code for Max plan compatibility (uses session auth, not API credits)
# Falls back to claude (API mode) if claude-code is unavailable
if command -v claude-code &> /dev/null; then
  claude-code -p "$PROMPT" 2>&1 | tee ${shellQuote(logFile)}
else
  claude -p "$PROMPT" 2>&1 | tee ${shellQuote(logFile)}
fi
echo 'PLANNER_EXITED' >> ${shellQuote(logFile)}
`;
      fs.writeFileSync(wrapperScript, scriptContent, { mode: 0o700 });

      // Start tmux session
      await execFileAsync("tmux", [
        "new-session",
        "-d",
        "-s",
        sessionName,
        "-c",
        this.projectDir,
        "bash",
        wrapperScript,
      ]);

      // Create status file
      const statusFile = path.join(
        this.workerDir,
        `${feature.id}.planner-${role.toLowerCase()}.status`
      );
      fs.writeFileSync(
        statusFile,
        JSON.stringify({
          sessionName,
          featureId: feature.id,
          role,
          startedAt: new Date().toISOString(),
          status: "running",
          mode: "planning",
        })
      );

      return {
        success: true,
        sessionName,
      };
    } catch (error: any) {
      return {
        success: false,
        error: sanitizeOutput(error.message),
      };
    }
  }

  /**
   * Check if a plan file exists for a feature/role
   */
  planExists(featureId: string, role: "A" | "B"): boolean {
    const planFile = path.join(this.workerDir, `${featureId}.plan.json`);
    // Also check role-specific plan file
    const rolePlanFile = path.join(
      this.workerDir,
      `${featureId}.planner-${role.toLowerCase()}.plan.json`
    );
    return fs.existsSync(planFile) || fs.existsSync(rolePlanFile);
  }

  /**
   * Read a plan file for a feature
   * Validates plan against Zod schema for type safety
   */
  readPlanFile(featureId: string): z.infer<typeof StructuredPlanSchema> | null {
    const planFile = path.join(this.workerDir, `${featureId}.plan.json`);
    try {
      if (fs.existsSync(planFile)) {
        const content = fs.readFileSync(planFile, "utf-8");
        const parsed = JSON.parse(content);
        const validated = StructuredPlanSchema.safeParse(parsed);
        if (validated.success) {
          return validated.data;
        }
        console.error(
          `Invalid plan format for ${featureId}:`,
          validated.error.issues
        );
      }
    } catch (error) {
      console.error(`Error reading plan file for ${featureId}:`, error);
    }
    return null;
  }

  /**
   * Start a worker in a tmux session
   * Security: Uses file-based prompt passing to avoid shell injection
   * Enforcement: Validates against active protocols before spawning
   */
  async startWorker(
    feature: Feature,
    customPrompt?: string
  ): Promise<StartWorkerResult> {
    // Validate feature ID
    try {
      validateFeatureId(feature.id);
    } catch (error: any) {
      return {
        success: false,
        error: `Invalid feature ID: ${error.message}`,
      };
    }

    // Pre-spawn validation: Check if active protocols allow this worker to spawn
    let enforcementValidation: PreSpawnValidationResult | undefined;
    if (this.enforcement) {
      try {
        enforcementValidation = this.enforcement.validatePreSpawn(feature, customPrompt);

        // If enforcement blocks the spawn, return with validation details
        if (!enforcementValidation.allowed) {
          const violationMessages = enforcementValidation.violations
            .map(v => `  - [${v.protocolName}] ${v.message}${v.remediation ? ` (${v.remediation})` : ""}`)
            .join("\n");

          return {
            success: false,
            error: `Protocol enforcement blocked worker spawn:\n${violationMessages}`,
            enforcementValidation,
          };
        }
      } catch (error) {
        // Enforcement validation failed - fail-closed for security
        console.error("Enforcement validation error:", error);
        return {
          success: false,
          error: `Protocol enforcement validation failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    }

    const sessionName = this.generateSessionName(feature.id);
    const prompt = this.buildWorkerPrompt(feature, customPrompt);

    // Create snapshot branch for rollback capability
    const snapshotResult = await this.createSnapshotBranch(feature.id);
    // Note: We don't fail if snapshot creation fails - just log it
    if (!snapshotResult.success) {
      console.log(`Note: Could not create snapshot branch for ${feature.id}: ${snapshotResult.error}`);
    }

    // Check if tmux is available
    try {
      await execFileAsync("which", ["tmux"]);
    } catch {
      return {
        success: false,
        error: "tmux is not installed. Please install tmux first.",
      };
    }

    try {
      // Write prompt to a file instead of passing via shell (prevents injection)
      const promptFile = path.join(this.workerDir, `${feature.id}.prompt`);
      fs.writeFileSync(promptFile, prompt, { mode: 0o600 });

      const logFile = path.join(this.workerDir, `${feature.id}.log`);

      // Create a wrapper script that reads the prompt from file
      // This avoids any shell escaping issues
      const wrapperScript = path.join(this.workerDir, `${feature.id}.sh`);
      const scriptContent = `#!/bin/bash
set -e
cd ${shellQuote(this.projectDir)}
PROMPT=$(cat ${shellQuote(promptFile)})
# Prefer claude-code for Max plan compatibility (uses session auth, not API credits)
# Falls back to claude (API mode) if claude-code is unavailable
if command -v claude-code &> /dev/null; then
  claude-code -p "$PROMPT" --allowedTools Bash,Read,Write,Edit,Glob,Grep 2>&1 | tee ${shellQuote(logFile)}
else
  claude -p "$PROMPT" --allowedTools Bash,Read,Write,Edit,Glob,Grep 2>&1 | tee ${shellQuote(logFile)}
fi
echo 'WORKER_EXITED' >> ${shellQuote(logFile)}
`;
      fs.writeFileSync(wrapperScript, scriptContent, { mode: 0o700 });

      // Start tmux session with the wrapper script
      // Using execFile with explicit arguments avoids shell interpretation
      await execFileAsync("tmux", [
        "new-session",
        "-d",
        "-s",
        sessionName,
        "-c",
        this.projectDir,
        "bash",
        wrapperScript,
      ]);

      // Create status file
      const statusFile = path.join(this.workerDir, `${feature.id}.status`);
      fs.writeFileSync(
        statusFile,
        JSON.stringify({
          sessionName,
          featureId: feature.id,
          startedAt: new Date().toISOString(),
          status: "running",
        })
      );

      // Start enforcement monitoring for this worker if enforcement is enabled
      if (this.enforcement) {
        this.enforcement.startMonitoring(feature.id, sessionName);
      }

      return {
        success: true,
        sessionName,
        enforcementValidation,
      };
    } catch (error: any) {
      return {
        success: false,
        error: sanitizeOutput(error.message),
      };
    }
  }

  /**
   * Truncate a line to a maximum length, adding ellipsis if truncated
   */
  private truncateLine(line: string, maxLength: number = 120): string {
    if (line.length <= maxLength) {
      return line;
    }
    return line.substring(0, maxLength - 3) + "...";
  }

  /**
   * Truncate all lines in output to a maximum length
   */
  private truncateOutputLines(output: string, maxLength: number = 120): string {
    return output
      .split("\n")
      .map((line) => this.truncateLine(line, maxLength))
      .join("\n");
  }

  /**
   * Check the status and output of a worker
   */
  async checkWorker(
    sessionName: string,
    lines: number = 50
  ): Promise<CheckWorkerResult> {
    // Validate session name format
    if (!validateSessionName(sessionName)) {
      return {
        status: "not_found",
        output: "Invalid session name format",
      };
    }

    try {
      // Check if session exists using execFile
      let sessions = "";
      try {
        const result = await execFileAsync("tmux", [
          "list-sessions",
          "-F",
          "#{session_name}",
        ]);
        sessions = result.stdout;
      } catch {
        // tmux might not be running, treat as no sessions
        sessions = "";
      }

      const sessionExists = sessions.includes(sessionName);

      if (!sessionExists) {
        // Session ended - check for completion file
        const featureId = this.extractFeatureId(sessionName);
        if (!featureId) {
          return {
            status: "not_found",
            output: "Could not extract feature ID from session name",
          };
        }

        const doneFile = path.join(this.workerDir, `${featureId}.done`);

        if (fs.existsSync(doneFile)) {
          const summary = fs.readFileSync(doneFile, "utf-8");
          return {
            status: "completed",
            output: `Worker completed.\n\nSummary:\n${this.truncateOutputLines(sanitizeOutput(summary))}`,
          };
        }

        // Check log file for crash info
        const logFile = path.join(this.workerDir, `${featureId}.log`);
        if (fs.existsSync(logFile)) {
          const log = fs.readFileSync(logFile, "utf-8");
          const lastLines = log.split("\n").slice(-lines).join("\n");
          return {
            status: "crashed",
            output: `Worker session ended unexpectedly.\n\nLast output:\n${this.truncateOutputLines(sanitizeOutput(lastLines))}`,
          };
        }

        return {
          status: "not_found",
          output: "Worker session not found and no logs available.",
        };
      }

      // Session is running - capture output using execFile
      const { stdout: output } = await execFileAsync("tmux", [
        "capture-pane",
        "-t",
        sessionName,
        "-p",
        "-S",
        `-${Math.min(lines, 500)}`, // Limit lines to prevent abuse
      ]);

      const featureId = this.extractFeatureId(sessionName);

      // If tmux capture is empty, try reading from log file as fallback
      if (!output || output.trim() === "") {
        if (featureId) {
          const logFile = path.join(this.workerDir, `${featureId}.log`);
          if (fs.existsSync(logFile)) {
            const log = fs.readFileSync(logFile, "utf-8");
            if (log.length > 0) {
              const lastLines = log.split("\n").slice(-lines).join("\n");

              // Record activity for enforcement monitoring
              if (this.enforcement) {
                this.enforcement.recordActivity(sessionName, featureId, lastLines);
              }

              return {
                status: "running",
                output: `(from log file)\n${this.truncateOutputLines(sanitizeOutput(lastLines))}`,
              };
            }
          }
        }
        // Still empty - worker is initializing
        return {
          status: "running",
          output:
            "⏳ Worker is initializing... (output will appear in 30-60 seconds)",
        };
      }

      // Record activity for enforcement monitoring
      if (this.enforcement && featureId) {
        this.enforcement.recordActivity(sessionName, featureId, output);
      }

      return {
        status: "running",
        output: this.truncateOutputLines(sanitizeOutput(output)),
      };
    } catch (error: any) {
      return {
        status: "not_found",
        output: sanitizeOutput(error.message),
      };
    }
  }

  /**
   * Check all workers and return their statuses
   */
  async checkAllWorkers(): Promise<WorkerStatus[]> {
    const state = this.stateManager.load();
    if (!state) return [];

    const statuses: WorkerStatus[] = [];

    for (const feature of state.features) {
      if (feature.workerId && validateSessionName(feature.workerId)) {
        const result = await this.checkWorker(feature.workerId);
        statuses.push({
          sessionName: feature.workerId,
          featureId: feature.id,
          status:
            result.status === "running"
              ? "running"
              : result.status === "completed"
                ? "completed"
                : result.status === "crashed"
                  ? "crashed"
                  : "unknown",
          startedAt: feature.startedAt || "",
          lastChecked: new Date().toISOString(),
        });
      }
    }

    return statuses;
  }

  /**
   * Get lightweight heartbeat info for a worker (no full output)
   * Parses log file to extract tool usage, file modifications, and activity
   */
  async getHeartbeatInfo(
    sessionName: string,
    startedAt?: string
  ): Promise<HeartbeatInfo> {
    // First check the basic status
    const basicResult = await this.checkWorker(sessionName, 10);

    const featureId = this.extractFeatureId(sessionName);
    if (!featureId) {
      return {
        status: basicResult.status,
        linesWritten: 0,
        filesModified: [],
      };
    }

    const logFile = path.join(this.workerDir, `${featureId}.log`);
    let linesWritten = 0;
    let lastToolUsed: string | undefined;
    let lastFile: string | undefined;
    const filesModified = new Set<string>();

    if (fs.existsSync(logFile)) {
      try {
        const log = fs.readFileSync(logFile, "utf-8");
        const lines = log.split("\n");
        linesWritten = lines.length;

        // Parse log for tool usage patterns (scan last 100 lines for efficiency)
        const recentLines = lines.slice(-100);
        for (const line of recentLines) {
          // Match tool usage patterns like "Read tool", "Edit tool", "Bash tool"
          const toolMatch = line.match(
            /\b(Read|Write|Edit|Bash|Glob|Grep)\b.*?(?:tool|file|command)/i
          );
          if (toolMatch) {
            lastToolUsed = toolMatch[1];
          }

          // Match file paths in tool output
          const fileMatch = line.match(
            /(?:Reading|Writing|Editing|Created|Modified|file_path['":\s]+)([^\s'"]+\.(ts|js|tsx|jsx|json|md|py|rs|go|css|scss|html))/i
          );
          if (fileMatch) {
            lastFile = fileMatch[1];
            filesModified.add(fileMatch[1]);
          }

          // Also match paths like /src/foo.ts
          const pathMatch = line.match(
            /\/[\w\-\/]+\.(ts|js|tsx|jsx|json|md|py|rs|go|css|scss|html)\b/
          );
          if (pathMatch) {
            lastFile = pathMatch[0];
            filesModified.add(pathMatch[0]);
          }
        }
      } catch {
        // Ignore read errors
      }
    }

    // Calculate last activity (use file mtime)
    let lastActivity: string | undefined;
    if (fs.existsSync(logFile)) {
      try {
        const stat = fs.statSync(logFile);
        const mtime = stat.mtime;
        const now = new Date();
        const diffMs = now.getTime() - mtime.getTime();
        const diffSec = Math.floor(diffMs / 1000);

        if (diffSec < 60) {
          lastActivity = `${diffSec}s ago`;
        } else if (diffSec < 3600) {
          lastActivity = `${Math.floor(diffSec / 60)}m ago`;
        } else {
          lastActivity = `${Math.floor(diffSec / 3600)}h ago`;
        }
      } catch {
        // Ignore stat errors
      }
    }

    // Calculate running time
    let runningFor: string | undefined;
    if (startedAt) {
      const startTime = new Date(startedAt);
      const now = new Date();
      const diffMs = now.getTime() - startTime.getTime();
      const diffSec = Math.floor(diffMs / 1000);
      const mins = Math.floor(diffSec / 60);
      const secs = diffSec % 60;
      runningFor = `${mins}m ${secs}s`;
    }

    // Get confidence score
    let confidence: AggregatedConfidence | undefined;
    if (basicResult.status === "running") {
      const confidenceResult = getWorkerConfidence(this.workerDir, featureId);
      if (confidenceResult) {
        confidence = confidenceResult;
      }
    }

    // Get enforcement monitoring info if available
    let enforcement: HeartbeatInfo["enforcement"] | undefined;
    if (this.enforcement && basicResult.status === "running") {
      const monitoringResult = this.enforcement.getMonitoringResult(sessionName);
      enforcement = {
        hasActiveProtocols: monitoringResult.hasActiveProtocols,
        alerts: monitoringResult.alerts.map(a => ({
          id: a.id,
          type: a.type,
          severity: a.severity,
          message: a.message,
        })),
        iterationCount: monitoringResult.stats.iterationCount,
        warningCount: monitoringResult.stats.warningCount,
      };

      // Check for any new alerts during this check
      const newAlerts = this.enforcement.checkAlerts(sessionName);
      if (newAlerts.length > 0) {
        // Add any new alerts not already in the list
        for (const alert of newAlerts) {
          if (!enforcement.alerts.some(a => a.id === alert.id)) {
            enforcement.alerts.push({
              id: alert.id,
              type: alert.type,
              severity: alert.severity,
              message: alert.message,
            });
          }
        }
      }
    }

    return {
      status: basicResult.status,
      lastToolUsed,
      lastFile,
      lastActivity,
      linesWritten,
      filesModified: Array.from(filesModified).slice(0, 10), // Limit to 10 files
      runningFor,
      confidence,
      enforcement,
    };
  }

  /**
   * Get modified files for a feature using git diff against snapshot branch.
   * This is the authoritative source - uses git to compare current HEAD with
   * the snapshot branch created before the worker started.
   * Falls back to log parsing if snapshot branch doesn't exist.
   *
   * @param featureId - The feature ID to check
   * @returns Promise resolving to array of file paths modified since the worker started
   */
  async getModifiedFilesForFeature(featureId: string): Promise<string[]> {
    const branchName = `swarm/${featureId}`;

    // Try git-based tracking first (authoritative)
    try {
      const { stdout } = await execFileAsync(
        "git", ["diff", "--name-only", branchName, "HEAD"],
        { cwd: this.projectDir }
      );
      const files = stdout.trim().split("\n").filter((f: string) => f && f.length > 0);
      if (files.length > 0) {
        return files;
      }
    } catch {
      // Snapshot branch doesn't exist or not a git repo - fall back to log parsing
    }

    // Fallback: parse worker log for file modifications
    return this.parseLogForModifiedFiles(featureId);
  }

  /**
   * Parse worker log to extract modified files (fallback method)
   * Used when git-based tracking is unavailable (no snapshot branch)
   *
   * @param featureId - The feature ID whose log to parse
   * @returns Array of file paths found in the log
   */
  private parseLogForModifiedFiles(featureId: string): string[] {
    const logFile = path.join(this.workerDir, `${featureId}.log`);
    const filesModified = new Set<string>();

    if (fs.existsSync(logFile)) {
      try {
        const log = fs.readFileSync(logFile, "utf-8");
        const lines = log.split("\n");

        for (const line of lines) {
          // Match file paths in tool output (Writing, Editing, Created - not Reading)
          const fileMatch = line.match(
            /(?:Writing|Editing|Created|Modified|file_path['":\s]+)([^\s'"]+\.[a-zA-Z]{1,10})/i
          );
          if (fileMatch) {
            filesModified.add(fileMatch[1]);
          }

          // Also match absolute paths
          const pathMatch = line.match(
            /\/[\w\-\/]+\.[a-zA-Z]{1,10}\b/
          );
          if (pathMatch) {
            filesModified.add(pathMatch[0]);
          }
        }
      } catch {
        // Ignore read errors
      }
    }

    return Array.from(filesModified);
  }

  /**
   * Get all modified files across all feature workers using git-based tracking.
   * Compares each swarm/* snapshot branch against HEAD to find all files
   * modified during the session. Falls back to parsing all worker logs
   * if git-based tracking is unavailable.
   *
   * @returns Array of unique file paths modified across all features
   */
  async getAllModifiedFiles(): Promise<string[]> {
    const modifiedFiles = new Set<string>();

    // Try git-based tracking first (authoritative)
    try {
      const { execSync } = await import("child_process");

      // Get all swarm/* branches
      const branchOutput = execSync("git branch --list swarm/*", {
        cwd: this.projectDir,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });

      const branches = branchOutput
        .split("\n")
        .map((b) => b.trim().replace(/^\*\s*/, ""))
        .filter((b) => b && b.length > 0 && b.startsWith("swarm/"));

      // Get files changed between each branch and HEAD
      for (const branch of branches) {
        try {
          const diffOutput = execSync(`git diff --name-only ${branch} HEAD`, {
            cwd: this.projectDir,
            encoding: "utf-8",
            stdio: ["pipe", "pipe", "pipe"],
          });
          const files = diffOutput.trim().split("\n").filter((f) => f);
          files.forEach((f) => modifiedFiles.add(f));
        } catch {
          // Ignore individual branch diff failures
        }
      }

      if (modifiedFiles.size > 0) {
        return Array.from(modifiedFiles);
      }
    } catch {
      // Not a git repo or git not available - fall back to log parsing
    }

    // Fallback: parse all worker logs for file modifications
    return this.parseAllLogsForModifiedFiles();
  }

  /**
   * Parse all worker logs to extract modified files (fallback method).
   * Used when git-based tracking is unavailable.
   *
   * @returns Array of unique file paths found across all worker logs
   */
  private parseAllLogsForModifiedFiles(): string[] {
    const modifiedFiles = new Set<string>();

    try {
      if (!fs.existsSync(this.workerDir)) {
        return [];
      }

      const files = fs.readdirSync(this.workerDir);
      const logFiles = files.filter((f) => f.endsWith(".log"));

      for (const logFile of logFiles) {
        try {
          const content = fs.readFileSync(
            path.join(this.workerDir, logFile),
            "utf-8"
          );

          // Extract file paths from Write tool calls
          const writeMatches = content.matchAll(
            /(?:Write|Writing)\s+(?:to\s+)?(?:file\s+)?['":']?\s*([^\s'":\n]+\.[a-zA-Z]{1,10})/gi
          );
          for (const match of writeMatches) {
            const filePath = match[1].trim();
            if (filePath && !filePath.includes("...")) {
              modifiedFiles.add(filePath);
            }
          }

          // Extract file paths from Edit tool calls
          const editMatches = content.matchAll(
            /(?:Edit|Editing)\s+(?:file\s+)?['":']?\s*([^\s'":\n]+\.[a-zA-Z]{1,10})/gi
          );
          for (const match of editMatches) {
            const filePath = match[1].trim();
            if (filePath && !filePath.includes("...")) {
              modifiedFiles.add(filePath);
            }
          }

          // Extract file_path parameters
          const filePathMatches = content.matchAll(
            /file_path['":\s]+([^\s'":\n]+\.[a-zA-Z]{1,10})/gi
          );
          for (const match of filePathMatches) {
            const filePath = match[1].trim();
            if (filePath && !filePath.includes("...")) {
              modifiedFiles.add(filePath);
            }
          }
        } catch {
          // Skip files we can't read
          continue;
        }
      }
    } catch (error) {
      console.error("Error parsing logs for modified files:", error);
    }

    return Array.from(modifiedFiles);
  }

  /**
   * Register a callback to be notified when workers complete or crash
   */
  onWorkerCompletion(callback: CompletionCallback): void {
    this.completionCallbacks.push(callback);
  }

  /**
   * Start monitoring workers for completion
   * Polls every 10 seconds to detect session exits
   */
  startCompletionMonitor(): void {
    if (this.monitorInterval) {
      return; // Already monitoring
    }

    this.monitorInterval = setInterval(async () => {
      try {
        await this.checkForCompletions();
      } catch (error) {
        console.error("Error checking for completions:", error);
      }
    }, 10000); // Check every 10 seconds
  }

  /**
   * Stop the completion monitor
   */
  stopCompletionMonitor(): void {
    if (this.monitorInterval) {
      clearInterval(this.monitorInterval);
      this.monitorInterval = null;
    }
  }

  /**
   * Check all tracked workers for completion and notify callbacks
   */
  private async checkForCompletions(): Promise<void> {
    const state = this.stateManager.load();
    if (!state) return;

    // Get list of in-progress features with workers
    const activeWorkers = state.features.filter(
      (f) => f.status === "in_progress" && f.workerId
    );

    for (const feature of activeWorkers) {
      if (!feature.workerId) continue;

      const currentStatus = await this.checkWorker(feature.workerId, 20);
      const lastStatus = this.lastKnownStatus.get(feature.id);

      // Track status changes
      if (lastStatus !== currentStatus.status) {
        this.lastKnownStatus.set(feature.id, currentStatus.status);

        // Notify on completion or crash (but not initial running status)
        if (
          lastStatus === "running" &&
          (currentStatus.status === "completed" ||
            currentStatus.status === "crashed")
        ) {
          // Stop enforcement monitoring for this worker
          if (this.enforcement && feature.workerId) {
            this.enforcement.stopMonitoring(feature.workerId);
          }

          // Notify all registered callbacks
          for (const callback of this.completionCallbacks) {
            try {
              callback(
                feature.id,
                currentStatus.status,
                currentStatus.output
              );
            } catch (error) {
              console.error("Error in completion callback:", error);
            }
          }
        }
      }

      // Initialize tracking for new workers
      if (!lastStatus && currentStatus.status === "running") {
        this.lastKnownStatus.set(feature.id, "running");
      }
    }

    // Clean up tracking for completed features
    for (const [featureId] of this.lastKnownStatus) {
      const feature = state.features.find((f) => f.id === featureId);
      if (!feature || feature.status !== "in_progress") {
        this.lastKnownStatus.delete(featureId);
      }
    }
  }

  /**
   * Analyze potential conflicts between features for parallel execution
   * Extracts file/component hints from descriptions and detects overlaps
   */
  analyzeFeatureConflicts(
    features: Feature[]
  ): Array<{ feature1: string; feature2: string; reason: string }> {
    const conflicts: Array<{
      feature1: string;
      feature2: string;
      reason: string;
    }> = [];

    // Extract file/component hints from each feature description
    const featureHints = features.map((feature) => {
      const desc = feature.description.toLowerCase();

      // Extract potential file paths
      const fileMatches = desc.match(
        /(?:[\w\-\/]+\.(ts|js|tsx|jsx|json|md|py|rs|go|css|scss|html|vue|svelte))/gi
      ) || [];

      // Extract component/module names
      const componentMatches = desc.match(
        /(?:component|module|service|controller|handler|model|route|api|endpoint|hook|context|store|page|layout)\s*['":]?\s*(\w+)/gi
      ) || [];

      // Extract folder/directory hints
      const folderMatches = desc.match(
        /(?:in|under|to|from|inside)\s+(?:the\s+)?['"\/]?(src|lib|app|components|pages|routes|api|services|utils|hooks|stores|models|controllers|handlers|config)(?:\/[\w\-]+)*/gi
      ) || [];

      // Extract action keywords that may conflict
      const actionMatches = desc.match(
        /(?:refactor|rewrite|restructure|redesign|overhaul|migrate)\s+(?:the\s+)?(\w+)/gi
      ) || [];

      return {
        id: feature.id,
        description: feature.description,
        files: fileMatches.map((f) => f.toLowerCase()),
        components: componentMatches.map((c) => c.toLowerCase()),
        folders: folderMatches.map((f) => f.toLowerCase()),
        actions: actionMatches.map((a) => a.toLowerCase()),
      };
    });

    // Compare each pair of features for potential conflicts
    for (let i = 0; i < featureHints.length; i++) {
      for (let j = i + 1; j < featureHints.length; j++) {
        const hint1 = featureHints[i];
        const hint2 = featureHints[j];

        // Check for overlapping files
        const fileOverlap = hint1.files.filter((f) => hint2.files.includes(f));
        if (fileOverlap.length > 0) {
          conflicts.push({
            feature1: hint1.id,
            feature2: hint2.id,
            reason: `Both may modify file(s): ${fileOverlap.join(", ")}`,
          });
          continue;
        }

        // Check for overlapping components
        const componentOverlap = hint1.components.filter((c) =>
          hint2.components.includes(c)
        );
        if (componentOverlap.length > 0) {
          conflicts.push({
            feature1: hint1.id,
            feature2: hint2.id,
            reason: `Both may modify component(s): ${componentOverlap.join(", ")}`,
          });
          continue;
        }

        // Check for overlapping folders
        const folderOverlap = hint1.folders.filter((f) =>
          hint2.folders.includes(f)
        );
        if (folderOverlap.length > 0) {
          conflicts.push({
            feature1: hint1.id,
            feature2: hint2.id,
            reason: `Both may modify folder(s): ${folderOverlap.join(", ")}`,
          });
          continue;
        }

        // Check for dangerous action combinations
        if (hint1.actions.length > 0 && hint2.actions.length > 0) {
          const actionOverlap = hint1.actions.filter((a) =>
            hint2.actions.some((a2) => a.includes(a2) || a2.includes(a))
          );
          if (actionOverlap.length > 0) {
            conflicts.push({
              feature1: hint1.id,
              feature2: hint2.id,
              reason: `Both involve major changes: ${hint1.actions[0]}, ${hint2.actions[0]}`,
            });
          }
        }
      }
    }

    return conflicts;
  }

  /**
   * Kill a specific worker session
   */
  async killWorker(sessionName: string): Promise<void> {
    // Validate session name
    if (!validateSessionName(sessionName)) {
      return;
    }

    try {
      await execFileAsync("tmux", ["kill-session", "-t", sessionName]);
    } catch {
      // Session might already be dead, that's fine
    }
  }

  /**
   * Kill all worker sessions for this project
   */
  async killAllWorkers(): Promise<void> {
    try {
      // List all sessions
      let sessions = "";
      try {
        const result = await execFileAsync("tmux", [
          "list-sessions",
          "-F",
          "#{session_name}",
        ]);
        sessions = result.stdout;
      } catch {
        sessions = "";
      }

      const workerSessions = sessions
        .split("\n")
        .filter((s) => s.startsWith("cc-worker-") && validateSessionName(s));

      for (const session of workerSessions) {
        if (session) {
          await this.killWorker(session);
        }
      }

      // Clean up worker files
      if (fs.existsSync(this.workerDir)) {
        const files = fs.readdirSync(this.workerDir);
        for (const file of files) {
          const filePath = path.join(this.workerDir, file);
          try {
            fs.unlinkSync(filePath);
          } catch {
            // Ignore errors during cleanup
          }
        }
      }
    } catch (error) {
      console.error("Error killing workers:", error);
    }
  }

  /**
   * Create a snapshot branch before starting a worker.
   * This allows rollback if the worker causes issues by preserving
   * the state of HEAD before any worker modifications.
   *
   * Branch naming: swarm/{featureId}
   *
   * @param featureId - The feature ID to create a snapshot for
   * @returns Object containing:
   *   - success: Whether the branch was created
   *   - branch: The branch name if successful
   *   - error: Error message if failed
   *
   * @remarks
   * If a snapshot branch already exists for this feature, it is deleted
   * and recreated to ensure a fresh snapshot at current HEAD.
   */
  async createSnapshotBranch(featureId: string): Promise<{ success: boolean; branch?: string; error?: string }> {
    const branchName = `swarm/${featureId}`;

    try {
      // Check if we're in a git repo
      await execFileAsync("git", ["rev-parse", "--git-dir"], { cwd: this.projectDir });
    } catch {
      return { success: false, error: "Not a git repository" };
    }

    try {
      // Delete existing branch if present (force fresh snapshot)
      try {
        await execFileAsync("git", ["branch", "-D", branchName], { cwd: this.projectDir });
      } catch {
        // Branch doesn't exist, that's fine
      }

      // Create new branch at current HEAD
      await execFileAsync("git", ["branch", branchName], { cwd: this.projectDir });

      return { success: true, branch: branchName };
    } catch (error) {
      return { success: false, error: `Failed to create snapshot branch: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  /**
   * Rollback files changed by a feature to their state before the worker started.
   * Uses the snapshot branch created by createSnapshotBranch() before the worker started.
   *
   * @param featureId - The feature ID to rollback
   * @param files - Optional list of specific files to rollback. If not provided,
   *                all files changed since the snapshot are rolled back.
   * @returns Object containing:
   *   - success: Whether the rollback succeeded
   *   - restoredFiles: List of files that were restored (or removed if newly added)
   *   - error: Error message if failed
   *
   * @remarks
   * - Files that existed in the snapshot are restored to their snapshot state
   * - Files that were added after the snapshot are removed
   * - If specific files are provided, only those files are affected
   *
   * @warning Race condition: If other workers modified the same files, their changes
   * will also be reverted. Use validate_workers to check for conflicts before rollback.
   */
  async rollbackFeature(featureId: string, files?: string[]): Promise<{ success: boolean; restoredFiles?: string[]; error?: string }> {
    const branchName = `swarm/${featureId}`;

    try {
      // Check if branch exists
      await execFileAsync("git", ["rev-parse", "--verify", branchName], { cwd: this.projectDir });
    } catch {
      return { success: false, error: `Snapshot branch ${branchName} not found. Was this feature started with rollback support?` };
    }

    try {
      const restoredFiles: string[] = [];

      if (files && files.length > 0) {
        // Rollback specific files with path validation
        const skippedFiles: string[] = [];

        for (const file of files) {
          // Security: Validate file path to prevent path traversal
          if (!file || file.length === 0) {
            continue; // Skip empty strings
          }
          if (file.includes('..')) {
            skippedFiles.push(`${file} (path traversal rejected)`);
            continue;
          }
          if (path.isAbsolute(file)) {
            skippedFiles.push(`${file} (absolute path rejected)`);
            continue;
          }
          // Normalize and ensure path stays within project
          const normalizedPath = path.normalize(file);
          if (normalizedPath.startsWith('..')) {
            skippedFiles.push(`${file} (path escapes project)`);
            continue;
          }

          try {
            await execFileAsync("git", ["checkout", branchName, "--", normalizedPath], { cwd: this.projectDir });
            restoredFiles.push(normalizedPath);
          } catch (fileError) {
            // File might not exist in snapshot - try to remove if it was added
            try {
              await execFileAsync("git", ["rm", "-f", normalizedPath], { cwd: this.projectDir });
              restoredFiles.push(`${normalizedPath} (removed)`);
            } catch {
              // Ignore files that can't be restored
            }
          }
        }

        // Include skipped files in response for visibility
        if (skippedFiles.length > 0) {
          restoredFiles.push(...skippedFiles);
        }
      } else {
        // Get list of files changed since snapshot
        const { stdout: diffOutput } = await execFileAsync(
          "git", ["diff", "--name-only", branchName, "HEAD"],
          { cwd: this.projectDir }
        );
        const changedFiles = diffOutput.trim().split("\n").filter(f => f);

        // Also check for new files not in snapshot
        const { stdout: newFilesOutput } = await execFileAsync(
          "git", ["diff", "--name-only", "--diff-filter=A", branchName, "HEAD"],
          { cwd: this.projectDir }
        );
        const newFiles = newFilesOutput.trim().split("\n").filter(f => f);

        // Remove new files
        for (const file of newFiles) {
          try {
            await execFileAsync("git", ["rm", "-f", file], { cwd: this.projectDir });
            restoredFiles.push(`${file} (removed)`);
          } catch {
            // Ignore
          }
        }

        // Restore modified/deleted files
        const modifiedFiles = changedFiles.filter(f => !newFiles.includes(f));
        for (const file of modifiedFiles) {
          try {
            await execFileAsync("git", ["checkout", branchName, "--", file], { cwd: this.projectDir });
            restoredFiles.push(file);
          } catch {
            // Ignore files that can't be restored
          }
        }
      }

      return { success: true, restoredFiles };
    } catch (error) {
      return { success: false, error: `Rollback failed: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  /**
   * Delete a snapshot branch after successful feature completion.
   * Called automatically by mark_complete when a feature succeeds.
   *
   * @param featureId - The feature ID whose snapshot branch to delete
   *
   * @remarks
   * This method is idempotent - it silently succeeds if the branch doesn't exist.
   */
  async deleteSnapshotBranch(featureId: string): Promise<void> {
    const branchName = `swarm/${featureId}`;
    try {
      await execFileAsync("git", ["branch", "-D", branchName], { cwd: this.projectDir });
    } catch {
      // Branch might not exist, that's fine
    }
  }

  /**
   * Clean up all swarm/* snapshot branches.
   * Called during orchestrator_reset to remove accumulated branches.
   *
   * @returns The number of branches successfully deleted
   *
   * @remarks
   * This method finds all branches matching the pattern `swarm/*` and
   * deletes them. Individual branch deletion failures are silently ignored.
   */
  async cleanupAllSnapshotBranches(): Promise<number> {
    try {
      // List all swarm/* branches
      const { stdout } = await execFileAsync(
        "git", ["branch", "--list", "swarm/*"],
        { cwd: this.projectDir }
      );

      const branches = stdout.split("\n")
        .map(b => b.trim().replace(/^\*\s*/, ""))
        .filter(b => b && b.length > 0 && b.startsWith("swarm/"));

      let deleted = 0;
      for (const branch of branches) {
        try {
          await execFileAsync("git", ["branch", "-D", branch], { cwd: this.projectDir });
          deleted++;
        } catch {
          // Ignore individual branch deletion failures
        }
      }

      return deleted;
    } catch {
      // Not a git repo or other error
      return 0;
    }
  }

  /**
   * Check for potential conflicts before rolling back a feature.
   * Compares files modified by the target feature against files modified
   * by other features to detect overlapping changes.
   *
   * @param targetFeatureId - The feature ID to check rollback conflicts for
   * @param allFeatures - Array of all features in the session
   * @returns Object containing:
   *   - hasConflicts: Whether any conflicts were detected
   *   - conflicts: Array of conflicting features with shared files
   *   - targetFiles: Files that would be rolled back
   *
   * @remarks
   * Use this before calling rollbackFeature() in parallel worker environments
   * to detect if rolling back would affect changes from other workers.
   */
  async checkRollbackConflicts(
    targetFeatureId: string,
    allFeatures: Array<{ id: string; status: string; modifiedFiles?: string[] }>
  ): Promise<{
    hasConflicts: boolean;
    conflicts: Array<{
      featureId: string;
      status: string;
      sharedFiles: string[];
    }>;
    targetFiles: string[];
  }> {
    // Get files modified by the target feature
    const targetFiles = await this.getModifiedFilesForFeature(targetFeatureId);

    if (targetFiles.length === 0) {
      return { hasConflicts: false, conflicts: [], targetFiles: [] };
    }

    const targetFileSet = new Set(targetFiles);
    const conflicts: Array<{
      featureId: string;
      status: string;
      sharedFiles: string[];
    }> = [];

    // Check each other feature for file overlaps
    for (const feature of allFeatures) {
      if (feature.id === targetFeatureId) continue;
      if (feature.status === "pending") continue; // Hasn't run yet

      // Get modified files for this feature
      let featureFiles: string[] = [];
      if (feature.modifiedFiles && feature.modifiedFiles.length > 0) {
        // Use cached data if available
        featureFiles = feature.modifiedFiles;
      } else if (feature.status === "in_progress" || feature.status === "completed" || feature.status === "failed") {
        // Query git/logs for this feature's changes
        featureFiles = await this.getModifiedFilesForFeature(feature.id);
      }

      // Find shared files
      const sharedFiles = featureFiles.filter(f => targetFileSet.has(f));

      if (sharedFiles.length > 0) {
        conflicts.push({
          featureId: feature.id,
          status: feature.status,
          sharedFiles,
        });
      }
    }

    return {
      hasConflicts: conflicts.length > 0,
      conflicts,
      targetFiles,
    };
  }

  /**
   * Start a review worker (code or architecture review)
   * Similar to planner workers: read-only tools + Write for findings file
   * Returns a unique session name for tracking
   */
  async startReviewWorker(
    type: "code" | "architecture",
    prompt: string
  ): Promise<StartWorkerResult> {
    const timestamp = Date.now().toString(36);
    const sessionName = `cc-reviewer-${type}-${timestamp}`;

    // Check if tmux is available
    try {
      await execFileAsync("which", ["tmux"]);
    } catch {
      return {
        success: false,
        error: "tmux is not installed. Please install tmux first.",
      };
    }

    try {
      // Write prompt to a file
      const promptFile = path.join(
        this.workerDir,
        `${type}-review.prompt`
      );
      fs.writeFileSync(promptFile, prompt, { mode: 0o600 });

      const logFile = path.join(
        this.workerDir,
        `${type}-review.log`
      );

      // Create wrapper script with read-only tools + Write for findings file
      const wrapperScript = path.join(
        this.workerDir,
        `${type}-review.sh`
      );
      const scriptContent = `#!/bin/bash
set -e
cd ${shellQuote(this.projectDir)}
PROMPT=$(cat ${shellQuote(promptFile)})
# Prefer claude-code for Max plan compatibility (uses session auth, not API credits)
# Falls back to claude (API mode) if claude-code is unavailable
# Note: Bash intentionally excluded for security - reviewers don't need shell access
if command -v claude-code &> /dev/null; then
  claude-code -p "$PROMPT" --allowedTools Read,Glob,Grep,Write 2>&1 | tee ${shellQuote(logFile)}
else
  claude -p "$PROMPT" --allowedTools Read,Glob,Grep,Write 2>&1 | tee ${shellQuote(logFile)}
fi
echo 'REVIEWER_EXITED' >> ${shellQuote(logFile)}
`;
      fs.writeFileSync(wrapperScript, scriptContent, { mode: 0o700 });

      // Start tmux session
      await execFileAsync("tmux", [
        "new-session",
        "-d",
        "-s",
        sessionName,
        "-c",
        this.projectDir,
        "bash",
        wrapperScript,
      ]);

      // Create status file
      const statusFile = path.join(
        this.workerDir,
        `${type}-review.status`
      );
      fs.writeFileSync(
        statusFile,
        JSON.stringify({
          sessionName,
          type,
          startedAt: new Date().toISOString(),
          status: "running",
          mode: "review",
        })
      );

      return {
        success: true,
        sessionName,
      };
    } catch (error: any) {
      return {
        success: false,
        error: sanitizeOutput(error.message),
      };
    }
  }

  /**
   * Read review findings file for a specific review type
   * Validates findings against Zod schema for type safety
   */
  readReviewFindings(type: "code" | "architecture"): ReviewFindings | null {
    const findingsFile = path.join(
      this.workerDir,
      `${type}-review.findings.json`
    );

    try {
      if (fs.existsSync(findingsFile)) {
        const content = fs.readFileSync(findingsFile, "utf-8");
        const parsed = JSON.parse(content);
        const validated = ReviewFindingsSchema.safeParse(parsed);
        if (validated.success) {
          return validated.data;
        }
        console.error(
          `Invalid ${type} review findings format:`,
          validated.error.issues
        );
      }
    } catch (error) {
      console.error(`Error reading ${type} review findings:`, error);
    }
    return null;
  }

  /**
   * Check if a review worker session is still running
   * Note: Review workers use different session naming (cc-reviewer-*) and completion
   * detection (findings.json file instead of .done file), so we handle them separately
   * from regular workers.
   */
  async checkReviewWorker(
    type: "code" | "architecture",
    lines: number = 50
  ): Promise<CheckWorkerResult> {
    // Find the session name from status file
    const statusFile = path.join(this.workerDir, `${type}-review.status`);

    if (!fs.existsSync(statusFile)) {
      return { status: "not_found" };
    }

    let sessionName: string;
    try {
      const statusContent = JSON.parse(fs.readFileSync(statusFile, "utf-8"));
      sessionName = statusContent.sessionName;

      if (!sessionName || !validateSessionName(sessionName)) {
        return { status: "not_found" };
      }
    } catch (error) {
      return { status: "not_found" };
    }

    // Check if tmux session exists
    let sessionExists = false;
    try {
      const result = await execFileAsync("tmux", [
        "list-sessions",
        "-F",
        "#{session_name}",
      ]);
      sessionExists = result.stdout.includes(sessionName);
    } catch {
      // tmux might not be running, treat as no sessions
      sessionExists = false;
    }

    if (sessionExists) {
      // Session is running - capture output
      try {
        const { stdout: output } = await execFileAsync("tmux", [
          "capture-pane",
          "-t",
          sessionName,
          "-p",
          "-S",
          `-${Math.min(lines, 500)}`,
        ]);
        return {
          status: "running",
          output: this.truncateOutputLines(sanitizeOutput(output || "")),
        };
      } catch {
        return { status: "running", output: "Unable to capture output" };
      }
    }

    // Session has ended - check for findings file (indicates successful completion)
    const findingsFile = path.join(this.workerDir, `${type}-review.findings.json`);
    if (fs.existsSync(findingsFile)) {
      // Read log file for context
      const logFile = path.join(this.workerDir, `${type}-review.log`);
      let output = "Review completed successfully.";
      if (fs.existsSync(logFile)) {
        const log = fs.readFileSync(logFile, "utf-8");
        const lastLines = log.split("\n").slice(-lines).join("\n");
        output = `Review completed.\n\nLast output:\n${this.truncateOutputLines(sanitizeOutput(lastLines))}`;
      }
      return { status: "completed", output };
    }

    // No findings file - check log for crash/exit info
    const logFile = path.join(this.workerDir, `${type}-review.log`);
    if (fs.existsSync(logFile)) {
      const log = fs.readFileSync(logFile, "utf-8");
      const lastLines = log.split("\n").slice(-lines).join("\n");
      return {
        status: "crashed",
        output: `Review worker exited without producing findings.\n\nLast output:\n${this.truncateOutputLines(sanitizeOutput(lastLines))}`,
      };
    }

    return { status: "not_found", output: "Review worker session not found and no logs available." };
  }

  /**
   * Wait for a worker to complete (blocking)
   */
  async waitForWorker(
    sessionName: string,
    timeoutMs: number = 3600000
  ): Promise<CheckWorkerResult> {
    if (!validateSessionName(sessionName)) {
      return {
        status: "not_found",
        output: "Invalid session name",
      };
    }

    const startTime = Date.now();
    const pollInterval = 5000; // Check every 5 seconds

    while (Date.now() - startTime < timeoutMs) {
      const result = await this.checkWorker(sessionName);

      if (result.status !== "running") {
        return result;
      }

      // Wait before checking again
      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }

    return {
      status: "crashed",
      output: "Worker timed out",
    };
  }
}
