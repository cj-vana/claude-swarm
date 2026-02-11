/**
 * State Manager - Persistent state management for orchestration sessions
 *
 * Key design principles:
 * - State persists independently of Claude's context
 * - All state is stored in JSON files within the project
 * - Supports recovery after context compaction
 * - Maintains a progress log (notebook pattern) for transparency
 *
 * Security:
 * - Atomic file writes to prevent corruption
 * - Schema validation on load
 * - Safe shell escaping in generated scripts
 * - Log rotation to prevent unbounded growth
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  OrchestratorStateSchema,
  shellQuote,
  sanitizeOutput,
} from "../utils/security.js";

import { ComplexityResult } from "../utils/complexity-detector.js";
import { PlanSubmission } from "../utils/plan-evaluator.js";
import { ConfidenceAlert } from "../workers/confidence.js";
import type { WorkerPlan, PlanReview, ApprovalCriteria, QualityScore } from "../workers/plan-reviewer.js";

/**
 * DocumentationRef - Reference to documentation that provides context for a feature
 * Used for protocol-based behavioral governance to provide relevant docs to workers
 */
export interface DocumentationRef {
  type: "file" | "url" | "snippet";
  path: string; // File path, URL, or identifier
  title?: string; // Human-readable title
  relevance?: string; // Why this doc is relevant to the feature
  section?: string; // Specific section within the document
}

/**
 * PreparedContext - Pre-processed context information for efficient worker startup
 * Contains extracted/summarized information ready for injection into worker prompts
 */
export interface PreparedContext {
  key: string; // Unique identifier for this context block
  content: string; // The actual context content
  source?: string; // Where this context came from
  priority: "required" | "recommended" | "optional";
  tokenEstimate?: number; // Estimated token count for budget management
}

/**
 * ProtocolBinding - Binds a protocol to a feature for behavioral governance
 * Protocols define constraints, validations, and behavioral rules for workers
 */
export interface ProtocolBinding {
  protocolId: string; // Reference to the protocol in the registry
  version?: string; // Optional version constraint
  scope: "pre_execution" | "post_execution" | "continuous" | "all";
  priority: number; // Higher priority protocols are enforced first
  parameters?: Record<string, unknown>; // Protocol-specific parameters
  overrides?: Record<string, unknown>; // Override default protocol settings
}

/**
 * RoutingConfig - Configuration for routing a feature to appropriate workers
 * Enables intelligent task assignment based on feature characteristics
 */
export interface RoutingConfig {
  preferredWorkerType?: string; // Hint for worker specialization
  requiredCapabilities?: string[]; // Capabilities the worker must have
  excludeCapabilities?: string[]; // Capabilities to avoid
  maxParallelism?: number; // Max concurrent workers for this feature
  affinityGroup?: string; // Group features that should run on same worker
  isolationLevel?: "none" | "session" | "process" | "container";
}

export interface ValidationConfig {
  enabled: boolean;
  coverageTarget?: number; // e.g., 50.0 for 50%
  testPassRequired?: boolean;
  enforceBlocking: boolean; // If true, validation failures block completion
  verifyCommand?: string; // e.g., "go test -cover ./internal/..."
  expectedPackages?: string[]; // e.g., ["internal/tui/components/chat"]
}

export interface ValidationCheck {
  name: string;
  passed: boolean;
  expected?: number;
  actual?: number;
  details?: string;
}

export interface ValidationResult {
  passed: boolean;
  checks: ValidationCheck[];
  error?: string;
  timestamp: string;
}

export interface GitVerification {
  beforeHash: string;
  afterHash: string;
  filesChanged: string[];
  linesAdded: number;
  linesDeleted: number;
  diffChecksum: string;
}

export interface Feature {
  id: string;
  description: string;
  status: "pending" | "in_progress" | "completed" | "failed";
  attempts: number;
  maxRetries?: number; // Default 3
  workerId?: string;
  startedAt?: string;
  completedAt?: string;
  lastError?: string;
  notes?: string;
  dependsOn?: string[]; // Array of feature IDs this feature depends on

