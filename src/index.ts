#!/usr/bin/env node
/**
 * Claude Swarm - MCP Server for Orchestrating Parallel Claude Code Workers
 *
 * Inspired by:
 * - Anthropic's "Effective harnesses for long-running agents"
 * - "Solving a Million-Step LLM Task with Zero Errors" (MAKER framework)
 * - Multi-Agent Collaboration via Evolving Orchestration
 *
 * This MCP server manages long-running coding tasks by:
 * 1. Maintaining persistent state outside Claude's context
 * 2. Orchestrating multiple worker Claude Code sessions via tmux
 * 3. Tracking progress through structured files (notebook pattern)
 * 4. Enabling graceful recovery after context compaction
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { StateManager, OrchestratorState, Feature, WorkerStatus } from "./state/manager.js";
import { WorkerManager } from "./workers/manager.js";
import { generateFeatureList } from "./utils/feature-generator.js";
import { formatDuration, formatPercent, formatDurationMs, calculateAverage } from "./utils/format.js";
import {
  validateProjectDir,
  validateFeatureId,
  validateCommand,
  sanitizeOutput,
} from "./utils/security.js";
import { startDashboardServer, DashboardServer } from "./dashboard/server.js";
import { analyzeComplexity, formatComplexityResult } from "./utils/complexity-detector.js";
import { evaluatePlans, parsePlanFromFile, formatEvaluationResult } from "./utils/plan-evaluator.js";
import { getWorkerConfidence, formatConfidenceResult } from "./workers/confidence.js";

// Dashboard configuration from environment variables
const DASHBOARD_PORT = parseInt(process.env.DASHBOARD_PORT || "3456", 10);
const ENABLE_DASHBOARD = process.env.ENABLE_DASHBOARD !== "false"; // Default: true

// Dashboard server instance (started when first project is initialized)
let dashboardServer: DashboardServer | null = null;

// Initialize MCP server
const server = new McpServer({
  name: "claude-swarm",
  version: "0.1.0",
});

// State and worker managers (initialized per-project)
let stateManager: StateManager | null = null;
let workerManager: WorkerManager | null = null;

/**
 * Initialize managers for a project directory
 * Security: Validates project directory to prevent path traversal
 */
async function ensureInitialized(projectDir: string): Promise<{ state: StateManager; workers: WorkerManager }> {
  // Validate project directory (throws on invalid path)
  const validatedDir = validateProjectDir(projectDir);

  if (!stateManager || stateManager.projectDir !== validatedDir) {
    stateManager = new StateManager(validatedDir);
    workerManager = new WorkerManager(validatedDir, stateManager);

    // Register completion callback to log when workers complete/crash
    workerManager.onWorkerCompletion((featureId, status, output) => {
      const currentState = stateManager?.load();
      if (currentState) {
        const feature = currentState.features.find((f) => f.id === featureId);
        const shortOutput = output ? output.slice(0, 100).replace(/\n/g, " ") : "";
        const logMessage =
          status === "completed"
            ? `[${new Date().toISOString()}] 🔔 Worker completed: ${featureId} - use mark_complete to update status`
            : `[${new Date().toISOString()}] ⚠️ Worker crashed: ${featureId}${shortOutput ? ` - ${shortOutput}...` : ""} - use mark_complete to update status`;
        currentState.progressLog.push(logMessage);
        currentState.lastUpdated = new Date().toISOString();
        stateManager?.save(currentState);
        // Also log to stderr for immediate visibility
        console.error(logMessage);
      }
    });

    // Start the completion monitor
    workerManager.startCompletionMonitor();

    // Start dashboard server if enabled and not already running
    if (ENABLE_DASHBOARD && !dashboardServer) {
      try {
        // Pass a getter function so dashboard always has current stateManager
        dashboardServer = await startDashboardServer(() => stateManager, {
          port: DASHBOARD_PORT,
          host: "127.0.0.1",
        });
        console.error(`📊 Dashboard available at http://127.0.0.1:${DASHBOARD_PORT}`);
      } catch (err: any) {
        // Log error but don't fail - dashboard is optional
        console.error(`⚠️ Failed to start dashboard server: ${err.message}`);
      }
    }
  }

  // TypeScript safety: workerManager is always set when stateManager is set
  if (!workerManager) {
    throw new Error("WorkerManager not initialized");
  }

  return { state: stateManager, workers: workerManager };
}

// ============================================================================
// TOOL: orchestrator_init
// ============================================================================
server.tool(
  "orchestrator_init",
  "Initialize a new long-running orchestration session. Call this first with a task description to set up the feature list, progress tracking, and environment.",
  {
    projectDir: z.string().describe("Absolute path to the project directory"),
    taskDescription: z.string().describe("Full description of what needs to be built/accomplished"),
    existingFeatures: z.array(z.string()).optional().describe("Optional: List of feature descriptions if you've already analyzed the task"),
  },
  async ({ projectDir, taskDescription, existingFeatures }) => {
    const { state } = await ensureInitialized(projectDir);

    // Check if session already exists
    const existing = state.load();
    if (existing && existing.status === "in_progress") {
      return {
        content: [
          {
            type: "text",
            text: `⚠️ Active session already exists!\n\nStarted: ${existing.startTime}\nFeatures: ${existing.features.length} total, ${existing.features.filter(f => f.status === "completed").length} completed\n\nUse orchestrator_status to see current state, or orchestrator_reset to start fresh.`,
          },
        ],
      };
    }

    // Generate features from task description
    const features: Feature[] = existingFeatures
      ? existingFeatures.map((desc, i) => ({
          id: `feature-${i + 1}`,
          description: desc,
          status: "pending" as const,
          attempts: 0,
        }))
      : generateFeatureList(taskDescription);

    // Initialize state
    const newState: OrchestratorState = {
      projectDir,
      taskDescription,
      features,
      workers: [],
      status: "in_progress",
      startTime: new Date().toISOString(),
      lastUpdated: new Date().toISOString(),
      progressLog: [`[${new Date().toISOString()}] Orchestration initialized with ${features.length} features`],
    };

    state.save(newState);
    state.writeProgressFile();
    state.writeInitScript();

    return {
      content: [
        {
          type: "text",
          text: `✅ Orchestration initialized!\n\nProject: ${projectDir}\nFeatures: ${features.length}\n\nFeature List:\n${features.map((f, i) => `${i + 1}. [${f.status}] ${f.description}`).join("\n")}\n\nNext steps:\n1. Review the features above\n2. Use start_worker to begin work on the first feature\n3. Use orchestrator_status to monitor progress`,
        },
      ],
    };
  }
);

// ============================================================================
// TOOL: orchestrator_status
// ============================================================================
server.tool(
  "orchestrator_status",
  "Get the current status of the orchestration session. Call this after context compaction to restore state, or anytime to check progress.",
  {
    projectDir: z.string().describe("Absolute path to the project directory"),
  },
  async ({ projectDir }) => {
    const { state, workers } = await ensureInitialized(projectDir);
    const current = state.load();

    if (!current) {
      return {
        content: [
          {
            type: "text",
            text: "No active orchestration session. Use orchestrator_init to start one.",
          },
        ],
      };
    }

    // Update worker statuses from tmux
    const workerStatuses = await workers.checkAllWorkers();

    const completed = current.features.filter(f => f.status === "completed");
    const failed = current.features.filter(f => f.status === "failed");
    const inProgress = current.features.filter(f => f.status === "in_progress");
    const pending = current.features.filter(f => f.status === "pending");

    const elapsed = formatDuration(new Date(current.startTime), new Date());

    let statusText = `📊 Orchestration Status\n`;
    statusText += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    statusText += `Project: ${current.projectDir}\n`;
    statusText += `Status: ${current.status}\n`;
    statusText += `Elapsed: ${elapsed}\n\n`;

    statusText += `📋 Features:\n`;
    statusText += `  ✅ Completed: ${completed.length}\n`;
    statusText += `  🔄 In Progress: ${inProgress.length}\n`;
    statusText += `  ⏳ Pending: ${pending.length}\n`;
    statusText += `  ❌ Failed: ${failed.length}\n\n`;

    if (inProgress.length > 0) {
      statusText += `🔄 Currently Working On:\n`;
      for (const f of inProgress) {
        statusText += `  - ${f.id}: ${f.description}\n`;
        const worker = workerStatuses.find(w => w.featureId === f.id);
        if (worker) {
          statusText += `    Worker: ${worker.sessionName} (${worker.status})\n`;
        }
      }
      statusText += `\n`;
    }

    if (pending.length > 0) {
      statusText += `⏳ Next Up:\n`;
      for (const f of pending.slice(0, 3)) {
        statusText += `  - ${f.id}: ${f.description}\n`;
      }
      if (pending.length > 3) {
        statusText += `  ... and ${pending.length - 3} more\n`;
      }
      statusText += `\n`;
    }

    if (failed.length > 0) {
      statusText += `❌ Failed (may need manual intervention):\n`;
      for (const f of failed) {
        statusText += `  - ${f.id}: ${f.description}\n`;
        if (f.lastError) {
          statusText += `    Error: ${f.lastError}\n`;
        }
      }
      statusText += `\n`;
    }

    // Recent progress log
    statusText += `📝 Recent Progress:\n`;
    const recentLogs = current.progressLog.slice(-5);
    for (const log of recentLogs) {
      statusText += `  ${log}\n`;
    }

    return {
      content: [{ type: "text", text: statusText }],
    };
  }
);

