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

import { StateManager, OrchestratorState, Feature, WorkerStatus, ReviewWorker, ReviewConfig, AggregatedReview, PlanModeConfig, RalphLoopConfig } from "./state/manager.js";
import { WorkerManager } from "./workers/manager.js";
import { ReviewManager, DEFAULT_REVIEW_CONFIG } from "./workers/review-manager.js";
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
import { ProtocolRegistry } from "./protocols/registry.js";
import { Protocol, ProtocolSchema, validateProtocol } from "./protocols/schema.js";
import { ContextEnricher, EnrichedContext, formatContextForPrompt } from "./context/enricher.js";
import type { DocumentationRef, PreparedContext, ProtocolBinding, RoutingConfig } from "./state/manager.js";
import { getNetworkingManager, ProtocolNetworkingManager, ConflictStrategy as NetworkConflictStrategy } from "./protocols/network/index.js";
import { getProposalManager, ProposalManager, type ProtocolProposal } from "./protocols/proposal-manager.js";
import { getBaseConstraints } from "./protocols/base-constraints.js";
import type { BaseConstraints } from "./protocols/schema.js";
import { SetupManager } from "./setup/manager.js";
import { VerificationRunner } from "./workers/verification-runner.js";
import { validateFeature } from "./utils/validation.js";
import { DEFAULT_APPROVAL_CRITERIA } from "./workers/plan-reviewer.js";
import type { ApprovalCriteria } from "./workers/plan-reviewer.js";
import {
  captureGitState,
  calculateGitVerification,
  formatGitVerification,
} from "./utils/git-verification.js";

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
let protocolRegistry: ProtocolRegistry | null = null;

/**
 * Initialize managers for a project directory
 * Security: Validates project directory to prevent path traversal
 */