  // Validation fields (NEW)
  validation?: ValidationConfig;
  validationResult?: ValidationResult;
  gitVerification?: GitVerification;

  // Competitive planning fields
  complexity?: ComplexityResult;
  planningPhase?: "planning" | "evaluating" | "implementing" | null;
  competingPlans?: {
    planA?: PlanSubmission;
    planB?: PlanSubmission;
    selectedPlan?: "A" | "B";
    selectionReason?: string;
  };

  // Protocol-based behavioral governance fields
  context?: {
    documentation: DocumentationRef[]; // References to relevant documentation
    prepared: PreparedContext[]; // Pre-processed context for worker injection
  };
  protocolBindings?: ProtocolBinding[]; // Protocols bound to this feature
  routing?: RoutingConfig; // Routing configuration for worker assignment

  // Git worktree isolation fields
  worktreePath?: string; // Path to the worktree directory (if using isolation)
  worktreeBranch?: string; // Git branch for the worktree
  isolationMode?: "none" | "worktree"; // How this feature's worker was isolated

  // Files modified by this feature's worker
  modifiedFiles?: string[];

  // Multi-agent voting fields
  votingGroup?: string; // e.g., "feature-5-voting" - identifies voting group
  votingRole?: `voter-${number}`; // Which voter in the group (voter-1, voter-2, etc.)
  votingScore?: number; // Score after evaluation (0-100)
  votingWinner?: boolean; // True if this solution won the vote

  // Worker plan mode fields
  planMode?: boolean;                     // Enable plan-before-implement
  planPhase?: "planning" | "reviewing" | "implementing";
  workerPlan?: WorkerPlan;                // The approved plan
  planReview?: PlanReview;                // Auto-review result
  planAttempts?: number;                  // Re-plan counter
  approvalCriteria?: ApprovalCriteria;    // Per-feature criteria
  qualityScore?: QualityScore;            // Post-completion quality assessment

  // Ralph Loop fields
  ralphLoop?: boolean;                    // Using Ralph Loop execution
  ralphIteration?: number;                // Current Ralph Loop iteration
  ralphMaxIterations?: number;            // Max iterations configured
  ralphProgressFile?: string;             // Path to progress file
}

export interface WorkerStatus {
  sessionName: string;
  featureId: string;
  status: "running" | "completed" | "crashed" | "unknown";
  startedAt: string;
  lastChecked?: string;
}

export interface ConfidenceConfig {
  threshold: number; // 0-100, default 35
  autoAlert: boolean; // Log alerts to progressLog automatically
}

/**
 * ReviewFindings - Structured output from code or architecture review workers
 * Contains categorized issues with severity levels and actionable suggestions
 */
export interface ReviewFindings {
  summary: string;
  severity: "clean" | "minor" | "moderate" | "major" | "critical";
  issues: Array<{
    category: string;
    severity: "info" | "warning" | "error";
    file?: string;
    line?: number;
    message: string;
    suggestion?: string;
  }>;
  recommendations: string[];
}

/**
 * ReviewWorker - Tracks the state of a review worker (code or architecture)
 * Review workers run after all implementation workers complete
 */
export interface ReviewWorker {
  type: "code" | "architecture";
  workerId: string;
  sessionName: string;
  status: "running" | "completed" | "failed";
  startedAt: string;
  completedAt?: string;
  findings?: ReviewFindings;
}

/**
 * ReviewConfig - Configuration for automatic post-completion reviews
 * Controls whether and how reviews are triggered after swarm completion
 */
export interface ReviewConfig {
  enabled: boolean; // Whether auto-review is enabled
  skipOnFailure: boolean; // Skip review if any features failed
  codeReviewEnabled: boolean; // Enable code quality review
  architectureReviewEnabled: boolean; // Enable architecture review
  autoTrigger: boolean; // Automatically trigger reviews when all features complete (default: true)
}

/**
 * AggregatedReview - Combined results from all review workers
 * Created by the orchestrator after all review workers complete
 */
export interface AggregatedReview {
  completedAt: string;
  codeReview?: ReviewFindings;
  architectureReview?: ReviewFindings;
  overallAssessment: string;
}