// ============================================================================
// TOOL: start_worker
// ============================================================================
server.tool(
  "start_worker",
  "Start a Claude Code worker in a tmux session to work on a specific feature. The worker will run autonomously.",
  {
    projectDir: z.string().describe("Absolute path to the project directory"),
    featureId: z.string().describe("ID of the feature to work on (e.g., 'feature-1')"),
    customPrompt: z.string().optional().describe("Optional custom prompt to give the worker additional context"),
  },
  async ({ projectDir, featureId, customPrompt }) => {
    const { state, workers } = await ensureInitialized(projectDir);

    // Validate feature ID format
    try {
      validateFeatureId(featureId);
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `Invalid feature ID: ${error.message}` }],
      };
    }

    const current = state.load();

    if (!current) {
      return {
        content: [{ type: "text", text: "No active session. Use orchestrator_init first." }],
      };
    }

    const feature = current.features.find(f => f.id === featureId);
    if (!feature) {
      return {
        content: [{ type: "text", text: `Feature '${featureId}' not found. Available: ${current.features.map(f => f.id).join(", ")}` }],
      };
    }

    if (feature.status === "completed") {
      return {
        content: [{ type: "text", text: `Feature '${featureId}' is already completed.` }],
      };
    }

    // Check if dependencies are met
    if (feature.dependsOn && feature.dependsOn.length > 0) {
      const unmetDeps: string[] = [];
      for (const depId of feature.dependsOn) {
        const depFeature = current.features.find(f => f.id === depId);
        if (!depFeature || depFeature.status !== "completed") {
          unmetDeps.push(depId);
        }
      }
      if (unmetDeps.length > 0) {
        return {
          content: [
            {
              type: "text",
              text: `❌ Cannot start feature '${featureId}' - dependencies not met.\n\nUnmet dependencies: ${unmetDeps.join(", ")}\n\nComplete these features first before starting ${featureId}.`,
            },
          ],
        };
      }
    }

    // Start the worker
    const result = await workers.startWorker(feature, customPrompt);

    if (result.success) {
      // Update feature status
      feature.status = "in_progress";
      feature.attempts++;
      feature.workerId = result.sessionName;
      feature.startedAt = new Date().toISOString();
      current.lastUpdated = new Date().toISOString();
      current.progressLog.push(`[${new Date().toISOString()}] Started worker for ${featureId}: ${feature.description}`);
      state.save(current);
      state.writeProgressFile();

      return {
        content: [
          {
            type: "text",
            text: `🚀 Worker started!\n\nSession: ${result.sessionName}\nFeature: ${feature.description}\n\n⏱️ IMPORTANT: Wait 2-3 minutes before checking worker output.\nWorkers typically take 5-10 minutes per feature.\n\nRun: sleep 180  (then check_worker)\n\nOr monitor directly: tmux attach -t ${result.sessionName}`,
          },
        ],
      };
    } else {
      return {
        content: [{ type: "text", text: `❌ Failed to start worker: ${result.error}` }],
      };
    }
  }
);

