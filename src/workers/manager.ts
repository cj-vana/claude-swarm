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
import {
  validateFeatureId,
  validateSessionName,
  shellQuote,
  sanitizeOutput,
} from "../utils/security.js";
import {
  getWorkerConfidence,
  AggregatedConfidence,
} from "./confidence.js";

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

interface StartWorkerResult {
  success: boolean;
  sessionName?: string;
  error?: string;
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
4. When you are DONE, create a file at: .claude/orchestrator/workers/${feature.id}.done
   with a brief summary of what you implemented
5. Do NOT commit your changes - the orchestrator will handle commits

## Important
- Do not work on other features
- If you encounter a blocker, document it in the .done file and stop
- Keep changes minimal and focused
- NEVER commit, stage, or git add ANY of these files:
  - .claude/ (entire directory - orchestrator state, logs, prompts, worker files)
  - claude-progress.txt
  - init.sh
  - *.prompt, *.log, *.done, *.status files in .claude/

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
# Planning mode: only read-only tools plus Write for the plan file
claude -p "$PROMPT" --allowedTools Read,Glob,Grep,Write 2>&1 | tee ${shellQuote(logFile)}
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
   */
  readPlanFile(featureId: string): any | null {
    const planFile = path.join(this.workerDir, `${featureId}.plan.json`);
    try {
      if (fs.existsSync(planFile)) {
        const content = fs.readFileSync(planFile, "utf-8");
        return JSON.parse(content);
      }
    } catch {
      // Return null if parsing fails
    }
    return null;
  }

  /**
   * Start a worker in a tmux session
   * Security: Uses file-based prompt passing to avoid shell injection
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

    const sessionName = this.generateSessionName(feature.id);
    const prompt = this.buildWorkerPrompt(feature, customPrompt);

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
claude -p "$PROMPT" --allowedTools Bash,Read,Write,Edit,Glob,Grep 2>&1 | tee ${shellQuote(logFile)}
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
            output: `Worker completed.\n\nSummary:\n${sanitizeOutput(summary)}`,
          };
        }

        // Check log file for crash info
        const logFile = path.join(this.workerDir, `${featureId}.log`);
        if (fs.existsSync(logFile)) {
          const log = fs.readFileSync(logFile, "utf-8");
          const lastLines = log.split("\n").slice(-lines).join("\n");
          return {
            status: "crashed",
            output: `Worker session ended unexpectedly.\n\nLast output:\n${sanitizeOutput(lastLines)}`,
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

      // If tmux capture is empty, try reading from log file as fallback
      if (!output || output.trim() === "") {
        const featureId = this.extractFeatureId(sessionName);
        if (featureId) {
          const logFile = path.join(this.workerDir, `${featureId}.log`);
          if (fs.existsSync(logFile)) {
            const log = fs.readFileSync(logFile, "utf-8");
            if (log.length > 0) {
              const lastLines = log.split("\n").slice(-lines).join("\n");
              return {
                status: "running",
                output: `(from log file)\n${sanitizeOutput(lastLines)}`,
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

      return {
        status: "running",
        output: sanitizeOutput(output),
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

    return {
      status: basicResult.status,
      lastToolUsed,
      lastFile,
      lastActivity,
      linesWritten,
      filesModified: Array.from(filesModified).slice(0, 10), // Limit to 10 files
      runningFor,
      confidence,
    };
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