/**
 * VerificationConfig - Commands workers must run before completing
 * These commands are injected into worker prompts to ensure code quality
 */
export interface VerificationConfig {
  commands: string[]; // Commands to run before completion (e.g., ['npm run build', 'npx tsc --noEmit'])
  failOnError: boolean; // Whether to fail the feature if verification fails
}

/**
 * PlanModeConfig - Global configuration for worker plan mode
 */
export interface PlanModeConfig {
  enabled: boolean;               // Global toggle (default: true)
  complexityThreshold: number;    // Min complexity score to trigger plan mode (default: 30)
  approvalCriteria: ApprovalCriteria;
  maxReplanAttempts: number;      // Max times to re-plan before fallback (default: 2)
}

/**
 * RalphLoopConfig - Global configuration for Ralph Loop execution
 */
export interface RalphLoopConfig {
  enabled: boolean;               // Global toggle (default: false)
  maxIterations: number;          // Max iterations per feature (default: 50)
  maxDurationMinutes: number;     // Max duration per feature (default: 480 = 8 hours)
  stopOnComplete: boolean;        // Stop when .done file detected (default: true)
  verifyBeforeStop: boolean;      // Run verification before stopping (default: true)
}

/**
 * Checkpoint - Periodic snapshot of session state for crash recovery
 */
export interface Checkpoint {
  id: string;                     // Timestamp-based
  reason: "periodic" | "feature_complete" | "crash_recovery" | "manual" | "shutdown";
  timestamp: string;
  state: OrchestratorState;       // Full state snapshot
  activeWorkers: WorkerCheckpoint[];
  gitHead: string;                // Git HEAD at checkpoint time
}

/**
 * WorkerCheckpoint - Snapshot of an active worker's state
 */
export interface WorkerCheckpoint {
  featureId: string;
  sessionName: string;
  tmuxAlive: boolean;
  lastProgress: string;           // Last line from progress file
  iteration: number;              // Ralph Loop iteration count
  phase: "planning" | "implementing";
}

/**
 * Heartbeat - Orchestrator liveness detection
 */
export interface Heartbeat {
  pid: number;
  lastBeat: string;
  sessionId: string;
  autoOrchestrateRunning: boolean;
}

/**
 * FailurePattern - Learned patterns from completed features
 */
export interface FailurePattern {
  featureType: string;
  commonErrors: string[];
  successfulApproaches: string[];
  iterations: number;
  planWasUseful: boolean;
}

export interface OrchestratorState {
  projectDir: string;
  taskDescription: string;
  features: Feature[];
  workers: WorkerStatus[];
  status:
    | "in_progress"
    | "reviewing"
    | "completed"
    | "completed_with_failures"
    | "paused";
  startTime: string;
  lastUpdated: string;
  completedAt?: string;
  progressLog: string[];

  // Confidence monitoring
  confidenceConfig?: ConfidenceConfig;
  confidenceAlerts?: ConfidenceAlert[];

  // Plan mode configuration
  planModeConfig?: PlanModeConfig;

  // Ralph Loop configuration
  ralphLoopConfig?: RalphLoopConfig;

  // Post-completion reviews
  reviewConfig?: ReviewConfig;
  reviewWorkers?: ReviewWorker[];
  aggregatedReview?: AggregatedReview;

  // Pre-completion verification
  verificationConfig?: VerificationConfig;
}

// Maximum number of log entries to keep (prevents unbounded growth)
const MAX_LOG_ENTRIES = 1000;

export class StateManager {
  public readonly projectDir: string;
  private stateFile: string;
  private progressFile: string;
  private initScriptFile: string;
  private featureListFile: string;

  constructor(projectDir: string) {
    this.projectDir = projectDir;

    // Ensure .claude directory exists
    const claudeDir = path.join(projectDir, ".claude", "orchestrator");
    if (!fs.existsSync(claudeDir)) {
      fs.mkdirSync(claudeDir, { recursive: true });
    }

    this.stateFile = path.join(claudeDir, "state.json");
    this.progressFile = path.join(projectDir, "claude-progress.txt");
    this.initScriptFile = path.join(projectDir, "init.sh");
    this.featureListFile = path.join(claudeDir, "feature_list.json");
  }