// ============================================================================
// TOOL: start_parallel_workers
// ============================================================================
server.tool(
  "start_parallel_workers",
  "Start multiple Claude Code workers simultaneously for independent features. Each worker runs in its own tmux session.",
  {
    projectDir: z.string().describe("Absolute path to the project directory"),
    featureIds: z.array(z.string()).min(1).max(10).describe("Array of feature IDs to start (e.g., ['feature-1', 'feature-2']). Maximum 10 workers at once."),
    customPrompts: z.record(z.string(), z.string()).optional().describe("Optional: Map of feature IDs to custom prompts (e.g., {'feature-1': 'Additional context...'})"),
  },
  async ({ projectDir, featureIds, customPrompts }) => {
    const { state, workers } = await ensureInitialized(projectDir);

    const current = state.load();

    if (!current) {
      return {
        content: [{ type: "text", text: "No active session. Use orchestrator_init first." }],
      };
    }

    // Validate all feature IDs first
    const validationErrors: string[] = [];
    const featuresToStart: Feature[] = [];

    for (const featureId of featureIds) {
      // Validate feature ID format
      try {
        validateFeatureId(featureId);
      } catch (error: any) {
        validationErrors.push(`Invalid feature ID '${featureId}': ${error.message}`);
        continue;
      }

      const feature = current.features.find(f => f.id === featureId);
      if (!feature) {
        validationErrors.push(`Feature '${featureId}' not found`);
        continue;
      }

      if (feature.status === "completed") {
        validationErrors.push(`Feature '${featureId}' is already completed`);
        continue;
      }

      if (feature.status === "in_progress") {
        validationErrors.push(`Feature '${featureId}' is already in progress`);
        continue;
      }

      // Check if dependencies are met
      if (feature.dependsOn && feature.dependsOn.length > 0) {
        const unmetDeps: string[] = [];
        for (const depId of feature.dependsOn) {
          const depFeature = current.features.find(f => f.id === depId);
          if (!depFeature || depFeature.status !== "completed") {
            unmetDeps.push(depId);
          }
        }
        if (unmetDeps.length > 0) {
          validationErrors.push(`Feature '${featureId}' has unmet dependencies: ${unmetDeps.join(", ")}`);
          continue;
        }
      }

      featuresToStart.push(feature);
    }

    if (featuresToStart.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: `❌ No valid features to start.\n\nErrors:\n${validationErrors.map(e => `  - ${e}`).join("\n")}\n\nAvailable features: ${current.features.filter(f => f.status === "pending").map(f => f.id).join(", ")}`,
          },
        ],
      };
    }

    // Start all workers in parallel
    const results: Array<{
      featureId: string;
      success: boolean;
      sessionName?: string;
      error?: string;
    }> = [];

    const startPromises = featuresToStart.map(async (feature) => {
      const customPrompt = customPrompts?.[feature.id];
      const result = await workers.startWorker(feature, customPrompt);

      if (result.success) {
        // Update feature status
        feature.status = "in_progress";
        feature.attempts++;
        feature.workerId = result.sessionName;
        feature.startedAt = new Date().toISOString();
      }

      return {
        featureId: feature.id,
        success: result.success,
        sessionName: result.sessionName,
        error: result.error,
      };
    });

    const workerResults = await Promise.all(startPromises);
    results.push(...workerResults);

    // Update state with all changes
    current.lastUpdated = new Date().toISOString();
    const successfulStarts = results.filter(r => r.success);
    const failedStarts = results.filter(r => !r.success);

    if (successfulStarts.length > 0) {
      current.progressLog.push(
        `[${new Date().toISOString()}] Started ${successfulStarts.length} parallel workers: ${successfulStarts.map(r => r.featureId).join(", ")}`
      );
    }

    state.save(current);
    state.writeProgressFile();

    // Build response message
    let responseText = `🚀 Parallel Worker Launch Results\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;

    if (successfulStarts.length > 0) {
      responseText += `✅ Successfully started (${successfulStarts.length}):\n`;
      for (const result of successfulStarts) {
        const feature = current.features.find(f => f.id === result.featureId);
        responseText += `  - ${result.featureId}: ${feature?.description || "Unknown"}\n`;
        responseText += `    Session: ${result.sessionName}\n`;
      }
      responseText += `\n`;
    }

    if (failedStarts.length > 0) {
      responseText += `❌ Failed to start (${failedStarts.length}):\n`;
      for (const result of failedStarts) {
        responseText += `  - ${result.featureId}: ${result.error}\n`;
      }
      responseText += `\n`;
    }

    if (validationErrors.length > 0) {
      responseText += `⚠️ Skipped (${validationErrors.length}):\n`;
      for (const error of validationErrors) {
        responseText += `  - ${error}\n`;
      }
      responseText += `\n`;
    }

    responseText += `\n⏱️ IMPORTANT: Wait 2-3 minutes before checking worker output.\nWorkers typically take 5-10 minutes per feature.\n\nRun: sleep 180  (then check_worker)\nOr attach to sessions: tmux attach -t <session-name>`;

    return {
      content: [{ type: "text", text: responseText }],
    };
  }
);

// ============================================================================
// TOOL: validate_workers
// ============================================================================
server.tool(
  "validate_workers",
  "Pre-flight validation before starting parallel workers. Checks feature readiness, dependency chains, and potential conflicts.",
  {
    projectDir: z.string().describe("Absolute path to the project directory"),
    featureIds: z.array(z.string()).describe("Array of feature IDs to validate for parallel execution"),
  },
  async ({ projectDir, featureIds }) => {
    const { state, workers } = await ensureInitialized(projectDir);
    const current = state.load();

    if (!current) {
      return {
        content: [{ type: "text", text: "No active session. Use orchestrator_init first." }],
      };
    }

    const ready: Array<{ id: string; description: string }> = [];
    const issues: Array<{ id: string; reason: string }> = [];
    const warnings: Array<{ feature1: string; feature2: string; reason: string }> = [];

    // Validate each feature ID
    for (const featureId of featureIds) {
      // Validate feature ID format
      try {
        validateFeatureId(featureId);
      } catch (error: any) {
        issues.push({ id: featureId, reason: `Invalid feature ID: ${error.message}` });
        continue;
      }

      const feature = current.features.find((f) => f.id === featureId);
      if (!feature) {
        issues.push({ id: featureId, reason: "Feature not found" });
        continue;
      }

      if (feature.status === "completed") {
        issues.push({ id: featureId, reason: "Already completed" });
        continue;
      }

      if (feature.status === "in_progress") {
        issues.push({ id: featureId, reason: "Already in progress" });
        continue;
      }

      if (feature.status === "failed") {
        issues.push({ id: featureId, reason: "Previously failed - use retry_feature first" });
        continue;
      }

      // Check dependencies
      if (feature.dependsOn && feature.dependsOn.length > 0) {
        const unmetDeps: string[] = [];
        for (const depId of feature.dependsOn) {
          const depFeature = current.features.find((f) => f.id === depId);
          if (!depFeature || depFeature.status !== "completed") {
            unmetDeps.push(depId);
          }
        }
        if (unmetDeps.length > 0) {
          issues.push({
            id: featureId,
            reason: `Unmet dependencies: ${unmetDeps.join(", ")}`,
          });
          continue;
        }
      }

      // Feature is ready
      ready.push({ id: feature.id, description: feature.description });
    }

    // Analyze conflicts between ready features
    if (ready.length > 1) {
      const readyFeatures = ready.map((r) =>
        current.features.find((f) => f.id === r.id)!
      );
      const conflicts = workers.analyzeFeatureConflicts(readyFeatures);
      warnings.push(...conflicts);
    }

    // Build response
    let responseText = `🔍 Pre-flight Validation Results\n`;
    responseText += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;

    if (ready.length > 0) {
      responseText += `✅ Ready to start (${ready.length}):\n`;
      for (const r of ready) {
        responseText += `  - ${r.id}: ${r.description.slice(0, 60)}${r.description.length > 60 ? "..." : ""}\n`;
      }
      responseText += `\n`;
    }

    if (warnings.length > 0) {
      responseText += `⚠️ Potential conflicts detected (${warnings.length}):\n`;
      for (const w of warnings) {
        responseText += `  - ${w.feature1} ↔ ${w.feature2}: ${w.reason}\n`;
      }
      responseText += `\n  Consider running these features sequentially to avoid conflicts.\n\n`;
    }

    if (issues.length > 0) {
      responseText += `❌ Issues (${issues.length}):\n`;
      for (const i of issues) {
        responseText += `  - ${i.id}: ${i.reason}\n`;
      }
      responseText += `\n`;
    }

    // Summary and recommendation
    responseText += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    if (ready.length === 0) {
      responseText += `❌ No features ready to start.`;
    } else if (warnings.length > 0) {
      responseText += `⚠️ ${ready.length} features ready but with potential conflicts.\n`;
      responseText += `Recommendation: Consider running conflicting features sequentially.`;
    } else {
      responseText += `✅ All ${ready.length} features validated and ready for parallel execution.\n`;
      responseText += `Use start_parallel_workers to launch them.`;
    }

    return {
      content: [{ type: "text", text: responseText }],
    };
  }
);

// ============================================================================
// TOOL: check_worker
// ============================================================================
server.tool(
  "check_worker",
  "Check the output and status of a running worker. Use heartbeat=true for lightweight status without output content.",
  {
    projectDir: z.string().describe("Absolute path to the project directory"),
    featureId: z.string().describe("ID of the feature whose worker to check"),
    lines: z.number().optional().describe("Number of lines of output to capture (default: 50)"),
    heartbeat: z.boolean().optional().describe("Return lightweight status only (no output content) - saves context"),
    sinceLine: z.number().optional().describe("Return only output after this line number (for incremental updates)"),
  },
  async ({ projectDir, featureId, lines = 50, heartbeat = false, sinceLine }) => {
    const { state, workers } = await ensureInitialized(projectDir);

    // Validate feature ID format
    try {
      validateFeatureId(featureId);
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `Invalid feature ID: ${error.message}` }],
      };
    }

    const current = state.load();

    if (!current) {
      return {
        content: [{ type: "text", text: "No active session." }],
      };
    }

    const feature = current.features.find(f => f.id === featureId);
    if (!feature || !feature.workerId) {
      return {
        content: [{ type: "text", text: `No active worker for feature '${featureId}'.` }],
      };
    }

    // Heartbeat mode - lightweight status only
    if (heartbeat) {
      const info = await workers.getHeartbeatInfo(feature.workerId, feature.startedAt);
      let text = `💓 Heartbeat: ${featureId}\n`;
      text += `Status: ${info.status}\n`;
      if (info.lastToolUsed) text += `Last tool: ${info.lastToolUsed}\n`;
      if (info.lastFile) text += `Last file: ${info.lastFile}\n`;
      if (info.lastActivity) text += `Last activity: ${info.lastActivity}\n`;
      text += `Lines written: ${info.linesWritten}\n`;
      if (info.runningFor) text += `Running for: ${info.runningFor}\n`;
      if (info.filesModified.length > 0) {
        text += `Files modified: ${info.filesModified.slice(0, 5).join(", ")}`;
        if (info.filesModified.length > 5) text += ` (+${info.filesModified.length - 5} more)`;
        text += "\n";
      }
      return { content: [{ type: "text", text }] };
    }

    const result = await workers.checkWorker(feature.workerId, lines);

    // Handle sinceLine cursor mode
    if (sinceLine !== undefined && result.output) {
      const allLines = result.output.split("\n");
      if (sinceLine < allLines.length) {
        const newLines = allLines.slice(sinceLine);
        const newCursor = allLines.length;
        return {
          content: [
            {
              type: "text",
              text: `📺 Worker Output (lines ${sinceLine + 1}-${newCursor})\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\nStatus: ${result.status}\n\n${newLines.join("\n")}\n\ncursor: ${newCursor} (use sinceLine=${newCursor} for next check)`,
            },
          ],
        };
      } else {
        return {
          content: [
            {
              type: "text",
              text: `📺 No new output since line ${sinceLine}\nStatus: ${result.status}\n\ncursor: ${allLines.length} (no new lines)`,
            },
          ],
        };
      }
    }

    return {
      content: [
        {
          type: "text",
          text: `📺 Worker Output (${feature.workerId})\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\nStatus: ${result.status}\n\n${result.output || "(no output captured)"}`,
        },
      ],
    };
  }
);

// ============================================================================
// TOOL: check_all_workers
// ============================================================================
server.tool(
  "check_all_workers",
  "Check status of all active workers at once. Returns a consolidated summary with optional output snippets.",
  {
    projectDir: z.string().describe("Absolute path to the project directory"),
    outputLines: z.number().optional().describe("Number of output lines per worker (default: 10)"),
    includeOutput: z.boolean().optional().describe("Include terminal output snippets (default: true)"),
    heartbeat: z.boolean().optional().describe("Use heartbeat mode for all workers (lightweight, no output)"),
  },
  async ({ projectDir, outputLines = 10, includeOutput = true, heartbeat = false }) => {
    const { state, workers } = await ensureInitialized(projectDir);
    const current = state.load();

    if (!current) {
      return {
        content: [{ type: "text", text: "No active session." }],
      };
    }

    const inProgressFeatures = current.features.filter(
      (f) => f.status === "in_progress" && f.workerId
    );

    if (inProgressFeatures.length === 0) {
      const pending = current.features.filter((f) => f.status === "pending");
      const completed = current.features.filter((f) => f.status === "completed");
      const failed = current.features.filter((f) => f.status === "failed");
      return {
        content: [
          {
            type: "text",
            text: `📋 No workers currently running.\n\nProgress: ${completed.length}/${current.features.length} completed${failed.length > 0 ? `, ${failed.length} failed` : ""}\nPending: ${pending.length > 0 ? pending.map((f) => f.id).join(", ") : "none"}`,
          },
        ],
      };
    }

    let responseText = `📋 All Workers Status (${inProgressFeatures.length} active)\n`;
    responseText += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;

    for (const feature of inProgressFeatures) {
      if (heartbeat) {
        // Lightweight heartbeat mode
        const info = await workers.getHeartbeatInfo(
          feature.workerId!,
          feature.startedAt
        );
        responseText += `💓 ${feature.id}: ${feature.description.slice(0, 50)}${feature.description.length > 50 ? "..." : ""}\n`;
        responseText += `   Status: ${info.status}`;
        if (info.lastToolUsed) responseText += ` | Last: ${info.lastToolUsed}`;
        if (info.lastActivity) responseText += ` | ${info.lastActivity}`;
        if (info.runningFor) responseText += ` | Running: ${info.runningFor}`;
        responseText += `\n`;
        if (info.lastFile) responseText += `   Last file: ${info.lastFile}\n`;
        responseText += `\n`;
      } else {
        // Full output mode
        const result = await workers.checkWorker(feature.workerId!, outputLines);
        responseText += `🔧 ${feature.id}: ${feature.description.slice(0, 60)}${feature.description.length > 60 ? "..." : ""}\n`;
        responseText += `   Session: ${feature.workerId}\n`;
        responseText += `   Status: ${result.status}\n`;

        if (feature.startedAt) {
          const started = new Date(feature.startedAt);
          const now = new Date();
          const diffMs = now.getTime() - started.getTime();
          const mins = Math.floor(diffMs / 60000);
          const secs = Math.floor((diffMs % 60000) / 1000);
          responseText += `   Running for: ${mins}m ${secs}s\n`;
        }

        if (includeOutput && result.output) {
          const outputSnippet = result.output.split("\n").slice(-5).join("\n");
          responseText += `   Latest output:\n`;
          responseText += outputSnippet
            .split("\n")
            .map((l) => `      ${l}`)
            .join("\n");
          responseText += "\n";
        }
        responseText += "\n";
      }
    }

    // Summary section
    const completed = current.features.filter((f) => f.status === "completed").length;
    const pending = current.features.filter((f) => f.status === "pending").length;
    const failed = current.features.filter((f) => f.status === "failed").length;

    responseText += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    responseText += `📊 Progress: ${completed}/${current.features.length} completed`;
    if (pending > 0) responseText += `, ${pending} pending`;
    if (failed > 0) responseText += `, ${failed} failed`;

    return {
      content: [{ type: "text", text: responseText }],
    };
  }
);

// ============================================================================
// TOOL: send_worker_message
// ============================================================================
server.tool(
  "send_worker_message",
  "Send a follow-up instruction or message to a running worker. The message will be typed into the worker's tmux session.",
  {
    projectDir: z.string().describe("Absolute path to the project directory"),
    featureId: z.string().describe("ID of the feature whose worker to message"),
    message: z.string().describe("The message/instruction to send to the worker"),
  },
  async ({ projectDir, featureId, message }) => {
    const { state } = await ensureInitialized(projectDir);

    // Validate feature ID format
    try {
      validateFeatureId(featureId);
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `Invalid feature ID: ${error.message}` }],
      };
    }

    const current = state.load();

    if (!current) {
      return {
        content: [{ type: "text", text: "No active session." }],
      };
    }

    const feature = current.features.find(f => f.id === featureId);
    if (!feature || !feature.workerId) {
      return {
        content: [{ type: "text", text: `No active worker for feature '${featureId}'.` }],
      };
    }

    const { execFile } = await import("child_process");
    const { promisify } = await import("util");
    const execFileAsync = promisify(execFile);

    try {
      // Check if session exists
      let sessions = "";
      try {
        const result = await execFileAsync("tmux", [
          "list-sessions",
          "-F",
          "#{session_name}",
        ]);
        sessions = result.stdout;
      } catch {
        return {
          content: [{ type: "text", text: `Worker session '${feature.workerId}' is not running (tmux unavailable).` }],
        };
      }

      if (!sessions.includes(feature.workerId)) {
        return {
          content: [{ type: "text", text: `Worker session '${feature.workerId}' is no longer running.` }],
        };
      }

      // Send the message to the worker using tmux send-keys
      // The message is sent followed by Enter to execute it
      await execFileAsync("tmux", [
        "send-keys",
        "-t",
        feature.workerId,
        message,
        "Enter",
      ]);

      // Log the message to progress log
      const truncatedMessage = message.length > 100 ? message.substring(0, 100) + "..." : message;
      current.progressLog.push(`[${new Date().toISOString()}] Sent message to ${featureId}: ${sanitizeOutput(truncatedMessage, 200)}`);
      current.lastUpdated = new Date().toISOString();
      state.save(current);

      return {
        content: [
          {
            type: "text",
            text: `📨 Message sent to worker (${feature.workerId})\n\nMessage: ${sanitizeOutput(truncatedMessage, 200)}\n\nUse check_worker to see the worker's response.`,
          },
        ],
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `❌ Failed to send message: ${sanitizeOutput(error.message)}` }],
      };
    }
  }
);