async function ensureInitialized(projectDir: string): Promise<{ state: StateManager; workers: WorkerManager; protocols: ProtocolRegistry }> {
  // Validate project directory (throws on invalid path)
  const validatedDir = validateProjectDir(projectDir);

  if (!stateManager || stateManager.projectDir !== validatedDir) {
    stateManager = new StateManager(validatedDir);
    workerManager = new WorkerManager(validatedDir, stateManager);
    protocolRegistry = new ProtocolRegistry(validatedDir);

    // Set up context enricher for auto-enriching worker prompts
    const enricher = new ContextEnricher(validatedDir);
    workerManager.setEnricher(enricher);

    // Verification runner for auto-verifying worker output
    const verificationRunner = new VerificationRunner();

    // Register completion callback to log and auto-verify when workers complete/crash
    workerManager.onWorkerCompletion(async (featureId, status, output) => {
      const currentState = stateManager?.load();
      if (!currentState) return;

      const feature = currentState.features.find((f) => f.id === featureId);
      const shortOutput = output ? output.slice(0, 100).replace(/\n/g, " ") : "";

      if (status === "completed") {
        // Auto-run verification if configured
        const verificationConfig = currentState.verificationConfig;
        if (verificationConfig?.commands?.length && verificationConfig.failOnError && feature) {
          const workingDir = feature.worktreePath || validatedDir;
          const verifyResult = await verificationRunner.runVerification(
            verificationConfig.commands,
            workingDir
          );

          if (!verifyResult.allPassed) {
            const failureSummary = verificationRunner.formatForRetry(verifyResult);
            const logMessage = `[${new Date().toISOString()}] 🚫 Worker ${featureId} completed but verification FAILED (${verifyResult.failedCount}/${verifyResult.results.length} commands). Auto-retry will occur on mark_complete.`;
            currentState.progressLog.push(logMessage);

            // Store the verification failure on the feature for retry context
            feature.lastError = failureSummary;

            currentState.lastUpdated = new Date().toISOString();
            stateManager?.save(currentState);
            console.error(logMessage);
            return;
          }

          // Verification passed
          const logMessage = `[${new Date().toISOString()}] ✅ Worker completed and verification PASSED: ${featureId} - use mark_complete to update status`;
          currentState.progressLog.push(logMessage);
          currentState.lastUpdated = new Date().toISOString();
          stateManager?.save(currentState);
          console.error(logMessage);
          return;
        }

        // No verification configured - standard completion log
        const logMessage = `[${new Date().toISOString()}] 🔔 Worker completed: ${featureId} - use mark_complete to update status`;
        currentState.progressLog.push(logMessage);
        currentState.lastUpdated = new Date().toISOString();
        stateManager?.save(currentState);
        console.error(logMessage);
      } else {
        const logMessage = `[${new Date().toISOString()}] ⚠️ Worker crashed: ${featureId}${shortOutput ? ` - ${shortOutput}...` : ""} - use mark_complete to update status`;
        currentState.progressLog.push(logMessage);
        currentState.lastUpdated = new Date().toISOString();
        stateManager?.save(currentState);
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

  // TypeScript safety: protocolRegistry is always set when stateManager is set
  if (!protocolRegistry) {
    throw new Error("ProtocolRegistry not initialized");
  }

  return { state: stateManager, workers: workerManager, protocols: protocolRegistry };
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
    format: z.enum(["compact", "pretty"]).optional().describe("Output format: 'compact' for minimal output (no emoji/decorators), 'pretty' for full formatting (default)"),
  },
  async ({ projectDir, format = "pretty" }) => {
    const { state, workers } = await ensureInitialized(projectDir);
    let current = state.load();

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

    // If session is in "reviewing" state, automatically check and update review status
    let reviewStatusUpdated = false;
    if (current.status === "reviewing" && current.reviewWorkers && current.reviewWorkers.length > 0) {
      const reviewManager = new ReviewManager(projectDir);
      const { allDone, reviewWorkers } = await reviewManager.checkReviewStatus(
        current.reviewWorkers,
        workers
      );

      // Update state with new review worker status
      current.reviewWorkers = reviewWorkers;

      // If all reviews are done, transition to completed
      if (allDone) {
        current.aggregatedReview = reviewManager.aggregateReviews(reviewWorkers);
        const allFeaturesSucceeded = current.features.every(f => f.status === "completed");
        current.status = allFeaturesSucceeded ? "completed" : "completed_with_failures";
        current.completedAt = new Date().toISOString();

        // Add review findings to progress log
        const reviewLogs = reviewManager.formatReviewsForLog(current.aggregatedReview);
        current.progressLog.push(...reviewLogs);
        current.progressLog.push(`[${new Date().toISOString()}] 🏁 Orchestration completed with reviews.`);
        reviewStatusUpdated = true;

        state.save(current);
        state.writeProgressFile();
      } else {
        // Just save the updated review worker statuses
        state.save(current);
      }
    }

    // Also check for review findings if session is completed but aggregatedReview is missing
    // This handles the case where reviews finished but findings weren't loaded
    if ((current.status === "completed" || current.status === "completed_with_failures") &&
        !current.aggregatedReview && current.reviewWorkers && current.reviewWorkers.length > 0) {
      const reviewManager = new ReviewManager(projectDir);

      // Update review worker statuses by checking findings files
      const { allDone, reviewWorkers } = await reviewManager.checkReviewStatus(
        current.reviewWorkers,
        workers
      );
      current.reviewWorkers = reviewWorkers;

      if (allDone) {
        current.aggregatedReview = reviewManager.aggregateReviews(reviewWorkers);
        reviewStatusUpdated = true;
        state.save(current);
      }
    }

    // Update worker statuses from tmux
    const workerStatuses = await workers.checkAllWorkers();

    const completed = current.features.filter(f => f.status === "completed");
    const failed = current.features.filter(f => f.status === "failed");
    const inProgress = current.features.filter(f => f.status === "in_progress");
    const pending = current.features.filter(f => f.status === "pending");

    const elapsed = formatDuration(new Date(current.startTime), new Date());

    // Compact format - minimal tokens, no emoji/decorators
    if (format === "compact") {
      let statusText = `Status: ${current.status} | Elapsed: ${elapsed}\n`;
      statusText += `Features: ${completed.length} done, ${inProgress.length} active, ${pending.length} pending, ${failed.length} failed\n`;

      if (inProgress.length > 0) {
        statusText += `Active: ${inProgress.map(f => f.id).join(", ")}\n`;
      }
      if (pending.length > 0) {
        statusText += `Next: ${pending.slice(0, 3).map(f => f.id).join(", ")}${pending.length > 3 ? ` +${pending.length - 3}` : ""}\n`;
      }
      if (failed.length > 0) {
        statusText += `Failed: ${failed.map(f => f.id).join(", ")}\n`;
      }

      return {
        content: [{ type: "text", text: statusText }],
      };
    }

    // Pretty format - full formatting with emojis
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

    // Show review status if in reviewing state or reviews just completed
    if (current.reviewWorkers && current.reviewWorkers.length > 0) {
      statusText += `🔍 Review Status:\n`;
      for (const rw of current.reviewWorkers) {
        const statusIcon = rw.status === "completed" ? "✅" :
          rw.status === "failed" ? "❌" : "🔄";
        statusText += `  ${statusIcon} ${rw.type.toUpperCase()} Review: ${rw.status}\n`;
        if (rw.findings) {
          statusText += `     Severity: ${rw.findings.severity} (${rw.findings.issues.length} issues)\n`;
        }
      }
      if (reviewStatusUpdated) {
        statusText += `\n  🏁 Reviews completed! Use get_review_results for detailed findings.\n`;
      }
      statusText += `\n`;
    }

    // Show verification config if set
    if (current.verificationConfig?.commands?.length) {
      statusText += `🔧 Verification Commands:\n`;
      for (const cmd of current.verificationConfig.commands) {
        statusText += `  - \`${cmd}\`\n`;
      }
      statusText += `  Mode: ${current.verificationConfig.failOnError ? "Must pass" : "Warnings only"}\n\n`;
    }

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

    // Capture git state before worker starts (for verification)
    try {
      const beforeHash = captureGitState(projectDir);
      feature.gitVerification = {
        beforeHash,
        afterHash: "",
        filesChanged: [],
        linesAdded: 0,
        linesDeleted: 0,
        diffChecksum: "",
      };
    } catch (error) {
      // Git state capture is optional - continue without it
      console.warn("Failed to capture git state:", error);
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

    // Capture git state once for all workers (they start from same point)
    let beforeHash: string | undefined;
    try {
      beforeHash = captureGitState(projectDir);
    } catch (error) {
      console.warn("Failed to capture git state:", error);
    }

    const startPromises = featuresToStart.map(async (feature) => {
      // Set git verification if we captured state
      if (beforeHash) {
        feature.gitVerification = {
          beforeHash,
          afterHash: "",
          filesChanged: [],
          linesAdded: 0,
          linesDeleted: 0,
          diffChecksum: "",
        };
      }

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
      responseText += `\n`;

      // Find features involved in conflicts
      const conflictingFeatures = new Set<string>();
      for (const w of warnings) {
        conflictingFeatures.add(w.feature1);
        conflictingFeatures.add(w.feature2);
      }

      // Find features that can run safely in parallel
      const safeFeatures = ready.filter(r => !conflictingFeatures.has(r.id));
      if (safeFeatures.length > 0) {
        responseText += `  ✅ Safe to run in parallel: ${safeFeatures.map(f => f.id).join(", ")}\n`;
      }

      responseText += `\n  💡 Mitigation options:\n`;
      responseText += `     1. Run conflicting features sequentially (safest)\n`;
      responseText += `     2. Use set_dependencies to order features explicitly\n`;
      responseText += `     3. If workers modify different parts of the same file, parallel may still work\n\n`;
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
    format: z.enum(["compact", "pretty"]).optional().describe("Output format: 'compact' for minimal output (no emoji/decorators), 'pretty' for full formatting (default)"),
  },
  async ({ projectDir, outputLines = 10, includeOutput = true, heartbeat = false, format = "pretty" }) => {
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

    const completedCount = current.features.filter((f) => f.status === "completed").length;
    const pendingCount = current.features.filter((f) => f.status === "pending").length;
    const failedCount = current.features.filter((f) => f.status === "failed").length;

    if (inProgressFeatures.length === 0) {
      const pending = current.features.filter((f) => f.status === "pending");
      if (format === "compact") {
        return {
          content: [
            {
              type: "text",
              text: `No active workers | ${completedCount}/${current.features.length} done${failedCount > 0 ? `, ${failedCount} failed` : ""} | Next: ${pending.slice(0, 3).map((f) => f.id).join(", ") || "none"}`,
            },
          ],
        };
      }
      return {
        content: [
          {
            type: "text",
            text: `📋 No workers currently running.\n\nProgress: ${completedCount}/${current.features.length} completed${failedCount > 0 ? `, ${failedCount} failed` : ""}\nPending: ${pending.length > 0 ? pending.map((f) => f.id).join(", ") : "none"}`,
          },
        ],
      };
    }

    // Compact format - minimal tokens, no emoji/decorators
    if (format === "compact") {
      let responseText = `Workers: ${inProgressFeatures.length} active | ${completedCount}/${current.features.length} done\n`;
      for (const feature of inProgressFeatures) {
        const info = await workers.getHeartbeatInfo(feature.workerId!, feature.startedAt);
        responseText += `${feature.id}: ${info.status}`;
        if (info.runningFor) responseText += ` ${info.runningFor}`;
        if (info.lastToolUsed) responseText += ` [${info.lastToolUsed}]`;
        responseText += `\n`;
      }
      return {
        content: [{ type: "text", text: responseText }],
      };
    }

    // Pretty format - full formatting with emojis
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
    responseText += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    responseText += `📊 Progress: ${completedCount}/${current.features.length} completed`;
    if (pendingCount > 0) responseText += `, ${pendingCount} pending`;
    if (failedCount > 0) responseText += `, ${failedCount} failed`;

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

    // Extract modified files from the worker log
    const modifiedFiles = await workers.getModifiedFilesForFeature(featureId);
    if (modifiedFiles.length > 0) {
      feature.modifiedFiles = modifiedFiles;
    }

    // Calculate git verification if we captured beforeHash
    if (feature.gitVerification && feature.gitVerification.beforeHash) {
      try {
        const verification = calculateGitVerification(
          projectDir,
          feature.gitVerification.beforeHash
        );
        feature.gitVerification = verification;
      } catch (error) {
        console.warn("Failed to calculate git verification:", error);
      }
    }

    // Validation: Run validation checks if marking as success
    let validationWarning = "";
    let validationBlocked = false;

    if (success && feature.validation?.enabled) {
      try {
        const validationResult = await validateFeature(feature, projectDir);
        feature.validationResult = validationResult;

        if (!validationResult.passed && feature.validation.enforceBlocking) {
          // Validation failed and blocking is enforced - prevent completion
          validationBlocked = true;

          // Format validation failure details
          const failedChecks = validationResult.checks
            .filter(c => !c.passed)
            .map(c => `  • ${c.name}: ${c.details}`)
            .join("\n");

          const validationError = `Validation failed:\n${failedChecks}`;
          feature.lastError = validationError;

          // Keep as pending for retry
          feature.status = "pending";
          feature.workerId = undefined;

          current.progressLog.push(
            `[${new Date().toISOString()}] 🔄 Validation failed: ${featureId} - attempt ${feature.attempts}/${feature.maxRetries || maxRetries}\n${validationError}`
          );
          current.lastUpdated = new Date().toISOString();
          state.save(current);
          state.writeProgressFile();

          const retryGuidance = feature.attempts < (feature.maxRetries || maxRetries)
            ? `\n\n💡 Feature will be retried (attempt ${feature.attempts + 1}/${feature.maxRetries || maxRetries}). Address validation failures:\n${failedChecks}\n\nUse start_worker to launch retry.`
            : `\n\n❌ Max retries (${feature.maxRetries || maxRetries}) exhausted. Validation still failing.`;

          return {
            content: [{
              type: "text",
              text: `🚫 Validation blocked completion of ${featureId}\n\n${validationError}${retryGuidance}`,
            }],
          };
        } else if (!validationResult.passed) {
          // Validation failed but not blocking - just warn
          const failedChecks = validationResult.checks
            .filter(c => !c.passed)
            .map(c => `  • ${c.name}: ${c.details}`)
            .join("\n");
          validationWarning = `\n\n⚠️ WARNING: Validation checks failed (non-blocking):\n${failedChecks}`;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        validationWarning = `\n\n⚠️ WARNING: Validation execution failed: ${message}`;
      }
    }

    let resultStatus: string;
    let willRetry = false;

    if (success && !validationBlocked) {
      // Mark as completed
      feature.status = "completed";
      feature.completedAt = new Date().toISOString();
      resultStatus = "completed";

      // If worker used a worktree, merge it back
      if (feature.isolationMode === "worktree" && feature.worktreePath) {
        const worktreeManager = workers.getWorktreeManager();
        const mergeResult = await worktreeManager.mergeWorktree(featureId);
        if (!mergeResult.success) {
          const conflictList = mergeResult.conflicts?.join(", ") || "unknown files";
          validationWarning += `\n\n⚠️ Merge conflicts on: ${conflictList}. Manual resolution required.`;
          feature.notes = (feature.notes || "") + `\nMerge conflicts: ${conflictList}`;
        }
        // Clean up worktree regardless
        await worktreeManager.removeWorktree(featureId);
      } else {
        // Legacy mode: clean up snapshot branch on successful completion
        await workers.deleteSnapshotBranch(featureId);
      }
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

      // Clean up worktree for failed features (no merge - discard changes)
      if (feature.isolationMode === "worktree" && feature.worktreePath && !willRetry) {
        const worktreeManager = workers.getWorktreeManager();
        await worktreeManager.removeWorktree(featureId);
      }
    }

    feature.workerId = undefined;

    // Release any file locks held by this feature
    const lockManager = workers.getLockManager();
    lockManager.releaseAll(featureId);

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
    let reviewsStarted = false;

    if (allDone) {
      const allSucceeded = current.features.every(f => f.status === "completed");

      // Check if reviews should be triggered
      const reviewConfig = current.reviewConfig || DEFAULT_REVIEW_CONFIG;
      const shouldReview = reviewConfig.enabled &&
        reviewConfig.autoTrigger &&
        (allSucceeded || !reviewConfig.skipOnFailure) &&
        (reviewConfig.codeReviewEnabled || reviewConfig.architectureReviewEnabled);

      if (shouldReview) {
        // Transition to reviewing status instead of completed
        current.status = "reviewing";
        current.progressLog.push(`[${new Date().toISOString()}] 🔍 All features done. Starting automated reviews...`);

        // Start review workers
        const reviewManager = new ReviewManager(projectDir);
        const reviewWorkers = await reviewManager.startReviews(current, workers, reviewConfig);
        current.reviewWorkers = reviewWorkers;
        reviewsStarted = reviewWorkers.length > 0;

        if (reviewWorkers.length > 0) {
          current.progressLog.push(`[${new Date().toISOString()}] 🔍 Started ${reviewWorkers.length} review worker(s)`);
        }
        // Note: completedAt is NOT set yet - wait for reviews
      } else {
        // No reviews configured - complete normally
        current.status = allSucceeded ? "completed" : "completed_with_failures";
        current.completedAt = new Date().toISOString();
        current.progressLog.push(`[${new Date().toISOString()}] 🏁 Orchestration ${allSucceeded ? "completed successfully" : "completed with failures"}`);

        // Clean up all remaining snapshot branches (session is done, rollback no longer possible)
        const cleanedBranches = await workers.cleanupAllSnapshotBranches();
        if (cleanedBranches > 0) {
          current.progressLog.push(`[${new Date().toISOString()}] 🧹 Cleaned up ${cleanedBranches} snapshot branch(es)`);
        }
      }
    }

    state.save(current);
    state.writeProgressFile();

    const completed = current.features.filter(f => f.status === "completed").length;
    const total = current.features.length;

    let responseText = `${success ? "✅" : willRetry ? "🔄" : "❌"} Feature ${featureId} ${resultStatus}.\n\nProgress: ${completed}/${total} features completed`;

    // Add validation warning if present
    if (validationWarning) {
      responseText += validationWarning;
    }

    if (willRetry) {
      responseText += `\n\n💡 Feature will be retried. Use start_worker to launch a new attempt.`;
    }

    if (allDone && reviewsStarted) {
      responseText += `\n\n🔍 All features processed! Reviews started. Use check_reviews to monitor progress.`;
    } else if (allDone) {
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
// TOOL: rollback_feature
// ============================================================================
server.tool(
  "rollback_feature",
  "Roll back files changed by a feature worker to their pre-worker state using git. Each worker creates a snapshot branch before starting that can be used for rollback.",
  {
    projectDir: z.string().describe("Absolute path to the project directory"),
    featureId: z.string().describe("ID of the feature to rollback"),
    files: z.array(z.string()).optional().describe("Specific files to rollback. If not provided, all files changed by the worker will be rolled back."),
  },
  async ({ projectDir, featureId, files }) => {
    const { workers } = await ensureInitialized(projectDir);

    // Validate feature ID format
    try {
      validateFeatureId(featureId);
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `Invalid feature ID: ${error.message}` }],
      };
    }

    const result = await workers.rollbackFeature(featureId, files);

    if (!result.success) {
      return {
        content: [{ type: "text", text: `❌ Rollback failed: ${result.error}` }],
      };
    }

    let responseText = `🔙 Rollback successful for feature ${featureId}\n\n`;
    if (result.restoredFiles && result.restoredFiles.length > 0) {
      responseText += `Restored files (${result.restoredFiles.length}):\n`;
      for (const file of result.restoredFiles) {
        responseText += `  - ${file}\n`;
      }
    } else {
      responseText += `No files were changed since the snapshot.\n`;
    }
    responseText += `\n💡 The working directory now matches the state before the worker started.\n`;
    responseText += `Use retry_feature to try implementing again.\n\n`;
    responseText += `⚠️  Race condition warning: If other workers modified the same files, their changes were also reverted.\n`;
    responseText += `Run check_rollback_conflicts before rollback in parallel worker environments to detect file conflicts.`;

    return {
      content: [{ type: "text", text: responseText }],
    };
  }
);

// ============================================================================
// TOOL: check_rollback_conflicts
// ============================================================================
server.tool(
  "check_rollback_conflicts",
  "Check for potential conflicts before rolling back a feature. Compares files modified by the target feature against files modified by other features to detect overlapping changes that would be affected by rollback.",
  {
    projectDir: z.string().describe("Absolute path to the project directory"),
    featureId: z.string().describe("ID of the feature to check rollback conflicts for"),
  },
  async ({ projectDir, featureId }) => {
    const { state, workers } = await ensureInitialized(projectDir);

    // Validate feature ID format
    try {
      validateFeatureId(featureId);
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `Invalid feature ID: ${error.message}` }],
      };
    }

    // Load current state
    const current = state.load();
    if (!current) {
      return {
        content: [{ type: "text", text: "No active orchestration session. Use orchestrator_init first." }],
      };
    }

    // Check if feature exists
    const feature = current.features.find((f: { id: string }) => f.id === featureId);
    if (!feature) {
      return {
        content: [{ type: "text", text: `Feature ${featureId} not found` }],
      };
    }

    const result = await workers.checkRollbackConflicts(featureId, current.features);

    let responseText = `🔍 Rollback Conflict Check for ${featureId}\n\n`;

    if (result.targetFiles.length === 0) {
      responseText += `No modified files detected for this feature.\n`;
      responseText += `Either the worker hasn't made changes yet, or the snapshot branch is missing.`;
      return {
        content: [{ type: "text", text: responseText }],
      };
    }

    responseText += `Files that would be rolled back (${result.targetFiles.length}):\n`;
    for (const file of result.targetFiles.slice(0, 20)) {
      responseText += `  - ${file}\n`;
    }
    if (result.targetFiles.length > 20) {
      responseText += `  ... and ${result.targetFiles.length - 20} more\n`;
    }

    responseText += `\n`;

    if (!result.hasConflicts) {
      responseText += `✅ No conflicts detected!\n`;
      responseText += `Safe to proceed with rollback_feature.`;
    } else {
      responseText += `⚠️  CONFLICTS DETECTED!\n\n`;
      responseText += `The following features have modified the same files:\n\n`;

      for (const conflict of result.conflicts) {
        responseText += `• ${conflict.featureId} (${conflict.status}):\n`;
        for (const file of conflict.sharedFiles.slice(0, 5)) {
          responseText += `    - ${file}\n`;
        }
        if (conflict.sharedFiles.length > 5) {
          responseText += `    ... and ${conflict.sharedFiles.length - 5} more shared files\n`;
        }
        responseText += `\n`;
      }

      responseText += `⛔ Rolling back ${featureId} will revert changes from these features too!\n\n`;
      responseText += `Options:\n`;
      responseText += `1. Roll back specific non-conflicting files only\n`;
      responseText += `2. Wait for conflicting features to complete and re-evaluate\n`;
      responseText += `3. Proceed with caution if you understand the implications`;
    }

    return {
      content: [{ type: "text", text: responseText }],
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

    // Clean up all swarm/* snapshot branches
    const branchesDeleted = await workers.cleanupAllSnapshotBranches();

    // Clean up all worktrees
    const worktreeManager = workers.getWorktreeManager();
    const worktreesCleaned = await worktreeManager.cleanupAll();

    // Clear all file locks
    const lockManager = workers.getLockManager();
    const locksCleared = lockManager.clearAll();

    // Clear state
    state.clear();

    let response = "🔄 Orchestration reset. All workers killed and state cleared.";
    if (branchesDeleted > 0) {
      response += `\n🗑️ Cleaned up ${branchesDeleted} snapshot branch(es).`;
    }
    if (worktreesCleaned > 0) {
      response += `\n🗑️ Cleaned up ${worktreesCleaned} worktree(s).`;
    }
    if (locksCleared > 0) {
      response += `\n🗑️ Cleared ${locksCleared} file lock(s).`;
    }
    response += "\n\nUse orchestrator_init to start a new session.";

    return {
      content: [{ type: "text", text: response }],
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
    limit: z.number().optional().describe("Number of entries to return (default: 20)"),
    offset: z.number().optional().describe("Number of entries to skip from the end (default: 0)"),
  },
  async ({ projectDir, limit = 20, offset = 0 }) => {
    const { state } = await ensureInitialized(projectDir);
    const current = state.load();

    if (!current) {
      return {
        content: [{ type: "text", text: "No active session." }],
      };
    }

    const totalEntries = current.progressLog.length;
    // Calculate slice range: skip 'offset' from end, then take 'limit' entries
    const startIndex = Math.max(0, totalEntries - offset - limit);
    const endIndex = Math.max(0, totalEntries - offset);
    const logs = current.progressLog.slice(startIndex, endIndex);

    const hasMore = startIndex > 0;
    const nextOffset = offset + limit;

    return {
      content: [
        {
          type: "text",
          text: `📜 Progress Log (${logs.length}/${totalEntries} entries)\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n${logs.join("\n")}${hasMore ? `\n\n(${startIndex} older entries, use offset=${nextOffset} to see more)` : ""}`,
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
    format: z.enum(["compact", "pretty"]).optional().describe("Output format: 'compact' for minimal output (no emoji/decorators), 'pretty' for full formatting (default)"),
  },
  async ({ projectDir, format = "pretty" }) => {
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

    // Compact format - minimal tokens, no emoji/decorators
    if (format === "compact") {
      let statsText = `Elapsed: ${totalElapsed} | Success: ${formatPercent(successRate)}\n`;
      statsText += `Features: ${completed.length} done, ${inProgress.length} active, ${pending.length} pending, ${failed.length} failed\n`;
      statsText += `Workers: ${runningWorkers} running, ${completedWorkers} completed, ${crashedWorkers} crashed\n`;
      statsText += `Attempts: ${totalAttempts} total, ${avgAttempts.toFixed(1)} avg, ${maxAttempts} max`;
      if (completionTimes.length > 0) {
        statsText += ` | Avg time: ${formatDurationMs(avgCompletionTimeMs)}`;
      }
      return {
        content: [{ type: "text", text: statsText }],
      };
    }

    // Pretty format - full formatting with emojis
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
  "Resume a paused or crashed orchestration session. Handles crash recovery: detects dead workers, restarts from checkpoints, and resumes auto-orchestration.",
  {
    projectDir: z.string().describe("Absolute path to the project directory"),
    fromCheckpoint: z.string().optional().describe("Specific checkpoint ID to restore from, or 'latest' (default: auto-detect)"),
    restartDeadWorkers: z.boolean().optional().describe("Restart workers that died during crash (default: true)"),
  },
  async ({ projectDir, fromCheckpoint, restartDeadWorkers = true }) => {
    const { state, workers } = await ensureInitialized(projectDir);
    const current = state.load();

    if (!current) {
      return {
        content: [{ type: "text", text: "No active session. Use orchestrator_init first." }],
      };
    }

    // Crash recovery: detect if previous session crashed
    const crashInfo = state.detectCrash();
    let recoveryReport = "";

    if (crashInfo.crashed && crashInfo.checkpoint) {
      recoveryReport += `🔧 Crash detected! Recovering from checkpoint...\n`;
      const checkpoint = fromCheckpoint === "latest" || !fromCheckpoint
        ? crashInfo.checkpoint
        : state.loadCheckpoint(fromCheckpoint) || crashInfo.checkpoint;

      recoveryReport += `  Checkpoint: ${checkpoint.id} (${checkpoint.reason})\n`;
      recoveryReport += `  Active workers at crash: ${checkpoint.activeWorkers.length}\n`;

      // Restore state from checkpoint if current state is corrupted
      if (current.status !== "paused" && current.status !== "in_progress") {
        // State might be stale - use checkpoint state
        const restoredState = checkpoint.state;
        restoredState.status = "in_progress";
        restoredState.lastUpdated = new Date().toISOString();
        restoredState.progressLog.push(
          `[${new Date().toISOString()}] 🔧 State restored from checkpoint ${checkpoint.id}`
        );
        state.save(restoredState);
      }

      // Recover workers
      if (restartDeadWorkers && checkpoint.activeWorkers.length > 0) {
        const recovery = await workers.recoverWorkers(checkpoint);
        recoveryReport += `\n  Recovery results:\n`;
        if (recovery.recovered.length > 0) {
          recoveryReport += `    Still alive: ${recovery.recovered.join(", ")}\n`;
        }
        if (recovery.restarted.length > 0) {
          recoveryReport += `    Restarted: ${recovery.restarted.join(", ")}\n`;
        }
        if (recovery.abandoned.length > 0) {
          recoveryReport += `    Reset to pending: ${recovery.abandoned.join(", ")}\n`;
        }
      }

      // Reload after recovery
      const recoveredState = state.load()!;
      recoveredState.status = "in_progress";
      recoveredState.progressLog.push(
        `[${new Date().toISOString()}] ▶️ Session recovered from crash`
      );
      state.save(recoveredState);
      state.writeProgressFile();
    } else {
      // Normal resume (not a crash)
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

      current.status = "in_progress";
      current.lastUpdated = new Date().toISOString();
      current.progressLog.push(`[${new Date().toISOString()}] ▶️ Session resumed`);
      state.save(current);
      state.writeProgressFile();
    }

    const finalState = state.load()!;
    const pendingFeatures = finalState.features.filter(f => f.status === "pending");
    const completedFeatures = finalState.features.filter(f => f.status === "completed");
    const failedFeatures = finalState.features.filter(f => f.status === "failed");
    const inProgressFeatures = finalState.features.filter(f => f.status === "in_progress");

    let responseText = recoveryReport || `▶️ Session resumed!\n\n`;
    responseText += `\n📊 Current Status:\n`;
    responseText += `  ✅ Completed: ${completedFeatures.length}\n`;
    responseText += `  🔄 In progress: ${inProgressFeatures.length}\n`;
    responseText += `  ⏳ Pending: ${pendingFeatures.length}\n`;
    responseText += `  ❌ Failed: ${failedFeatures.length}\n\n`;

    if (pendingFeatures.length > 0) {
      responseText += `📋 Ready to work on:\n`;
      for (const f of pendingFeatures) {
        responseText += `  - ${f.id}: ${f.description}\n`;
      }
      responseText += `\nUse start_worker, start_ralph_loop, or auto_orchestrate to begin.`;
    } else if (inProgressFeatures.length > 0) {
      responseText += `Workers are running. Use check_worker to monitor progress.`;
    } else if (failedFeatures.length > 0) {
      responseText += `⚠️ No pending features. Consider retrying failed features.`;
    } else {
      responseText += `🎉 All features are completed!`;
    }

    // List available checkpoints
    const checkpoints = state.listCheckpoints();
    if (checkpoints.length > 0) {
      responseText += `\n\n📸 Available checkpoints: ${checkpoints.length}`;
      responseText += `\n  Latest: ${checkpoints[0].id} (${checkpoints[0].reason})`;
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
// TOOL: protocol_register
// ============================================================================
server.tool(
  "protocol_register",
  "Register a new protocol for behavioral governance. Protocols define constraints and enforcement rules for worker behavior.",
  {
    projectDir: z.string().describe("Absolute path to the project directory"),
    protocol: z.object({
      id: z.string().regex(/^[a-zA-Z0-9_-]+$/).describe("Unique protocol ID (alphanumeric with dashes/underscores)"),
      version: z.string().regex(/^\d+\.\d+\.\d+$/).describe("Semantic version (e.g., '1.0.0')"),
      name: z.string().min(1).max(100).describe("Human-readable name"),
      description: z.string().max(1000).optional().describe("Protocol description"),
      extends: z.array(z.string()).optional().describe("IDs of protocols this extends"),
      requires: z.array(z.string()).optional().describe("IDs of required protocols"),
      conflicts: z.array(z.string()).optional().describe("IDs of conflicting protocols"),
      constraints: z.array(z.object({
        id: z.string().describe("Constraint ID"),
        type: z.enum(["tool_restriction", "file_access", "output_format", "behavioral", "temporal", "resource", "side_effect"]),
        rule: z.record(z.unknown()).describe("Constraint-specific rule configuration"),
        severity: z.enum(["error", "warning", "info"]),
        message: z.string().max(500).describe("Human-readable description"),
        enabled: z.boolean().optional(),
      })).describe("Array of constraints"),
      enforcement: z.object({
        mode: z.enum(["strict", "permissive", "audit", "learning"]).optional(),
        preExecutionValidation: z.boolean().optional(),
        postExecutionValidation: z.boolean().optional(),
        onViolation: z.enum(["block", "warn", "log", "notify", "rollback"]).optional(),
        logLevel: z.enum(["none", "minimal", "standard", "verbose", "debug"]).optional(),
      }).optional().describe("Enforcement configuration"),
      applicableContexts: z.object({
        featurePatterns: z.array(z.string()).optional(),
        filePatterns: z.array(z.string()).optional(),
        projectPatterns: z.array(z.string()).optional(),
        taskPatterns: z.array(z.string()).optional(),
        environments: z.array(z.string()).optional(),
      }).optional().describe("Context matching configuration"),
      priority: z.number().int().min(0).max(1000).optional().describe("Priority (higher = more important, default: 100)"),
      tags: z.array(z.string()).optional().describe("Tags for categorization"),
    }).describe("Protocol definition"),
    activate: z.boolean().optional().describe("Activate immediately after registration (default: false)"),
  },
  async ({ projectDir, protocol, activate = false }) => {
    const { protocols, state } = await ensureInitialized(projectDir);

    try {
      // Build full protocol with defaults
      const fullProtocol: Protocol = {
        id: protocol.id,
        version: protocol.version,
        name: protocol.name,
        description: protocol.description,
        extends: protocol.extends,
        requires: protocol.requires,
        conflicts: protocol.conflicts,
        constraints: protocol.constraints.map(c => ({
          ...c,
          enabled: c.enabled ?? true,
          rule: c.rule as any, // Trust the Zod validation
        })),
        enforcement: {
          mode: protocol.enforcement?.mode ?? "strict",
          preExecutionValidation: protocol.enforcement?.preExecutionValidation ?? true,
          postExecutionValidation: protocol.enforcement?.postExecutionValidation ?? true,
          onViolation: protocol.enforcement?.onViolation ?? "block",
          maxRetries: 0,
          retryDelaySeconds: 0,
          logLevel: protocol.enforcement?.logLevel ?? "standard",
          includeContext: true,
          allowOverride: false,
          overrideRequiresApproval: true,
        },
        applicableContexts: protocol.applicableContexts ?? {},
        priority: protocol.priority ?? 100,
        tags: protocol.tags,
        enabled: true,
        deprecated: false,
        createdAt: new Date().toISOString(),
      };

      // Validate and register
      validateProtocol(fullProtocol);
      protocols.register(fullProtocol, "orchestrator");

      // Optionally activate
      if (activate) {
        protocols.activate(fullProtocol.id, "orchestrator");
      }

      // Log to state
      const current = state.load();
      if (current) {
        current.progressLog.push(
          `[${new Date().toISOString()}] 📋 Protocol registered: ${fullProtocol.id} v${fullProtocol.version}${activate ? " (activated)" : ""}`
        );
        state.save(current);
      }

      return {
        content: [
          {
            type: "text",
            text: `✅ Protocol Registered\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\nID: ${fullProtocol.id}\nVersion: ${fullProtocol.version}\nName: ${fullProtocol.name}\nConstraints: ${fullProtocol.constraints.length}\nPriority: ${fullProtocol.priority}\nStatus: ${activate ? "Active" : "Registered (inactive)"}\n\n${activate ? "Protocol is now enforcing constraints." : "Use protocol_activate to enable enforcement."}`,
          },
        ],
      };
    } catch (error: any) {
      return {
        content: [
          {
            type: "text",
            text: `❌ Failed to register protocol: ${error.message}`,
          },
        ],
      };
    }
  }
);

// ============================================================================
// TOOL: protocol_activate
// ============================================================================
server.tool(
  "protocol_activate",
  "Activate a registered protocol to begin enforcing its constraints. Checks for conflicts with currently active protocols.",
  {
    projectDir: z.string().describe("Absolute path to the project directory"),
    protocolId: z.string().describe("ID of the protocol to activate"),
  },
  async ({ projectDir, protocolId }) => {
    const { protocols, state } = await ensureInitialized(projectDir);

    try {
      // Get the protocol first to include details in response
      const protocol = protocols.getProtocol(protocolId);
      if (!protocol) {
        return {
          content: [
            {
              type: "text",
              text: `❌ Protocol '${protocolId}' not found.\n\nUse protocol_list to see available protocols.`,
            },
          ],
        };
      }

      // Check if already active
      if (protocols.isActive(protocolId)) {
        return {
          content: [
            {
              type: "text",
              text: `⚠️ Protocol '${protocolId}' is already active.`,
            },
          ],
        };
      }

      // Activate
      protocols.activate(protocolId, "orchestrator");

      // Log to state
      const current = state.load();
      if (current) {
        current.progressLog.push(
          `[${new Date().toISOString()}] ▶️ Protocol activated: ${protocolId}`
        );
        state.save(current);
      }

      const activeCount = protocols.getActive().length;

      return {
        content: [
          {
            type: "text",
            text: `▶️ Protocol Activated\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\nID: ${protocol.id}\nName: ${protocol.name}\nVersion: ${protocol.version}\nConstraints: ${protocol.constraints.length}\nMode: ${protocol.enforcement.mode}\n\nTotal active protocols: ${activeCount}\n\nThe protocol is now enforcing its constraints on workers.`,
          },
        ],
      };
    } catch (error: any) {
      return {
        content: [
          {
            type: "text",
            text: `❌ Failed to activate protocol: ${error.message}`,
          },
        ],
      };
    }
  }
);

// ============================================================================
// TOOL: protocol_deactivate
// ============================================================================
server.tool(
  "protocol_deactivate",
  "Deactivate an active protocol to stop enforcing its constraints. Checks for dependencies from other active protocols.",
  {
    projectDir: z.string().describe("Absolute path to the project directory"),
    protocolId: z.string().describe("ID of the protocol to deactivate"),
  },
  async ({ projectDir, protocolId }) => {
    const { protocols, state } = await ensureInitialized(projectDir);

    try {
      // Get the protocol first to include details in response
      const protocol = protocols.getProtocol(protocolId);
      if (!protocol) {
        return {
          content: [
            {
              type: "text",
              text: `❌ Protocol '${protocolId}' not found.\n\nUse protocol_list to see available protocols.`,
            },
          ],
        };
      }

      // Check if already inactive
      if (!protocols.isActive(protocolId)) {
        return {
          content: [
            {
              type: "text",
              text: `⚠️ Protocol '${protocolId}' is already inactive.`,
            },
          ],
        };
      }

      // Deactivate
      protocols.deactivate(protocolId, "orchestrator");

      // Log to state
      const current = state.load();
      if (current) {
        current.progressLog.push(
          `[${new Date().toISOString()}] ⏸️ Protocol deactivated: ${protocolId}`
        );
        state.save(current);
      }

      const activeCount = protocols.getActive().length;

      return {
        content: [
          {
            type: "text",
            text: `⏸️ Protocol Deactivated\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\nID: ${protocol.id}\nName: ${protocol.name}\n\nTotal active protocols: ${activeCount}\n\nThe protocol's constraints are no longer being enforced.`,
          },
        ],
      };
    } catch (error: any) {
      return {
        content: [
          {
            type: "text",
            text: `❌ Failed to deactivate protocol: ${error.message}`,
          },
        ],
      };
    }
  }
);

// ============================================================================
// TOOL: protocol_list
// ============================================================================
server.tool(
  "protocol_list",
  "List all registered protocols with their status and summary information.",
  {
    projectDir: z.string().describe("Absolute path to the project directory"),
    activeOnly: z.boolean().optional().describe("Only show active protocols (default: false)"),
    format: z.enum(["compact", "pretty"]).optional().describe("Output format: 'compact' for minimal output, 'pretty' for full formatting (default)"),
  },
  async ({ projectDir, activeOnly = false, format = "pretty" }) => {
    const { protocols } = await ensureInitialized(projectDir);

    const allProtocols = activeOnly ? protocols.getActiveProtocols() : protocols.getAllProtocols();
    const activeIds = new Set(protocols.getActive());

    if (allProtocols.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: activeOnly
              ? "No active protocols.\n\nUse protocol_register to add protocols, then protocol_activate to enable them."
              : "No protocols registered.\n\nUse protocol_register to add behavioral governance protocols.",
          },
        ],
      };
    }

    // Sort by priority (highest first), then by ID
    const sorted = [...allProtocols].sort((a, b) => {
      if (b.priority !== a.priority) return b.priority - a.priority;
      return a.id.localeCompare(b.id);
    });

    if (format === "compact") {
      let text = `Protocols: ${sorted.length} total, ${activeIds.size} active\n`;
      for (const p of sorted) {
        const status = activeIds.has(p.id) ? "ON" : "OFF";
        text += `[${status}] ${p.id} v${p.version} (${p.constraints.length} constraints)\n`;
      }
      return { content: [{ type: "text", text }] };
    }

    // Pretty format
    let text = `📋 Protocol Registry\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
    text += `Total: ${sorted.length} | Active: ${activeIds.size}\n\n`;

    for (const p of sorted) {
      const statusIcon = activeIds.has(p.id) ? "🟢" : "⚪";
      const statusText = activeIds.has(p.id) ? "Active" : "Inactive";

      text += `${statusIcon} ${p.id} (${statusText})\n`;
      text += `   Name: ${p.name}\n`;
      text += `   Version: ${p.version}\n`;
      text += `   Priority: ${p.priority}\n`;
      text += `   Constraints: ${p.constraints.length}\n`;
      text += `   Mode: ${p.enforcement.mode}\n`;
      if (p.description) {
        text += `   Description: ${p.description.slice(0, 80)}${p.description.length > 80 ? "..." : ""}\n`;
      }
      if (p.extends && p.extends.length > 0) {
        text += `   Extends: ${p.extends.join(", ")}\n`;
      }
      if (p.requires && p.requires.length > 0) {
        text += `   Requires: ${p.requires.join(", ")}\n`;
      }
      if (p.tags && p.tags.length > 0) {
        text += `   Tags: ${p.tags.join(", ")}\n`;
      }
      text += `\n`;
    }

    return { content: [{ type: "text", text }] };
  }
);

// ============================================================================
// TOOL: protocol_status
// ============================================================================
server.tool(
  "protocol_status",
  "Get detailed status of a specific protocol including its constraints, enforcement config, violations, and audit history.",
  {
    projectDir: z.string().describe("Absolute path to the project directory"),
    protocolId: z.string().describe("ID of the protocol to inspect"),
    includeViolations: z.boolean().optional().describe("Include recent violations (default: true)"),
    includeAudit: z.boolean().optional().describe("Include audit log entries (default: false)"),
    violationLimit: z.number().int().min(1).max(50).optional().describe("Max violations to show (default: 10)"),
    auditLimit: z.number().int().min(1).max(50).optional().describe("Max audit entries to show (default: 10)"),
  },
  async ({ projectDir, protocolId, includeViolations = true, includeAudit = false, violationLimit = 10, auditLimit = 10 }) => {
    const { protocols } = await ensureInitialized(projectDir);

    const protocol = protocols.getProtocol(protocolId);
    if (!protocol) {
      return {
        content: [
          {
            type: "text",
            text: `❌ Protocol '${protocolId}' not found.\n\nUse protocol_list to see available protocols.`,
          },
        ],
      };
    }

    const isActive = protocols.isActive(protocolId);
    const stats = protocols.getStats();

    let text = `📊 Protocol Status: ${protocol.id}\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;

    // Basic info
    text += `📌 Basic Information\n`;
    text += `   ID: ${protocol.id}\n`;
    text += `   Name: ${protocol.name}\n`;
    text += `   Version: ${protocol.version}\n`;
    text += `   Status: ${isActive ? "🟢 Active" : "⚪ Inactive"}\n`;
    text += `   Priority: ${protocol.priority}\n`;
    if (protocol.description) {
      text += `   Description: ${protocol.description}\n`;
    }
    if (protocol.createdAt) {
      text += `   Created: ${protocol.createdAt}\n`;
    }
    if (protocol.updatedAt) {
      text += `   Updated: ${protocol.updatedAt}\n`;
    }
    if (protocol.deprecated) {
      text += `   ⚠️ DEPRECATED: ${protocol.deprecationMessage || "No reason provided"}\n`;
    }
    text += `\n`;

    // Dependencies
    if ((protocol.extends && protocol.extends.length > 0) ||
        (protocol.requires && protocol.requires.length > 0) ||
        (protocol.conflicts && protocol.conflicts.length > 0)) {
      text += `🔗 Dependencies\n`;
      if (protocol.extends && protocol.extends.length > 0) {
        text += `   Extends: ${protocol.extends.join(", ")}\n`;
      }
      if (protocol.requires && protocol.requires.length > 0) {
        text += `   Requires: ${protocol.requires.join(", ")}\n`;
      }
      if (protocol.conflicts && protocol.conflicts.length > 0) {
        text += `   Conflicts: ${protocol.conflicts.join(", ")}\n`;
      }
      text += `\n`;
    }

    // Enforcement config
    text += `⚙️ Enforcement Configuration\n`;
    text += `   Mode: ${protocol.enforcement.mode}\n`;
    text += `   Pre-validation: ${protocol.enforcement.preExecutionValidation ? "Yes" : "No"}\n`;
    text += `   Post-validation: ${protocol.enforcement.postExecutionValidation ? "Yes" : "No"}\n`;
    text += `   On Violation: ${protocol.enforcement.onViolation}\n`;
    text += `   Log Level: ${protocol.enforcement.logLevel}\n`;
    if (protocol.enforcement.allowOverride) {
      text += `   Override Allowed: Yes (requires approval: ${protocol.enforcement.overrideRequiresApproval})\n`;
    }
    text += `\n`;

    // Constraints
    text += `📏 Constraints (${protocol.constraints.length})\n`;
    for (const c of protocol.constraints) {
      const enabledIcon = c.enabled ? "✓" : "✗";
      const severityIcon = c.severity === "error" ? "🔴" : c.severity === "warning" ? "🟡" : "🔵";
      text += `   ${enabledIcon} ${severityIcon} [${c.type}] ${c.id}\n`;
      text += `      ${c.message}\n`;
    }
    text += `\n`;

    // Context matching
    const ctx = protocol.applicableContexts;
    const hasContexts = ctx.featurePatterns?.length || ctx.filePatterns?.length ||
                        ctx.projectPatterns?.length || ctx.taskPatterns?.length ||
                        ctx.environments?.length;
    if (hasContexts) {
      text += `🎯 Context Matching\n`;
      if (ctx.featurePatterns?.length) text += `   Features: ${ctx.featurePatterns.join(", ")}\n`;
      if (ctx.filePatterns?.length) text += `   Files: ${ctx.filePatterns.join(", ")}\n`;
      if (ctx.projectPatterns?.length) text += `   Projects: ${ctx.projectPatterns.join(", ")}\n`;
      if (ctx.taskPatterns?.length) text += `   Tasks: ${ctx.taskPatterns.join(", ")}\n`;
      if (ctx.environments?.length) text += `   Environments: ${ctx.environments.join(", ")}\n`;
      text += `\n`;
    }

    // Violations
    if (includeViolations) {
      const violations = protocols.getViolations({ protocolId, limit: violationLimit });
      text += `⚠️ Recent Violations (${violations.length})\n`;
      if (violations.length === 0) {
        text += `   No violations recorded\n`;
      } else {
        for (const v of violations) {
          const resolvedIcon = v.resolved ? "✅" : "❌";
          text += `   ${resolvedIcon} [${v.severity}] ${v.constraintId} - ${v.message.slice(0, 60)}${v.message.length > 60 ? "..." : ""}\n`;
          text += `      Time: ${v.timestamp}${v.featureId ? ` | Feature: ${v.featureId}` : ""}\n`;
        }
      }
      text += `\n`;
    }

    // Audit log
    if (includeAudit) {
      const auditEntries = protocols.getAuditLog({ protocolId, limit: auditLimit });
      text += `📜 Audit Log (${auditEntries.length})\n`;
      if (auditEntries.length === 0) {
        text += `   No audit entries\n`;
      } else {
        for (const e of auditEntries) {
          text += `   [${e.action}] ${e.timestamp}${e.actor ? ` by ${e.actor}` : ""}\n`;
        }
      }
      text += `\n`;
    }

    // Registry stats
    text += `📈 Registry Stats\n`;
    text += `   Total Protocols: ${stats.totalProtocols}\n`;
    text += `   Active Protocols: ${stats.activeProtocols}\n`;
    text += `   Total Violations: ${stats.totalViolations}\n`;
    text += `   Unresolved Violations: ${stats.unresolvedViolations}\n`;

    return { content: [{ type: "text", text }] };
  }
);

// ============================================================================
// TOOL: enrich_feature
// ============================================================================
server.tool(
  "enrich_feature",
  "Auto-enrich a feature with relevant documentation and code context. Uses intelligent analysis to find related files, detect patterns, and prepare context for workers.",
  {
    projectDir: z.string().describe("Absolute path to the project directory"),
    featureId: z.string().describe("ID of the feature to enrich"),
    maxDocLength: z.number().optional().describe("Maximum characters per documentation file (default: 4000)"),
    maxCodeLength: z.number().optional().describe("Maximum characters per code file (default: 2000)"),
    maxTotalContext: z.number().optional().describe("Maximum total context size (default: 16000)"),
    maxRelatedFiles: z.number().optional().describe("Maximum number of related files to include (default: 10)"),
    detectPatterns: z.boolean().optional().describe("Enable architectural pattern detection (default: true)"),
  },
  async ({ projectDir, featureId, maxDocLength, maxCodeLength, maxTotalContext, maxRelatedFiles, detectPatterns }) => {
    const { state } = await ensureInitialized(projectDir);

    // Validate feature ID
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

    const feature = current.features.find((f) => f.id === featureId);
    if (!feature) {
      return {
        content: [{ type: "text", text: `Feature '${featureId}' not found.` }],
      };
    }

    // Create enricher with custom config
    const enricher = new ContextEnricher(projectDir, {
      maxDocLength: maxDocLength ?? 4000,
      maxCodeLength: maxCodeLength ?? 2000,
      maxTotalContext: maxTotalContext ?? 16000,
      maxRelatedFiles: maxRelatedFiles ?? 10,
      detectPatterns: detectPatterns ?? true,
    });

    // Enrich the feature
    const enrichedContext = await enricher.enrichFeature(feature, current.features);

    // Convert to feature context format
    const documentation: DocumentationRef[] = enrichedContext.documentation.map((doc) => ({
      type: "file" as const,
      path: doc.path,
      title: doc.path,
      relevance: `Priority ${doc.priority}${doc.truncated ? " (truncated)" : ""}`,
    }));

    const prepared: PreparedContext[] = [];

    // Add project info as prepared context
    if (enrichedContext.projectInfo.type !== "unknown") {
      prepared.push({
        key: "project_info",
        content: `Type: ${enrichedContext.projectInfo.type}${enrichedContext.projectInfo.framework ? `, Framework: ${enrichedContext.projectInfo.framework}` : ""}${enrichedContext.projectInfo.testFramework ? `, Tests: ${enrichedContext.projectInfo.testFramework}` : ""}`,
        source: "auto-detected",
        priority: "required",
      });
    }

    // Add documentation as prepared context
    for (const doc of enrichedContext.documentation.slice(0, 3)) {
      prepared.push({
        key: `doc_${doc.path.replace(/[^a-zA-Z0-9]/g, "_")}`,
        content: doc.content,
        source: doc.path,
        priority: doc.priority >= 80 ? "required" : "recommended",
        tokenEstimate: Math.ceil(doc.content.length / 4),
      });
    }

    // Add pattern conventions as prepared context
    for (const pattern of enrichedContext.patterns) {
      prepared.push({
        key: `pattern_${pattern.name.toLowerCase().replace(/\s+/g, "_")}`,
        content: `${pattern.name}: ${pattern.description}\nConventions:\n${pattern.conventions.map((c) => `- ${c}`).join("\n")}`,
        source: "pattern-detection",
        priority: "recommended",
      });
    }

    // Store context in feature
    feature.context = {
      documentation,
      prepared,
    };

    current.progressLog.push(
      `[${new Date().toISOString()}] 📚 Enriched ${featureId}: ${documentation.length} docs, ${enrichedContext.relatedFiles.length} related files, ${enrichedContext.patterns.length} patterns`
    );
    state.save(current);
    state.writeProgressFile();

    // Build response
    let response = `📚 Feature Enriched: ${featureId}\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;

    response += `📁 Project: ${enrichedContext.projectInfo.type}`;
    if (enrichedContext.projectInfo.framework) {
      response += ` (${enrichedContext.projectInfo.framework})`;
    }
    response += `\n\n`;

    response += `📄 Documentation (${documentation.length}):\n`;
    for (const doc of documentation.slice(0, 5)) {
      response += `  - ${doc.path}${doc.relevance ? ` [${doc.relevance}]` : ""}\n`;
    }
    if (documentation.length > 5) {
      response += `  ... and ${documentation.length - 5} more\n`;
    }
    response += `\n`;

    response += `📂 Related Files (${enrichedContext.relatedFiles.length}):\n`;
    for (const file of enrichedContext.relatedFiles.slice(0, 5)) {
      response += `  - ${file.path} (score: ${file.relevanceScore})\n`;
      response += `    ${file.relevanceReason}\n`;
    }
    if (enrichedContext.relatedFiles.length > 5) {
      response += `  ... and ${enrichedContext.relatedFiles.length - 5} more\n`;
    }
    response += `\n`;

    if (enrichedContext.patterns.length > 0) {
      response += `🏗️ Detected Patterns:\n`;
      for (const pattern of enrichedContext.patterns) {
        response += `  - ${pattern.name}: ${pattern.description}\n`;
      }
      response += `\n`;
    }

    if (enrichedContext.relatedFeatures.length > 0) {
      response += `🔗 Related Features: ${enrichedContext.relatedFeatures.join(", ")}\n\n`;
    }

    response += `📊 Total Context: ${enrichedContext.totalSize} chars (~${Math.ceil(enrichedContext.totalSize / 4)} tokens)\n`;
    response += `\nContext has been stored in the feature. It will be automatically injected into worker prompts.`;

    return {
      content: [{ type: "text", text: response }],
    };
  }
);

// ============================================================================
// TOOL: set_feature_context
// ============================================================================
server.tool(
  "set_feature_context",
  "Manually set context for a feature. Allows adding documentation references, prepared context blocks, and protocol bindings.",
  {
    projectDir: z.string().describe("Absolute path to the project directory"),
    featureId: z.string().describe("ID of the feature to configure"),
    documentation: z.array(z.object({
      type: z.enum(["file", "url", "snippet"]).describe("Type of documentation reference"),
      path: z.string().describe("File path, URL, or identifier"),
      title: z.string().optional().describe("Human-readable title"),
      relevance: z.string().optional().describe("Why this doc is relevant"),
      section: z.string().optional().describe("Specific section within the document"),
    })).optional().describe("Documentation references to add"),
    prepared: z.array(z.object({
      key: z.string().describe("Unique identifier for this context block"),
      content: z.string().describe("The actual context content"),
      source: z.string().optional().describe("Where this context came from"),
      priority: z.enum(["required", "recommended", "optional"]).describe("Priority for inclusion"),
      tokenEstimate: z.number().optional().describe("Estimated token count"),
    })).optional().describe("Pre-processed context blocks"),
    protocolBindings: z.array(z.object({
      protocolId: z.string().describe("Reference to the protocol in the registry"),
      version: z.string().optional().describe("Optional version constraint"),
      scope: z.enum(["pre_execution", "post_execution", "continuous", "all"]).describe("When to apply the protocol"),
      priority: z.number().describe("Higher priority protocols are enforced first"),
      parameters: z.record(z.unknown()).optional().describe("Protocol-specific parameters"),
      overrides: z.record(z.unknown()).optional().describe("Override default protocol settings"),
    })).optional().describe("Protocol bindings to apply"),
    merge: z.boolean().optional().describe("Merge with existing context instead of replacing (default: true)"),
  },
  async ({ projectDir, featureId, documentation, prepared, protocolBindings, merge = true }) => {
    const { state, protocols } = await ensureInitialized(projectDir);

    // Validate feature ID
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

    const feature = current.features.find((f) => f.id === featureId);
    if (!feature) {
      return {
        content: [{ type: "text", text: `Feature '${featureId}' not found.` }],
      };
    }

    // Validate protocol bindings if provided
    if (protocolBindings) {
      for (const binding of protocolBindings) {
        const protocol = protocols.getProtocol(binding.protocolId);
        if (!protocol) {
          return {
            content: [
              {
                type: "text",
                text: `❌ Protocol '${binding.protocolId}' not found. Register it first using protocol_register.`,
              },
            ],
          };
        }
      }
    }

    // Initialize or merge context
    if (!feature.context || !merge) {
      feature.context = {
        documentation: [],
        prepared: [],
      };
    }

    // Add documentation
    if (documentation) {
      const existingPaths = new Set(feature.context.documentation.map((d) => d.path));
      for (const doc of documentation) {
        if (!existingPaths.has(doc.path)) {
          feature.context.documentation.push(doc as DocumentationRef);
          existingPaths.add(doc.path);
        }
      }
    }

    // Add prepared context
    if (prepared) {
      const existingKeys = new Set(feature.context.prepared.map((p) => p.key));
      for (const prep of prepared) {
        if (existingKeys.has(prep.key)) {
          // Update existing
          const idx = feature.context.prepared.findIndex((p) => p.key === prep.key);
          if (idx >= 0) {
            feature.context.prepared[idx] = prep as PreparedContext;
          }
        } else {
          feature.context.prepared.push(prep as PreparedContext);
          existingKeys.add(prep.key);
        }
      }
    }

    // Set protocol bindings
    if (protocolBindings) {
      if (merge && feature.protocolBindings) {
        // Merge by protocol ID
        const existingIds = new Set(feature.protocolBindings.map((b) => b.protocolId));
        for (const binding of protocolBindings) {
          if (existingIds.has(binding.protocolId)) {
            // Update existing
            const idx = feature.protocolBindings.findIndex((b) => b.protocolId === binding.protocolId);
            if (idx >= 0) {
              feature.protocolBindings[idx] = binding as ProtocolBinding;
            }
          } else {
            feature.protocolBindings.push(binding as ProtocolBinding);
          }
        }
      } else {
        feature.protocolBindings = protocolBindings as ProtocolBinding[];
      }
    }

    current.progressLog.push(
      `[${new Date().toISOString()}] 📝 Set context for ${featureId}: ${feature.context.documentation.length} docs, ${feature.context.prepared.length} prepared, ${feature.protocolBindings?.length || 0} protocols`
    );
    state.save(current);
    state.writeProgressFile();

    // Build response
    let response = `📝 Feature Context Updated: ${featureId}\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;

    response += `📄 Documentation (${feature.context.documentation.length}):\n`;
    for (const doc of feature.context.documentation.slice(0, 5)) {
      response += `  - [${doc.type}] ${doc.path}${doc.title ? ` - ${doc.title}` : ""}\n`;
    }
    if (feature.context.documentation.length > 5) {
      response += `  ... and ${feature.context.documentation.length - 5} more\n`;
    }
    response += `\n`;

    response += `📦 Prepared Context (${feature.context.prepared.length}):\n`;
    for (const prep of feature.context.prepared.slice(0, 5)) {
      response += `  - [${prep.priority}] ${prep.key}`;
      if (prep.tokenEstimate) {
        response += ` (~${prep.tokenEstimate} tokens)`;
      }
      response += `\n`;
    }
    if (feature.context.prepared.length > 5) {
      response += `  ... and ${feature.context.prepared.length - 5} more\n`;
    }
    response += `\n`;

    if (feature.protocolBindings && feature.protocolBindings.length > 0) {
      response += `📋 Protocol Bindings (${feature.protocolBindings.length}):\n`;
      for (const binding of feature.protocolBindings) {
        response += `  - ${binding.protocolId} [${binding.scope}] priority=${binding.priority}\n`;
      }
      response += `\n`;
    }

    response += `Mode: ${merge ? "Merged with existing context" : "Replaced existing context"}`;

    return {
      content: [{ type: "text", text: response }],
    };
  }
);

// ============================================================================
// TOOL: get_feature_graph
// ============================================================================
server.tool(
  "get_feature_graph",
  "Get the feature dependency graph with context information. Shows relationships between features, their dependencies, and enriched context summaries.",
  {
    projectDir: z.string().describe("Absolute path to the project directory"),
    format: z.enum(["compact", "pretty", "json"]).optional().describe("Output format (default: pretty)"),
    includeContext: z.boolean().optional().describe("Include context summaries (default: true)"),
    includeProtocols: z.boolean().optional().describe("Include protocol bindings (default: true)"),
  },
  async ({ projectDir, format = "pretty", includeContext = true, includeProtocols = true }) => {
    const { state } = await ensureInitialized(projectDir);

    const current = state.load();
    if (!current) {
      return {
        content: [{ type: "text", text: "No active session. Use orchestrator_init first." }],
      };
    }

    // Build dependency graph
    interface GraphNode {
      id: string;
      description: string;
      status: string;
      dependsOn: string[];
      dependedBy: string[];
      hasContext: boolean;
      contextSummary?: {
        docs: number;
        prepared: number;
        protocols: number;
        totalTokens: number;
      };
      routing?: RoutingConfig;
    }

    const nodes: Map<string, GraphNode> = new Map();

    // First pass: create nodes
    for (const feature of current.features) {
      const node: GraphNode = {
        id: feature.id,
        description: feature.description,
        status: feature.status,
        dependsOn: feature.dependsOn || [],
        dependedBy: [],
        hasContext: !!(feature.context && (feature.context.documentation.length > 0 || feature.context.prepared.length > 0)),
        routing: feature.routing,
      };

      if (includeContext && feature.context) {
        let totalTokens = 0;
        for (const prep of feature.context.prepared) {
          totalTokens += prep.tokenEstimate || Math.ceil(prep.content.length / 4);
        }
        node.contextSummary = {
          docs: feature.context.documentation.length,
          prepared: feature.context.prepared.length,
          protocols: feature.protocolBindings?.length || 0,
          totalTokens,
        };
      }

      nodes.set(feature.id, node);
    }

    // Second pass: compute dependedBy
    for (const feature of current.features) {
      if (feature.dependsOn) {
        for (const depId of feature.dependsOn) {
          const depNode = nodes.get(depId);
          if (depNode) {
            depNode.dependedBy.push(feature.id);
          }
        }
      }
    }

    // Find root nodes (no dependencies)
    const roots = Array.from(nodes.values()).filter((n) => n.dependsOn.length === 0);

    // Find leaf nodes (nothing depends on them)
    const leaves = Array.from(nodes.values()).filter((n) => n.dependedBy.length === 0);

    // JSON format
    if (format === "json") {
      const graphData = {
        projectDir: current.projectDir,
        featureCount: current.features.length,
        roots: roots.map((n) => n.id),
        leaves: leaves.map((n) => n.id),
        nodes: Object.fromEntries(nodes),
      };
      return {
        content: [{ type: "text", text: JSON.stringify(graphData, null, 2) }],
      };
    }

    // Compact format
    if (format === "compact") {
      let text = `Features: ${nodes.size} | Roots: ${roots.length} | Leaves: ${leaves.length}\n`;

      // Sort by status then by dependency order
      const sorted = Array.from(nodes.values()).sort((a, b) => {
        const statusOrder: Record<string, number> = { in_progress: 0, pending: 1, completed: 2, failed: 3 };
        const aOrder = statusOrder[a.status] ?? 4;
        const bOrder = statusOrder[b.status] ?? 4;
        if (aOrder !== bOrder) return aOrder - bOrder;
        return a.dependsOn.length - b.dependsOn.length;
      });

      for (const node of sorted) {
        const statusIcon = node.status === "completed" ? "+" : node.status === "failed" ? "x" : node.status === "in_progress" ? ">" : "-";
        const contextIcon = node.hasContext ? "C" : " ";
        const deps = node.dependsOn.length > 0 ? ` <-[${node.dependsOn.join(",")}]` : "";
        text += `[${statusIcon}${contextIcon}] ${node.id}${deps}\n`;
      }
      return {
        content: [{ type: "text", text }],
      };
    }

    // Pretty format
    let text = `🔗 Feature Dependency Graph\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;

    text += `📊 Summary\n`;
    text += `   Total Features: ${nodes.size}\n`;
    text += `   Root Features (no deps): ${roots.length}\n`;
    text += `   Leaf Features (no dependents): ${leaves.length}\n\n`;

    // Group by status
    const byStatus: Record<string, GraphNode[]> = {
      in_progress: [],
      pending: [],
      completed: [],
      failed: [],
    };
    for (const node of nodes.values()) {
      if (byStatus[node.status]) {
        byStatus[node.status].push(node);
      }
    }

    for (const [status, statusNodes] of Object.entries(byStatus)) {
      if (statusNodes.length === 0) continue;

      const statusIcon = status === "completed" ? "✅" : status === "failed" ? "❌" : status === "in_progress" ? "🔄" : "⏳";
      text += `${statusIcon} ${status.toUpperCase()} (${statusNodes.length})\n`;

      for (const node of statusNodes) {
        text += `   ${node.id}: ${node.description.slice(0, 50)}${node.description.length > 50 ? "..." : ""}\n`;

        if (node.dependsOn.length > 0) {
          text += `      ← Depends on: ${node.dependsOn.join(", ")}\n`;
        }
        if (node.dependedBy.length > 0) {
          text += `      → Depended by: ${node.dependedBy.join(", ")}\n`;
        }

        if (includeContext && node.contextSummary) {
          text += `      📚 Context: ${node.contextSummary.docs} docs, ${node.contextSummary.prepared} prepared (~${node.contextSummary.totalTokens} tokens)`;
          if (node.contextSummary.protocols > 0) {
            text += `, ${node.contextSummary.protocols} protocols`;
          }
          text += `\n`;
        }

        if (includeProtocols && node.routing) {
          const r = node.routing;
          const parts: string[] = [];
          if (r.preferredWorkerType) parts.push(`type=${r.preferredWorkerType}`);
          if (r.maxParallelism) parts.push(`parallel=${r.maxParallelism}`);
          if (r.isolationLevel) parts.push(`isolation=${r.isolationLevel}`);
          if (parts.length > 0) {
            text += `      🛤️ Routing: ${parts.join(", ")}\n`;
          }
        }
      }
      text += `\n`;
    }

    // Show critical path (longest dependency chain)
    function getDepth(nodeId: string, visited: Set<string> = new Set()): number {
      if (visited.has(nodeId)) return 0; // Cycle detection
      visited.add(nodeId);
      const node = nodes.get(nodeId);
      if (!node || node.dependsOn.length === 0) return 1;
      let maxDepth = 0;
      for (const depId of node.dependsOn) {
        maxDepth = Math.max(maxDepth, getDepth(depId, new Set(visited)));
      }
      return maxDepth + 1;
    }

    let maxDepth = 0;
    let deepestNode: GraphNode | null = null;
    for (const node of nodes.values()) {
      const depth = getDepth(node.id);
      if (depth > maxDepth) {
        maxDepth = depth;
        deepestNode = node;
      }
    }

    if (deepestNode && maxDepth > 1) {
      text += `📏 Longest Dependency Chain: ${maxDepth} features\n`;
      text += `   Deepest: ${deepestNode.id}\n`;
    }

    return {
      content: [{ type: "text", text }],
    };
  }
);

// ============================================================================
// TOOL: route_feature
// ============================================================================
server.tool(
  "route_feature",
  "Configure routing for a feature. Sets preferences for worker type, capabilities, parallelism, and isolation level.",
  {
    projectDir: z.string().describe("Absolute path to the project directory"),
    featureId: z.string().describe("ID of the feature to configure routing for"),
    preferredWorkerType: z.string().optional().describe("Hint for worker specialization (e.g., 'frontend', 'backend', 'testing')"),
    requiredCapabilities: z.array(z.string()).optional().describe("Capabilities the worker must have"),
    excludeCapabilities: z.array(z.string()).optional().describe("Capabilities to avoid"),
    maxParallelism: z.number().int().min(1).max(10).optional().describe("Maximum concurrent workers for this feature"),
    affinityGroup: z.string().optional().describe("Group features that should run on the same worker"),
    isolationLevel: z.enum(["none", "session", "process", "container"]).optional().describe("Isolation level for the worker"),
  },
  async ({ projectDir, featureId, preferredWorkerType, requiredCapabilities, excludeCapabilities, maxParallelism, affinityGroup, isolationLevel }) => {
    const { state } = await ensureInitialized(projectDir);

    // Validate feature ID
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

    const feature = current.features.find((f) => f.id === featureId);
    if (!feature) {
      return {
        content: [{ type: "text", text: `Feature '${featureId}' not found.` }],
      };
    }

    // Build routing config
    const routing: RoutingConfig = {
      ...(feature.routing || {}),
    };

    if (preferredWorkerType !== undefined) {
      routing.preferredWorkerType = preferredWorkerType;
    }
    if (requiredCapabilities !== undefined) {
      routing.requiredCapabilities = requiredCapabilities;
    }
    if (excludeCapabilities !== undefined) {
      routing.excludeCapabilities = excludeCapabilities;
    }
    if (maxParallelism !== undefined) {
      routing.maxParallelism = maxParallelism;
    }
    if (affinityGroup !== undefined) {
      routing.affinityGroup = affinityGroup;
    }
    if (isolationLevel !== undefined) {
      routing.isolationLevel = isolationLevel;
    }

    feature.routing = routing;

    current.progressLog.push(
      `[${new Date().toISOString()}] 🛤️ Configured routing for ${featureId}${preferredWorkerType ? ` (type=${preferredWorkerType})` : ""}${isolationLevel ? ` (isolation=${isolationLevel})` : ""}`
    );
    state.save(current);
    state.writeProgressFile();

    // Build response
    let response = `🛤️ Feature Routing Configured: ${featureId}\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;

    response += `Feature: ${feature.description.slice(0, 60)}${feature.description.length > 60 ? "..." : ""}\n\n`;

    response += `📋 Routing Configuration:\n`;
    if (routing.preferredWorkerType) {
      response += `   Preferred Type: ${routing.preferredWorkerType}\n`;
    }
    if (routing.requiredCapabilities && routing.requiredCapabilities.length > 0) {
      response += `   Required Capabilities: ${routing.requiredCapabilities.join(", ")}\n`;
    }
    if (routing.excludeCapabilities && routing.excludeCapabilities.length > 0) {
      response += `   Excluded Capabilities: ${routing.excludeCapabilities.join(", ")}\n`;
    }
    if (routing.maxParallelism) {
      response += `   Max Parallelism: ${routing.maxParallelism}\n`;
    }
    if (routing.affinityGroup) {
      response += `   Affinity Group: ${routing.affinityGroup}\n`;
    }
    if (routing.isolationLevel) {
      response += `   Isolation Level: ${routing.isolationLevel}\n`;
    }

    // Find other features in same affinity group
    if (routing.affinityGroup) {
      const sameGroup = current.features.filter(
        (f) => f.id !== featureId && f.routing?.affinityGroup === routing.affinityGroup
      );
      if (sameGroup.length > 0) {
        response += `\n🔗 Features in same affinity group '${routing.affinityGroup}':\n`;
        for (const f of sameGroup) {
          response += `   - ${f.id}\n`;
        }
      }
    }

    response += `\nRouting will be applied when starting workers for this feature.`;

    return {
      content: [{ type: "text", text: response }],
    };
  }
);

// ============================================================================
// TOOL: export_protocols
// ============================================================================
server.tool(
  "export_protocols",
  "Export protocols to a shareable bundle. Creates a portable bundle that can be imported by other MCP instances or shared with team members.",
  {
    projectDir: z.string().describe("Absolute path to the project directory"),
    protocolIds: z.array(z.string()).optional().describe("Specific protocol IDs to export (empty = all active)"),
    includeDependencies: z.boolean().optional().describe("Include all dependencies of selected protocols (default: true)"),
    includeInactive: z.boolean().optional().describe("Include inactive protocols (default: false)"),
    filterTags: z.array(z.string()).optional().describe("Only include protocols with these tags"),
    name: z.string().optional().describe("Bundle name (auto-generated if not provided)"),
    description: z.string().optional().describe("Bundle description"),
    signBundle: z.boolean().optional().describe("Sign the bundle for integrity verification (default: true)"),
    outputPath: z.string().optional().describe("File path to save the bundle (optional)"),
  },
  async ({ projectDir, protocolIds, includeDependencies, includeInactive, filterTags, name, description, signBundle, outputPath }) => {
    const { protocols } = await ensureInitialized(projectDir);
    const networking = getNetworkingManager(projectDir, protocols);

    const result = networking.exportProtocols({
      protocolIds,
      includeDependencies,
      includeInactive,
      filterTags,
      name,
      description,
      signBundle,
      outputPath,
    });

    if (!result.success) {
      return {
        content: [{ type: "text", text: `❌ Export failed: ${result.error}` }],
      };
    }

    const bundle = result.bundle!;
    let response = `📦 Protocols Exported\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;

    response += `Bundle ID: ${bundle.bundleId}\n`;
    response += `Name: ${bundle.name}\n`;
    response += `Version: ${bundle.version}\n`;
    response += `Source Instance: ${bundle.source.instanceId}\n`;
    response += `Exported At: ${bundle.source.exportedAt}\n\n`;

    response += `📋 Protocols (${bundle.protocols.length}):\n`;
    for (const p of bundle.protocols.slice(0, 10)) {
      const activeIcon = protocols.isActive(p.id) ? "▶️" : "⏸️";
      response += `  ${activeIcon} ${p.id} v${p.version} - ${p.name}\n`;
    }
    if (bundle.protocols.length > 10) {
      response += `  ... and ${bundle.protocols.length - 10} more\n`;
    }

    response += `\n🔗 Registration Order:\n`;
    response += `  ${bundle.registrationOrder.join(" → ")}\n`;

    if (bundle.signature) {
      response += `\n🔐 Signed: Yes (${bundle.signature.algorithm})\n`;
    }

    if (result.outputPath) {
      response += `\n📁 Saved to: ${result.outputPath}\n`;
    } else {
      response += `\n💡 Use 'outputPath' parameter to save to a file, or use the bundle directly with import_protocols.\n`;
    }

    return {
      content: [{ type: "text", text: response }],
    };
  }
);

// ============================================================================
// TOOL: import_protocols
// ============================================================================
server.tool(
  "import_protocols",
  "Import protocols from a bundle file or inline bundle. Supports conflict resolution strategies and dry-run mode.",
  {
    projectDir: z.string().describe("Absolute path to the project directory"),
    bundlePath: z.string().optional().describe("Path to bundle file to import"),
    bundle: z.object({
      bundleId: z.string(),
      name: z.string(),
      version: z.string(),
      source: z.object({
        instanceId: z.string(),
        exportedAt: z.string(),
      }),
      protocols: z.array(z.object({
        id: z.string(),
        version: z.string(),
        name: z.string(),
      }).passthrough()),
      registrationOrder: z.array(z.string()),
    }).passthrough().optional().describe("Inline bundle object to import"),
    conflictStrategy: z.enum(["skip", "replace", "rename", "merge", "newest", "highest_priority"]).optional()
      .describe("How to handle conflicts (default: skip)"),
    activateImported: z.boolean().optional().describe("Activate imported protocols immediately (default: false)"),
    validateDependencies: z.boolean().optional().describe("Validate dependencies exist (default: true)"),
    verifySignature: z.boolean().optional().describe("Verify bundle signature if present (default: true)"),
    dryRun: z.boolean().optional().describe("Validate but don't actually import (default: false)"),
  },
  async ({ projectDir, bundlePath, bundle, conflictStrategy, activateImported, validateDependencies, verifySignature, dryRun }) => {
    const { protocols, state } = await ensureInitialized(projectDir);
    const networking = getNetworkingManager(projectDir, protocols);

    const result = networking.importProtocols({
      bundle: bundle as any,
      bundlePath,
      conflictStrategy: conflictStrategy as NetworkConflictStrategy | undefined,
      activateImported,
      validateDependencies,
      verifySignature,
      dryRun,
      actor: "import_protocols",
    });

    let response: string;

    if (result.dryRun) {
      response = `🔍 Import Dry Run\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
    } else if (result.success) {
      response = `✅ Protocols Imported\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
    } else {
      response = `⚠️ Import Completed with Issues\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
    }

    if (result.imported.length > 0) {
      response += `📥 Imported (${result.imported.length}):\n`;
      for (const id of result.imported.slice(0, 10)) {
        response += `  ✓ ${id}\n`;
      }
      if (result.imported.length > 10) {
        response += `  ... and ${result.imported.length - 10} more\n`;
      }
      response += `\n`;
    }

    if (result.activated.length > 0) {
      response += `▶️ Activated (${result.activated.length}):\n`;
      for (const id of result.activated) {
        response += `  ✓ ${id}\n`;
      }
      response += `\n`;
    }

    if (result.skipped.length > 0) {
      response += `⏭️ Skipped (${result.skipped.length}):\n`;
      for (const id of result.skipped.slice(0, 5)) {
        response += `  - ${id}\n`;
      }
      if (result.skipped.length > 5) {
        response += `  ... and ${result.skipped.length - 5} more\n`;
      }
      response += `\n`;
    }

    if (result.conflicts.length > 0) {
      response += `⚔️ Conflicts (${result.conflicts.length}):\n`;
      for (const c of result.conflicts.slice(0, 5)) {
        response += `  - ${c.protocolId}: ${c.resolution || "unresolved"}\n`;
        response += `    Local: v${c.existingVersion} | Imported: v${c.importedVersion}\n`;
      }
      if (result.conflicts.length > 5) {
        response += `  ... and ${result.conflicts.length - 5} more\n`;
      }
      response += `\n`;
    }

    if (result.errors.length > 0) {
      response += `❌ Errors:\n`;
      for (const err of result.errors) {
        response += `  - ${err}\n`;
      }
      response += `\n`;
    }

    // Log to state
    if (!result.dryRun && result.imported.length > 0) {
      const current = state.load();
      if (current) {
        current.progressLog.push(
          `[${new Date().toISOString()}] 📥 Imported ${result.imported.length} protocols${result.activated.length > 0 ? `, activated ${result.activated.length}` : ""}`
        );
        state.save(current);
      }
    }

    return {
      content: [{ type: "text", text: response }],
    };
  }
);

// ============================================================================
// TOOL: discover_protocols
// ============================================================================
server.tool(
  "discover_protocols",
  "Discover peer MCP instances and their protocols. Enables cross-instance protocol sharing.",
  {
    projectDir: z.string().describe("Absolute path to the project directory"),
    startSync: z.boolean().optional().describe("Start synchronization service (default: false)"),
    refreshPeers: z.boolean().optional().describe("Refresh the list of known peers (default: true)"),
  },
  async ({ projectDir, startSync, refreshPeers }) => {
    const { protocols } = await ensureInitialized(projectDir);
    const networking = getNetworkingManager(projectDir, protocols);

    const result = networking.discoverProtocols({
      startSync,
      refreshPeers: refreshPeers ?? true,
    });

    if (!result.success) {
      return {
        content: [{ type: "text", text: `❌ Discovery failed: ${result.error}` }],
      };
    }

    let response = `🔍 Protocol Discovery\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;

    response += `🆔 This Instance: ${result.instanceId.slice(0, 16)}...\n`;
    response += `🔄 Sync Status: ${result.syncStarted ? "Started" : "Not running"}\n\n`;

    if (result.peers.length === 0) {
      response += `👥 No peer instances discovered.\n\n`;
      response += `Peers are discovered through shared state files.\n`;
      response += `To enable peer discovery:\n`;
      response += `  1. Start another MCP instance on the same project\n`;
      response += `  2. Use sync_protocols to broadcast your protocols\n`;
    } else {
      response += `👥 Discovered Peers (${result.peers.length}):\n`;
      for (const peer of result.peers) {
        response += `  📡 ${peer.name || peer.instanceId.slice(0, 16)}\n`;
        response += `     ID: ${peer.instanceId}\n`;
        response += `     Protocols: ${peer.protocolCount}\n`;
        response += `     Last Seen: ${peer.lastSeen}\n`;
        if (peer.capabilities && peer.capabilities.length > 0) {
          response += `     Capabilities: ${peer.capabilities.join(", ")}\n`;
        }
        response += `\n`;
      }
    }

    if (!result.syncStarted) {
      response += `\n💡 Use startSync: true to enable real-time protocol synchronization.`;
    }

    return {
      content: [{ type: "text", text: response }],
    };
  }
);

// ============================================================================
// TOOL: sync_protocols
// ============================================================================
server.tool(
  "sync_protocols",
  "Synchronize protocols with peer MCP instances. Supports push, pull, or bidirectional sync.",
  {
    projectDir: z.string().describe("Absolute path to the project directory"),
    targetInstance: z.string().optional().describe("Specific instance ID to sync with (omit for broadcast)"),
    direction: z.enum(["push", "pull", "bidirectional"]).optional().describe("Sync direction (default: bidirectional)"),
    protocolIds: z.array(z.string()).optional().describe("Specific protocols to sync (default: all active)"),
    includeInactive: z.boolean().optional().describe("Include inactive protocols in push (default: false)"),
    conflictStrategy: z.enum(["skip", "replace", "rename", "merge", "newest", "highest_priority"]).optional()
      .describe("How to handle conflicts on pull (default: skip)"),
  },
  async ({ projectDir, targetInstance, direction, protocolIds, includeInactive, conflictStrategy }) => {
    const { protocols, state } = await ensureInitialized(projectDir);
    const networking = getNetworkingManager(projectDir, protocols);

    const result = networking.syncProtocols({
      targetInstance,
      direction,
      protocolIds,
      includeInactive,
      conflictStrategy: conflictStrategy as NetworkConflictStrategy | undefined,
    });

    if (!result.success) {
      return {
        content: [{ type: "text", text: `❌ Sync failed: ${result.error}` }],
      };
    }

    let response = `🔄 Protocol Sync Complete\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;

    response += `Direction: ${direction || "bidirectional"}\n`;
    if (targetInstance) {
      response += `Target: ${targetInstance}\n`;
    } else {
      response += `Target: All peers (broadcast)\n`;
    }
    response += `\n`;

    response += `📤 Pushed: ${result.pushed} protocol${result.pushed !== 1 ? "s" : ""}\n`;
    response += `📥 Pulled: ${result.pulled} protocol${result.pulled !== 1 ? "s" : ""}\n`;

    if (result.conflicts > 0) {
      response += `⚔️ Conflicts: ${result.conflicts}\n`;
    }

    // Get networking stats
    const stats = networking.getStats();
    response += `\n📊 Networking Stats:\n`;
    response += `   Known Peers: ${stats.peerCount}\n`;
    response += `   Exported Bundles: ${stats.exportedBundles}\n`;
    if (stats.lastSync) {
      response += `   Last Sync: ${stats.lastSync}\n`;
    }

    // Log to state
    const current = state.load();
    if (current) {
      current.progressLog.push(
        `[${new Date().toISOString()}] 🔄 Protocol sync: pushed ${result.pushed}, pulled ${result.pulled}${result.conflicts > 0 ? `, ${result.conflicts} conflicts` : ""}`
      );
      state.save(current);
    }

    return {
      content: [{ type: "text", text: response }],
    };
  }
);

// ============================================================================
// TOOL: propose_protocol
// ============================================================================
server.tool(
  "propose_protocol",
  "Submit a new protocol proposal for review. Validates against base constraints and calculates risk score. LLMs and users can submit proposals which must be approved before becoming active.",
  {
    projectDir: z.string().describe("Absolute path to the project directory"),
    protocol: z.object({
      id: z.string().regex(/^[a-zA-Z0-9_-]+$/).describe("Unique protocol ID (alphanumeric with dashes/underscores)"),
      version: z.string().regex(/^\d+\.\d+\.\d+$/).describe("Semantic version (e.g., '1.0.0')"),
      name: z.string().min(1).max(100).describe("Human-readable name"),
      description: z.string().max(1000).optional().describe("Protocol description"),
      constraints: z.array(z.object({
        id: z.string().describe("Constraint ID"),
        type: z.enum(["tool_restriction", "file_access", "output_format", "behavioral", "temporal", "resource", "side_effect"])
          .describe("Constraint type"),
        rule: z.record(z.any()).describe("Constraint-specific rule configuration"),
        severity: z.enum(["error", "warning", "info"]).describe("Severity level"),
        message: z.string().max(500).describe("Human-readable description"),
        enabled: z.boolean().optional().describe("Whether constraint is enabled (default: true)"),
      })).describe("Array of constraints"),
      enforcement: z.object({
        mode: z.enum(["strict", "permissive", "audit", "learning"]).optional().describe("Enforcement mode (default: strict)"),
        onViolation: z.enum(["block", "warn", "log", "notify", "rollback"]).optional().describe("Action on violation (default: block)"),
        preExecutionValidation: z.boolean().optional().describe("Validate before execution (default: true)"),
        postExecutionValidation: z.boolean().optional().describe("Validate after execution (default: true)"),
        logLevel: z.enum(["none", "minimal", "standard", "verbose", "debug"]).optional().describe("Logging level (default: standard)"),
        allowOverride: z.boolean().optional().describe("Allow constraint overrides (default: false)"),
        overrideRequiresApproval: z.boolean().optional().describe("Require approval for overrides (default: true)"),
      }).optional().describe("Enforcement configuration"),
      priority: z.number().min(0).max(1000).optional().describe("Priority (higher = more important, default: 100)"),
      tags: z.array(z.string()).optional().describe("Tags for categorization"),
      requires: z.array(z.string()).optional().describe("IDs of required protocols"),
      extends: z.array(z.string()).optional().describe("IDs of protocols this extends"),
      conflicts: z.array(z.string()).optional().describe("IDs of conflicting protocols"),
      applicableContexts: z.object({
        featurePatterns: z.array(z.string()).optional(),
        filePatterns: z.array(z.string()).optional(),
        taskPatterns: z.array(z.string()).optional(),
        projectPatterns: z.array(z.string()).optional(),
        environments: z.array(z.string()).optional(),
      }).optional().describe("Context matching configuration"),
    }).describe("The protocol to propose"),
    description: z.string().optional().describe("Why this protocol is needed"),
    rationale: z.string().optional().describe("Design rationale and decisions"),
    source: z.enum(["llm", "user", "system", "import"]).optional().describe("Source of the proposal (default: llm)"),
    priority: z.number().min(0).max(100).optional().describe("Review priority (0-100, default: 50)"),
    tags: z.array(z.string()).optional().describe("Tags for the proposal"),
  },
  async ({ projectDir, protocol, description, rationale, source, priority, tags }) => {
    await ensureInitialized(projectDir);
    const proposalManager = getProposalManager(projectDir);

    try {
      // Build the full protocol with defaults
      const fullProtocol: Protocol = {
        id: protocol.id,
        version: protocol.version,
        name: protocol.name,
        description: protocol.description,
        constraints: protocol.constraints.map((c) => ({
          id: c.id,
          type: c.type,
          rule: { type: c.type, ...c.rule },
          severity: c.severity,
          message: c.message,
          enabled: c.enabled ?? true,
        })),
        enforcement: {
          mode: protocol.enforcement?.mode ?? "strict",
          onViolation: protocol.enforcement?.onViolation ?? "block",
          preExecutionValidation: protocol.enforcement?.preExecutionValidation ?? true,
          postExecutionValidation: protocol.enforcement?.postExecutionValidation ?? true,
          logLevel: protocol.enforcement?.logLevel ?? "standard",
          allowOverride: protocol.enforcement?.allowOverride ?? false,
          overrideRequiresApproval: protocol.enforcement?.overrideRequiresApproval ?? true,
          maxRetries: 0,
          retryDelaySeconds: 0,
          includeContext: true,
        },
        priority: protocol.priority ?? 100,
        tags: protocol.tags,
        requires: protocol.requires,
        extends: protocol.extends,
        conflicts: protocol.conflicts,
        applicableContexts: {
          featurePatterns: protocol.applicableContexts?.featurePatterns,
          filePatterns: protocol.applicableContexts?.filePatterns,
          taskPatterns: protocol.applicableContexts?.taskPatterns,
          projectPatterns: protocol.applicableContexts?.projectPatterns,
          environments: protocol.applicableContexts?.environments,
        },
        createdAt: new Date().toISOString(),
        enabled: true,
        deprecated: false,
      };

      // Submit the proposal
      const proposal = proposalManager.submit({
        protocol: fullProtocol,
        source: source ?? "llm",
        description,
        rationale,
        priority,
        tags,
        submittedBy: source ?? "llm",
      });

      // Format response
      let response = `📋 Protocol Proposal Submitted\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
      response += `📝 Proposal ID: ${proposal.id}\n`;
      response += `🏷️ Protocol: ${proposal.protocol.name} (${proposal.protocol.id} v${proposal.protocol.version})\n`;
      response += `📊 Status: ${proposal.status}\n`;
      response += `⏰ Submitted: ${proposal.submittedAt}\n`;
      if (proposal.expiresAt) {
        response += `⏳ Expires: ${proposal.expiresAt}\n`;
      }
      response += `\n`;

      // Validation summary
      const validation = proposal.validation;
      response += `🔍 Validation Results:\n`;
      response += `   Valid: ${validation.isValid ? "✅ Yes" : "❌ No"}\n`;
      response += `   Fixable: ${validation.isFixable ? "✅ Yes" : "❌ No"}\n`;
      response += `   Issues: ${validation.issues.length} (${validation.issues.filter((i: { type: string }) => i.type === "error").length} errors, ${validation.issues.filter((i: { type: string }) => i.type === "warning").length} warnings)\n`;
      response += `\n`;

      // Risk assessment
      const risk = validation.riskAssessment;
      response += `⚠️ Risk Assessment:\n`;
      response += `   Score: ${risk.overallScore}/100\n`;
      response += `   Level: ${risk.riskLevel.toUpperCase()}\n`;
      response += `   Acceptable: ${risk.isAcceptable ? "✅ Yes" : "❌ No"} (threshold: ${risk.acceptanceThreshold})\n`;

      if (risk.highestRisks.length > 0) {
        response += `   Highest Risks:\n`;
        for (const r of risk.highestRisks.slice(0, 3)) {
          response += `     • ${r}\n`;
        }
      }

      if (risk.recommendations.length > 0) {
        response += `   Recommendations:\n`;
        for (const rec of risk.recommendations.slice(0, 3)) {
          response += `     • ${rec}\n`;
        }
      }

      // If not valid, show errors
      if (!validation.isValid) {
        response += `\n❌ Validation Errors:\n`;
        for (const issue of validation.issues.filter((i: { type: string }) => i.type === "error").slice(0, 5)) {
          response += `   • ${issue.message}`;
          if (issue.suggestedFix) {
            response += ` (Fix: ${issue.suggestedFix})`;
          }
          response += `\n`;
        }
      }

      response += `\n💡 Next Steps:\n`;
      if (validation.isValid) {
        response += `   Use approve_protocol to approve and register this protocol.\n`;
      } else if (validation.isFixable) {
        response += `   The protocol has issues but can be fixed. Review the errors and resubmit.\n`;
      } else {
        response += `   The protocol has unfixable issues. Review the base constraints with get_base_constraints.\n`;
      }
      response += `   Use reject_protocol to reject this proposal.\n`;
      response += `   Use review_proposals to see all pending proposals.\n`;

      return {
        content: [{ type: "text", text: response }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `❌ Error submitting proposal: ${error instanceof Error ? error.message : String(error)}` }],
      };
    }
  }
);

// ============================================================================
// TOOL: review_proposals
// ============================================================================
server.tool(
  "review_proposals",
  "Review pending protocol proposals. Shows validation results, risk scores, and recommendations.",
  {
    projectDir: z.string().describe("Absolute path to the project directory"),
    status: z.enum(["pending", "reviewing", "approved", "rejected", "expired"]).optional()
      .describe("Filter by status (default: pending)"),
    source: z.enum(["llm", "user", "system", "import"]).optional().describe("Filter by source"),
    proposalId: z.string().optional().describe("Get details for a specific proposal"),
    limit: z.number().min(1).max(50).optional().describe("Maximum proposals to return (default: 10)"),
    includeStats: z.boolean().optional().describe("Include proposal statistics (default: true)"),
  },
  async ({ projectDir, status, source, proposalId, limit, includeStats }) => {
    await ensureInitialized(projectDir);
    const proposalManager = getProposalManager(projectDir);

    try {
      // If a specific proposal is requested
      if (proposalId) {
        const proposal = proposalManager.getProposal(proposalId);
        if (!proposal) {
          return {
            content: [{ type: "text", text: `❌ Proposal '${proposalId}' not found` }],
          };
        }

        let response = `📋 Proposal Details: ${proposalId}\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
        response += formatProposalDetails(proposal);
        return {
          content: [{ type: "text", text: response }],
        };
      }

      // Get proposals with filters
      const proposals = proposalManager.getProposals({
        status: status ?? "pending",
        source,
        limit: limit ?? 10,
      });

      let response = `📋 Protocol Proposals\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;

      // Show stats if requested
      if (includeStats !== false) {
        const stats = proposalManager.getStats();
        response += `📊 Statistics:\n`;
        response += `   Total: ${stats.total} | Pending: ${stats.pending} | Approved: ${stats.approved} | Rejected: ${stats.rejected}\n`;
        response += `   Avg Risk Score: ${stats.avgRiskScore}/100 | Valid Proposals: ${stats.validProposals}\n`;
        response += `   By Source: LLM(${stats.bySource.llm}) User(${stats.bySource.user}) System(${stats.bySource.system}) Import(${stats.bySource.import})\n\n`;
      }

      if (proposals.length === 0) {
        response += `No ${status ?? "pending"} proposals found.\n`;
        response += `\n💡 Use propose_protocol to submit a new protocol proposal.\n`;
      } else {
        response += `Found ${proposals.length} ${status ?? "pending"} proposal(s):\n\n`;

        for (const proposal of proposals) {
          response += `┌─────────────────────────────────────\n`;
          response += `│ 📝 ${proposal.id}\n`;
          response += `│ Protocol: ${proposal.protocol.name} (${proposal.protocol.id} v${proposal.protocol.version})\n`;
          response += `│ Source: ${proposal.source} | Priority: ${proposal.priority}\n`;
          response += `│ Valid: ${proposal.validation.isValid ? "✅" : "❌"} | Risk: ${proposal.validation.riskAssessment.overallScore}/100 (${proposal.validation.riskAssessment.riskLevel})\n`;
          if (proposal.description) {
            response += `│ Description: ${proposal.description.slice(0, 60)}${proposal.description.length > 60 ? "..." : ""}\n`;
          }
          response += `│ Submitted: ${proposal.submittedAt}\n`;
          response += `└─────────────────────────────────────\n\n`;
        }

        response += `💡 Commands:\n`;
        response += `   • review_proposals with proposalId for details\n`;
        response += `   • approve_protocol to approve a proposal\n`;
        response += `   • reject_protocol to reject a proposal\n`;
      }

      return {
        content: [{ type: "text", text: response }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `❌ Error reviewing proposals: ${error instanceof Error ? error.message : String(error)}` }],
      };
    }
  }
);

// ============================================================================
// TOOL: approve_protocol
// ============================================================================
server.tool(
  "approve_protocol",
  "Approve a pending protocol proposal and register it in the protocol registry.",
  {
    projectDir: z.string().describe("Absolute path to the project directory"),
    proposalId: z.string().describe("ID of the proposal to approve"),
    reason: z.string().describe("Reason for approval"),
    reviewedBy: z.string().optional().describe("Who is approving (default: orchestrator)"),
    modifications: z.record(z.any()).optional().describe("Optional modifications to apply to the protocol before registration"),
    activate: z.boolean().optional().describe("Activate the protocol immediately after registration (default: false)"),
  },
  async ({ projectDir, proposalId, reason, reviewedBy, modifications, activate }) => {
    const { protocols, state } = await ensureInitialized(projectDir);
    const proposalManager = getProposalManager(projectDir);

    try {
      // Approve the proposal
      const proposal = proposalManager.approve({
        proposalId,
        decision: "approve",
        reason,
        reviewedBy: reviewedBy ?? "orchestrator",
        modifications: modifications as Partial<Protocol> | undefined,
      });

      let response = `✅ Protocol Approved\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
      response += `📝 Proposal: ${proposalId}\n`;
      response += `🏷️ Protocol: ${proposal.protocol.name} (${proposal.protocol.id} v${proposal.protocol.version})\n`;
      response += `👤 Approved By: ${proposal.reviewedBy}\n`;
      response += `📅 Approved At: ${proposal.reviewedAt}\n`;
      response += `📋 Reason: ${reason}\n\n`;

      // Optionally activate
      if (activate) {
        try {
          protocols.activate(proposal.protocol.id, reviewedBy ?? "orchestrator");
          response += `⚡ Protocol has been activated!\n`;
        } catch (error) {
          response += `⚠️ Protocol registered but activation failed: ${error instanceof Error ? error.message : String(error)}\n`;
        }
      } else {
        response += `💡 The protocol is registered but not active.\n`;
        response += `   Use protocol_activate to activate it when ready.\n`;
      }

      // Log to state
      const current = state.load();
      if (current) {
        current.progressLog.push(
          `[${new Date().toISOString()}] ✅ Protocol approved: ${proposal.protocol.id} - ${reason}`
        );
        state.save(current);
      }

      return {
        content: [{ type: "text", text: response }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `❌ Error approving proposal: ${error instanceof Error ? error.message : String(error)}` }],
      };
    }
  }
);

// ============================================================================
// TOOL: reject_protocol
// ============================================================================
server.tool(
  "reject_protocol",
  "Reject a pending protocol proposal with a reason.",
  {
    projectDir: z.string().describe("Absolute path to the project directory"),
    proposalId: z.string().describe("ID of the proposal to reject"),
    reason: z.string().describe("Reason for rejection"),
    reviewedBy: z.string().optional().describe("Who is rejecting (default: orchestrator)"),
  },
  async ({ projectDir, proposalId, reason, reviewedBy }) => {
    const { state } = await ensureInitialized(projectDir);
    const proposalManager = getProposalManager(projectDir);

    try {
      const proposal = proposalManager.reject({
        proposalId,
        decision: "reject",
        reason,
        reviewedBy: reviewedBy ?? "orchestrator",
      });

      let response = `❌ Protocol Rejected\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
      response += `📝 Proposal: ${proposalId}\n`;
      response += `🏷️ Protocol: ${proposal.protocol.name} (${proposal.protocol.id} v${proposal.protocol.version})\n`;
      response += `👤 Rejected By: ${proposal.reviewedBy}\n`;
      response += `📅 Rejected At: ${proposal.reviewedAt}\n`;
      response += `📋 Reason: ${reason}\n\n`;

      // Show validation issues as context
      const errors = proposal.validation.issues.filter((i: { type: string }) => i.type === "error");
      if (errors.length > 0) {
        response += `🔍 Validation issues that may have contributed to rejection:\n`;
        for (const issue of errors.slice(0, 5)) {
          response += `   • ${issue.message}\n`;
        }
        response += `\n`;
      }

      response += `💡 The proposer can address the issues and submit a new proposal.\n`;

      // Log to state
      const current = state.load();
      if (current) {
        current.progressLog.push(
          `[${new Date().toISOString()}] ❌ Protocol rejected: ${proposal.protocol.id} - ${reason}`
        );
        state.save(current);
      }

      return {
        content: [{ type: "text", text: response }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `❌ Error rejecting proposal: ${error instanceof Error ? error.message : String(error)}` }],
      };
    }
  }
);

// ============================================================================
// TOOL: get_base_constraints
// ============================================================================
server.tool(
  "get_base_constraints",
  "Get the immutable base constraints that all protocols must comply with. These define security boundaries that cannot be overridden.",
  {
    projectDir: z.string().describe("Absolute path to the project directory"),
    format: z.enum(["compact", "pretty", "json"]).optional().describe("Output format (default: pretty)"),
  },
  async ({ projectDir, format }) => {
    await ensureInitialized(projectDir);
    const baseConstraints = getBaseConstraints();

    if (format === "json") {
      return {
        content: [{ type: "text", text: JSON.stringify(baseConstraints, null, 2) }],
      };
    }

    const compact = format === "compact";

    let response = compact
      ? `Base Constraints\n`
      : `🔒 Base Constraints\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;

    response += compact
      ? `These are immutable security constraints.\n\n`
      : `These are immutable security constraints that all protocols must comply with.\nProtocols violating these constraints will be rejected during validation.\n\n`;

    // Prohibited tools
    if (baseConstraints.prohibitedTools.length > 0) {
      response += compact ? `Prohibited Tools: ` : `🚫 Prohibited Tools:\n   `;
      response += baseConstraints.prohibitedTools.join(", ");
      response += `\n`;
      if (!compact) response += `\n`;
    }

    // Max allowed tools
    if (baseConstraints.maxAllowedTools && baseConstraints.maxAllowedTools.length > 0) {
      response += compact ? `Max Allowed Tools: ` : `✅ Maximum Allowed Tools:\n   `;
      response += baseConstraints.maxAllowedTools.join(", ");
      response += `\n`;
      if (!compact) response += `\n`;
    }

    // Prohibited paths
    if (baseConstraints.prohibitedPaths.length > 0) {
      response += compact ? `Prohibited Paths: ` : `📁 Prohibited Paths:\n`;
      if (compact) {
        response += baseConstraints.prohibitedPaths.slice(0, 5).join(", ");
        if (baseConstraints.prohibitedPaths.length > 5) {
          response += ` (+${baseConstraints.prohibitedPaths.length - 5} more)`;
        }
      } else {
        for (const path of baseConstraints.prohibitedPaths) {
          response += `   • ${path}\n`;
        }
      }
      response += `\n`;
      if (!compact) response += `\n`;
    }

    // Prohibited operations
    if (baseConstraints.prohibitedOperations.length > 0) {
      response += compact ? `Prohibited Operations: ` : `⛔ Prohibited Operations:\n`;
      if (compact) {
        response += baseConstraints.prohibitedOperations.slice(0, 5).join(", ");
        if (baseConstraints.prohibitedOperations.length > 5) {
          response += ` (+${baseConstraints.prohibitedOperations.length - 5} more)`;
        }
      } else {
        for (const op of baseConstraints.prohibitedOperations) {
          response += `   • ${op}\n`;
        }
      }
      response += `\n`;
      if (!compact) response += `\n`;
    }

    // Validation requirements
    if (!compact) {
      response += `🔍 Validation Requirements:\n`;
      response += `   • Pre-execution validation: ${baseConstraints.requirePreValidation ? "Required" : "Optional"}\n`;
      response += `   • Post-execution validation: ${baseConstraints.requirePostValidation ? "Required" : "Optional"}\n`;
      response += `   • Audit logging: ${baseConstraints.requireAuditLog ? "Required" : "Optional"}\n\n`;
    }

    // Limits
    if (!compact) {
      response += `📊 Limits:\n`;
      response += `   • Max allowed tools: ${baseConstraints.maxAllowedTools?.length ?? "Unlimited"}\n`;
      response += `   • Max allowed paths: ${baseConstraints.maxAllowedPaths?.length ?? "Unlimited"}\n`;
      response += `   • Audit retention: ${baseConstraints.auditRetentionDays} days\n\n`;
    }

    // Usage instructions
    if (!compact) {
      response += `💡 Usage:\n`;
      response += `   When proposing protocols, ensure:\n`;
      response += `   1. No prohibited tools are allowed\n`;
      response += `   2. No access to prohibited paths\n`;
      response += `   3. No prohibited operations are enabled\n`;
      response += `   4. Validation requirements are met in enforcement config\n`;
    }

    return {
      content: [{ type: "text", text: response }],
    };
  }
);

// ============================================================================
// Helper: Format proposal details
// ============================================================================
function formatProposalDetails(proposal: ProtocolProposal): string {
  let response = ``;

  // Basic info
  response += `🆔 ID: ${proposal.id}\n`;
  response += `📊 Status: ${proposal.status.toUpperCase()}\n`;
  response += `📦 Source: ${proposal.source}\n`;
  response += `⭐ Priority: ${proposal.priority}\n\n`;

  // Protocol info
  response += `📋 Protocol:\n`;
  response += `   ID: ${proposal.protocol.id}\n`;
  response += `   Version: ${proposal.protocol.version}\n`;
  response += `   Name: ${proposal.protocol.name}\n`;
  if (proposal.protocol.description) {
    response += `   Description: ${proposal.protocol.description}\n`;
  }
  response += `   Constraints: ${proposal.protocol.constraints.length}\n`;
  response += `   Priority: ${proposal.protocol.priority}\n`;
  response += `   Enforcement: ${proposal.protocol.enforcement.mode}\n`;
  if (proposal.protocol.tags && proposal.protocol.tags.length > 0) {
    response += `   Tags: ${proposal.protocol.tags.join(", ")}\n`;
  }
  response += `\n`;

  // Description and rationale
  if (proposal.description) {
    response += `📝 Description:\n   ${proposal.description}\n\n`;
  }
  if (proposal.rationale) {
    response += `💭 Rationale:\n   ${proposal.rationale}\n\n`;
  }

  // Validation
  const validation = proposal.validation;
  response += `🔍 Validation:\n`;
  response += `   Valid: ${validation.isValid ? "✅ Yes" : "❌ No"}\n`;
  response += `   Fixable: ${validation.isFixable ? "✅ Yes" : "❌ No"}\n`;
  response += `   Time: ${validation.validationTimeMs}ms\n`;
  response += `   Validated: ${validation.validatedAt}\n\n`;

  // Issues
  if (validation.issues.length > 0) {
    const errors = validation.issues.filter((i: { type: string }) => i.type === "error");
    const warnings = validation.issues.filter((i: { type: string }) => i.type === "warning");
    const infos = validation.issues.filter((i: { type: string }) => i.type === "info");

    response += `📌 Issues (${validation.issues.length}):\n`;
    if (errors.length > 0) {
      response += `   Errors (${errors.length}):\n`;
      for (const issue of errors.slice(0, 5)) {
        response += `     ❌ ${issue.message}\n`;
        if (issue.suggestedFix) {
          response += `        Fix: ${issue.suggestedFix}\n`;
        }
      }
      if (errors.length > 5) {
        response += `     ... and ${errors.length - 5} more errors\n`;
      }
    }
    if (warnings.length > 0) {
      response += `   Warnings (${warnings.length}):\n`;
      for (const issue of warnings.slice(0, 3)) {
        response += `     ⚠️ ${issue.message}\n`;
      }
      if (warnings.length > 3) {
        response += `     ... and ${warnings.length - 3} more warnings\n`;
      }
    }
    if (infos.length > 0) {
      response += `   Info (${infos.length}):\n`;
      for (const issue of infos.slice(0, 2)) {
        response += `     ℹ️ ${issue.message}\n`;
      }
    }
    response += `\n`;
  }

  // Risk assessment
  const risk = validation.riskAssessment;
  response += `⚠️ Risk Assessment:\n`;
  response += `   Overall Score: ${risk.overallScore}/100\n`;
  response += `   Level: ${risk.riskLevel.toUpperCase()}\n`;
  response += `   Acceptable: ${risk.isAcceptable ? "✅ Yes" : "❌ No"} (threshold: ${risk.acceptanceThreshold})\n`;

  if (risk.factors && risk.factors.length > 0) {
    response += `   \n   Risk Factors:\n`;
    const topFactors = risk.factors
      .sort((a: { score: number }, b: { score: number }) => b.score - a.score)
      .slice(0, 5);
    for (const factor of topFactors) {
      const bar = "█".repeat(Math.floor(factor.score / 10)) + "░".repeat(10 - Math.floor(factor.score / 10));
      response += `     ${factor.category}: [${bar}] ${factor.score}\n`;
    }
  }

  if (risk.recommendations && risk.recommendations.length > 0) {
    response += `   \n   Recommendations:\n`;
    for (const rec of risk.recommendations.slice(0, 3)) {
      response += `     • ${rec}\n`;
    }
  }
  response += `\n`;

  // Timeline
  response += `📅 Timeline:\n`;
  response += `   Submitted: ${proposal.submittedAt}\n`;
  if (proposal.submittedBy) {
    response += `   Submitted By: ${proposal.submittedBy}\n`;
  }
  if (proposal.expiresAt && proposal.status === "pending") {
    response += `   Expires: ${proposal.expiresAt}\n`;
  }
  if (proposal.reviewedAt) {
    response += `   Reviewed: ${proposal.reviewedAt}\n`;
    if (proposal.reviewedBy) {
      response += `   Reviewed By: ${proposal.reviewedBy}\n`;
    }
  }
  if (proposal.reviewReason) {
    response += `   Review Reason: ${proposal.reviewReason}\n`;
  }

  return response;
}

// ============================================================================
// TOOL: validate_feature_protocols
// ============================================================================
server.tool(
  "validate_feature_protocols",
  "Validate a feature against all active protocols before starting a worker. Returns whether the feature can proceed and any constraint violations.",
  {
    projectDir: z.string().describe("Absolute path to the project directory"),
    featureId: z.string().describe("ID of the feature to validate"),
    customPrompt: z.string().optional().describe("Optional custom prompt to include in validation context"),
  },
  async ({ projectDir, featureId, customPrompt }) => {
    const { state, protocols } = await ensureInitialized(projectDir);

    // Validate feature ID
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

    const feature = current.features.find((f) => f.id === featureId);
    if (!feature) {
      return {
        content: [{ type: "text", text: `Feature '${featureId}' not found.` }],
      };
    }

    // Check if there are active protocols
    const activeProtocols = protocols.getActiveProtocols();
    if (activeProtocols.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: `✅ Feature Validation: ${featureId}\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\nNo active protocols to validate against.\nThe feature can proceed without protocol constraints.\n\nUse protocol_register and protocol_activate to add behavioral governance.`,
          },
        ],
      };
    }

    // Import enforcement integration dynamically to avoid circular deps
    const { ProtocolResolver } = await import("./protocols/resolver.js");
    const { EnforcementEngine } = await import("./protocols/enforcement.js");

    const resolver = new ProtocolResolver();
    const engine = new EnforcementEngine(protocols, resolver);

    // Build execution context for validation
    const context = {
      featureId: feature.id,
      projectDir,
      actionType: "tool_call" as const,
      actionName: "spawn_worker",
      actionParams: {
        featureDescription: feature.description,
        customPrompt,
        attempt: feature.attempts + 1,
      },
      timestamp: new Date().toISOString(),
    };

    const result = engine.validatePreExecution(context);

    // Build response
    let response = `🔍 Feature Validation: ${featureId}\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;

    response += `Feature: ${feature.description.slice(0, 60)}${feature.description.length > 60 ? "..." : ""}\n`;
    response += `Status: ${feature.status}\n`;
    response += `Attempts: ${feature.attempts}\n\n`;

    response += `📋 Active Protocols (${activeProtocols.length}):\n`;
    for (const p of activeProtocols.slice(0, 5)) {
      const applied = result.appliedProtocols.includes(p.id);
      response += `   ${applied ? "✓" : "○"} ${p.id} (${p.name})\n`;
    }
    if (activeProtocols.length > 5) {
      response += `   ... and ${activeProtocols.length - 5} more\n`;
    }
    response += `\n`;

    response += `⏱️ Evaluation Time: ${result.evaluationTimeMs}ms\n\n`;

    if (result.allowed) {
      response += `✅ Result: ALLOWED\n`;
      response += `   The feature passes all protocol constraints.\n`;

      if (result.warnings.length > 0) {
        response += `\n⚠️ Warnings (${result.warnings.length}):\n`;
        for (const warning of result.warnings.slice(0, 5)) {
          response += `   • [${warning.protocolId}] ${warning.message}\n`;
        }
        if (result.warnings.length > 5) {
          response += `   ... and ${result.warnings.length - 5} more warnings\n`;
        }
      }
    } else {
      response += `❌ Result: BLOCKED\n`;
      response += `   The feature violates protocol constraints.\n\n`;

      response += `🚫 Violations (${result.violations.length}):\n`;
      for (const v of result.violations.slice(0, 10)) {
        response += `   ❌ [${v.protocolId}] ${v.constraintId}\n`;
        response += `      Severity: ${v.severity.toUpperCase()}\n`;
        response += `      Message: ${v.message}\n`;
        if (v.remediation) {
          response += `      Fix: ${v.remediation}\n`;
        }
        response += `\n`;
      }
      if (result.violations.length > 10) {
        response += `   ... and ${result.violations.length - 10} more violations\n`;
      }

      response += `\n💡 Suggested Action: ${result.suggestedAction || "abort"}\n`;
    }

    // Log to state
    current.progressLog.push(
      `[${new Date().toISOString()}] 🔍 Validated ${featureId}: ${result.allowed ? "ALLOWED" : "BLOCKED"} (${result.violations.length} violations, ${result.warnings.length} warnings)`
    );
    state.save(current);

    return {
      content: [{ type: "text", text: response }],
    };
  }
);

// ============================================================================
// TOOL: get_violations
// ============================================================================
server.tool(
  "get_violations",
  "Get protocol violations with optional filtering. Shows violations recorded during enforcement.",
  {
    projectDir: z.string().describe("Absolute path to the project directory"),
    protocolId: z.string().optional().describe("Filter by protocol ID"),
    featureId: z.string().optional().describe("Filter by feature ID"),
    workerId: z.string().optional().describe("Filter by worker ID"),
    resolved: z.boolean().optional().describe("Filter by resolved status (true/false, omit for all)"),
    severity: z.enum(["error", "warning", "info"]).optional().describe("Filter by severity"),
    limit: z.number().int().min(1).max(100).optional().describe("Maximum violations to return (default: 20)"),
    offset: z.number().int().min(0).optional().describe("Skip first N violations (default: 0)"),
    format: z.enum(["compact", "pretty"]).optional().describe("Output format (default: pretty)"),
  },
  async ({ projectDir, protocolId, featureId, workerId, resolved, severity, limit = 20, offset = 0, format = "pretty" }) => {
    const { protocols } = await ensureInitialized(projectDir);

    const violations = protocols.getViolations({
      protocolId,
      featureId,
      workerId,
      resolved,
      severity,
      limit,
      offset,
    });

    const totalCount = protocols.getViolationCount({ protocolId, resolved });
    const unresolvedCount = protocols.getViolationCount({ protocolId, resolved: false });

    if (format === "compact") {
      let text = `Violations: ${totalCount} total, ${unresolvedCount} unresolved\n`;
      if (violations.length === 0) {
        text += `No violations matching filters.\n`;
      } else {
        for (const v of violations) {
          const status = v.resolved ? "[R]" : "[U]";
          text += `${status} ${v.id}: [${v.severity}] ${v.protocolId}/${v.constraintId} - ${v.message.slice(0, 50)}...\n`;
        }
        if (totalCount > offset + violations.length) {
          text += `... use offset=${offset + limit} to see more\n`;
        }
      }
      return { content: [{ type: "text", text }] };
    }

    // Pretty format
    let response = `🚨 Protocol Violations\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;

    response += `📊 Summary:\n`;
    response += `   Total: ${totalCount}\n`;
    response += `   Unresolved: ${unresolvedCount}\n`;
    response += `   Showing: ${violations.length} (offset: ${offset})\n\n`;

    if (protocolId || featureId || workerId || resolved !== undefined || severity) {
      response += `🔍 Filters:\n`;
      if (protocolId) response += `   Protocol: ${protocolId}\n`;
      if (featureId) response += `   Feature: ${featureId}\n`;
      if (workerId) response += `   Worker: ${workerId}\n`;
      if (resolved !== undefined) response += `   Resolved: ${resolved}\n`;
      if (severity) response += `   Severity: ${severity}\n`;
      response += `\n`;
    }

    if (violations.length === 0) {
      response += `No violations matching the specified filters.\n`;
      if (totalCount === 0) {
        response += `\n💡 No protocol violations have been recorded.\nViolations are recorded when workers or features violate protocol constraints.`;
      }
    } else {
      for (const v of violations) {
        const statusIcon = v.resolved ? "✅" : "❌";
        const severityIcon = v.severity === "error" ? "🔴" : v.severity === "warning" ? "🟡" : "🔵";

        response += `┌────────────────────────────────────\n`;
        response += `│ ${statusIcon} ${v.id}\n`;
        response += `│ ${severityIcon} Severity: ${v.severity.toUpperCase()}\n`;
        response += `│ Protocol: ${v.protocolId}\n`;
        response += `│ Constraint: ${v.constraintId}\n`;
        if (v.featureId) response += `│ Feature: ${v.featureId}\n`;
        if (v.workerId) response += `│ Worker: ${v.workerId}\n`;
        response += `│ Time: ${v.timestamp}\n`;
        response += `│ Message: ${v.message}\n`;
        if (v.resolved) {
          response += `│ ✅ Resolved: ${v.resolvedAt}\n`;
          if (v.resolution) {
            response += `│    Resolution: ${v.resolution}\n`;
          }
        }
        response += `└────────────────────────────────────\n\n`;
      }

      if (totalCount > offset + violations.length) {
        response += `📄 Showing ${violations.length} of ${totalCount} violations.\n`;
        response += `   Use offset=${offset + limit} to see more.\n`;
      }
    }

    response += `\n💡 Use resolve_violation to mark violations as resolved.`;

    return {
      content: [{ type: "text", text: response }],
    };
  }
);

// ============================================================================
// TOOL: resolve_violation
// ============================================================================
server.tool(
  "resolve_violation",
  "Mark a protocol violation as resolved with a resolution note.",
  {
    projectDir: z.string().describe("Absolute path to the project directory"),
    violationId: z.string().describe("ID of the violation to resolve"),
    resolution: z.string().min(1).max(500).describe("Description of how the violation was resolved"),
  },
  async ({ projectDir, violationId, resolution }) => {
    const { protocols, state } = await ensureInitialized(projectDir);

    try {
      protocols.resolveViolation(violationId, resolution, "orchestrator");

      // Log to state
      const current = state.load();
      if (current) {
        current.progressLog.push(
          `[${new Date().toISOString()}] ✅ Resolved violation: ${violationId}`
        );
        state.save(current);
      }

      // Get updated stats
      const stats = protocols.getStats();

      return {
        content: [
          {
            type: "text",
            text: `✅ Violation Resolved\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\nViolation ID: ${violationId}\nResolution: ${resolution}\nResolved At: ${new Date().toISOString()}\n\n📊 Updated Stats:\n   Total Violations: ${stats.totalViolations}\n   Unresolved: ${stats.unresolvedViolations}\n\nThe violation has been marked as resolved in the audit log.`,
          },
        ],
      };
    } catch (error: any) {
      return {
        content: [
          {
            type: "text",
            text: `❌ Failed to resolve violation: ${error.message}\n\nUse get_violations to see available violation IDs.`,
          },
        ],
      };
    }
  }
);

// ============================================================================
// TOOL: get_audit_log
// ============================================================================
server.tool(
  "get_audit_log",
  "Get the protocol audit log. Shows all protocol operations including registrations, activations, violations, and resolutions.",
  {
    projectDir: z.string().describe("Absolute path to the project directory"),
    protocolId: z.string().optional().describe("Filter by protocol ID"),
    action: z.enum(["register", "activate", "deactivate", "update", "delete", "violation", "resolve_violation"]).optional()
      .describe("Filter by action type"),
    limit: z.number().int().min(1).max(100).optional().describe("Maximum entries to return (default: 20)"),
    offset: z.number().int().min(0).optional().describe("Skip first N entries (default: 0)"),
    format: z.enum(["compact", "pretty"]).optional().describe("Output format (default: pretty)"),
  },
  async ({ projectDir, protocolId, action, limit = 20, offset = 0, format = "pretty" }) => {
    const { protocols } = await ensureInitialized(projectDir);

    const entries = protocols.getAuditLog({
      protocolId,
      action,
      limit,
      offset,
    });

    const stats = protocols.getStats();

    if (format === "compact") {
      let text = `Audit Log: ${stats.auditLogSize} entries\n`;
      if (entries.length === 0) {
        text += `No entries matching filters.\n`;
      } else {
        for (const e of entries) {
          const protoLabel = e.protocolId ? `[${e.protocolId}]` : "";
          text += `${e.timestamp.slice(0, 19)} ${e.action.toUpperCase()} ${protoLabel}\n`;
        }
        if (stats.auditLogSize > offset + entries.length) {
          text += `... use offset=${offset + limit} to see more\n`;
        }
      }
      return { content: [{ type: "text", text }] };
    }

    // Pretty format
    let response = `📜 Protocol Audit Log\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;

    response += `📊 Summary:\n`;
    response += `   Total Entries: ${stats.auditLogSize}\n`;
    response += `   Showing: ${entries.length} (offset: ${offset})\n\n`;

    if (protocolId || action) {
      response += `🔍 Filters:\n`;
      if (protocolId) response += `   Protocol: ${protocolId}\n`;
      if (action) response += `   Action: ${action}\n`;
      response += `\n`;
    }

    if (entries.length === 0) {
      response += `No audit entries matching the specified filters.\n`;
      if (stats.auditLogSize === 0) {
        response += `\n💡 The audit log is empty. Entries are created when:\n`;
        response += `   • Protocols are registered, activated, or deactivated\n`;
        response += `   • Violations are recorded or resolved\n`;
        response += `   • Protocol configurations are updated\n`;
      }
    } else {
      for (const e of entries) {
        const actionIcon = getActionIcon(e.action);

        response += `┌────────────────────────────────────\n`;
        response += `│ ${actionIcon} ${e.action.toUpperCase()}\n`;
        response += `│ ID: ${e.id}\n`;
        response += `│ Time: ${e.timestamp}\n`;
        if (e.protocolId) response += `│ Protocol: ${e.protocolId}\n`;
        if (e.actor) response += `│ Actor: ${e.actor}\n`;

        // Format details based on action type
        if (Object.keys(e.details).length > 0) {
          response += `│ Details:\n`;
          for (const [key, value] of Object.entries(e.details)) {
            const valueStr = typeof value === "object" ? JSON.stringify(value) : String(value);
            response += `│   ${key}: ${valueStr.slice(0, 60)}${valueStr.length > 60 ? "..." : ""}\n`;
          }
        }
        response += `└────────────────────────────────────\n\n`;
      }

      if (stats.auditLogSize > offset + entries.length) {
        response += `📄 Showing ${entries.length} of ${stats.auditLogSize} entries.\n`;
        response += `   Use offset=${offset + limit} to see more.\n`;
      }
    }

    return {
      content: [{ type: "text", text: response }],
    };
  }
);

// ============================================================================
// TOOL: run_review
// ============================================================================
server.tool(
  "run_review",
  "Manually trigger code and/or architecture reviews. Can be called at any time, but typically after features complete.",
  {
    projectDir: z.string().describe("Absolute path to the project directory"),
    reviewTypes: z.array(z.enum(["code", "architecture"])).optional()
      .describe("Types of reviews to run (default: both)"),
    forceRerun: z.boolean().optional()
      .describe("Re-run even if reviews already completed (default: false)"),
  },
  async ({ projectDir, reviewTypes = ["code", "architecture"], forceRerun = false }) => {
    const { state, workers } = await ensureInitialized(projectDir);
    const current = state.load();

    if (!current) {
      return {
        content: [{ type: "text", text: "❌ No active orchestration session. Use orchestrator_init first." }],
      };
    }

    // Check if reviews already exist and forceRerun is not set
    if (!forceRerun && current.reviewWorkers && current.reviewWorkers.length > 0) {
      const hasRunningReviews = current.reviewWorkers.some(r => r.status === "running");
      if (hasRunningReviews) {
        return {
          content: [{ type: "text", text: "⚠️ Reviews are already running. Use check_reviews to monitor progress." }],
        };
      }
    }

    // Build review config from requested types
    const reviewConfig: ReviewConfig = {
      enabled: true,
      skipOnFailure: false,
      codeReviewEnabled: reviewTypes.includes("code"),
      architectureReviewEnabled: reviewTypes.includes("architecture"),
      autoTrigger: true,
    };

    // Start reviews
    const reviewManager = new ReviewManager(projectDir);
    const reviewWorkers = await reviewManager.startReviews(current, workers, reviewConfig);

    if (reviewWorkers.length === 0) {
      return {
        content: [{ type: "text", text: "❌ No review workers started. Check configuration." }],
      };
    }

    // Update state
    current.reviewWorkers = reviewWorkers;
    if (current.status === "completed" || current.status === "completed_with_failures") {
      current.status = "reviewing";
    }
    current.progressLog.push(`[${new Date().toISOString()}] 🔍 Manually started ${reviewWorkers.length} review worker(s)`);
    state.save(current);
    state.writeProgressFile();

    const started = reviewWorkers.map(r => `${r.type} (${r.sessionName})`).join(", ");

    return {
      content: [{
        type: "text",
        text: `🔍 Started ${reviewWorkers.length} review worker(s):\n${started}\n\nUse check_reviews to monitor progress.`,
      }],
    };
  }
);

// ============================================================================
// TOOL: check_reviews
// ============================================================================
server.tool(
  "check_reviews",
  "Check the status and output of running review workers.",
  {
    projectDir: z.string().describe("Absolute path to the project directory"),
    includeOutput: z.boolean().optional().describe("Include recent output (default: true)"),
    outputLines: z.number().optional().describe("Number of output lines to include (default: 30)"),
  },
  async ({ projectDir, includeOutput = true, outputLines = 30 }) => {
    const { state, workers } = await ensureInitialized(projectDir);
    const current = state.load();

    if (!current) {
      return {
        content: [{ type: "text", text: "❌ No active orchestration session." }],
      };
    }

    if (!current.reviewWorkers || current.reviewWorkers.length === 0) {
      return {
        content: [{ type: "text", text: "❌ No review workers found. Use run_review to start reviews." }],
      };
    }

    // Check and update review worker status
    const reviewManager = new ReviewManager(projectDir);
    const { allDone, reviewWorkers } = await reviewManager.checkReviewStatus(
      current.reviewWorkers,
      workers
    );

    // Update state with new status
    current.reviewWorkers = reviewWorkers;

    // If all reviews are done, aggregate and complete
    if (allDone && current.status === "reviewing") {
      current.aggregatedReview = reviewManager.aggregateReviews(reviewWorkers);
      const allFeaturesSucceeded = current.features.every(f => f.status === "completed");
      current.status = allFeaturesSucceeded ? "completed" : "completed_with_failures";
      current.completedAt = new Date().toISOString();

      // Add review findings to progress log
      const reviewLogs = reviewManager.formatReviewsForLog(current.aggregatedReview);
      current.progressLog.push(...reviewLogs);
      current.progressLog.push(`[${new Date().toISOString()}] 🏁 Orchestration completed with reviews.`);

      // Clean up all remaining snapshot branches (session is done, rollback no longer possible)
      const cleanedBranches = await workers.cleanupAllSnapshotBranches();
      if (cleanedBranches > 0) {
        current.progressLog.push(`[${new Date().toISOString()}] 🧹 Cleaned up ${cleanedBranches} snapshot branch(es)`);
      }
    }

    state.save(current);
    state.writeProgressFile();

    // Build response
    let response = `## Review Status\n\n`;

    for (const reviewer of reviewWorkers) {
      const statusIcon = reviewer.status === "completed" ? "✅" :
        reviewer.status === "failed" ? "❌" : "🔄";
      response += `${statusIcon} **${reviewer.type.toUpperCase()} Review**: ${reviewer.status}\n`;
      response += `   Session: ${reviewer.sessionName}\n`;
      response += `   Started: ${reviewer.startedAt}\n`;
      if (reviewer.completedAt) {
        response += `   Completed: ${reviewer.completedAt}\n`;
      }
      if (reviewer.findings) {
        response += `   Severity: ${reviewer.findings.severity}\n`;
        response += `   Issues: ${reviewer.findings.issues.length}\n`;
      }

      // Include output if requested and worker is running
      if (includeOutput && reviewer.status === "running") {
        const result = await workers.checkReviewWorker(reviewer.type, outputLines);
        if (result.output) {
          response += `\n   Recent output:\n   \`\`\`\n   ${result.output.split("\n").slice(-10).join("\n   ")}\n   \`\`\`\n`;
        }
      }
      response += "\n";
    }

    if (allDone) {
      response += `\n🏁 All reviews completed! Use get_review_results for detailed findings.`;
    }

    return {
      content: [{ type: "text", text: response }],
    };
  }
);

// ============================================================================
// TOOL: get_review_results
// ============================================================================
server.tool(
  "get_review_results",
  "Get the aggregated review findings after reviews complete.",
  {
    projectDir: z.string().describe("Absolute path to the project directory"),
    format: z.enum(["summary", "detailed", "json"]).optional()
      .describe("Output format (default: summary)"),
  },
  async ({ projectDir, format = "summary" }) => {
    const { state } = await ensureInitialized(projectDir);
    const current = state.load();

    if (!current) {
      return {
        content: [{ type: "text", text: "❌ No active orchestration session." }],
      };
    }

    if (!current.aggregatedReview) {
      // Check if reviews are still running
      if (current.reviewWorkers && current.reviewWorkers.some(r => r.status === "running")) {
        return {
          content: [{ type: "text", text: "⏳ Reviews are still in progress. Use check_reviews to monitor." }],
        };
      }
      return {
        content: [{ type: "text", text: "❌ No review results available. Use run_review first." }],
      };
    }

    const review = current.aggregatedReview;

    if (format === "json") {
      return {
        content: [{ type: "text", text: JSON.stringify(review, null, 2) }],
      };
    }

    let response = `## Review Results\n\n`;
    response += `**Overall Assessment**: ${review.overallAssessment}\n`;
    response += `**Completed**: ${review.completedAt}\n\n`;

    // Code Review
    if (review.codeReview) {
      const cr = review.codeReview;
      response += `### Code Review\n`;
      response += `**Severity**: ${cr.severity}\n`;
      response += `**Summary**: ${cr.summary}\n\n`;

      if (format === "detailed" && cr.issues.length > 0) {
        response += `**Issues (${cr.issues.length}):**\n`;
        for (const issue of cr.issues) {
          const icon = issue.severity === "error" ? "🔴" :
            issue.severity === "warning" ? "🟡" : "🔵";
          response += `${icon} [${issue.category}] ${issue.message}`;
          if (issue.file) response += ` (${issue.file}${issue.line ? `:${issue.line}` : ""})`;
          response += "\n";
          if (issue.suggestion) response += `   → ${issue.suggestion}\n`;
        }
        response += "\n";
      } else if (cr.issues.length > 0) {
        const errors = cr.issues.filter(i => i.severity === "error").length;
        const warnings = cr.issues.filter(i => i.severity === "warning").length;
        const infos = cr.issues.filter(i => i.severity === "info").length;
        response += `**Issues**: ${errors} errors, ${warnings} warnings, ${infos} info\n\n`;
      }

      if (cr.recommendations.length > 0) {
        response += `**Recommendations**:\n`;
        for (const rec of cr.recommendations) {
          response += `- ${rec}\n`;
        }
        response += "\n";
      }
    }

    // Architecture Review
    if (review.architectureReview) {
      const ar = review.architectureReview;
      response += `### Architecture Review\n`;
      response += `**Severity**: ${ar.severity}\n`;
      response += `**Summary**: ${ar.summary}\n\n`;

      if (format === "detailed" && ar.issues.length > 0) {
        response += `**Issues (${ar.issues.length}):**\n`;
        for (const issue of ar.issues) {
          const icon = issue.severity === "error" ? "🔴" :
            issue.severity === "warning" ? "🟡" : "🔵";
          response += `${icon} [${issue.category}] ${issue.message}`;
          if (issue.file) response += ` (${issue.file}${issue.line ? `:${issue.line}` : ""})`;
          response += "\n";
          if (issue.suggestion) response += `   → ${issue.suggestion}\n`;
        }
        response += "\n";
      } else if (ar.issues.length > 0) {
        const errors = ar.issues.filter(i => i.severity === "error").length;
        const warnings = ar.issues.filter(i => i.severity === "warning").length;
        const infos = ar.issues.filter(i => i.severity === "info").length;
        response += `**Issues**: ${errors} errors, ${warnings} warnings, ${infos} info\n\n`;
      }

      if (ar.recommendations.length > 0) {
        response += `**Recommendations**:\n`;
        for (const rec of ar.recommendations) {
          response += `- ${rec}\n`;
        }
      }
    }

    return {
      content: [{ type: "text", text: response }],
    };
  }
);

// ============================================================================
// TOOL: configure_reviews
// ============================================================================
server.tool(
  "configure_reviews",
  "Configure automatic post-completion review settings.",
  {
    projectDir: z.string().describe("Absolute path to the project directory"),
    enabled: z.boolean().optional().describe("Enable/disable automatic reviews"),
    skipOnFailure: z.boolean().optional().describe("Skip reviews if any features failed"),
    codeReviewEnabled: z.boolean().optional().describe("Enable code quality reviews"),
    architectureReviewEnabled: z.boolean().optional().describe("Enable architecture reviews"),
    autoTrigger: z.boolean().optional().describe("Automatically start reviews when all features complete (default: true). Set to false to trigger manually via run_review."),
  },
  async ({ projectDir, enabled, skipOnFailure, codeReviewEnabled, architectureReviewEnabled, autoTrigger }) => {
    const { state } = await ensureInitialized(projectDir);
    const current = state.load();

    if (!current) {
      return {
        content: [{ type: "text", text: "❌ No active orchestration session. Use orchestrator_init first." }],
      };
    }

    // Get current config or defaults
    const currentConfig = current.reviewConfig || DEFAULT_REVIEW_CONFIG;

    // Update with provided values
    const newConfig: ReviewConfig = {
      enabled: enabled ?? currentConfig.enabled,
      skipOnFailure: skipOnFailure ?? currentConfig.skipOnFailure,
      codeReviewEnabled: codeReviewEnabled ?? currentConfig.codeReviewEnabled,
      architectureReviewEnabled: architectureReviewEnabled ?? currentConfig.architectureReviewEnabled,
      autoTrigger: autoTrigger ?? currentConfig.autoTrigger,
    };

    current.reviewConfig = newConfig;
    current.progressLog.push(`[${new Date().toISOString()}] ⚙️ Review configuration updated`);
    state.save(current);
    state.writeProgressFile();

    let response = `## Review Configuration Updated\n\n`;
    response += `- **Auto-review enabled**: ${newConfig.enabled ? "Yes" : "No"}\n`;
    response += `- **Auto-trigger on completion**: ${newConfig.autoTrigger ? "Yes" : "No (use run_review manually)"}\n`;
    response += `- **Skip on feature failure**: ${newConfig.skipOnFailure ? "Yes" : "No"}\n`;
    response += `- **Code review**: ${newConfig.codeReviewEnabled ? "Enabled" : "Disabled"}\n`;
    response += `- **Architecture review**: ${newConfig.architectureReviewEnabled ? "Enabled" : "Disabled"}\n`;

    return {
      content: [{ type: "text", text: response }],
    };
  }
);

// ============================================================================
// TOOL: configure_verification
// ============================================================================
server.tool(
  "configure_verification",
  "Configure pre-completion verification commands that workers must run before marking a feature as complete. Use this to enforce type checking, linting, or tests.",
  {
    projectDir: z.string().describe("Absolute path to the project directory"),
    commands: z.array(z.string()).optional()
      .describe("Commands workers must run before completion (e.g., ['npm run build', 'npx tsc --noEmit'])"),
    failOnError: z.boolean().optional()
      .describe("Whether workers should fix errors before proceeding (default: true)"),
    clear: z.boolean().optional()
      .describe("Clear all verification commands (default: false)"),
  },
  async ({ projectDir, commands, failOnError, clear }) => {
    const { state } = await ensureInitialized(projectDir);
    const current = state.load();

    if (!current) {
      return {
        content: [{ type: "text", text: "❌ No active orchestration session. Use orchestrator_init first." }],
      };
    }

    if (clear) {
      current.verificationConfig = undefined;
      current.progressLog.push(`[${new Date().toISOString()}] ⚙️ Verification configuration cleared`);
      state.save(current);
      state.writeProgressFile();
      return {
        content: [{ type: "text", text: "## Verification Configuration Cleared\n\nWorkers will no longer run verification commands before completion." }],
      };
    }

    // Validate commands against allowlist if provided
    if (commands && commands.length > 0) {
      const invalidCommands: string[] = [];
      for (const cmd of commands) {
        try {
          validateCommand(cmd);
        } catch (error: any) {
          invalidCommands.push(`${cmd}: ${error.message}`);
        }
      }
      if (invalidCommands.length > 0) {
        return {
          content: [{
            type: "text",
            text: `❌ Invalid verification commands:\n${invalidCommands.map(c => `  - ${c}`).join("\n")}\n\nOnly safe commands (npm test, npx tsc, etc.) are allowed.`,
          }],
        };
      }
    }

    // Get current config or defaults
    const currentConfig = current.verificationConfig || { commands: [], failOnError: true };

    // Update with provided values
    const newConfig = {
      commands: commands ?? currentConfig.commands,
      failOnError: failOnError ?? currentConfig.failOnError,
    };

    current.verificationConfig = newConfig;
    current.progressLog.push(`[${new Date().toISOString()}] ⚙️ Verification configuration updated: ${newConfig.commands.length} command(s)`);
    state.save(current);
    state.writeProgressFile();

    let response = `## Verification Configuration Updated\n\n`;
    response += `- **Fail on error**: ${newConfig.failOnError ? "Yes (workers must fix issues)" : "No (warnings only)"}\n`;
    response += `- **Commands** (${newConfig.commands.length}):\n`;
    if (newConfig.commands.length > 0) {
      for (const cmd of newConfig.commands) {
        response += `  - \`${cmd}\`\n`;
      }
    } else {
      response += `  _(none configured)_\n`;
    }
    response += `\nWorkers will run these commands before creating their .done file.`;

    return {
      content: [{ type: "text", text: response }],
    };
  }
);

// ============================================================================
// TOOL: implement_review_suggestions
// ============================================================================
server.tool(
  "implement_review_suggestions",
  "Convert review findings into new features that can be worked on. This allows the orchestrator to act on code/architecture review suggestions by creating actionable tasks.",
  {
    projectDir: z.string().describe("Absolute path to the project directory"),
    issueIndices: z.array(z.number()).optional()
      .describe("Specific issue indices to implement (0-based). If not provided, shows available issues."),
    minSeverity: z.enum(["info", "warning", "error"]).optional()
      .describe("Minimum severity level to include (default: warning)"),
    reviewType: z.enum(["code", "architecture", "both"]).optional()
      .describe("Which review findings to use (default: both)"),
    autoSelect: z.boolean().optional()
      .describe("Auto-select all issues at or above minSeverity (default: false)"),
  },
  async ({ projectDir, issueIndices, minSeverity = "warning", reviewType = "both", autoSelect = false }) => {
    const { state } = await ensureInitialized(projectDir);
    const current = state.load();

    if (!current) {
      return {
        content: [{ type: "text", text: "❌ No active orchestration session." }],
      };
    }

    if (!current.aggregatedReview) {
      return {
        content: [{ type: "text", text: "❌ No review results available. Run reviews first." }],
      };
    }

    const review = current.aggregatedReview;

    // Collect all issues from relevant reviews
    interface IndexedIssue {
      index: number;
      source: "code" | "architecture";
      category: string;
      severity: string;
      file?: string;
      line?: number;
      message: string;
      suggestion?: string;
    }

    const allIssues: IndexedIssue[] = [];
    let idx = 0;

    if ((reviewType === "code" || reviewType === "both") && review.codeReview?.issues) {
      for (const issue of review.codeReview.issues) {
        allIssues.push({
          index: idx++,
          source: "code",
          ...issue,
        });
      }
    }

    if ((reviewType === "architecture" || reviewType === "both") && review.architectureReview?.issues) {
      for (const issue of review.architectureReview.issues) {
        allIssues.push({
          index: idx++,
          source: "architecture",
          ...issue,
        });
      }
    }

    if (allIssues.length === 0) {
      return {
        content: [{ type: "text", text: "✅ No issues found in review results. Nothing to implement." }],
      };
    }

    // Severity ordering for filtering (includes all review severity levels)
    const severityOrder: Record<string, number> = {
      info: 0,
      minor: 1,
      warning: 1,
      moderate: 2,
      error: 2,
      major: 3,
      critical: 4
    };

    // Normalize severity strings to handle case variations
    const normalizeSeverity = (s: unknown): string =>
      typeof s === "string" ? s.toLowerCase().trim() : "";

    const minSeverityLevel = severityOrder[normalizeSeverity(minSeverity)] ?? 0;

    // Filter by severity
    const eligibleIssues = allIssues.filter(
      (issue) => (severityOrder[normalizeSeverity(issue.severity)] ?? 0) >= minSeverityLevel
    );

    // If no indices provided and not auto-selecting, show available issues
    if ((!issueIndices || issueIndices.length === 0) && !autoSelect) {
      let response = `## Review Issues Available for Implementation\n\n`;
      response += `Found ${allIssues.length} total issues, ${eligibleIssues.length} at ${minSeverity} or higher.\n\n`;

      for (const issue of eligibleIssues) {
        const sev = normalizeSeverity(issue.severity);
        const icon =
          sev === "critical" || sev === "major" || sev === "error" ? "🔴" :
          sev === "moderate" || sev === "warning" ? "🟡" : "🔵";
        response += `**[${issue.index}]** ${icon} [${issue.source}/${issue.category}] ${issue.message}\n`;
        if (issue.file) response += `   File: ${issue.file}${issue.line ? `:${issue.line}` : ""}\n`;
        if (issue.suggestion) response += `   Fix: ${issue.suggestion}\n`;
        response += "\n";
      }

      response += `---\n`;
      response += `To implement specific issues, call again with:\n`;
      response += `- \`issueIndices: [0, 1, 2]\` - specific issue indices\n`;
      response += `- \`autoSelect: true\` - all issues at ${minSeverity}+ severity\n`;

      return {
        content: [{ type: "text", text: response }],
      };
    }

    // Validate and filter issueIndices
    let invalidIndices: number[] = [];
    if (issueIndices) {
      const validIndices = new Set(allIssues.map(i => i.index));
      invalidIndices = issueIndices.filter(idx => !validIndices.has(idx));
    }

    // Determine which issues to implement
    const issuesToImplement: IndexedIssue[] = autoSelect
      ? eligibleIssues
      : allIssues.filter((issue) => issueIndices?.includes(issue.index));

    if (issuesToImplement.length === 0) {
      let errorMsg = "❌ No valid issues selected.";
      if (invalidIndices.length > 0) {
        errorMsg += ` Invalid indices: ${invalidIndices.join(", ")}.`;
      }
      errorMsg += " Check the indices or severity filter.";
      return {
        content: [{ type: "text", text: errorMsg }],
      };
    }

    // Group issues by file or category for efficient features
    const featureGroups = new Map<string, IndexedIssue[]>();
    for (const issue of issuesToImplement) {
      const key = issue.file || `${issue.source}-${issue.category}`;
      if (!featureGroups.has(key)) {
        featureGroups.set(key, []);
      }
      featureGroups.get(key)!.push(issue);
    }

    // Create features for each group
    const newFeatures: Feature[] = [];

    // Generate unique feature IDs by scanning existing IDs
    const existingIds = new Set(current.features.map((f) => f.id));
    const nextFixId = (() => {
      let n = 1;
      return () => {
        while (existingIds.has(`fix-${n}`)) n++;
        const id = `fix-${n}`;
        existingIds.add(id);
        n++;
        return id;
      };
    })();

    for (const [key, issues] of featureGroups) {
      const featureId = nextFixId();

      // Build description from issues
      let description: string;
      if (issues.length === 1) {
        const issue = issues[0];
        description = issue.suggestion || issue.message;
        if (issue.file) {
          description = `[${issue.file}] ${description}`;
        }
      } else {
        const fileOrCategory = issues[0].file || `${issues[0].source} ${issues[0].category}`;
        description = `Fix ${issues.length} ${issues[0].severity}+ issues in ${fileOrCategory}`;
      }

      // Truncate if too long
      if (description.length > 200) {
        description = description.substring(0, 197) + "...";
      }

      const feature: Feature = {
        id: featureId,
        description,
        status: "pending",
        attempts: 0,
        context: {
          documentation: [],
          prepared: [{
            key: "review-issues",
            content: JSON.stringify(issues, null, 2),
            priority: "required",
            source: "review-findings",
          }],
        },
      };

      newFeatures.push(feature);
    }

    // Add features to state
    current.features.push(...newFeatures);

    // Reset session status to in_progress if it was completed
    if (current.status === "completed" || current.status === "completed_with_failures" || current.status === "reviewing") {
      current.status = "in_progress";
      current.completedAt = undefined;
    }

    // Log the action
    const timestamp = new Date().toISOString();
    current.progressLog.push(
      `[${timestamp}] 🔧 Created ${newFeatures.length} feature(s) from review findings`
    );
    for (const f of newFeatures) {
      current.progressLog.push(`[${timestamp}]   - ${f.id}: ${f.description}`);
    }

    state.save(current);
    state.writeProgressFile();

    let response = `## Features Created from Review Findings\n\n`;
    response += `Created ${newFeatures.length} new feature(s) from ${issuesToImplement.length} issue(s):\n\n`;

    for (const f of newFeatures) {
      response += `- **${f.id}**: ${f.description}\n`;
    }

    response += `\nSession status: ${current.status}\n`;
    response += `\nUse \`start_worker\` or \`start_parallel_workers\` to begin implementing these fixes.`;

    return {
      content: [{ type: "text", text: response }],
    };
  }
);

// ============================================================================
// TOOL: setup_analyze
// ============================================================================
server.tool(
  "setup_analyze",
  "Analyze a repository to detect freshness (how much setup is needed) and identify missing configurations. Use this to understand what setup work is needed before running setup_init.",
  {
    projectDir: z.string().describe("Absolute path to the project directory"),
  },
  async ({ projectDir }) => {
    // Validate project directory
    const validatedDir = validateProjectDir(projectDir);

    const setupManager = new SetupManager(validatedDir);

    // Detect freshness and analyze project
    const [freshness, analysis] = await Promise.all([
      setupManager.detectFreshness(),
      setupManager.analyzeProject(),
    ]);

    // Generate potential setup features
    const features = setupManager.generateSetupFeatures(analysis);
    const missingConfigs = features.filter(f => !f.existingFile && !f.skip);

    let response = `## Repository Analysis\n\n`;

    // Freshness section
    response += `### Freshness Score: ${freshness.score}/100\n`;
    response += freshness.isFresh
      ? `This repository appears to need initial setup.\n\n`
      : `This repository appears to be already configured.\n\n`;

    response += `**Freshness Checks:**\n`;
    for (const check of freshness.checks) {
      const icon = check.missing ? "✗" : "✓";
      response += `- [${icon}] ${check.name} (${check.points}/${check.maxPoints} points)\n`;
    }
    response += `\n`;

    // Project info section
    response += `### Project Information\n`;
    response += `- **Type**: ${analysis.projectInfo.type}\n`;
    response += `- **Package Manager**: ${analysis.projectInfo.packageManager || "unknown"}\n`;
    response += `- **Has Tests**: ${analysis.ciNeeds.test ? "Yes" : "No"}\n`;
    response += `- **Has Build**: ${analysis.ciNeeds.build ? "Yes" : "No"}\n`;
    response += `- **Has Linting**: ${analysis.ciNeeds.lint ? "Yes" : "No"}\n`;
    response += `- **Is Monorepo**: ${analysis.sourceStructure.isMonorepo ? "Yes" : "No"}\n\n`;

    // Missing configs section
    response += `### Missing Configurations\n`;
    if (missingConfigs.length === 0) {
      response += `All standard configurations are present.\n`;
    } else {
      for (const config of missingConfigs) {
        response += `- **${config.id}**: ${config.description}\n`;
        response += `  Target: \`${config.targetPath}\`\n`;
      }
    }
    response += `\n`;

    // Recommendations
    response += `### Recommendations\n`;
    if (freshness.isFresh && missingConfigs.length > 0) {
      response += `Run \`setup_init\` to start the automated setup process.\n`;
      response += `This will create ${missingConfigs.length} configuration file(s).\n`;
    } else if (missingConfigs.length > 0) {
      response += `Some configurations are missing. Run \`setup_init\` to add them.\n`;
    } else {
      response += `No setup action needed. Repository is fully configured.\n`;
    }

    return {
      content: [{ type: "text", text: response }],
    };
  }
);

// ============================================================================
// TOOL: setup_init
// ============================================================================
server.tool(
  "setup_init",
  "Initialize repository setup by creating features for missing configurations and starting workers to implement them. This runs as a swarm with workers for CLAUDE.md, GitHub Actions CI, Dependabot, Release Please, and issue templates.",
  {
    projectDir: z.string().describe("Absolute path to the project directory"),
    skipConfigs: z.array(z.string()).optional().describe("Skip specific config types (e.g., ['dependabot', 'release-please'])"),
    force: z.boolean().optional().describe("Force overwrite existing files without merging (default: false)"),
    platform: z.enum(["github", "gitlab", "gitea", "bitbucket", "azure"]).optional().describe("Override auto-detected Git platform"),
  },
  async ({ projectDir, skipConfigs, force, platform }) => {
    const { state, workers } = await ensureInitialized(projectDir);

    // Create SetupManager with config
    const setupManager = new SetupManager(projectDir, {
      skipConfigs: skipConfigs || [],
      force: force || false,
      platform,
    });

    // Analyze project
    const analysis = await setupManager.analyzeProject();
    const setupFeatures = setupManager.generateSetupFeatures(analysis);

    // Filter to only features that need work
    const featuresToCreate = setupFeatures.filter(f => !f.skip && (!f.existingFile || force));

    if (featuresToCreate.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: `No setup work needed! All configurations are already present.\n\nUse \`setup_analyze\` to see the current state, or use \`force: true\` to regenerate existing files.`,
          },
        ],
      };
    }

    // Check for existing session
    const existing = state.load();
    if (existing && existing.status === "in_progress") {
      return {
        content: [
          {
            type: "text",
            text: `An orchestration session is already in progress.\n\nUse \`orchestrator_status\` to check current progress, or \`orchestrator_reset\` to start fresh before running setup.`,
          },
        ],
      };
    }

    // Convert setup features to orchestrator features
    const orchestratorFeatures: Feature[] = featuresToCreate.map((sf, i) => ({
      id: sf.id,
      description: sf.description,
      status: "pending" as const,
      attempts: 0,
      dependsOn: sf.dependsOn,
    }));

    // Initialize orchestration state
    const newState: OrchestratorState = {
      projectDir,
      taskDescription: `Repository setup: Configure ${featuresToCreate.length} files including ${featuresToCreate.map(f => f.targetPath).join(", ")}`,
      features: orchestratorFeatures,
      workers: [],
      status: "in_progress",
      startTime: new Date().toISOString(),
      lastUpdated: new Date().toISOString(),
      progressLog: [`[${new Date().toISOString()}] Setup initialized with ${orchestratorFeatures.length} configuration tasks`],
    };

    state.save(newState);
    state.writeProgressFile();

    // Initialize setup state
    setupManager.initializeSetup();

    // Start workers for features without dependencies (up to 3 in parallel)
    const startableFeatures = orchestratorFeatures.filter(f => !f.dependsOn || f.dependsOn.length === 0);
    const startedWorkers: string[] = [];

    const workerPromises = startableFeatures.slice(0, 3).map(async (feature) => {
      // Build the setup prompt
      const prompt = setupManager.buildSetupPrompt(feature.id, analysis);

      // Start the worker
      const result = await workers.startWorker(feature, prompt);

      if (result.success) {
        feature.status = "in_progress";
        feature.attempts++;
        feature.workerId = result.sessionName;
        feature.startedAt = new Date().toISOString();
        startedWorkers.push(`${feature.id} (${result.sessionName})`);

        newState.progressLog.push(`[${new Date().toISOString()}] Started setup worker for ${feature.id}`);
      }
    });
    await Promise.all(workerPromises);

    state.save(newState);
    state.writeProgressFile();

    let response = `## Repository Setup Initialized\n\n`;
    response += `**Project**: ${projectDir}\n`;
    response += `**Features**: ${orchestratorFeatures.length} configuration tasks\n\n`;

    response += `### Tasks to Create:\n`;
    for (const feature of orchestratorFeatures) {
      const icon = feature.status === "in_progress" ? "🔄" : "⏳";
      response += `${icon} ${feature.id}: ${feature.description}\n`;
    }
    response += `\n`;

    response += `### Workers Started:\n`;
    if (startedWorkers.length > 0) {
      for (const worker of startedWorkers) {
        response += `- ${worker}\n`;
      }
      response += `\n`;
      response += `Use \`setup_status\` to monitor progress.\n`;
      response += `Use \`check_worker\` to view individual worker output.\n`;
    } else {
      response += `No workers started yet. Use \`start_worker\` to begin.\n`;
    }

    return {
      content: [{ type: "text", text: response }],
    };
  }
);

// ============================================================================
// TOOL: setup_status
// ============================================================================
server.tool(
  "setup_status",
  "Check the progress of a repository setup operation. Shows which setup tasks are completed, in progress, or pending.",
  {
    projectDir: z.string().describe("Absolute path to the project directory"),
  },
  async ({ projectDir }) => {
    const { state, workers } = await ensureInitialized(projectDir);

    const setupManager = new SetupManager(projectDir);
    const setupStatus = await setupManager.getSetupStatus();

    if (!setupStatus.initialized) {
      return {
        content: [
          {
            type: "text",
            text: `No setup in progress.\n\nUse \`setup_analyze\` to check repository freshness, then \`setup_init\` to start setup.`,
          },
        ],
      };
    }

    // Also get orchestrator state for worker info
    const current = state.load();

    let response = `## Setup Progress: ${setupStatus.progressPercent}%\n\n`;

    // Summary
    const completed = setupStatus.completedFeatures.length;
    const pending = setupStatus.pendingFeatures.length;
    const failed = setupStatus.failedFeatures.length;
    const total = completed + pending + failed;

    response += `**Progress**: ${completed}/${total} tasks completed\n`;
    if (failed > 0) {
      response += `**Failed**: ${failed} task(s) need attention\n`;
    }
    response += `\n`;

    // Completed tasks
    if (setupStatus.completedFeatures.length > 0) {
      response += `### Completed\n`;
      for (const featureId of setupStatus.completedFeatures) {
        const feature = setupStatus.features.find(f => f.id === featureId);
        response += `- ✅ ${featureId}: ${feature?.targetPath || ""}\n`;
      }
      response += `\n`;
    }

    // In progress tasks
    const inProgressFeatures = current?.features.filter(f => f.status === "in_progress") || [];
    if (inProgressFeatures.length > 0) {
      response += `### In Progress\n`;
      for (const feature of inProgressFeatures) {
        response += `- 🔄 ${feature.id}`;
        if (feature.workerId) {
          response += ` (worker: ${feature.workerId})`;
        }
        response += `\n`;
      }
      response += `\n`;
    }

    // Pending tasks
    if (setupStatus.pendingFeatures.length > 0) {
      response += `### Pending\n`;
      for (const featureId of setupStatus.pendingFeatures) {
        const feature = setupStatus.features.find(f => f.id === featureId);
        const deps = feature?.dependsOn || [];
        response += `- ⏳ ${featureId}: ${feature?.targetPath || ""}`;
        if (deps.length > 0) {
          response += ` (depends on: ${deps.join(", ")})`;
        }
        response += `\n`;
      }
      response += `\n`;
    }

    // Failed tasks
    if (setupStatus.failedFeatures.length > 0) {
      response += `### Failed\n`;
      for (const featureId of setupStatus.failedFeatures) {
        const feature = setupStatus.features.find(f => f.id === featureId);
        response += `- ❌ ${featureId}: ${feature?.targetPath || ""}\n`;
      }
      response += `\n`;
      response += `Use \`retry_feature\` to retry failed tasks.\n`;
    }

    // Next steps
    response += `### Next Steps\n`;
    if (pending === 0 && failed === 0) {
      response += `Setup complete! All configurations have been created.\n`;
    } else if (inProgressFeatures.length > 0) {
      response += `Wait for in-progress workers to complete, then use \`mark_complete\` to update status.\n`;
    } else if (pending > 0) {
      response += `Use \`start_worker\` to start the next pending task.\n`;
    }

    return {
      content: [{ type: "text", text: response }],
    };
  }
);

/**
 * Get icon for audit action type
 */
function getActionIcon(action: string): string {
  switch (action) {
    case "register":
      return "📋";
    case "activate":
      return "▶️";
    case "deactivate":
      return "⏸️";
    case "update":
      return "🔄";
    case "delete":
      return "🗑️";
    case "violation":
      return "🚨";
    case "resolve_violation":
      return "✅";
    default:
      return "📝";
  }
}

// ============================================================================
// TOOL: auto_orchestrate
// ============================================================================
// ============================================================================
// TOOL: start_continuous_worker
// ============================================================================
server.tool(
  "start_continuous_worker",
  "Start a Claude Code worker that processes multiple features sequentially in a loop. The worker picks up new tasks from a queue, reducing startup overhead. Inspired by the infinite-loop pattern from 'Building a C compiler with parallel Claudes'.",
  {
    projectDir: z.string().describe("Absolute path to the project directory"),
    featureId: z.string().describe("First feature to work on"),
    workerId: z.string().optional().describe("Worker identifier (default: auto-generated)"),
    maxTasks: z.number().min(1).max(50).optional().describe("Maximum features before worker exits (default: 10)"),
  },
  async ({ projectDir, featureId, workerId, maxTasks }) => {
    const { state, workers } = await ensureInitialized(projectDir);

    try {
      validateFeatureId(featureId);
    } catch (error: any) {
      return { content: [{ type: "text", text: `Invalid feature ID: ${error.message}` }] };
    }

    const current = state.load();
    if (!current) {
      return { content: [{ type: "text", text: "No active session. Use orchestrator_init first." }] };
    }

    const feature = current.features.find(f => f.id === featureId);
    if (!feature) {
      return { content: [{ type: "text", text: `Feature '${featureId}' not found.` }] };
    }

    const id = workerId || `continuous-${Date.now().toString(36)}`;
    const result = await workers.startContinuousWorker(feature, id, { maxTasks });

    if (!result.success) {
      return { content: [{ type: "text", text: `Failed to start continuous worker: ${result.error}` }] };
    }

    // Update feature status
    feature.status = "in_progress";
    feature.workerId = result.sessionName;
    feature.startedAt = new Date().toISOString();
    feature.attempts++;

    current.progressLog.push(
      `[${new Date().toISOString()}] 🔄 Continuous worker started: ${id} (session: ${result.sessionName}, first task: ${featureId}, max tasks: ${maxTasks || 10})`
    );
    current.lastUpdated = new Date().toISOString();
    state.save(current);

    return {
      content: [{
        type: "text",
        text: `🔄 Continuous worker started!\n  Worker ID: ${id}\n  Session: ${result.sessionName}\n  First task: ${featureId}\n  Max tasks: ${maxTasks || 10}\n\nUse enqueue_feature to add more tasks to this worker.`,
      }],
    };
  }
);

// ============================================================================
// TOOL: enqueue_feature
// ============================================================================
server.tool(
  "enqueue_feature",
  "Add a feature to a running continuous worker's task queue. The worker will pick it up after finishing its current task.",
  {
    projectDir: z.string().describe("Absolute path to the project directory"),
    workerId: z.string().describe("The continuous worker's ID"),
    featureId: z.string().describe("Feature ID to add to the queue"),
  },
  async ({ projectDir, workerId, featureId }) => {
    const { state, workers } = await ensureInitialized(projectDir);

    try {
      validateFeatureId(featureId);
    } catch (error: any) {
      return { content: [{ type: "text", text: `Invalid feature ID: ${error.message}` }] };
    }

    const current = state.load();
    if (!current) {
      return { content: [{ type: "text", text: "No active session." }] };
    }

    const feature = current.features.find(f => f.id === featureId);
    if (!feature) {
      return { content: [{ type: "text", text: `Feature '${featureId}' not found.` }] };
    }

    const result = await workers.enqueueFeature(workerId, feature);

    if (!result.success) {
      return { content: [{ type: "text", text: `Failed to enqueue: ${result.error}` }] };
    }

    current.progressLog.push(
      `[${new Date().toISOString()}] 📥 Enqueued ${featureId} to continuous worker ${workerId}`
    );
    current.lastUpdated = new Date().toISOString();
    state.save(current);

    return {
      content: [{
        type: "text",
        text: `📥 Feature ${featureId} added to worker ${workerId}'s queue. It will be processed after the current task completes.`,
      }],
    };
  }
);

// ============================================================================
// TOOL: auto_orchestrate
// ============================================================================
server.tool(
  "auto_orchestrate",
  "Automatically schedule and monitor workers based on priority, dependencies, and worker health. Runs hands-free until all features complete.",
  {
    projectDir: z.string().describe("Absolute path to the project directory"),
    strategy: z.enum(["breadth-first", "depth-first", "adaptive"]).optional().describe("Scheduling strategy (default: adaptive)"),
    maxConcurrent: z.number().min(1).max(10).optional().describe("Maximum concurrent workers (default: 5)"),
    checkIntervalSeconds: z.number().min(10).max(300).optional().describe("How often to check worker progress in seconds (default: 30)"),
  },
  async ({ projectDir, strategy = "adaptive", maxConcurrent = 5, checkIntervalSeconds = 30 }) => {
    const { state, workers } = await ensureInitialized(projectDir);

    const current = state.load();
    if (!current) {
      return {
        content: [{ type: "text", text: "No active session. Use orchestrator_init first." }],
      };
    }

    // Priority calculation function
    function calculatePriority(feature: Feature, allFeatures: Feature[]): number {
      let score = 0;

      // +50 points per feature this blocks
      const blockedCount = allFeatures.filter(f =>
        f.dependsOn?.includes(feature.id) && f.status === "pending"
      ).length;
      score += blockedCount * 50;

      // +40 points if no dependencies (can start immediately)
      if (!feature.dependsOn || feature.dependsOn.length === 0) {
        score += 40;
      }

      // +30 points for low complexity (if available)
      if (feature.complexity && feature.complexity.score < 40) {
        score += 30;
      }

      // -20 points per previous attempt (struggling)
      score -= (feature.attempts || 0) * 20;

      // Routing-aware: boost features whose affinity group has running workers (co-locate related work)
      if (feature.routing?.affinityGroup) {
        const runningInGroup = allFeatures.filter(f =>
          f.status === "in_progress" &&
          f.routing?.affinityGroup === feature.routing!.affinityGroup
        ).length;
        if (runningInGroup > 0) score += 25;
      }

      // Strategy-specific adjustments
      if (strategy === "breadth-first") {
        // Prefer features with no dependencies
        if (!feature.dependsOn || feature.dependsOn.length === 0) score += 20;
      } else if (strategy === "depth-first") {
        // Prefer features that unblock others
        score += blockedCount * 30;
      }

      return Math.max(0, score);
    }

    // Get features ready to work on
    function getReadyFeatures(): Feature[] {
      return current!.features.filter(f => {
        if (f.status !== "pending") return false;

        // Check dependencies are met
        if (f.dependsOn && f.dependsOn.length > 0) {
          const unmetDeps = f.dependsOn.filter(depId => {
            const dep = current!.features.find(df => df.id === depId);
            return !dep || dep.status !== "completed";
          });
          if (unmetDeps.length > 0) return false;
        }

        // Respect maxParallelism from routing config
        if (f.routing?.maxParallelism) {
          const sameGroupRunning = current!.features.filter(other =>
            other.status === "in_progress" &&
            other.routing?.affinityGroup === f.routing?.affinityGroup
          ).length;
          if (sameGroupRunning >= f.routing.maxParallelism) return false;
        }

        return true;
      });
    }

    // Execution loop: runs autonomously until all features complete or safety limit reached
    let iterationCount = 0;
    const maxIterations = 200; // Safety limit
    let totalStarted = 0;
    let totalCompleted = 0;
    let totalFailed = 0;

    current.progressLog.push(
      `[${new Date().toISOString()}] 🤖 Auto-orchestration started (strategy: ${strategy}, maxConcurrent: ${maxConcurrent}, check interval: ${checkIntervalSeconds}s)`
    );
    state.save(current);

    const verificationRunner = new VerificationRunner();

    while (iterationCount < maxIterations) {
      iterationCount++;

      // Reload state (may have been modified by completion callbacks)
      const freshState = state.load();
      if (!freshState) break;

      // Count features by status
      const pending = freshState.features.filter(f => f.status === "pending");
      const inProgress = freshState.features.filter(f => f.status === "in_progress");
      const completed = freshState.features.filter(f => f.status === "completed");
      const failed = freshState.features.filter(f => f.status === "failed");

      // Check if all done (no pending or in-progress)
      if (pending.length === 0 && inProgress.length === 0) {
        freshState.progressLog.push(
          `[${new Date().toISOString()}] 🏁 Auto-orchestration finished: ${completed.length} completed, ${failed.length} failed`
        );
        state.save(freshState);
        break;
      }

      // Process completions: check each in-progress worker
      for (const feature of inProgress) {
        if (!feature.workerId) continue;

        const checkResult = await workers.checkWorker(feature.workerId, 20);

        // Handle plan-phase completion separately
        if (feature.planPhase === "planning" && (checkResult.status === "completed" || checkResult.status === "crashed")) {
          if (workers.isPlanDone(feature.id)) {
            const plan = workers.readWorkerPlan(feature.id);
            if (plan) {
              const criteria = freshState.planModeConfig?.approvalCriteria || DEFAULT_APPROVAL_CRITERIA;
              const review = workers.reviewWorkerPlan(plan, feature, criteria);

              feature.workerPlan = plan;
              feature.planReview = review;

              if (review.approved) {
                // Plan approved - start implement phase
                feature.planPhase = "implementing";
                const implResult = await workers.startWorker(feature);
                if (implResult.success) {
                  feature.workerId = implResult.sessionName;
                  freshState.progressLog.push(
                    `[${new Date().toISOString()}] ✅ Plan approved for ${feature.id} (score: ${review.score}). Starting implementation.`
                  );
                }
              } else {
                // Plan rejected - re-plan or fallback
                const maxReplans = freshState.planModeConfig?.maxReplanAttempts ?? 2;
                if ((feature.planAttempts || 0) < maxReplans) {
                  feature.planPhase = "planning";
                  feature.planAttempts = (feature.planAttempts || 0) + 1;
                  const replanResult = await workers.startPlanPhaseWorker(
                    feature,
                    `Previous plan was rejected (score: ${review.score}). Feedback: ${review.feedback}\nSuggestions: ${review.suggestions.join("; ")}`
                  );
                  if (replanResult.success) {
                    feature.workerId = replanResult.sessionName;
                    freshState.progressLog.push(
                      `[${new Date().toISOString()}] 🔄 Re-planning ${feature.id} (attempt ${feature.planAttempts}, score: ${review.score})`
                    );
                  }
                } else {
                  // Fallback: implement without plan
                  feature.planPhase = "implementing";
                  const implResult = await workers.startWorker(feature);
                  if (implResult.success) {
                    feature.workerId = implResult.sessionName;
                    freshState.progressLog.push(
                      `[${new Date().toISOString()}] ⚠️ Plan mode exhausted for ${feature.id}. Starting implementation without plan.`
                    );
                  }
                }
              }
            } else {
              // Plan file not readable - fallback to implement without plan
              feature.planPhase = "implementing";
              const implResult = await workers.startWorker(feature);
              if (implResult.success) {
                feature.workerId = implResult.sessionName;
                freshState.progressLog.push(
                  `[${new Date().toISOString()}] ⚠️ Plan not readable for ${feature.id}. Starting implementation without plan.`
                );
              }
            }
          } else {
            // Plan phase crashed or didn't produce plan - fallback
            feature.planPhase = "implementing";
            const implResult = await workers.startWorker(feature);
            if (implResult.success) {
              feature.workerId = implResult.sessionName;
              freshState.progressLog.push(
                `[${new Date().toISOString()}] ⚠️ Plan phase failed for ${feature.id}. Starting implementation directly.`
              );
            }
          }
          continue;
        }

        if (checkResult.status === "completed" || checkResult.status === "crashed") {
          const isSuccess = checkResult.status === "completed";

          // Auto-verification for completed workers
          let verificationPassed = true;
          if (isSuccess && freshState.verificationConfig?.commands?.length && freshState.verificationConfig.failOnError) {
            const workDir = feature.worktreePath || projectDir;
            const verifyResult = await verificationRunner.runVerification(
              freshState.verificationConfig.commands,
              workDir
            );
            verificationPassed = verifyResult.allPassed;
            if (!verificationPassed) {
              feature.lastError = verificationRunner.formatForRetry(verifyResult);
            }
          }

          const actualSuccess = isSuccess && verificationPassed;

          if (actualSuccess) {
            // Merge worktree if applicable
            if (feature.isolationMode === "worktree" && feature.worktreePath) {
              const worktreeManager = workers.getWorktreeManager();
              const mergeResult = await worktreeManager.mergeWorktree(feature.id);
              if (!mergeResult.success) {
                feature.notes = (feature.notes || "") + `\nMerge conflicts: ${mergeResult.conflicts?.join(", ")}`;
              }
              await worktreeManager.removeWorktree(feature.id);
            } else {
              await workers.deleteSnapshotBranch(feature.id);
            }

            feature.status = "completed";
            feature.completedAt = new Date().toISOString();
            feature.planPhase = undefined;
            totalCompleted++;

            // Record learning for future features
            try {
              state.recordLearning({
                featureType: feature.description.substring(0, 100),
                commonErrors: feature.lastError ? [feature.lastError.substring(0, 200)] : [],
                successfulApproaches: feature.workerPlan?.summary ? [feature.workerPlan.summary.substring(0, 200)] : [],
                iterations: feature.ralphIteration || feature.attempts,
                planWasUseful: !!feature.workerPlan,
              });
            } catch {
              // Non-fatal
            }

            // Checkpoint on feature completion
            try {
              await state.checkpoint("feature_complete");
            } catch {
              // Non-fatal
            }

            freshState.progressLog.push(
              `[${new Date().toISOString()}] ✅ Auto-completed: ${feature.id}`
            );
          } else {
            // Failed or verification failed - check for retry
            const maxRetries = feature.maxRetries ?? 3;
            if (feature.attempts < maxRetries) {
              feature.status = "pending";
              feature.lastError = feature.lastError || checkResult.output?.slice(0, 200) || "Worker failed";

              // Clean up worktree for retry
              if (feature.isolationMode === "worktree" && feature.worktreePath) {
                const worktreeManager = workers.getWorktreeManager();
                await worktreeManager.removeWorktree(feature.id);
                feature.worktreePath = undefined;
                feature.worktreeBranch = undefined;
              }

              freshState.progressLog.push(
                `[${new Date().toISOString()}] 🔄 Auto-retry queued: ${feature.id} (attempt ${feature.attempts}/${maxRetries})`
              );
            } else {
              feature.status = "failed";
              feature.completedAt = new Date().toISOString();
              totalFailed++;

              // Clean up worktree
              if (feature.isolationMode === "worktree" && feature.worktreePath) {
                const worktreeManager = workers.getWorktreeManager();
                await worktreeManager.removeWorktree(feature.id);
              }

              freshState.progressLog.push(
                `[${new Date().toISOString()}] ❌ Auto-failed (exhausted retries): ${feature.id}`
              );
            }
          }

          // Release locks and clear worker ID
          const lockManager = workers.getLockManager();
          lockManager.releaseAll(feature.id);
          feature.workerId = undefined;
        }
      }

      // Start new workers for ready features
      // Re-evaluate ready features after processing completions
      const readyFeatures = freshState.features.filter(f => {
        if (f.status !== "pending") return false;
        if (f.dependsOn && f.dependsOn.length > 0) {
          const unmetDeps = f.dependsOn.filter(depId => {
            const dep = freshState.features.find(df => df.id === depId);
            return !dep || dep.status !== "completed";
          });
          if (unmetDeps.length > 0) return false;
        }
        if (f.routing?.maxParallelism) {
          const sameGroupRunning = freshState.features.filter(other =>
            other.status === "in_progress" &&
            other.routing?.affinityGroup === f.routing?.affinityGroup
          ).length;
          if (sameGroupRunning >= f.routing.maxParallelism) return false;
        }
        return true;
      });

      const currentlyRunning = freshState.features.filter(f => f.status === "in_progress").length;
      const availableSlots = maxConcurrent - currentlyRunning;

      if (availableSlots > 0 && readyFeatures.length > 0) {
        // Prioritize and start
        const prioritized = readyFeatures
          .map(f => ({ feature: f, priority: calculatePriority(f, freshState.features) }))
          .sort((a, b) => b.priority - a.priority);

        const batch = prioritized.slice(0, availableSlots);

        for (const { feature } of batch) {
          // Determine execution mode: plan mode, Ralph Loop, or standard
          const usePlanMode = workers.shouldUsePlanMode(feature, freshState.planModeConfig || undefined);
          const useRalphLoop = freshState.ralphLoopConfig?.enabled ?? false;

          let startResult;
          let mode = "standard";

          if (usePlanMode && !feature.planPhase) {
            // Start plan phase first
            feature.planPhase = "planning";
            feature.planAttempts = (feature.planAttempts || 0) + 1;
            startResult = await workers.startPlanPhaseWorker(feature);
            mode = "plan-phase";
          } else if (useRalphLoop) {
            // Use Ralph Loop
            startResult = await workers.startRalphLoop(feature, {
              maxIterations: freshState.ralphLoopConfig!.maxIterations,
              maxDurationMinutes: freshState.ralphLoopConfig!.maxDurationMinutes,
              stopOnComplete: freshState.ralphLoopConfig!.stopOnComplete,
              verifyBeforeStop: freshState.ralphLoopConfig!.verifyBeforeStop,
            });
            mode = "ralph-loop";
          } else {
            // Standard single-run worker
            startResult = await workers.startWorker(feature);
          }

          if (startResult.success) {
            feature.status = "in_progress";
            feature.workerId = startResult.sessionName;
            feature.startedAt = new Date().toISOString();
            feature.attempts++;
            totalStarted++;

            freshState.progressLog.push(
              `[${new Date().toISOString()}] 🚀 Auto-started: ${feature.id} (${mode}, attempt ${feature.attempts})`
            );
          }
        }
      }

      freshState.lastUpdated = new Date().toISOString();
      state.save(freshState);

      // Write heartbeat for crash detection
      state.writeHeartbeat(`auto-${Date.now().toString(36)}`, true);

      // Periodic checkpoint (every ~15 minutes based on check interval)
      if (iterationCount % Math.max(1, Math.floor(900 / checkIntervalSeconds)) === 0) {
        try {
          const activeWorkerCheckpoints = freshState.features
            .filter(f => f.status === "in_progress" && f.workerId)
            .map(f => ({
              featureId: f.id,
              sessionName: f.workerId!,
              tmuxAlive: true,
              lastProgress: "",
              iteration: f.ralphIteration || 0,
              phase: (f.planPhase || "implementing") as "planning" | "implementing",
            }));
          await state.checkpoint("periodic", activeWorkerCheckpoints);
        } catch {
          // Non-fatal - checkpoint failure shouldn't stop orchestration
        }
      }

      // Wait before next check
      await new Promise(resolve => setTimeout(resolve, checkIntervalSeconds * 1000));
    }

    // Clean up heartbeat
    state.removeHeartbeat();

    // Build final summary
    const finalState = state.load()!;
    const completedFeatures = finalState.features.filter(f => f.status === "completed");
    const failedFeatures = finalState.features.filter(f => f.status === "failed");
    const pendingFeatures = finalState.features.filter(f => f.status === "pending");

    let response = `🤖 Auto-Orchestration Complete\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
    response += `Strategy: ${strategy}\n`;
    response += `Iterations: ${iterationCount}\n`;
    response += `Workers started: ${totalStarted}\n\n`;
    response += `Results:\n`;
    response += `  ✅ Completed: ${completedFeatures.length}\n`;
    response += `  ❌ Failed: ${failedFeatures.length}\n`;
    if (pendingFeatures.length > 0) {
      response += `  ⏳ Still pending: ${pendingFeatures.length}\n`;
    }

    if (failedFeatures.length > 0) {
      response += `\nFailed features:\n`;
      for (const f of failedFeatures) {
        response += `  - ${f.id}: ${f.lastError?.substring(0, 80) || "No details"}\n`;
      }
    }

    if (iterationCount >= maxIterations) {
      response += `\n⚠️ Safety limit reached (${maxIterations} iterations). Some features may be incomplete.`;
    }

    return {
      content: [{ type: "text", text: response }],
    };
  }
);

// ============================================================================
// TOOL: configure_plan_mode
// ============================================================================
server.tool(
  "configure_plan_mode",
  "Configure worker plan mode. When enabled, workers analyze the codebase and produce a plan before implementing. Plans are auto-approved by the orchestrator.",
  {
    projectDir: z.string().describe("Absolute path to the project directory"),
    enabled: z.boolean().optional().describe("Enable/disable plan mode globally (default: true)"),
    complexityThreshold: z.number().min(0).max(100).optional().describe("Minimum complexity score to trigger plan mode (default: 30)"),
    requireTestStrategy: z.boolean().optional().describe("Require test strategy in plans (default: true)"),
    requireRiskAssessment: z.boolean().optional().describe("Require risk assessment in plans (default: true)"),
    maxSteps: z.number().min(1).max(50).optional().describe("Maximum steps allowed in a plan (default: 20)"),
    requireFileList: z.boolean().optional().describe("Require file list in plans (default: true)"),
    maxReplanAttempts: z.number().min(0).max(5).optional().describe("Maximum re-plan attempts before fallback (default: 2)"),
  },
  async ({ projectDir, enabled, complexityThreshold, requireTestStrategy, requireRiskAssessment, maxSteps, requireFileList, maxReplanAttempts }) => {
    const { state } = await ensureInitialized(projectDir);
    const current = state.load();

    if (!current) {
      return { content: [{ type: "text", text: "No active session. Use orchestrator_init first." }] };
    }

    // Build config from params, merging with existing
    const existingConfig = current.planModeConfig;
    const config: PlanModeConfig = {
      enabled: enabled ?? existingConfig?.enabled ?? true,
      complexityThreshold: complexityThreshold ?? existingConfig?.complexityThreshold ?? 30,
      maxReplanAttempts: maxReplanAttempts ?? existingConfig?.maxReplanAttempts ?? 2,
      approvalCriteria: {
        requireTestStrategy: requireTestStrategy ?? existingConfig?.approvalCriteria?.requireTestStrategy ?? true,
        requireRiskAssessment: requireRiskAssessment ?? existingConfig?.approvalCriteria?.requireRiskAssessment ?? true,
        maxSteps: maxSteps ?? existingConfig?.approvalCriteria?.maxSteps ?? 20,
        requireFileList: requireFileList ?? existingConfig?.approvalCriteria?.requireFileList ?? true,
      },
    };

    current.planModeConfig = config;
    current.progressLog.push(
      `[${new Date().toISOString()}] Plan mode configured: enabled=${config.enabled}, threshold=${config.complexityThreshold}, maxReplans=${config.maxReplanAttempts}`
    );
    state.save(current);

    return {
      content: [{
        type: "text",
        text: `Plan mode configured:\n  Enabled: ${config.enabled}\n  Complexity threshold: ${config.complexityThreshold}\n  Max re-plan attempts: ${config.maxReplanAttempts}\n  Require test strategy: ${config.approvalCriteria.requireTestStrategy}\n  Require risk assessment: ${config.approvalCriteria.requireRiskAssessment}\n  Max steps: ${config.approvalCriteria.maxSteps}\n  Require file list: ${config.approvalCriteria.requireFileList}`,
      }],
    };
  }
);

// ============================================================================
// TOOL: configure_ralph_loop
// ============================================================================
server.tool(
  "configure_ralph_loop",
  "Configure Ralph Loop execution mode. When enabled, workers get fresh context each iteration with state loaded from filesystem. Supports hours/days-long autonomous sessions.",
  {
    projectDir: z.string().describe("Absolute path to the project directory"),
    enabled: z.boolean().optional().describe("Enable/disable Ralph Loop globally (default: false)"),
    maxIterations: z.number().min(1).max(200).optional().describe("Maximum iterations per feature (default: 50)"),
    maxDurationMinutes: z.number().min(1).max(14400).optional().describe("Maximum duration in minutes per feature (default: 480 = 8 hours)"),
    stopOnComplete: z.boolean().optional().describe("Stop when .done file detected (default: true)"),
    verifyBeforeStop: z.boolean().optional().describe("Run verification before stopping (default: true)"),
  },
  async ({ projectDir, enabled, maxIterations, maxDurationMinutes, stopOnComplete, verifyBeforeStop }) => {
    const { state } = await ensureInitialized(projectDir);
    const current = state.load();

    if (!current) {
      return { content: [{ type: "text", text: "No active session. Use orchestrator_init first." }] };
    }

    const existingConfig = current.ralphLoopConfig;
    const config: RalphLoopConfig = {
      enabled: enabled ?? existingConfig?.enabled ?? false,
      maxIterations: maxIterations ?? existingConfig?.maxIterations ?? 50,
      maxDurationMinutes: maxDurationMinutes ?? existingConfig?.maxDurationMinutes ?? 480,
      stopOnComplete: stopOnComplete ?? existingConfig?.stopOnComplete ?? true,
      verifyBeforeStop: verifyBeforeStop ?? existingConfig?.verifyBeforeStop ?? true,
    };

    current.ralphLoopConfig = config;
    current.progressLog.push(
      `[${new Date().toISOString()}] Ralph Loop configured: enabled=${config.enabled}, maxIterations=${config.maxIterations}, maxDuration=${config.maxDurationMinutes}min`
    );
    state.save(current);

    return {
      content: [{
        type: "text",
        text: `Ralph Loop configured:\n  Enabled: ${config.enabled}\n  Max iterations: ${config.maxIterations}\n  Max duration: ${config.maxDurationMinutes} minutes\n  Stop on complete: ${config.stopOnComplete}\n  Verify before stop: ${config.verifyBeforeStop}`,
      }],
    };
  }
);

// ============================================================================
// TOOL: start_ralph_loop
// ============================================================================
server.tool(
  "start_ralph_loop",
  "Start a worker using the Ralph Loop pattern. Each iteration gets a fresh Claude session with state loaded from filesystem (progress files, git diff). Eliminates context rot for long-running tasks.",
  {
    projectDir: z.string().describe("Absolute path to the project directory"),
    featureId: z.string().describe("Feature to work on"),
    maxIterations: z.number().min(1).max(200).optional().describe("Maximum iterations (default: 50)"),
    maxDurationMinutes: z.number().min(1).max(14400).optional().describe("Maximum duration in minutes (default: 480)"),
  },
  async ({ projectDir, featureId, maxIterations, maxDurationMinutes }) => {
    const { state, workers } = await ensureInitialized(projectDir);

    try {
      validateFeatureId(featureId);
    } catch (error: any) {
      return { content: [{ type: "text", text: `Invalid feature ID: ${error.message}` }] };
    }

    const current = state.load();
    if (!current) {
      return { content: [{ type: "text", text: "No active session. Use orchestrator_init first." }] };
    }

    const feature = current.features.find(f => f.id === featureId);
    if (!feature) {
      return { content: [{ type: "text", text: `Feature '${featureId}' not found.` }] };
    }

    if (feature.status === "completed") {
      return { content: [{ type: "text", text: `Feature '${featureId}' is already completed.` }] };
    }

    const options: Partial<import("./workers/ralph-loop.js").RalphLoopOptions> = {};
    if (maxIterations) options.maxIterations = maxIterations;
    if (maxDurationMinutes) options.maxDurationMinutes = maxDurationMinutes;

    // Apply global defaults if configured
    const globalConfig = current.ralphLoopConfig;
    if (globalConfig) {
      if (!maxIterations) options.maxIterations = globalConfig.maxIterations;
      if (!maxDurationMinutes) options.maxDurationMinutes = globalConfig.maxDurationMinutes;
      options.stopOnComplete = globalConfig.stopOnComplete;
      options.verifyBeforeStop = globalConfig.verifyBeforeStop;
    }

    const result = await workers.startRalphLoop(feature, options);

    if (!result.success) {
      return { content: [{ type: "text", text: `Failed to start Ralph Loop: ${result.error}` }] };
    }

    feature.status = "in_progress";
    feature.workerId = result.sessionName;
    feature.startedAt = new Date().toISOString();
    feature.attempts++;

    current.progressLog.push(
      `[${new Date().toISOString()}] 🔄 Ralph Loop started: ${featureId} (session: ${result.sessionName}, max iterations: ${options.maxIterations || 50})`
    );
    state.save(current);

    return {
      content: [{
        type: "text",
        text: `🔄 Ralph Loop started!\n  Feature: ${featureId}\n  Session: ${result.sessionName}\n  Max iterations: ${options.maxIterations || 50}\n  Max duration: ${options.maxDurationMinutes || 480} minutes\n\nWorker will iterate with fresh context until feature is complete.\nProgress tracked in: .claude/orchestrator/workers/${featureId}.progress.md`,
      }],
    };
  }
);

// ============================================================================
// TOOL: shutdown_session
// ============================================================================
server.tool(
  "shutdown_session",
  "Gracefully shut down the orchestration session. Creates a checkpoint, stops all workers (letting current iteration finish), and writes shutdown record. Use before closing laptop for resume_session recovery later.",
  {
    projectDir: z.string().describe("Absolute path to the project directory"),
    checkpoint: z.boolean().optional().describe("Create a checkpoint before shutdown (default: true)"),
    waitSeconds: z.number().min(0).max(120).optional().describe("Seconds to wait for workers to finish current iteration (default: 60)"),
  },
  async ({ projectDir, checkpoint = true, waitSeconds = 60 }) => {
    const { state, workers } = await ensureInitialized(projectDir);
    const current = state.load();

    if (!current) {
      return { content: [{ type: "text", text: "No active session." }] };
    }

    // Get active worker info for checkpoint
    const workerStatuses = await workers.checkAllWorkers();
    const activeWorkers = workerStatuses
      .filter(w => w.status === "running")
      .map(w => ({
        featureId: w.featureId,
        sessionName: w.sessionName,
        tmuxAlive: true,
        lastProgress: "",
        iteration: 0,
        phase: "implementing" as const,
      }));

    // Create checkpoint if requested
    let checkpointId: string | undefined;
    if (checkpoint) {
      try {
        checkpointId = await state.checkpoint("shutdown", activeWorkers);
      } catch (error) {
        console.error("Failed to create shutdown checkpoint:", error);
      }
    }

    // Wait for workers to finish current iteration
    if (activeWorkers.length > 0 && waitSeconds > 0) {
      // Brief wait to let in-flight work complete
      await new Promise(resolve => setTimeout(resolve, Math.min(waitSeconds, 10) * 1000));
    }

    // Kill all workers
    await workers.killAllWorkers();

    // Update feature statuses
    for (const feature of current.features) {
      if (feature.status === "in_progress") {
        feature.status = "pending";
        feature.workerId = undefined;
      }
    }

    current.status = "paused";
    current.progressLog.push(
      `[${new Date().toISOString()}] 🛑 Session shut down gracefully${checkpointId ? ` (checkpoint: ${checkpointId})` : ""}. ${activeWorkers.length} worker(s) stopped.`
    );
    state.save(current);
    state.writeProgressFile();

    // Remove heartbeat
    state.removeHeartbeat();

    return {
      content: [{
        type: "text",
        text: `🛑 Session shut down gracefully!\n\n  Workers stopped: ${activeWorkers.length}\n  Checkpoint: ${checkpointId || "none"}\n  Status: paused\n\nTo resume later: use resume_session with crash recovery.\nAll progress has been saved to filesystem.`,
      }],
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