  /**
   * Load state from disk with validation
   */
  load(): OrchestratorState | null {
    if (!fs.existsSync(this.stateFile)) {
      return null;
    }

    try {
      const data = fs.readFileSync(this.stateFile, "utf-8");
      const parsed = JSON.parse(data);

      // Validate against schema
      const validated = OrchestratorStateSchema.parse(parsed);
      return validated as OrchestratorState;
    } catch (error) {
      // If validation fails, the file is corrupted or tampered with
      console.error("Error loading state (file may be corrupted):", error);
      throw new Error(
        "State file is corrupted or invalid. Use orchestrator_reset to start fresh."
      );
    }
  }

  /**
   * Save state to disk using atomic write
   */
  save(state: OrchestratorState): void {
    state.lastUpdated = new Date().toISOString();

    // Rotate log if too large
    if (state.progressLog.length > MAX_LOG_ENTRIES) {
      state.progressLog = state.progressLog.slice(-MAX_LOG_ENTRIES);
    }

    // Atomic write: write to temp file, then rename
    const tempFile = `${this.stateFile}.tmp.${Date.now()}`;
    try {
      fs.writeFileSync(tempFile, JSON.stringify(state, null, 2));
      fs.renameSync(tempFile, this.stateFile);
    } catch (error) {
      // Clean up temp file if rename failed
      try {
        fs.unlinkSync(tempFile);
      } catch {
        // Ignore cleanup errors
      }
      throw error;
    }

    this.writeFeatureList(state);
  }

  /**
   * Clear all state
   */
  clear(): void {
    const filesToRemove = [
      this.stateFile,
      this.progressFile,
      this.featureListFile,
    ];

    for (const file of filesToRemove) {
      if (fs.existsSync(file)) {
        try {
          fs.unlinkSync(file);
        } catch {
          // Ignore errors during cleanup
        }
      }
    }
  }

  /**
   * Write the human-readable progress file (notebook pattern)
   * This file is designed to be easily readable by Claude after compaction
   */
  writeProgressFile(): void {
    let state: OrchestratorState | null;
    try {
      state = this.load();
    } catch {
      return;
    }
    if (!state) return;

    const completed = state.features.filter((f) => f.status === "completed");
    const failed = state.features.filter((f) => f.status === "failed");
    const inProgress = state.features.filter((f) => f.status === "in_progress");
    const pending = state.features.filter((f) => f.status === "pending");

    let content = `# Claude Orchestrator Progress Log
# ===============================
# Project: ${sanitizeOutput(state.projectDir, 200)}
# Started: ${state.startTime}
# Last Updated: ${state.lastUpdated}
# Status: ${state.status}

## Summary
- Total Features: ${state.features.length}
- Completed: ${completed.length}
- In Progress: ${inProgress.length}
- Pending: ${pending.length}
- Failed: ${failed.length}

## Task Description
${sanitizeOutput(state.taskDescription, 2000)}

## Feature Status
`;

    for (const feature of state.features) {
      const statusIcon =
        feature.status === "completed"
          ? "✅"
          : feature.status === "failed"
            ? "❌"
            : feature.status === "in_progress"
              ? "🔄"
              : "⏳";
      content += `${statusIcon} [${feature.status.toUpperCase()}] ${feature.id}: ${sanitizeOutput(feature.description, 200)}\n`;
      if (feature.lastError) {
        content += `   Error: ${sanitizeOutput(feature.lastError, 200)}\n`;
      }
      if (feature.notes) {
        content += `   Notes: ${sanitizeOutput(feature.notes, 200)}\n`;
      }
    }

    content += `\n## Progress Log (last ${Math.min(state.progressLog.length, 100)} entries)\n`;
    const recentLogs = state.progressLog.slice(-100);
    for (const log of recentLogs) {
      content += `${sanitizeOutput(log, 500)}\n`;
    }

    // Atomic write for progress file too
    const tempFile = `${this.progressFile}.tmp.${Date.now()}`;
    try {
      fs.writeFileSync(tempFile, content);
      fs.renameSync(tempFile, this.progressFile);
    } catch (error) {
      try {
        fs.unlinkSync(tempFile);
      } catch {
        // Ignore cleanup errors
      }
      throw error;
    }
  }