// ============================================================================
// TOOL: mark_complete
// ============================================================================
server.tool(
  "mark_complete",
  "Mark a feature as completed or failed. Call this after verifying the worker's output or running tests. When marking as failed, auto-retry is enabled by default (up to maxRetries attempts).",
  {
    projectDir: z.string().describe("Absolute path to the project directory"),
    featureId: z.string().describe("ID of the feature to mark"),
    success: z.boolean().describe("Whether the feature was completed successfully"),
    notes: z.string().optional().describe("Optional notes about the completion or failure"),
    maxRetries: z.number().optional().describe("Maximum retry attempts for failed features (default: 3). Set to 0 to disable auto-retry."),
  },
  async ({ projectDir, featureId, success, notes, maxRetries = 3 }) => {
    const { state, workers } = await ensureInitialized(projectDir);

    // Validate feature ID format
    try {
      validateFeatureId(featureId);
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `Invalid feature ID: ${error.message}` }],
      };
    }

    const current = state.load();

    if (!current) {
      return {
        content: [{ type: "text", text: "No active session." }],
      };
    }

    const feature = current.features.find(f => f.id === featureId);
    if (!feature) {
      return {
        content: [{ type: "text", text: `Feature '${featureId}' not found.` }],
      };
    }

    // Kill the worker if still running
    if (feature.workerId) {
      await workers.killWorker(feature.workerId);
    }

    let resultStatus: string;
    let willRetry = false;

    if (success) {
      // Mark as completed
      feature.status = "completed";
      feature.completedAt = new Date().toISOString();
      resultStatus = "completed";
    } else {
      // Check if we should auto-retry
      if (maxRetries > 0 && feature.attempts < maxRetries) {
        // Keep as pending for retry
        feature.status = "pending";
        feature.lastError = notes || "Failed (will retry)";
        willRetry = true;
        resultStatus = `failed (attempt ${feature.attempts}/${maxRetries}, will retry)`;
      } else {
        // Max retries exhausted or auto-retry disabled
        feature.status = "failed";
        feature.completedAt = new Date().toISOString();
        if (notes) {
          feature.lastError = notes;
        }
        resultStatus = `failed (${feature.attempts} attempts exhausted)`;
      }
    }

    feature.workerId = undefined;

    // Log progress
    let logEntry: string;
    if (success) {
      logEntry = `[${new Date().toISOString()}] ✅ Completed: ${featureId} - ${feature.description}`;
    } else if (willRetry) {
      logEntry = `[${new Date().toISOString()}] 🔄 Failed (will retry): ${featureId} - attempt ${feature.attempts}/${maxRetries} - ${notes || "No details"}`;
    } else {
      logEntry = `[${new Date().toISOString()}] ❌ Failed: ${featureId} - ${notes || "No details"}`;
    }
    current.progressLog.push(logEntry);
    current.lastUpdated = new Date().toISOString();

    // Check if all features are done (only completed or permanently failed)
    const allDone = current.features.every(f => f.status === "completed" || f.status === "failed");
    if (allDone) {
      const allSucceeded = current.features.every(f => f.status === "completed");
      current.status = allSucceeded ? "completed" : "completed_with_failures";
      current.completedAt = new Date().toISOString();
      current.progressLog.push(`[${new Date().toISOString()}] 🏁 Orchestration ${allSucceeded ? "completed successfully" : "completed with failures"}`);
    }

    state.save(current);
    state.writeProgressFile();

    const completed = current.features.filter(f => f.status === "completed").length;
    const total = current.features.length;

    let responseText = `${success ? "✅" : willRetry ? "🔄" : "❌"} Feature ${featureId} ${resultStatus}.\n\nProgress: ${completed}/${total} features completed`;

    if (willRetry) {
      responseText += `\n\n💡 Feature will be retried. Use start_worker to launch a new attempt.`;
    }

    if (allDone) {
      responseText += `\n\n🏁 All features processed!`;
    }

    return {
      content: [
        {
          type: "text",
          text: responseText,
        },
      ],
    };
  }
);

