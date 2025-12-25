/**
 * Enforcement Integration - Connects WorkerManager with Protocol Enforcement Engine
 *
 * This module provides the bridge between worker lifecycle events and protocol
 * enforcement. It:
 * - Validates worker actions against active protocols before execution
 * - Monitors worker activity and records actions for continuous monitoring
 * - Provides alerts when workers violate constraints or exhibit concerning patterns
 *
 * Key integration points:
 * - Pre-spawn validation: Check if a worker can be started for a feature
 * - Activity monitoring: Record tool usage and file access during checks
 * - Alert generation: Surface enforcement alerts to the orchestrator
 */

import type { Feature } from "../state/manager.js";
import type { ProtocolRegistry } from "../protocols/registry.js";
import { ProtocolResolver } from "../protocols/resolver.js";
import {
  EnforcementEngine,
  type ExecutionContext,
  type EnforcementResult,
  type MonitoringState,
  type MonitoringAlert,
} from "../protocols/enforcement.js";

// ============================================================================
// Types
// ============================================================================

/**
 * Result of pre-spawn validation
 */
export interface PreSpawnValidationResult {
  allowed: boolean;
  violations: Array<{
    protocolId: string;
    protocolName: string;
    constraintId: string;
    severity: "error" | "warning" | "info";
    message: string;
    remediation?: string;
  }>;
  warnings: Array<{
    protocolId: string;
    constraintId: string;
    message: string;
  }>;
  appliedProtocols: string[];
  evaluationTimeMs: number;
}

/**
 * Result of monitoring a worker's activity
 */
export interface MonitoringResult {
  hasActiveProtocols: boolean;
  alerts: MonitoringAlert[];
  patterns: Array<{
    type: string;
    frequency: number;
    examples: string[];
  }>;
  stats: {
    iterationCount: number;
    warningCount: number;
    toolsUsed: string[];
    filesAccessed: string[];
  };
}

/**
 * Parsed activity from worker output
 */
export interface ParsedWorkerActivity {
  toolUsage: Array<{ tool: string; timestamp: number }>;
  fileAccess: Array<{ file: string; action: "read" | "write" | "edit"; timestamp: number }>;
  shellCommands: Array<{ command: string; timestamp: number }>;
  gitOperations: Array<{ operation: string; timestamp: number }>;
}

// ============================================================================
// EnforcementIntegration Class
// ============================================================================

/**
 * EnforcementIntegration - Bridges WorkerManager with EnforcementEngine
 */
export class EnforcementIntegration {
  private readonly projectDir: string;
  private readonly registry: ProtocolRegistry;
  private readonly resolver: ProtocolResolver;
  private readonly engine: EnforcementEngine;

  constructor(projectDir: string, registry: ProtocolRegistry) {
    this.projectDir = projectDir;
    this.registry = registry;
    this.resolver = new ProtocolResolver();
    this.engine = new EnforcementEngine(registry, this.resolver);
  }

  // ==========================================================================
  // Pre-Spawn Validation
  // ==========================================================================

  /**
   * Validate whether a worker can be spawned for a feature
   *
   * Checks active protocols for constraints that might prevent worker creation:
   * - Feature pattern restrictions
   * - Resource limits
   * - Temporal constraints (time windows)
   * - Required dependencies
   *
   * @param feature - The feature the worker will implement
   * @param customPrompt - Optional custom prompt for additional context
   * @returns Validation result indicating if spawn is allowed
   */
  validatePreSpawn(feature: Feature, customPrompt?: string): PreSpawnValidationResult {
    const context: ExecutionContext = {
      featureId: feature.id,
      projectDir: this.projectDir,
      actionType: "tool_call",
      actionName: "spawn_worker",
      actionParams: {
        featureDescription: feature.description,
        customPrompt,
        attempt: feature.attempts + 1,
      },
      timestamp: new Date().toISOString(),
    };

    const result = this.engine.validatePreExecution(context);

    return {
      allowed: result.allowed,
      violations: result.violations.map((v) => ({
        protocolId: v.protocolId,
        protocolName: v.protocolName,
        constraintId: v.constraintId,
        severity: v.severity,
        message: v.message,
        remediation: v.remediation,
      })),
      warnings: result.warnings,
      appliedProtocols: result.appliedProtocols,
      evaluationTimeMs: result.evaluationTimeMs,
    };
  }

  // ==========================================================================
  // Monitoring Integration
  // ==========================================================================

  /**
   * Start monitoring a worker session
   *
   * Initializes tracking for:
   * - Tool usage patterns
   * - File access sequences
   * - Rate limiting counters
   * - Behavioral patterns
   *
   * @param featureId - ID of the feature being implemented
   * @param workerId - Session name of the worker
   */
  startMonitoring(featureId: string, workerId: string): void {
    this.engine.startMonitoring(featureId, workerId);
  }

  /**
   * Stop monitoring a worker session
   *
   * Returns the final monitoring state for analysis
   *
   * @param workerId - Session name of the worker
   * @returns Final monitoring state, if available
   */
  stopMonitoring(workerId: string): MonitoringState | undefined {
    return this.engine.stopMonitoring(workerId);
  }