  /**
   * Write the feature list JSON file (for structured access)
   */
  writeFeatureList(state: OrchestratorState): void {
    const featureList = {
      projectDir: state.projectDir,
      taskDescription: state.taskDescription,
      lastUpdated: state.lastUpdated,
      features: state.features.map((f) => ({
        id: f.id,
        description: f.description,
        status: f.status,
        passes: f.status === "completed",
      })),
    };

    // Atomic write
    const tempFile = `${this.featureListFile}.tmp.${Date.now()}`;
    try {
      fs.writeFileSync(tempFile, JSON.stringify(featureList, null, 2));
      fs.renameSync(tempFile, this.featureListFile);
    } catch (error) {
      try {
        fs.unlinkSync(tempFile);
      } catch {
        // Ignore cleanup errors
      }
      throw error;
    }
  }

  /**
   * Write init.sh script for environment setup
   * Following Anthropic's pattern from "Effective harnesses for long-running agents"
   * Security: Uses shell quoting to prevent injection
   */
  writeInitScript(): void {
    let state: OrchestratorState | null;
    try {
      state = this.load();
    } catch {
      return;
    }
    if (!state) return;

    // Use shell quoting for the project directory
    const quotedProjectDir = shellQuote(state.projectDir);

    const script = `#!/bin/bash
# Claude Orchestrator - Init Script
# Generated: ${new Date().toISOString()}
#
# This script sets up the environment for the orchestration session.
# Run this at the start of each session to ensure proper setup.

set -e

echo "🚀 Initializing Claude Orchestrator environment..."

# Navigate to project (safely quoted)
cd ${quotedProjectDir}

# Check git status
if git rev-parse --git-dir > /dev/null 2>&1; then
    echo "📦 Git repository detected"
    git status --short
else
    echo "⚠️  Not a git repository"
fi

# Check for common project files and run setup if found
if [ -f "package.json" ]; then
    echo "📦 Node.js project detected"
    if [ ! -d "node_modules" ]; then
        echo "   Installing dependencies..."
        npm install
    fi
fi

if [ -f "requirements.txt" ]; then
    echo "🐍 Python project detected"
    if [ -d "venv" ]; then
        source venv/bin/activate
    fi
fi

if [ -f "Cargo.toml" ]; then
    echo "🦀 Rust project detected"
fi

if [ -f "go.mod" ]; then
    echo "🐹 Go project detected"
fi

# Show orchestrator status
echo ""
echo "📊 Orchestrator Status:"
if [ -f ".claude/orchestrator/state.json" ]; then
    head -20 .claude/orchestrator/state.json
else
    echo "   No active session"
fi

echo ""
echo "✅ Environment ready!"
echo "   Use 'orchestrator_status' to check current progress"
`;

    fs.writeFileSync(this.initScriptFile, script, { mode: 0o700 }); // Owner-only execution
  }

  /**
   * Append to progress log
   */
  appendLog(message: string): void {
    let state: OrchestratorState | null;
    try {
      state = this.load();
    } catch {
      return;
    }
    if (state) {
      state.progressLog.push(`[${new Date().toISOString()}] ${message}`);
      this.save(state);
      this.writeProgressFile();
    }
  }

  // ============================================================================
  // Checkpointing (Phase 3)
  // ============================================================================

  private get checkpointDir(): string {
    return path.join(this.projectDir, ".claude", "orchestrator", "checkpoints");
  }

  private get heartbeatFile(): string {
    return path.join(this.projectDir, ".claude", "orchestrator", "heartbeat.json");
  }

  private get learningsFile(): string {
    return path.join(this.projectDir, ".claude", "orchestrator", "learnings.json");
  }