// ============================================================================
// TOOL: retry_feature
// ============================================================================
server.tool(
  "retry_feature",
  "Reset a failed feature to pending status so it can be retried. Use this to manually retry a feature after fixing issues or when auto-retry has been exhausted.",
  {
    projectDir: z.string().describe("Absolute path to the project directory"),
    featureId: z.string().describe("ID of the feature to retry"),
    resetAttempts: z.boolean().optional().describe("Whether to reset the attempt counter to 0 (default: false)"),
  },
  async ({ projectDir, featureId, resetAttempts = false }) => {
    const { state } = await ensureInitialized(projectDir);

    // Validate feature ID format
    try {
      validateFeatureId(featureId);
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `Invalid feature ID: ${error.message}` }],
      };
    }

    const current = state.load();

    if (!current) {
      return {
        content: [{ type: "text", text: "No active session." }],
      };
    }

    const feature = current.features.find(f => f.id === featureId);
    if (!feature) {
      return {
        content: [{ type: "text", text: `Feature '${featureId}' not found.` }],
      };
    }

    // Reject if feature is already completed successfully
    if (feature.status === "completed") {
      return {
        content: [
          {
            type: "text",
            text: `❌ Cannot retry feature '${featureId}' - it is already completed successfully.\n\nOnly failed or pending features can be retried.`,
          },
        ],
      };
    }

    // Reject if feature is currently in progress
    if (feature.status === "in_progress") {
      return {
        content: [
          {
            type: "text",
            text: `❌ Cannot retry feature '${featureId}' - it is currently in progress.\n\nUse mark_complete to finish the current attempt first, or check_worker to see its status.`,
          },
        ],
      };
    }

    // Store previous state for logging
    const previousAttempts = feature.attempts;
    const previousError = feature.lastError;

    // Reset the feature for retry
    feature.status = "pending";
    feature.lastError = undefined;
    feature.completedAt = undefined;
    feature.workerId = undefined;

    if (resetAttempts) {
      feature.attempts = 0;
    }

    // If session was marked as completed_with_failures, revert to in_progress
    if (current.status === "completed_with_failures") {
      current.status = "in_progress";
      current.completedAt = undefined;
    }

    // Log the retry action
    const logEntry = resetAttempts
      ? `[${new Date().toISOString()}] 🔄 Retry: ${featureId} - reset from failed (${previousAttempts} attempts) to pending (attempts reset to 0)`
      : `[${new Date().toISOString()}] 🔄 Retry: ${featureId} - reset from failed to pending (${previousAttempts} attempts so far)`;
    current.progressLog.push(logEntry);
    current.lastUpdated = new Date().toISOString();

    state.save(current);
    state.writeProgressFile();

    let responseText = `🔄 Feature ${featureId} reset for retry.\n\n`;
    responseText += `Previous attempts: ${previousAttempts}\n`;
    if (resetAttempts) {
      responseText += `Attempts reset to: 0\n`;
    }
    if (previousError) {
      responseText += `Previous error: ${previousError}\n`;
    }
    responseText += `\n💡 Use start_worker to launch a new attempt.`;

    return {
      content: [
        {
          type: "text",
          text: responseText,
        },
      ],
    };
  }
);

// ============================================================================
// TOOL: run_verification
// ============================================================================
server.tool(
  "run_verification",
  "Run a verification command (e.g., tests, linting, build) to check if a feature works correctly. Only allows safe commands like npm test, pytest, cargo test, etc.",
  {
    projectDir: z.string().describe("Absolute path to the project directory"),
    command: z.string().describe("The command to run for verification (e.g., 'npm test', 'pytest', 'cargo test')"),
    featureId: z.string().optional().describe("Optional feature ID this verification is for"),
  },
  async ({ projectDir, command, featureId }) => {
    const { state } = await ensureInitialized(projectDir);

    // Security: Validate command against allowlist
    let validatedCommand: string;
    try {
      validatedCommand = validateCommand(command);
    } catch (error: any) {
      return {
        content: [
          {
            type: "text",
            text: `❌ Command rejected: ${error.message}\n\nAllowed commands: npm test, npm run test, pytest, cargo test, go test, make test, eslint, tsc, etc.`,
          },
        ],
      };
    }

    const { execFile } = await import("child_process");
    const { promisify } = await import("util");
    const execFileAsync = promisify(execFile);

    try {
      // Use /bin/bash -c to execute the validated command
      // This is safe because validateCommand has already verified the command
      // against a strict allowlist and blocked all dangerous shell operators
      const { stdout, stderr } = await execFileAsync("/bin/bash", ["-c", validatedCommand], {
        cwd: projectDir,
        timeout: 300000, // 5 minute timeout
        maxBuffer: 1024 * 1024 * 10, // 10MB buffer
        // NO shell: true - we explicitly invoke bash with the validated command
      });

      const current = state.load();
      if (current && featureId) {
        current.progressLog.push(`[${new Date().toISOString()}] Verification passed for ${featureId}: ${validatedCommand}`);
        state.save(current);
      }

      return {
        content: [
          {
            type: "text",
            text: `✅ Verification passed!\n\nCommand: ${validatedCommand}\n\nOutput:\n${sanitizeOutput(stdout)}${stderr ? `\n\nStderr:\n${sanitizeOutput(stderr)}` : ""}`,
          },
        ],
      };
    } catch (error: any) {
      const current = state.load();
      if (current && featureId) {
        current.progressLog.push(`[${new Date().toISOString()}] Verification failed for ${featureId}: ${validatedCommand}`);
        state.save(current);
      }

      return {
        content: [
          {
            type: "text",
            text: `❌ Verification failed!\n\nCommand: ${validatedCommand}\nExit code: ${error.code}\n\nOutput:\n${sanitizeOutput(error.stdout || "")}\n\nError:\n${sanitizeOutput(error.stderr || error.message)}`,
          },
        ],
      };
    }
  }
);

// ============================================================================
// TOOL: add_feature
// ============================================================================
server.tool(
  "add_feature",
  "Add a new feature to the current session. Use this when you discover additional work needed.",
  {
    projectDir: z.string().describe("Absolute path to the project directory"),
    description: z.string().describe("Description of the new feature"),
    insertAfter: z.string().optional().describe("Optional: Insert after this feature ID"),
  },
  async ({ projectDir, description, insertAfter }) => {
    const { state } = await ensureInitialized(projectDir);
    const current = state.load();

    if (!current) {
      return {
        content: [{ type: "text", text: "No active session." }],
      };
    }

    const newId = `feature-${current.features.length + 1}`;
    const newFeature: Feature = {
      id: newId,
      description,
      status: "pending",
      attempts: 0,
    };

    if (insertAfter) {
      const index = current.features.findIndex(f => f.id === insertAfter);
      if (index !== -1) {
        current.features.splice(index + 1, 0, newFeature);
      } else {
        current.features.push(newFeature);
      }
    } else {
      current.features.push(newFeature);
    }

    current.progressLog.push(`[${new Date().toISOString()}] Added new feature: ${newId} - ${description}`);
    current.lastUpdated = new Date().toISOString();
    state.save(current);

    return {
      content: [
        {
          type: "text",
          text: `➕ Added feature ${newId}: ${description}\n\nTotal features: ${current.features.length}`,
        },
      ],
    };
  }
);

// ============================================================================
// TOOL: set_dependencies
// ============================================================================
server.tool(
  "set_dependencies",
  "Set dependencies for a feature. The feature cannot be started until all its dependencies are completed.",
  {
    projectDir: z.string().describe("Absolute path to the project directory"),
    featureId: z.string().describe("ID of the feature to set dependencies for"),
    dependsOn: z.array(z.string()).describe("Array of feature IDs this feature depends on"),
  },
  async ({ projectDir, featureId, dependsOn }) => {
    const { state } = await ensureInitialized(projectDir);

    // Validate feature ID format
    try {
      validateFeatureId(featureId);
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `Invalid feature ID: ${error.message}` }],
      };
    }

    // Validate all dependency feature IDs
    for (const depId of dependsOn) {
      try {
        validateFeatureId(depId);
      } catch (error: any) {
        return {
          content: [{ type: "text", text: `Invalid dependency feature ID '${depId}': ${error.message}` }],
        };
      }
    }

    const current = state.load();

    if (!current) {
      return {
        content: [{ type: "text", text: "No active session. Use orchestrator_init first." }],
      };
    }

    // Find the feature to update
    const feature = current.features.find(f => f.id === featureId);
    if (!feature) {
      return {
        content: [{ type: "text", text: `Feature '${featureId}' not found. Available: ${current.features.map(f => f.id).join(", ")}` }],
      };
    }

    // Validate all dependency feature IDs exist
    const missingDeps: string[] = [];
    for (const depId of dependsOn) {
      if (!current.features.find(f => f.id === depId)) {
        missingDeps.push(depId);
      }
    }

    if (missingDeps.length > 0) {
      return {
        content: [{ type: "text", text: `Dependency feature(s) not found: ${missingDeps.join(", ")}. Available: ${current.features.map(f => f.id).join(", ")}` }],
      };
    }

    // Check for self-dependency
    if (dependsOn.includes(featureId)) {
      return {
        content: [{ type: "text", text: `Feature '${featureId}' cannot depend on itself.` }],
      };
    }

    // Update the feature's dependencies
    feature.dependsOn = dependsOn.length > 0 ? dependsOn : undefined;

    // Log the change
    const depDescription = dependsOn.length > 0 ? dependsOn.join(", ") : "none";
    current.progressLog.push(`[${new Date().toISOString()}] Set dependencies for ${featureId}: ${depDescription}`);
    current.lastUpdated = new Date().toISOString();
    state.save(current);
    state.writeProgressFile();

    return {
      content: [
        {
          type: "text",
          text: `✅ Dependencies set for ${featureId}\n\nDepends on: ${dependsOn.length > 0 ? dependsOn.join(", ") : "(none)"}\n\nNote: This feature will not start until all dependencies are completed.`,
        },
      ],
    };
  }
);

