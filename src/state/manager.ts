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

  votingRole?: `voter-${number}`; // Which voter in the group
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

export interface OrchestratorState {
  projectDir: string;
  taskDescription: string;
  features: Feature[];
  workers: WorkerStatus[];
  status: "in_progress" | "completed" | "completed_with_failures" | "paused";
  startTime: string;
  lastUpdated: string;
  completedAt?: string;
  progressLog: string[];

  // Confidence monitoring
  confidenceConfig?: ConfidenceConfig;
  confidenceAlerts?: ConfidenceAlert[];
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
}