  /**
   * Create a checkpoint of the current session state
   */
  async checkpoint(
    reason: Checkpoint["reason"],
    activeWorkers: WorkerCheckpoint[] = []
  ): Promise<string> {
    const state = this.load();
    if (!state) throw new Error("No state to checkpoint");

    // Get git HEAD
    let gitHead = "unknown";
    try {
      const { execFileSync } = await import("child_process");
      gitHead = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: this.projectDir,
        encoding: "utf-8",
      }).trim();
    } catch {
      // Not a git repo or git not available
    }

    const id = new Date().toISOString().replace(/[:.]/g, "-");
    const checkpoint: Checkpoint = {
      id,
      reason,
      timestamp: new Date().toISOString(),
      state,
      activeWorkers,
      gitHead,
    };

    // Ensure checkpoint directory exists
    if (!fs.existsSync(this.checkpointDir)) {
      fs.mkdirSync(this.checkpointDir, { recursive: true });
    }

    // Write checkpoint atomically
    const checkpointFile = path.join(this.checkpointDir, `${id}.json`);
    const tempFile = `${checkpointFile}.tmp.${Date.now()}`;
    try {
      fs.writeFileSync(tempFile, JSON.stringify(checkpoint, null, 2));
      fs.renameSync(tempFile, checkpointFile);
    } catch (error) {
      try { fs.unlinkSync(tempFile); } catch { /* ignore */ }
      throw error;
    }

    // Rotate: keep last 10 checkpoints
    this.rotateCheckpoints(10);

    return id;
  }

  /**
   * Load the most recent checkpoint
   */
  loadLatestCheckpoint(): Checkpoint | null {
    if (!fs.existsSync(this.checkpointDir)) return null;

    const files = fs.readdirSync(this.checkpointDir)
      .filter(f => f.endsWith(".json"))
      .sort()
      .reverse();

    if (files.length === 0) return null;

    try {
      const content = fs.readFileSync(
        path.join(this.checkpointDir, files[0]),
        "utf-8"
      );
      return JSON.parse(content) as Checkpoint;
    } catch {
      return null;
    }
  }

  /**
   * Load a specific checkpoint by ID
   */
  loadCheckpoint(id: string): Checkpoint | null {
    const file = path.join(this.checkpointDir, `${id}.json`);
    if (!fs.existsSync(file)) return null;

    try {
      const content = fs.readFileSync(file, "utf-8");
      return JSON.parse(content) as Checkpoint;
    } catch {
      return null;
    }
  }

  /**
   * List available checkpoints
   */
  listCheckpoints(): Array<{ id: string; reason: string; timestamp: string }> {
    if (!fs.existsSync(this.checkpointDir)) return [];

    return fs.readdirSync(this.checkpointDir)
      .filter(f => f.endsWith(".json"))
      .sort()
      .reverse()
      .map(f => {
        try {
          const content = fs.readFileSync(
            path.join(this.checkpointDir, f),
            "utf-8"
          );
          const cp = JSON.parse(content) as Checkpoint;
          return { id: cp.id, reason: cp.reason, timestamp: cp.timestamp };
        } catch {
          return null;
        }
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);
  }

  /**
   * Rotate checkpoints, keeping only the most recent N
   */
  private rotateCheckpoints(keep: number): void {
    if (!fs.existsSync(this.checkpointDir)) return;

    const files = fs.readdirSync(this.checkpointDir)
      .filter(f => f.endsWith(".json"))
      .sort();

    if (files.length <= keep) return;

    const toDelete = files.slice(0, files.length - keep);
    for (const file of toDelete) {
      try {
        fs.unlinkSync(path.join(this.checkpointDir, file));
      } catch {
        // Ignore deletion errors
      }
    }
  }

  // ============================================================================
  // Heartbeat (Phase 3)
  // ============================================================================

  /**
   * Write a heartbeat file to indicate the orchestrator is alive
   */
  writeHeartbeat(sessionId: string, autoOrchestrateRunning: boolean): void {
    const heartbeat: Heartbeat = {
      pid: process.pid,
      lastBeat: new Date().toISOString(),
      sessionId,
      autoOrchestrateRunning,
    };

    const tempFile = `${this.heartbeatFile}.tmp.${Date.now()}`;
    try {
      fs.writeFileSync(tempFile, JSON.stringify(heartbeat, null, 2));
      fs.renameSync(tempFile, this.heartbeatFile);
    } catch (error) {
      try { fs.unlinkSync(tempFile); } catch { /* ignore */ }
      // Non-fatal - heartbeat is best-effort
    }
  }

  /**
   * Read the current heartbeat
   */
  readHeartbeat(): Heartbeat | null {
    if (!fs.existsSync(this.heartbeatFile)) return null;

    try {
      const content = fs.readFileSync(this.heartbeatFile, "utf-8");
      return JSON.parse(content) as Heartbeat;
    } catch {
      return null;
    }
  }

  /**
   * Check if a previous orchestrator session crashed
   * Returns true if heartbeat is stale (> 2 minutes) and PID is dead
   */
  detectCrash(): { crashed: boolean; heartbeat: Heartbeat | null; checkpoint: Checkpoint | null } {
    const heartbeat = this.readHeartbeat();
    const checkpoint = this.loadLatestCheckpoint();

    if (!heartbeat) {
      // No heartbeat file - check if there's a non-completed state with checkpoint
      const state = this.load();
      if (state && checkpoint && state.status !== "completed" && state.status !== "completed_with_failures") {
        return { crashed: true, heartbeat: null, checkpoint };
      }
      return { crashed: false, heartbeat: null, checkpoint: null };
    }

    // Check if heartbeat is stale (> 2 minutes old)
    const lastBeat = new Date(heartbeat.lastBeat);
    const staleMs = 2 * 60 * 1000;
    const isStale = (Date.now() - lastBeat.getTime()) > staleMs;

    if (!isStale) {
      return { crashed: false, heartbeat, checkpoint: null };
    }

    // Heartbeat is stale - check if PID is still alive
    let pidAlive = false;
    try {
      process.kill(heartbeat.pid, 0); // Signal 0 = just check existence
      pidAlive = true;
    } catch {
      pidAlive = false;
    }

    if (pidAlive) {
      return { crashed: false, heartbeat, checkpoint: null };
    }

    // Stale heartbeat + dead PID = crash
    return { crashed: true, heartbeat, checkpoint };
  }

  /**
   * Remove heartbeat file (on clean shutdown)
   */
  removeHeartbeat(): void {
    if (fs.existsSync(this.heartbeatFile)) {
      try {
        fs.unlinkSync(this.heartbeatFile);
      } catch {
        // Ignore
      }
    }
  }

  // ============================================================================
  // Failure Pattern Learning (Phase 4)
  // ============================================================================

  /**
   * Record a failure pattern from a completed feature
   */
  recordLearning(pattern: FailurePattern): void {
    const patterns = this.loadLearnings();
    patterns.push(pattern);

    // Keep last 100 patterns
    const trimmed = patterns.slice(-100);

    const tempFile = `${this.learningsFile}.tmp.${Date.now()}`;
    try {
      fs.writeFileSync(tempFile, JSON.stringify({ patterns: trimmed }, null, 2));
      fs.renameSync(tempFile, this.learningsFile);
    } catch (error) {
      try { fs.unlinkSync(tempFile); } catch { /* ignore */ }
    }
  }

  /**
   * Load failure patterns
   */
  loadLearnings(): FailurePattern[] {
    if (!fs.existsSync(this.learningsFile)) return [];

    try {
      const content = fs.readFileSync(this.learningsFile, "utf-8");
      const data = JSON.parse(content);
      return data.patterns || [];
    } catch {
      return [];
    }
  }

  /**
   * Find relevant learnings for a feature description
   */
  findRelevantLearnings(description: string, maxResults: number = 3): FailurePattern[] {
    const patterns = this.loadLearnings();
    if (patterns.length === 0) return [];

    // Simple keyword matching - find patterns with overlapping terms
    const descWords = new Set(
      description.toLowerCase().split(/\W+/).filter(w => w.length > 3)
    );

    return patterns
      .map(p => {
        const typeWords = new Set(
          p.featureType.toLowerCase().split(/\W+/).filter(w => w.length > 3)
        );
        const overlap = [...descWords].filter(w => typeWords.has(w)).length;
        return { pattern: p, score: overlap };
      })
      .filter(x => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, maxResults)
      .map(x => x.pattern);
  }
}