// ============================================================================
// TOOL: orchestrator_reset
// ============================================================================
server.tool(
  "orchestrator_reset",
  "Reset the orchestration session. Kills all workers and clears state. Use with caution!",
  {
    projectDir: z.string().describe("Absolute path to the project directory"),
    confirm: z.boolean().describe("Must be true to confirm reset"),
  },
  async ({ projectDir, confirm }) => {
    if (!confirm) {
      return {
        content: [{ type: "text", text: "Reset cancelled. Set confirm=true to proceed." }],
      };
    }

    const { state, workers } = await ensureInitialized(projectDir);

    // Kill all workers
    await workers.killAllWorkers();

    // Clear state
    state.clear();

    return {
      content: [
        {
          type: "text",
          text: "🔄 Orchestration reset. All workers killed and state cleared.\n\nUse orchestrator_init to start a new session.",
        },
      ],
    };
  }
);

// ============================================================================
// TOOL: get_progress_log
// ============================================================================
server.tool(
  "get_progress_log",
  "Get the full progress log for the current session. Useful for understanding what has happened.",
  {
    projectDir: z.string().describe("Absolute path to the project directory"),
    limit: z.number().optional().describe("Limit to last N entries (default: all)"),
  },
  async ({ projectDir, limit }) => {
    const { state } = await ensureInitialized(projectDir);
    const current = state.load();

    if (!current) {
      return {
        content: [{ type: "text", text: "No active session." }],
      };
    }

    const logs = limit ? current.progressLog.slice(-limit) : current.progressLog;

    return {
      content: [
        {
          type: "text",
          text: `📜 Progress Log (${logs.length} entries)\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n${logs.join("\n")}`,
        },
      ],
    };
  }
);

// ============================================================================
// TOOL: get_session_stats
// ============================================================================
server.tool(
  "get_session_stats",
  "Get statistics about the current orchestration session including success rate, average completion time, worker counts, and attempt statistics.",
  {
    projectDir: z.string().describe("Absolute path to the project directory"),
  },
  async ({ projectDir }) => {
    const { state, workers } = await ensureInitialized(projectDir);
    const current = state.load();

    if (!current) {
      return {
        content: [{ type: "text", text: "No active session. Use orchestrator_init first." }],
      };
    }

    // Calculate feature counts by status
    const completed = current.features.filter(f => f.status === "completed");
    const failed = current.features.filter(f => f.status === "failed");
    const inProgress = current.features.filter(f => f.status === "in_progress");
    const pending = current.features.filter(f => f.status === "pending");

    // Calculate success rate (completed / (completed + failed))
    const totalFinished = completed.length + failed.length;
    const successRate = totalFinished > 0 ? completed.length / totalFinished : 0;

    // Calculate average completion time for completed features
    const completionTimes: number[] = [];
    for (const feature of completed) {
      if (feature.startedAt && feature.completedAt) {
        const startTime = new Date(feature.startedAt).getTime();
        const endTime = new Date(feature.completedAt).getTime();
        if (startTime > 0 && endTime > startTime) {
          completionTimes.push(endTime - startTime);
        }
      }
    }
    const avgCompletionTimeMs = calculateAverage(completionTimes);

    // Calculate total elapsed time
    const startTime = new Date(current.startTime);
    const now = new Date();
    const totalElapsed = formatDuration(startTime, now);

    // Get current worker statuses
    const workerStatuses = await workers.checkAllWorkers();
    const runningWorkers = workerStatuses.filter(w => w.status === "running").length;
    const completedWorkers = workerStatuses.filter(w => w.status === "completed").length;
    const crashedWorkers = workerStatuses.filter(w => w.status === "crashed").length;

    // Calculate attempt statistics
    const attemptCounts = current.features.map(f => f.attempts);
    const totalAttempts = attemptCounts.reduce((sum, val) => sum + val, 0);
    const avgAttempts = calculateAverage(attemptCounts);
    const maxAttempts = attemptCounts.length > 0 ? Math.max(...attemptCounts) : 0;

    // Build stats output
    let statsText = `📈 Session Statistics\n`;
    statsText += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;

    statsText += `⏱️  Time Metrics:\n`;
    statsText += `   Total Elapsed: ${totalElapsed}\n`;
    statsText += `   Avg Completion Time: ${completionTimes.length > 0 ? formatDurationMs(avgCompletionTimeMs) : "N/A (no completed features)"}\n`;
    if (completionTimes.length > 0) {
      const minTime = Math.min(...completionTimes);
      const maxTime = Math.max(...completionTimes);
      statsText += `   Fastest Completion: ${formatDurationMs(minTime)}\n`;
      statsText += `   Slowest Completion: ${formatDurationMs(maxTime)}\n`;
    }
    statsText += `\n`;

    statsText += `✅ Success Metrics:\n`;
    statsText += `   Success Rate: ${formatPercent(successRate)} (${completed.length}/${totalFinished} finished)\n`;
    statsText += `   Features Completed: ${completed.length}\n`;
    statsText += `   Features Failed: ${failed.length}\n`;
    statsText += `   Features In Progress: ${inProgress.length}\n`;
    statsText += `   Features Pending: ${pending.length}\n`;
    statsText += `\n`;

    statsText += `👷 Worker Metrics:\n`;
    statsText += `   Currently Running: ${runningWorkers}\n`;
    statsText += `   Completed Sessions: ${completedWorkers}\n`;
    statsText += `   Crashed Sessions: ${crashedWorkers}\n`;
    statsText += `   Total Workers Tracked: ${workerStatuses.length}\n`;
    statsText += `\n`;

    statsText += `🔄 Attempt Statistics:\n`;
    statsText += `   Total Attempts: ${totalAttempts}\n`;
    statsText += `   Avg Attempts per Feature: ${avgAttempts.toFixed(2)}\n`;
    statsText += `   Max Attempts on Single Feature: ${maxAttempts}\n`;

    // Find features with most attempts (potential problem areas)
    const highAttemptFeatures = current.features
      .filter(f => f.attempts > 1)
      .sort((a, b) => b.attempts - a.attempts)
      .slice(0, 3);

    if (highAttemptFeatures.length > 0) {
      statsText += `\n⚠️  Features with Multiple Attempts:\n`;
      for (const f of highAttemptFeatures) {
        statsText += `   ${f.id}: ${f.attempts} attempts - ${f.description.slice(0, 50)}${f.description.length > 50 ? "..." : ""}\n`;
      }
    }

    return {
      content: [{ type: "text", text: statsText }],
    };
  }
);

// ============================================================================
// TOOL: commit_progress
// ============================================================================
server.tool(
  "commit_progress",
  "Create a git commit with the current progress. Use after completing features to checkpoint work.",
  {
    projectDir: z.string().describe("Absolute path to the project directory"),
    message: z.string().describe("Commit message describing the progress"),
  },
  async ({ projectDir, message }) => {
    const { state } = await ensureInitialized(projectDir);
    const { execFile } = await import("child_process");
    const { promisify } = await import("util");
    const execFileAsync = promisify(execFile);

    try {
      // Stage all changes using execFile (no shell interpretation)
      await execFileAsync("git", ["add", "-A"], { cwd: projectDir });

      // Unstage orchestrator files - these should never be committed
      const orchestratorFiles = [
        ".claude",           // Entire .claude directory (orchestrator state, logs, prompts)
        "claude-progress.txt",
        "init.sh",
      ];
      for (const file of orchestratorFiles) {
        try {
          await execFileAsync("git", ["reset", "HEAD", "--", file], { cwd: projectDir });
        } catch {
          // File might not be staged, that's fine
        }
      }

      // Build commit message safely (no shell escaping needed with execFile)
      const fullMessage = `${message}\n\n🤖 Committed by claude-swarm`;

      // Commit using execFile with message as argument (prevents injection)
      const { stdout } = await execFileAsync("git", ["commit", "-m", fullMessage], {
        cwd: projectDir,
      });

      const current = state.load();
      if (current) {
        current.progressLog.push(`[${new Date().toISOString()}] Git commit: ${sanitizeOutput(message, 200)}`);
        state.save(current);
      }

      return {
        content: [
          {
            type: "text",
            text: `✅ Committed!\n\n${sanitizeOutput(stdout)}`,
          },
        ],
      };
    } catch (error: any) {
      if (error.message.includes("nothing to commit")) {
        return {
          content: [{ type: "text", text: "Nothing to commit - working tree clean." }],
        };
      }
      return {
        content: [{ type: "text", text: `❌ Commit failed: ${sanitizeOutput(error.message)}` }],
      };
    }
  }
);