  /**
   * Record activity from worker output for monitoring
   *
   * Parses worker output to extract tool usage and file access patterns,
   * then records them with the enforcement engine for constraint checking.
   *
   * @param workerId - Session name of the worker
   * @param featureId - ID of the feature being implemented
   * @param output - Raw output from the worker
   * @param sequenceNumber - Optional sequence number for ordering
   */
  recordActivity(
    workerId: string,
    featureId: string,
    output: string,
    sequenceNumber?: number
  ): void {
    const parsed = this.parseWorkerOutput(output);

    // Record each activity as an action
    for (const usage of parsed.toolUsage) {
      this.engine.recordAction({
        featureId,
        workerId,
        projectDir: this.projectDir,
        actionType: "tool_call",
        actionName: usage.tool,
        timestamp: new Date(usage.timestamp).toISOString(),
        sequenceNumber,
      });
    }

    for (const access of parsed.fileAccess) {
      this.engine.recordAction({
        featureId,
        workerId,
        projectDir: this.projectDir,
        actionType: "file_operation",
        actionName: access.action,
        targetFiles: [access.file],
        timestamp: new Date(access.timestamp).toISOString(),
        sequenceNumber,
      });
    }

    for (const cmd of parsed.shellCommands) {
      this.engine.recordAction({
        featureId,
        workerId,
        projectDir: this.projectDir,
        actionType: "shell_command",
        actionName: "bash",
        command: cmd.command,
        timestamp: new Date(cmd.timestamp).toISOString(),
        sequenceNumber,
      });
    }

    for (const op of parsed.gitOperations) {
      this.engine.recordAction({
        featureId,
        workerId,
        projectDir: this.projectDir,
        actionType: "git_operation",
        actionName: "git",
        gitOperation: op.operation,
        timestamp: new Date(op.timestamp).toISOString(),
        sequenceNumber,
      });
    }
  }

  /**
   * Check for alerts on a monitored worker
   *
   * @param workerId - Session name of the worker
   * @returns Array of active alerts
   */
  checkAlerts(workerId: string): MonitoringAlert[] {
    return this.engine.checkMonitoringAlerts(workerId);
  }

  /**
   * Get monitoring result for a worker
   *
   * Provides a summary of monitoring state and any alerts
   *
   * @param workerId - Session name of the worker
   * @returns Monitoring result with stats and alerts
   */
  getMonitoringResult(workerId: string): MonitoringResult {
    const state = this.engine.getMonitoringState(workerId);
    const activeProtocols = this.registry.getActiveProtocols();

    if (!state) {
      return {
        hasActiveProtocols: activeProtocols.length > 0,
        alerts: [],
        patterns: [],
        stats: {
          iterationCount: 0,
          warningCount: 0,
          toolsUsed: [],
          filesAccessed: [],
        },
      };
    }

    return {
      hasActiveProtocols: activeProtocols.length > 0,
      alerts: state.activeAlerts.filter((a) => !a.acknowledged),
      patterns: state.observedPatterns.map((p) => ({
        type: p.type,
        frequency: p.frequency,
        examples: p.examples,
      })),
      stats: {
        iterationCount: state.iterationCount,
        warningCount: state.warningCount,
        toolsUsed: [...new Set(state.toolUsageSequence)],
        filesAccessed: [...new Set(state.fileAccessSequence)],
      },
    };
  }

  /**
   * Acknowledge an alert
   *
   * @param workerId - Session name of the worker
   * @param alertId - ID of the alert to acknowledge
   * @returns Whether the alert was found and acknowledged
   */
  acknowledgeAlert(workerId: string, alertId: string): boolean {
    return this.engine.acknowledgeAlert(workerId, alertId);
  }

  // ==========================================================================
  // Tool Call Validation
  // ==========================================================================

  /**
   * Validate a specific tool call before execution
   *
   * This can be used for real-time validation if the worker supports it
   *
   * @param workerId - Session name of the worker
   * @param featureId - ID of the feature
   * @param toolName - Name of the tool being called
   * @param params - Parameters for the tool
   * @returns Enforcement result
   */
  validateToolCall(
    workerId: string,
    featureId: string,
    toolName: string,
    params?: Record<string, unknown>
  ): EnforcementResult {
    const context: ExecutionContext = {
      featureId,
      workerId,
      projectDir: this.projectDir,
      actionType: "tool_call",
      actionName: toolName,
      actionParams: params,
      timestamp: new Date().toISOString(),
    };

    // Extract file targets from params if present
    if (params) {
      const files: string[] = [];
      if (typeof params.file_path === "string") files.push(params.file_path);
      if (typeof params.path === "string") files.push(params.path);
      if (Array.isArray(params.files)) {
        files.push(...params.files.filter((f): f is string => typeof f === "string"));
      }
      if (files.length > 0) {
        context.targetFiles = files;
      }

      // Extract command for Bash tool
      if (toolName.toLowerCase() === "bash" && typeof params.command === "string") {
        context.actionType = "shell_command";
        context.command = params.command;
      }
    }

    return this.engine.validatePreExecution(context);
  }

  /**
   * Validate file access before execution
   *
   * @param workerId - Session name of the worker
   * @param featureId - ID of the feature
   * @param files - Files being accessed
   * @param action - Type of access (read, write, edit)
   * @returns Enforcement result
   */
  validateFileAccess(
    workerId: string,
    featureId: string,
    files: string[],
    action: "read" | "write" | "edit"
  ): EnforcementResult {
    const context: ExecutionContext = {
      featureId,
      workerId,
      projectDir: this.projectDir,
      actionType: "file_operation",
      actionName: action,
      targetFiles: files,
      timestamp: new Date().toISOString(),
    };

    return this.engine.validatePreExecution(context);
  }

  // ==========================================================================
  // Output Parsing
  // ==========================================================================

  /**
   * Parse worker output to extract activity information
   *
   * Detects patterns for:
   * - Tool usage (Read, Write, Edit, Bash, Glob, Grep)
   * - File access patterns
   * - Shell command execution
   * - Git operations
   *
   * @param output - Raw output from worker
   * @returns Parsed activity data
   */
  private parseWorkerOutput(output: string): ParsedWorkerActivity {
    const now = Date.now();
    const activity: ParsedWorkerActivity = {
      toolUsage: [],
      fileAccess: [],
      shellCommands: [],
      gitOperations: [],
    };

    const lines = output.split("\n");

    for (const line of lines) {
      // Detect tool usage patterns
      const toolMatch = line.match(
        /\b(Read|Write|Edit|Bash|Glob|Grep|WebFetch|WebSearch)\b/i
      );
      if (toolMatch) {
        activity.toolUsage.push({
          tool: toolMatch[1],
          timestamp: now,
        });
      }

      // Detect file access patterns
      const fileReadMatch = line.match(
        /(?:Reading|read|Read tool).*?([\/\w\-\.]+\.(ts|js|tsx|jsx|json|md|py|rs|go|css|scss|html))/i
      );
      if (fileReadMatch) {
        activity.fileAccess.push({
          file: fileReadMatch[1],
          action: "read",
          timestamp: now,
        });
      }

      const fileWriteMatch = line.match(
        /(?:Writing|write|Write tool|Created|created).*?([\/\w\-\.]+\.(ts|js|tsx|jsx|json|md|py|rs|go|css|scss|html))/i
      );
      if (fileWriteMatch) {
        activity.fileAccess.push({
          file: fileWriteMatch[1],
          action: "write",
          timestamp: now,
        });
      }

      const fileEditMatch = line.match(
        /(?:Editing|edit|Edit tool|Modified|modified).*?([\/\w\-\.]+\.(ts|js|tsx|jsx|json|md|py|rs|go|css|scss|html))/i
      );
      if (fileEditMatch) {
        activity.fileAccess.push({
          file: fileEditMatch[1],
          action: "edit",
          timestamp: now,
        });
      }

      // Detect shell commands
      const bashMatch = line.match(/(?:Bash|Running|Executing):\s*(.+)/i);
      if (bashMatch) {
        activity.shellCommands.push({
          command: bashMatch[1].trim(),
          timestamp: now,
        });
      }

      // Detect git operations
      const gitMatch = line.match(
        /\bgit\s+(status|add|commit|push|pull|checkout|branch|merge|rebase|diff|log|stash)\b/i
      );
      if (gitMatch) {
        activity.gitOperations.push({
          operation: gitMatch[1].toLowerCase(),
          timestamp: now,
        });
      }
    }

    return activity;
  }

  // ==========================================================================
  // Utility Methods
  // ==========================================================================

  /**
   * Check if there are any active protocols
   *
   * @returns Whether any protocols are active
   */
  hasActiveProtocols(): boolean {
    return this.registry.getActiveProtocols().length > 0;
  }

  /**
   * Get enforcement statistics
   *
   * @returns Stats about enforcement activity
   */
  getStats(): {
    activeMonitoringSessions: number;
    totalViolationsRecorded: number;
    unresolvedViolations: number;
    activeProtocolCount: number;
  } {
    const engineStats = this.engine.getStats();
    return {
      ...engineStats,
      activeProtocolCount: this.registry.getActiveProtocols().length,
    };
  }

  /**
   * Clear monitoring state (for testing or reset)
   */
  clearMonitoringState(): void {
    this.engine.clearMonitoringState();
  }

  /**
   * Clear resolver cache (call when protocols are modified)
   */
  clearResolverCache(): void {
    this.resolver.clearCache();
  }
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create an EnforcementIntegration instance and wire it to a WorkerManager
 *
 * This is a convenience function that creates the integration and sets it
 * on the worker manager in one step.
 *
 * @param projectDir - Project directory
 * @param registry - Protocol registry
 * @param workerManager - Worker manager to integrate with
 * @returns The created EnforcementIntegration instance
 */
export function createEnforcementIntegration(
  projectDir: string,
  registry: ProtocolRegistry,
  workerManager: { setEnforcement(e: EnforcementIntegration): void }
): EnforcementIntegration {
  const integration = new EnforcementIntegration(projectDir, registry);
  workerManager.setEnforcement(integration);
  return integration;
}