// ============================================================================
// TOOL: pause_session
// ============================================================================
server.tool(
  "pause_session",
  "Pause the orchestration session. Gracefully kills all running workers and sets status to paused. Use when you need to stop work temporarily.",
  {
    projectDir: z.string().describe("Absolute path to the project directory"),
  },
  async ({ projectDir }) => {
    const { state, workers } = await ensureInitialized(projectDir);
    const current = state.load();

    if (!current) {
      return {
        content: [{ type: "text", text: "No active session. Use orchestrator_init first." }],
      };
    }

    // Check if already paused
    if (current.status === "paused") {
      return {
        content: [{ type: "text", text: "⚠️ Session is already paused. Use resume_session to continue." }],
      };
    }

    // Check if session is already completed
    if (current.status === "completed" || current.status === "completed_with_failures") {
      return {
        content: [{ type: "text", text: `⚠️ Session is already ${current.status}. Cannot pause a completed session.` }],
      };
    }

    // Count running workers before killing
    const workerStatuses = await workers.checkAllWorkers();
    const runningWorkersFiltered = workerStatuses.filter(w => w.status === "running");
    const runningCount = runningWorkersFiltered.length;

    // Kill all running workers
    await workers.killAllWorkers();

    // Update features that were in progress back to pending
    for (const feature of current.features) {
      if (feature.status === "in_progress") {
        feature.status = "pending";
        feature.workerId = undefined;
      }
    }

    // Set session status to paused
    current.status = "paused";
    current.lastUpdated = new Date().toISOString();
    current.progressLog.push(`[${new Date().toISOString()}] ⏸️ Session paused - ${runningCount} worker(s) stopped`);

    state.save(current);
    state.writeProgressFile();

    const pendingCount = current.features.filter(f => f.status === "pending").length;
    const completedCount = current.features.filter(f => f.status === "completed").length;

    return {
      content: [
        {
          type: "text",
          text: `⏸️ Session paused!\n\nWorkers stopped: ${runningCount}\nCompleted features: ${completedCount}\nPending features: ${pendingCount}\n\nUse resume_session to continue working.`,
        },
      ],
    };
  }
);

// ============================================================================
// TOOL: resume_session
// ============================================================================
server.tool(
  "resume_session",
  "Resume a paused orchestration session. Changes status back to in_progress and returns the list of pending features ready to work on.",
  {
    projectDir: z.string().describe("Absolute path to the project directory"),
  },
  async ({ projectDir }) => {
    const { state } = await ensureInitialized(projectDir);
    const current = state.load();

    if (!current) {
      return {
        content: [{ type: "text", text: "No active session. Use orchestrator_init first." }],
      };
    }

    // Check if session is paused
    if (current.status !== "paused") {
      return {
        content: [
          {
            type: "text",
            text: `⚠️ Session is not paused (current status: ${current.status}). Use pause_session first to pause, or orchestrator_status to check current state.`,
          },
        ],
      };
    }

    // Resume the session
    current.status = "in_progress";
    current.lastUpdated = new Date().toISOString();
    current.progressLog.push(`[${new Date().toISOString()}] ▶️ Session resumed`);

    state.save(current);
    state.writeProgressFile();

    const pendingFeatures = current.features.filter(f => f.status === "pending");
    const completedFeatures = current.features.filter(f => f.status === "completed");
    const failedFeatures = current.features.filter(f => f.status === "failed");

    let responseText = `▶️ Session resumed!\n\n`;
    responseText += `📊 Current Status:\n`;
    responseText += `  ✅ Completed: ${completedFeatures.length}\n`;
    responseText += `  ⏳ Pending: ${pendingFeatures.length}\n`;
    responseText += `  ❌ Failed: ${failedFeatures.length}\n\n`;

    if (pendingFeatures.length > 0) {
      responseText += `📋 Ready to work on:\n`;
      for (const f of pendingFeatures) {
        responseText += `  - ${f.id}: ${f.description}\n`;
      }
      responseText += `\nUse start_worker or start_parallel_workers to begin.`;
    } else if (failedFeatures.length > 0) {
      responseText += `⚠️ No pending features. Consider retrying failed features.`;
    } else {
      responseText += `🎉 All features are completed!`;
    }

    return {
      content: [{ type: "text", text: responseText }],
    };
  }
);

// ============================================================================
// TOOL: get_feature_complexity
// ============================================================================
server.tool(
  "get_feature_complexity",
  "Analyze the complexity of a feature and get a recommendation for whether to use competitive planning.",
  {
    projectDir: z.string().describe("Absolute path to the project directory"),
    featureId: z.string().describe("ID of the feature to analyze"),
    threshold: z.number().optional().describe("Complexity threshold for competitive planning (default: 60)"),
  },
  async ({ projectDir, featureId, threshold }) => {
    const { state } = await ensureInitialized(projectDir);
    const current = state.load();

    if (!current) {
      return {
        content: [{ type: "text", text: "No active session. Use orchestrator_init first." }],
      };
    }

    const feature = current.features.find(f => f.id === featureId);
    if (!feature) {
      return {
        content: [{ type: "text", text: `Feature '${featureId}' not found.` }],
      };
    }

    const complexity = analyzeComplexity(feature, threshold);

    // Store complexity in feature for later reference
    feature.complexity = complexity;
    state.save(current);

    return {
      content: [
        {
          type: "text",
          text: `🔍 Complexity Analysis for ${featureId}\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n${formatComplexityResult(complexity)}`,
        },
      ],
    };
  }
);

// ============================================================================
// TOOL: start_competitive_planning
// ============================================================================
server.tool(
  "start_competitive_planning",
  "Start competitive planning for a complex feature. Spawns two workers in planning mode to create competing implementation plans.",
  {
    projectDir: z.string().describe("Absolute path to the project directory"),
    featureId: z.string().describe("ID of the feature to plan"),
    forceCompetitive: z.boolean().optional().describe("Force competitive planning even if not detected as complex"),
    customPromptA: z.string().optional().describe("Custom prompt for planner A"),
    customPromptB: z.string().optional().describe("Custom prompt for planner B"),
  },
  async ({ projectDir, featureId, forceCompetitive, customPromptA, customPromptB }) => {
    const { state, workers } = await ensureInitialized(projectDir);
    const current = state.load();

    if (!current) {
      return {
        content: [{ type: "text", text: "No active session. Use orchestrator_init first." }],
      };
    }

    const feature = current.features.find(f => f.id === featureId);
    if (!feature) {
      return {
        content: [{ type: "text", text: `Feature '${featureId}' not found.` }],
      };
    }

    // Check if already in planning phase
    if (feature.planningPhase === "planning") {
      return {
        content: [{ type: "text", text: `Feature '${featureId}' is already in planning phase.` }],
      };
    }

    // Analyze complexity if not forced
    if (!forceCompetitive && !feature.complexity) {
      feature.complexity = analyzeComplexity(feature);
    }

    if (!forceCompetitive && feature.complexity && !feature.complexity.isComplex) {
      return {
        content: [
          {
            type: "text",
            text: `Feature '${featureId}' is not complex enough for competitive planning (score: ${feature.complexity.score}/100).\n\nRecommendation: ${feature.complexity.recommendation}\n\nUse forceCompetitive=true to override, or use start_worker for simple implementation.`,
          },
        ],
      };
    }

    // Start two planner workers
    const [resultA, resultB] = await Promise.all([
      workers.startPlannerWorker(feature, "A", customPromptA),
      workers.startPlannerWorker(feature, "B", customPromptB),
    ]);

    if (!resultA.success || !resultB.success) {
      // Try to clean up if one succeeded
      if (resultA.success && resultA.sessionName) {
        await workers.killWorker(resultA.sessionName);
      }
      if (resultB.success && resultB.sessionName) {
        await workers.killWorker(resultB.sessionName);
      }
      return {
        content: [
          {
            type: "text",
            text: `Failed to start planners:\nPlanner A: ${resultA.error || "OK"}\nPlanner B: ${resultB.error || "OK"}`,
          },
        ],
      };
    }

    // Update feature state
    feature.planningPhase = "planning";
    feature.competingPlans = {
      planA: {
        workerId: resultA.sessionName!,
        submittedAt: "",
        plan: { summary: "", steps: [], filesToCreate: [], filesToModify: [], testStrategy: "", risks: [] },
      },
      planB: {
        workerId: resultB.sessionName!,
        submittedAt: "",
        plan: { summary: "", steps: [], filesToCreate: [], filesToModify: [], testStrategy: "", risks: [] },
      },
    };

    current.progressLog.push(
      `[${new Date().toISOString()}] 🏁 Started competitive planning for ${featureId} (complexity: ${feature.complexity?.score || "N/A"})`
    );
    state.save(current);
    state.writeProgressFile();

    return {
      content: [
        {
          type: "text",
          text: `🏁 Competitive Planning Started for ${featureId}\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\nPlanner A: ${resultA.sessionName}\nPlanner B: ${resultB.sessionName}\n\nBoth planners are now exploring the codebase and creating implementation plans.\nUse check_worker with their session names to monitor progress.\n\nOnce both planners complete, use evaluate_plans to compare and select a winner.`,
        },
      ],
    };
  }
);

// ============================================================================
// TOOL: evaluate_plans
// ============================================================================
server.tool(
  "evaluate_plans",
  "Evaluate competing plans for a feature and select the winner. The winning plan's approach will be used for implementation.",
  {
    projectDir: z.string().describe("Absolute path to the project directory"),
    featureId: z.string().describe("ID of the feature to evaluate plans for"),
    manualSelection: z.enum(["A", "B"]).optional().describe("Override automatic selection with manual choice"),
    selectionReason: z.string().optional().describe("Reason for manual selection"),
  },
  async ({ projectDir, featureId, manualSelection, selectionReason }) => {
    const { state, workers } = await ensureInitialized(projectDir);
    const current = state.load();

    if (!current) {
      return {
        content: [{ type: "text", text: "No active session. Use orchestrator_init first." }],
      };
    }

    const feature = current.features.find(f => f.id === featureId);
    if (!feature) {
      return {
        content: [{ type: "text", text: `Feature '${featureId}' not found.` }],
      };
    }

    if (feature.planningPhase !== "planning") {
      return {
        content: [
          {
            type: "text",
            text: `Feature '${featureId}' is not in planning phase. Use start_competitive_planning first.`,
          },
        ],
      };
    }

    // Read plan files
    const planAFile = `.claude/orchestrator/workers/${featureId}.plan.json`;
    const planA = workers.readPlanFile(featureId);

    // Check for role-specific plan files as fallback
    let planB = null;
    // Try to find the second plan if both planners wrote to the same file
    // In practice, planners might use different naming

    if (!planA) {
      return {
        content: [
          {
            type: "text",
            text: `No plans found yet. Wait for planners to complete and write their plans to .claude/orchestrator/workers/${featureId}.plan.json`,
          },
        ],
      };
    }

    // If we only have one plan, we'll evaluate it against an empty plan
    // In a real scenario, both planners would submit separate plans
    const planBData = planB || {
      summary: "(No Plan B submitted)",
      steps: [],
      filesToCreate: [],
      filesToModify: [],
      testStrategy: "",
      risks: [],
    };

    let evaluation;
    let winner: "A" | "B";

    if (manualSelection) {
      winner = manualSelection;
      evaluation = {
        winner,
        selectionReason: selectionReason || `Manual selection: Plan ${winner} chosen by orchestrator`,
        marginOfVictory: 0,
        evaluations: {
          A: { planId: "A" as const, scores: { completeness: 0, feasibility: 0, riskAwareness: 0, clarity: 0, efficiency: 0, total: 0 }, concerns: [], strengths: [] },
          B: { planId: "B" as const, scores: { completeness: 0, feasibility: 0, riskAwareness: 0, clarity: 0, efficiency: 0, total: 0 }, concerns: [], strengths: [] },
        },
      };
    } else {
      evaluation = evaluatePlans(feature, planA, planBData, projectDir);
      winner = evaluation.winner;
    }

    // Update feature state
    feature.planningPhase = "evaluating";
    if (feature.competingPlans) {
      feature.competingPlans.selectedPlan = winner;
      feature.competingPlans.selectionReason = evaluation.selectionReason;
      if (feature.competingPlans.planA) {
        feature.competingPlans.planA.plan = planA;
        feature.competingPlans.planA.submittedAt = new Date().toISOString();
        feature.competingPlans.planA.evaluationScore = evaluation.evaluations.A.scores.total;
      }
      if (feature.competingPlans.planB) {
        feature.competingPlans.planB.plan = planBData;
        feature.competingPlans.planB.submittedAt = new Date().toISOString();
        feature.competingPlans.planB.evaluationScore = evaluation.evaluations.B.scores.total;
      }
    }

    current.progressLog.push(
      `[${new Date().toISOString()}] 🏆 Plan ${winner} selected for ${featureId} (${manualSelection ? "manual" : "automatic"})`
    );
    state.save(current);
    state.writeProgressFile();

    // Kill both planner sessions (they should be done by now)
    if (feature.competingPlans?.planA?.workerId) {
      await workers.killWorker(feature.competingPlans.planA.workerId);
    }
    if (feature.competingPlans?.planB?.workerId) {
      await workers.killWorker(feature.competingPlans.planB.workerId);
    }

    let response = `🏆 Plan Evaluation Complete for ${featureId}\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
    response += `Winner: Plan ${winner}\n`;
    response += `Reason: ${evaluation.selectionReason}\n\n`;

    if (!manualSelection) {
      response += formatEvaluationResult(evaluation);
    }

    response += `\n\n📋 Winning Plan Summary:\n${planA.summary || "(No summary)"}\n\n`;
    response += `Next Steps:\n`;
    response += `1. Set planningPhase to "implementing" on the feature\n`;
    response += `2. Use start_worker to begin implementation with the winning plan as context`;

    return {
      content: [{ type: "text", text: response }],
    };
  }
);

// ============================================================================
// TOOL: get_worker_confidence
// ============================================================================
server.tool(
  "get_worker_confidence",
  "Get detailed confidence analysis for a running worker. Shows tool activity patterns, self-reported confidence, and output analysis.",
  {
    projectDir: z.string().describe("Absolute path to the project directory"),
    featureId: z.string().describe("ID of the feature whose worker to analyze"),
  },
  async ({ projectDir, featureId }) => {
    const { state, workers } = await ensureInitialized(projectDir);
    const current = state.load();

    if (!current) {
      return {
        content: [{ type: "text", text: "No active session. Use orchestrator_init first." }],
      };
    }

    const feature = current.features.find(f => f.id === featureId);
    if (!feature) {
      return {
        content: [{ type: "text", text: `Feature '${featureId}' not found.` }],
      };
    }

    if (!feature.workerId || feature.status !== "in_progress") {
      return {
        content: [{ type: "text", text: `Feature '${featureId}' does not have an active worker.` }],
      };
    }

    // Get worker directory from project
    const workerDir = `${projectDir}/.claude/orchestrator/workers`;
    const confidence = getWorkerConfidence(workerDir, featureId);

    if (!confidence) {
      return {
        content: [
          {
            type: "text",
            text: `Could not analyze confidence for ${featureId}. Worker may still be initializing.`,
          },
        ],
      };
    }

    // Check if we should alert based on threshold
    const threshold = current.confidenceConfig?.threshold ?? 35;
    let alertMessage = "";
    if (confidence.score < threshold) {
      alertMessage = `\n\n⚠️ ALERT: Confidence below threshold (${confidence.score} < ${threshold})`;

      // Add to alerts if autoAlert is enabled
      if (current.confidenceConfig?.autoAlert !== false) {
        if (!current.confidenceAlerts) {
          current.confidenceAlerts = [];
        }
        current.confidenceAlerts.push({
          type: "self_reported_low",
          message: `Confidence for ${featureId} dropped to ${confidence.score}`,
          severity: confidence.score < 20 ? "critical" : "warning",
          timestamp: new Date().toISOString(),
        });
        current.progressLog.push(
          `[${new Date().toISOString()}] ⚠️ Low confidence alert: ${featureId} at ${confidence.score}%`
        );
        state.save(current);
      }
    }

    return {
      content: [
        {
          type: "text",
          text: `📊 Confidence Analysis for ${featureId}\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n${formatConfidenceResult(confidence)}${alertMessage}`,
        },
      ],
    };
  }
);

// ============================================================================
// TOOL: set_confidence_threshold
// ============================================================================
server.tool(
  "set_confidence_threshold",
  "Configure the confidence threshold for alerts. When worker confidence drops below this threshold, alerts will be generated.",
  {
    projectDir: z.string().describe("Absolute path to the project directory"),
    threshold: z.number().min(0).max(100).describe("Confidence threshold (0-100, default: 35)"),
    autoAlert: z.boolean().optional().describe("Automatically log alerts to progress log (default: true)"),
  },
  async ({ projectDir, threshold, autoAlert }) => {
    const { state } = await ensureInitialized(projectDir);
    const current = state.load();

    if (!current) {
      return {
        content: [{ type: "text", text: "No active session. Use orchestrator_init first." }],
      };
    }

    current.confidenceConfig = {
      threshold,
      autoAlert: autoAlert ?? true,
    };

    current.progressLog.push(
      `[${new Date().toISOString()}] 🎚️ Confidence threshold set to ${threshold}% (autoAlert: ${autoAlert ?? true})`
    );
    state.save(current);

    return {
      content: [
        {
          type: "text",
          text: `🎚️ Confidence Threshold Updated\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\nThreshold: ${threshold}%\nAuto-Alert: ${autoAlert ?? true}\n\nWhen any worker's confidence drops below ${threshold}%, an alert will be generated.`,
        },
      ],
    };
  }
);

// ============================================================================
// Start the server
// ============================================================================
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Claude Orchestrator MCP Server running");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
