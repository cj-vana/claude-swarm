/**
 * Protocol Enforcement Engine - Pre/post execution validation and continuous monitoring
 *
 * This module implements the enforcement layer for the Protocol-Based Behavioral Governance
 * system. It validates worker actions against active protocols before execution, monitors
 * behavior during execution, and verifies outcomes after execution.
 *
 * Key features:
 * - Pre-execution validation: Check actions against constraints before they happen
 * - Continuous monitoring: Track patterns, rate limits, and behavioral signals
 * - Post-execution verification: Validate outcomes and side effects
 * - Violation recording and escalation
 * - Learning mode for protocol development
 */

import { z } from "zod";
import type {
  Protocol,
  ProtocolConstraint,
  ConstraintRule,
  ConstraintSeverity,
  EnforcementConfig,
  ToolRestrictionRule,
  FileAccessRule,
  OutputFormatRule,
  BehavioralRule,
  TemporalRule,
  ResourceRule,
  SideEffectRule,
  ProtocolValidationResult,
} from "./schema.js";
import { ProtocolValidationResultSchema } from "./schema.js";
import type { ProtocolRegistry, ProtocolViolation } from "./registry.js";
import type { ProtocolResolver, EffectiveConstraints } from "./resolver.js";
import { isDangerousRegexPattern, safeRegexTest } from "../utils/security.js";

// ============================================================================
// Execution Context Types
// ============================================================================

/**
 * Context for an action being validated
 */
export interface ExecutionContext {
  // Identity
  featureId?: string;
  workerId?: string;
  projectDir?: string;

  // Action details
  actionType: "tool_call" | "file_operation" | "output" | "network" | "shell_command" | "git_operation";
  actionName: string;
  actionParams?: Record<string, unknown>;

  // File context
  targetFiles?: string[];
  sourceFiles?: string[];

  // Output context
  outputContent?: string;
  outputFormat?: string;

  // Network context
  targetHost?: string;
  requestMethod?: string;

  // Shell context
  command?: string;
  commandArgs?: string[];

  // Git context
  gitOperation?: string;
  gitBranch?: string;

  // Timing
  timestamp: string;
  sequenceNumber?: number;
}

/**
 * Result of validating an action
 */
export interface EnforcementResult {
  allowed: boolean;
  violations: ViolationDetail[];
  warnings: WarningDetail[];
  appliedProtocols: string[];
  evaluationTimeMs: number;
  shouldBlock: boolean;
  suggestedAction?: "proceed" | "retry" | "abort" | "escalate";
}

/**
 * Details of a constraint violation
 */
export interface ViolationDetail {
  protocolId: string;
  protocolName: string;
  constraintId: string;
  constraintType: string;
  severity: ConstraintSeverity;
  message: string;
  context: Record<string, unknown>;
  remediation?: string;
}

/**
 * Details of a warning (non-blocking violation)
 */
export interface WarningDetail {
  protocolId: string;
  constraintId: string;
  message: string;
  context?: Record<string, unknown>;
}

// ============================================================================
// Monitoring State Types
// ============================================================================

/**
 * State tracked during continuous monitoring
 */
export interface MonitoringState {
  featureId: string;
  workerId: string;
  startedAt: string;

  // Rate limiting
  operationCounts: Map<string, number[]>; // operation type -> timestamps

  // Behavioral tracking
  iterationCount: number;
  toolUsageSequence: string[];
  fileAccessSequence: string[];

  // Alerts and warnings
  activeAlerts: MonitoringAlert[];
  warningCount: number;

  // Learning mode data
  observedPatterns: ObservedPattern[];
}

/**
 * An alert raised during monitoring
 */
export interface MonitoringAlert {
  id: string;
  type: "rate_limit" | "behavioral" | "resource" | "timeout" | "pattern";
  severity: ConstraintSeverity;
  message: string;
  timestamp: string;
  constraintId?: string;
  acknowledged: boolean;
}

/**
 * Pattern observed during learning mode
 */
export interface ObservedPattern {
  type: string;
  frequency: number;
  examples: string[];
  firstSeen: string;
  lastSeen: string;
}

// ============================================================================
// Zod Schemas
// ============================================================================

export const ExecutionContextSchema = z.object({
  featureId: z.string().optional(),
  workerId: z.string().optional(),
  projectDir: z.string().optional(),
  actionType: z.enum(["tool_call", "file_operation", "output", "network", "shell_command", "git_operation"]),
  actionName: z.string(),
  actionParams: z.record(z.unknown()).optional(),
  targetFiles: z.array(z.string()).optional(),
  sourceFiles: z.array(z.string()).optional(),
  outputContent: z.string().optional(),
  outputFormat: z.string().optional(),
  targetHost: z.string().optional(),
  requestMethod: z.string().optional(),
  command: z.string().optional(),
  commandArgs: z.array(z.string()).optional(),
  gitOperation: z.string().optional(),
  gitBranch: z.string().optional(),
  timestamp: z.string(),
  sequenceNumber: z.number().optional(),
});

export const ViolationDetailSchema = z.object({
  protocolId: z.string(),
  protocolName: z.string(),
  constraintId: z.string(),
  constraintType: z.string(),
  severity: z.enum(["error", "warning", "info"]),
  message: z.string(),
  context: z.record(z.unknown()),
  remediation: z.string().optional(),
});

export const EnforcementResultSchema = z.object({
  allowed: z.boolean(),
  violations: z.array(ViolationDetailSchema),
  warnings: z.array(z.object({
    protocolId: z.string(),
    constraintId: z.string(),
    message: z.string(),
    context: z.record(z.unknown()).optional(),
  })),
  appliedProtocols: z.array(z.string()),
  evaluationTimeMs: z.number(),
  shouldBlock: z.boolean(),
  suggestedAction: z.enum(["proceed", "retry", "abort", "escalate"]).optional(),
});

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Generate a unique ID for alerts
 */
function generateAlertId(): string {
  return `alert-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * Check if a path matches a glob-like pattern
 * Supports * (single segment) and ** (multiple segments)
 * Protected against ReDoS attacks using isDangerousRegexPattern
 */
function pathMatchesPattern(path: string, pattern: string): boolean {
  // Normalize paths
  const normalizedPath = path.replace(/\\/g, "/");
  const normalizedPattern = pattern.replace(/\\/g, "/");

  // Convert glob to regex
  const regexPattern = normalizedPattern
    .replace(/\*\*/g, "§§") // Temporarily replace **
    .replace(/\*/g, "[^/]*") // Single segment wildcard
    .replace(/§§/g, ".*") // Multi-segment wildcard
    .replace(/\?/g, "[^/]") // Single character
    .replace(/\./g, "\\."); // Escape dots

  const fullPattern = `^${regexPattern}$`;

  // Check for dangerous patterns before creating RegExp (ReDoS protection)
  if (isDangerousRegexPattern(fullPattern)) {
    // Fall back to literal matching
    return normalizedPath.toLowerCase().includes(normalizedPattern.toLowerCase());
  }

  try {
    const regex = new RegExp(fullPattern);
    return regex.test(normalizedPath);
  } catch {
    // If pattern is invalid, do exact match
    return normalizedPath === normalizedPattern;
  }
}

/**
 * Check if a string matches any pattern in a list
 * Protected against ReDoS attacks using safeRegexTest from security.ts
 */
function matchesAnyPattern(value: string, patterns: string[]): boolean {
  return patterns.some(pattern => safeRegexTest(pattern, value));
}

// ============================================================================
// EnforcementEngine Class
// ============================================================================

/**
 * EnforcementEngine - Core enforcement logic for protocol governance
 */
export class EnforcementEngine {
  private registry: ProtocolRegistry;
  private resolver: ProtocolResolver;

  // Monitoring state per worker
  private monitoringStates: Map<string, MonitoringState> = new Map();

  // Configuration
  private defaultEnforcement: EnforcementConfig = {
    mode: "strict",
    preExecutionValidation: true,
    postExecutionValidation: true,
    onViolation: "block",
    maxRetries: 0,
    retryDelaySeconds: 0,
    logLevel: "standard",
    includeContext: true,
    allowOverride: false,
    overrideRequiresApproval: true,
  };

  constructor(registry: ProtocolRegistry, resolver: ProtocolResolver) {
    this.registry = registry;
    this.resolver = resolver;
  }

  // ==========================================================================
  // Pre-Execution Validation
  // ==========================================================================

  /**
   * Validate an action before execution
   * Returns whether the action should be allowed and any violations
   */
  validatePreExecution(context: ExecutionContext): EnforcementResult {
    const startTime = Date.now();
    const violations: ViolationDetail[] = [];
    const warnings: WarningDetail[] = [];
    const appliedProtocols: string[] = [];

    // Get active protocols sorted by priority
    const activeProtocols = this.registry.getActiveProtocols();

    for (const protocol of activeProtocols) {
      // Skip if pre-execution validation is disabled for this protocol
      if (!protocol.enforcement.preExecutionValidation) {
        continue;
      }

      // Check if protocol applies to this context
      if (!this.protocolApplies(protocol, context)) {
        continue;
      }

      appliedProtocols.push(protocol.id);

      // Get effective constraints (including inherited)
      const effective = this.resolver.getEffectiveConstraints(protocol.id, this.registry);

      // Evaluate each constraint
      for (const constraint of effective.constraints) {
        if (!constraint.enabled) continue;

        const result = this.evaluateConstraint(constraint, context);

        if (!result.passed) {
          if (constraint.severity === "error") {
            violations.push({
              protocolId: protocol.id,
              protocolName: protocol.name,
              constraintId: constraint.id,
              constraintType: constraint.type,
              severity: constraint.severity,
              message: result.message || constraint.message,
              context: result.context || {},
              remediation: result.remediation,
            });
          } else {
            warnings.push({
              protocolId: protocol.id,
              constraintId: constraint.id,
              message: result.message || constraint.message,
              context: result.context,
            });
          }
        }
      }
    }

    // Determine if we should block
    const shouldBlock = this.shouldBlockExecution(violations, activeProtocols);
    const allowed = !shouldBlock;

    // Determine suggested action
    let suggestedAction: EnforcementResult["suggestedAction"];
    if (violations.length === 0) {
      suggestedAction = "proceed";
    } else if (shouldBlock) {
      suggestedAction = violations.some(v => v.severity === "error") ? "abort" : "retry";
    } else {
      suggestedAction = "proceed";
    }

    // Record violations in registry
    for (const violation of violations) {
      this.registry.recordViolation({
        protocolId: violation.protocolId,
        constraintId: violation.constraintId,
        featureId: context.featureId,
        workerId: context.workerId,
        severity: violation.severity,
        message: violation.message,
        context: violation.context,
      });
    }

    return {
      allowed,
      violations,
      warnings,
      appliedProtocols,
      evaluationTimeMs: Date.now() - startTime,
      shouldBlock,
      suggestedAction,
    };
  }

  /**
   * Evaluate a single constraint against the execution context
   */
  private evaluateConstraint(
    constraint: ProtocolConstraint,
    context: ExecutionContext
  ): { passed: boolean; message?: string; context?: Record<string, unknown>; remediation?: string } {
    const rule = constraint.rule;

    switch (rule.type) {
      case "tool_restriction":
        return this.evaluateToolRestriction(rule, context);
      case "file_access":
        return this.evaluateFileAccess(rule, context);
      case "output_format":
        return this.evaluateOutputFormat(rule, context);
      case "behavioral":
        return this.evaluateBehavioral(rule, context);
      case "temporal":
        return this.evaluateTemporal(rule, context);
      case "resource":
        return this.evaluateResource(rule, context);
      case "side_effect":
        return this.evaluateSideEffect(rule, context);
      default:
        // Unknown rule type - fail-closed for security (log warning)
        console.warn(`Unknown constraint rule type encountered: ${(rule as { type?: string }).type}`);
        return {
          passed: false,
          message: `Unknown constraint rule type: ${(rule as { type?: string }).type}`
        };
    }
  }

  /**
   * Evaluate tool restriction rules
   */
  private evaluateToolRestriction(
    rule: ToolRestrictionRule,
    context: ExecutionContext
  ): { passed: boolean; message?: string; context?: Record<string, unknown>; remediation?: string } {
    if (context.actionType !== "tool_call") {
      return { passed: true };
    }

    const toolName = context.actionName;

    // Check denied tools first (highest priority)
    if (rule.deniedTools?.includes(toolName)) {
      return {
        passed: false,
        message: `Tool '${toolName}' is explicitly denied`,
        context: { tool: toolName, deniedTools: rule.deniedTools },
        remediation: `Use an alternative tool. Allowed tools: ${rule.allowedTools?.join(", ") || "any not in denied list"}`,
      };
    }

    // Check tool patterns for denial (protected against ReDoS)
    if (rule.toolPatterns) {
      for (const pattern of rule.toolPatterns) {
        if (safeRegexTest(pattern, toolName)) {
          return {
            passed: false,
            message: `Tool '${toolName}' matches denied pattern '${pattern}'`,
            context: { tool: toolName, pattern },
          };
        }
      }
    }

    // Check allowed tools (whitelist mode)
    if (rule.allowedTools && rule.allowedTools.length > 0) {
      if (!rule.allowedTools.includes(toolName)) {
        return {
          passed: false,
          message: `Tool '${toolName}' is not in the allowed list`,
          context: { tool: toolName, allowedTools: rule.allowedTools },
          remediation: `Use one of the allowed tools: ${rule.allowedTools.join(", ")}`,
        };
      }
    }

    // Check if approval is required
    if (rule.requireApproval?.includes(toolName)) {
      // For now, we treat this as a warning in pre-execution
      // Actual approval flow would be handled by the orchestrator
      return {
        passed: true, // Allow to proceed, but...
        message: `Tool '${toolName}' requires approval`,
        context: { tool: toolName, requiresApproval: true },
      };
    }

    return { passed: true };
  }

  /**
   * Evaluate file access rules
   */
  private evaluateFileAccess(
    rule: FileAccessRule,
    context: ExecutionContext
  ): { passed: boolean; message?: string; context?: Record<string, unknown>; remediation?: string } {
    const files = [...(context.targetFiles || []), ...(context.sourceFiles || [])];

    if (files.length === 0) {
      return { passed: true };
    }

    for (const file of files) {
      // Check denied paths
      if (rule.deniedPaths) {
        for (const pattern of rule.deniedPaths) {
          if (pathMatchesPattern(file, pattern)) {
            return {
              passed: false,
              message: `Access to '${file}' is denied (matches pattern '${pattern}')`,
              context: { file, pattern, deniedPaths: rule.deniedPaths },
              remediation: `Choose a file outside the denied paths`,
            };
          }
        }
      }

      // Check allowed paths (if specified, acts as whitelist)
      if (rule.allowedPaths && rule.allowedPaths.length > 0) {
        const isAllowed = rule.allowedPaths.some(pattern => pathMatchesPattern(file, pattern));
        if (!isAllowed) {
          return {
            passed: false,
            message: `Access to '${file}' is not in allowed paths`,
            context: { file, allowedPaths: rule.allowedPaths },
            remediation: `Choose a file matching one of: ${rule.allowedPaths.join(", ")}`,
          };
        }
      }

      // Check file extensions
      const ext = file.split(".").pop()?.toLowerCase();
      if (ext) {
        if (rule.deniedExtensions?.includes(ext)) {
          return {
            passed: false,
            message: `File extension '.${ext}' is denied`,
            context: { file, extension: ext, deniedExtensions: rule.deniedExtensions },
          };
        }

        if (rule.allowedExtensions && rule.allowedExtensions.length > 0) {
          if (!rule.allowedExtensions.includes(ext)) {
            return {
              passed: false,
              message: `File extension '.${ext}' is not allowed`,
              context: { file, extension: ext, allowedExtensions: rule.allowedExtensions },
              remediation: `Use files with extensions: ${rule.allowedExtensions.join(", ")}`,
            };
          }
        }
      }

      // Check read-only paths
      if (rule.readOnly && context.actionType === "file_operation") {
        const isWrite = context.actionName.includes("write") || context.actionName.includes("edit");
        if (isWrite) {
          for (const pattern of rule.readOnly) {
            if (pathMatchesPattern(file, pattern)) {
              return {
                passed: false,
                message: `Cannot write to read-only path '${file}'`,
                context: { file, pattern, readOnlyPaths: rule.readOnly },
              };
            }
          }
        }
      }
    }

    return { passed: true };
  }

  /**
   * Evaluate output format rules
   */
  private evaluateOutputFormat(
    rule: OutputFormatRule,
    context: ExecutionContext
  ): { passed: boolean; message?: string; context?: Record<string, unknown>; remediation?: string } {
    if (context.actionType !== "output" || !context.outputContent) {
      return { passed: true };
    }

    const output = context.outputContent;

    // Check max length
    if (rule.maxLength && output.length > rule.maxLength) {
      return {
        passed: false,
        message: `Output exceeds maximum length (${output.length} > ${rule.maxLength})`,
        context: { length: output.length, maxLength: rule.maxLength },
        remediation: `Reduce output to ${rule.maxLength} characters or less`,
      };
    }

    // Check forbidden patterns (protected against ReDoS)
    if (rule.forbiddenPatterns) {
      for (const pattern of rule.forbiddenPatterns) {
        if (safeRegexTest(pattern, output)) {
          return {
            passed: false,
            message: `Output contains forbidden pattern '${pattern}'`,
            context: { pattern },
            remediation: `Remove content matching the forbidden pattern`,
          };
        }
      }
    }

    // Check required patterns (protected against ReDoS)
    if (rule.requiredPatterns) {
      for (const pattern of rule.requiredPatterns) {
        if (!safeRegexTest(pattern, output)) {
          return {
            passed: false,
            message: `Output missing required pattern '${pattern}'`,
            context: { pattern },
            remediation: `Include content matching the required pattern`,
          };
        }
      }
    }

    // Check format if specified
    if (rule.format === "json") {
      try {
        JSON.parse(output);
      } catch {
        return {
          passed: false,
          message: `Output is not valid JSON`,
          context: { format: "json" },
          remediation: `Ensure output is valid JSON format`,
        };
      }
    }

    return { passed: true };
  }

  /**
   * Evaluate behavioral rules
   */
  private evaluateBehavioral(
    rule: BehavioralRule,
    context: ExecutionContext
  ): { passed: boolean; message?: string; context?: Record<string, unknown>; remediation?: string } {
    // Check prohibited actions
    if (rule.prohibitedActions) {
      if (rule.prohibitedActions.includes(context.actionName)) {
        return {
          passed: false,
          message: `Action '${context.actionName}' is prohibited`,
          context: { action: context.actionName, prohibitedActions: rule.prohibitedActions },
        };
      }
    }

    // Check iteration count (requires monitoring state)
    if (rule.maxIterations !== undefined && context.workerId) {
      const state = this.monitoringStates.get(context.workerId);
      if (state && state.iterationCount >= rule.maxIterations) {
        return {
          passed: false,
          message: `Maximum iterations (${rule.maxIterations}) exceeded`,
          context: { iterations: state.iterationCount, maxIterations: rule.maxIterations },
          remediation: `Complete the task or request orchestrator intervention`,
        };
      }
    }

    return { passed: true };
  }

  /**
   * Evaluate temporal rules (rate limiting, time windows)
   */
  private evaluateTemporal(
    rule: TemporalRule,
    context: ExecutionContext
  ): { passed: boolean; message?: string; context?: Record<string, unknown>; remediation?: string } {
    const now = new Date();
    const timestamp = new Date(context.timestamp);

    // Check valid time window
    if (rule.validFrom) {
      const validFrom = new Date(rule.validFrom);
      if (timestamp < validFrom) {
        return {
          passed: false,
          message: `Action not valid before ${rule.validFrom}`,
          context: { validFrom: rule.validFrom, timestamp: context.timestamp },
        };
      }
    }

    if (rule.validUntil) {
      const validUntil = new Date(rule.validUntil);
      if (timestamp > validUntil) {
        return {
          passed: false,
          message: `Action not valid after ${rule.validUntil}`,
          context: { validUntil: rule.validUntil, timestamp: context.timestamp },
        };
      }
    }

    // Check allowed hours
    if (rule.allowedHours && rule.allowedHours.length > 0) {
      const hour = now.getHours();
      if (!rule.allowedHours.includes(hour)) {
        return {
          passed: false,
          message: `Action not allowed at hour ${hour}`,
          context: { currentHour: hour, allowedHours: rule.allowedHours },
        };
      }
    }

    // Check allowed days
    if (rule.allowedDays && rule.allowedDays.length > 0) {
      const day = now.getDay();
      if (!rule.allowedDays.includes(day)) {
        return {
          passed: false,
          message: `Action not allowed on day ${day}`,
          context: { currentDay: day, allowedDays: rule.allowedDays },
        };
      }
    }

    // Check rate limits (requires monitoring state)
    if (context.workerId) {
      const state = this.monitoringStates.get(context.workerId);
      if (state) {
        const operationType = context.actionType;
        const timestamps = state.operationCounts.get(operationType) || [];

        // Clean old timestamps
        const oneMinuteAgo = Date.now() - 60000;
        const oneHourAgo = Date.now() - 3600000;
        const recentMinute = timestamps.filter(t => t > oneMinuteAgo);
        const recentHour = timestamps.filter(t => t > oneHourAgo);

        // IMPORTANT: Truncate stored timestamps to prevent memory leak
        // Only keep timestamps from the last hour (the longest window we need)
        state.operationCounts.set(operationType, recentHour);

        if (rule.rateLimitPerMinute && recentMinute.length >= rule.rateLimitPerMinute) {
          return {
            passed: false,
            message: `Rate limit exceeded: ${recentMinute.length}/${rule.rateLimitPerMinute} per minute`,
            context: {
              count: recentMinute.length,
              limit: rule.rateLimitPerMinute,
              period: "minute",
            },
            remediation: `Wait before retrying. Cooldown: ${rule.cooldownSeconds || 60} seconds`,
          };
        }

        if (rule.rateLimitPerHour && recentHour.length >= rule.rateLimitPerHour) {
          return {
            passed: false,
            message: `Rate limit exceeded: ${recentHour.length}/${rule.rateLimitPerHour} per hour`,
            context: {
              count: recentHour.length,
              limit: rule.rateLimitPerHour,
              period: "hour",
            },
          };
        }
      }
    }

    return { passed: true };
  }

  /**
   * Evaluate resource rules
   */
  private evaluateResource(
    rule: ResourceRule,
    context: ExecutionContext
  ): { passed: boolean; message?: string; context?: Record<string, unknown>; remediation?: string } {
    // Resource rules are typically checked by the runtime environment
    // Here we do basic validation of the action parameters

    // Check concurrent operations (requires monitoring state)
    if (rule.maxConcurrentOps !== undefined && context.workerId) {
      const state = this.monitoringStates.get(context.workerId);
      // In a real implementation, we'd track concurrent operations
      // For now, this is a placeholder
    }

    return { passed: true };
  }

  /**
   * Evaluate side effect rules
   */
  private evaluateSideEffect(
    rule: SideEffectRule,
    context: ExecutionContext
  ): { passed: boolean; message?: string; context?: Record<string, unknown>; remediation?: string } {
    // Network access
    if (context.actionType === "network") {
      if (rule.allowNetwork === false) {
        return {
          passed: false,
          message: `Network access is not allowed`,
          context: { targetHost: context.targetHost },
        };
      }

      if (context.targetHost) {
        // Check denied hosts
        if (rule.deniedHosts) {
          for (const pattern of rule.deniedHosts) {
            if (matchesAnyPattern(context.targetHost, [pattern])) {
              return {
                passed: false,
                message: `Access to host '${context.targetHost}' is denied`,
                context: { host: context.targetHost, deniedHosts: rule.deniedHosts },
              };
            }
          }
        }

        // Check allowed hosts (whitelist)
        if (rule.allowedHosts && rule.allowedHosts.length > 0) {
          const isAllowed = rule.allowedHosts.some(pattern =>
            matchesAnyPattern(context.targetHost!, [pattern])
          );
          if (!isAllowed) {
            return {
              passed: false,
              message: `Access to host '${context.targetHost}' is not in allowed list`,
              context: { host: context.targetHost, allowedHosts: rule.allowedHosts },
            };
          }
        }
      }
    }

    // Shell commands
    if (context.actionType === "shell_command") {
      if (rule.allowShellCommands === false) {
        return {
          passed: false,
          message: `Shell command execution is not allowed`,
          context: { command: context.command },
        };
      }

      if (context.command) {
        // Check denied commands
        if (rule.deniedCommands) {
          for (const denied of rule.deniedCommands) {
            if (context.command.startsWith(denied) || context.command.includes(denied)) {
              return {
                passed: false,
                message: `Command '${denied}' is denied`,
                context: { command: context.command, deniedCommands: rule.deniedCommands },
              };
            }
          }
        }

        // Check allowed commands (whitelist)
        if (rule.allowedCommands && rule.allowedCommands.length > 0) {
          const isAllowed = rule.allowedCommands.some(allowed =>
            context.command!.startsWith(allowed)
          );
          if (!isAllowed) {
            return {
              passed: false,
              message: `Command not in allowed list`,
              context: { command: context.command, allowedCommands: rule.allowedCommands },
            };
          }
        }
      }
    }

    // Git operations
    if (context.actionType === "git_operation") {
      if (rule.allowGitOperations === false) {
        return {
          passed: false,
          message: `Git operations are not allowed`,
          context: { operation: context.gitOperation },
        };
      }

      if (context.gitOperation) {
        // Check denied git operations
        if (rule.deniedGitOps?.includes(context.gitOperation)) {
          return {
            passed: false,
            message: `Git operation '${context.gitOperation}' is denied`,
            context: { operation: context.gitOperation, deniedGitOps: rule.deniedGitOps },
          };
        }

        // Check allowed git operations (whitelist)
        if (rule.allowedGitOps && rule.allowedGitOps.length > 0) {
          if (!rule.allowedGitOps.includes(context.gitOperation)) {
            return {
              passed: false,
              message: `Git operation '${context.gitOperation}' is not allowed`,
              context: { operation: context.gitOperation, allowedGitOps: rule.allowedGitOps },
            };
          }
        }
      }
    }

    return { passed: true };
  }

  // ==========================================================================
  // Continuous Monitoring
  // ==========================================================================

  /**
   * Start monitoring a worker
   */
  startMonitoring(featureId: string, workerId: string): void {
    const state: MonitoringState = {
      featureId,
      workerId,
      startedAt: new Date().toISOString(),
      operationCounts: new Map(),
      iterationCount: 0,
      toolUsageSequence: [],
      fileAccessSequence: [],
      activeAlerts: [],
      warningCount: 0,
      observedPatterns: [],
    };

    this.monitoringStates.set(workerId, state);
  }

  /**
   * Stop monitoring a worker
   */
  stopMonitoring(workerId: string): MonitoringState | undefined {
    const state = this.monitoringStates.get(workerId);
    this.monitoringStates.delete(workerId);
    return state;
  }

  /**
   * Record an action for monitoring purposes
   */
  recordAction(context: ExecutionContext): void {
    if (!context.workerId) return;

    const state = this.monitoringStates.get(context.workerId);
    if (!state) return;

    // Update operation counts
    const counts = state.operationCounts.get(context.actionType) || [];
    counts.push(Date.now());
    state.operationCounts.set(context.actionType, counts);

    // Update tool usage sequence
    if (context.actionType === "tool_call") {
      state.toolUsageSequence.push(context.actionName);
      // Keep only last 100 entries
      if (state.toolUsageSequence.length > 100) {
        state.toolUsageSequence.shift();
      }
    }

    // Update file access sequence
    if (context.targetFiles) {
      for (const file of context.targetFiles) {
        state.fileAccessSequence.push(file);
        if (state.fileAccessSequence.length > 100) {
          state.fileAccessSequence.shift();
        }
      }
    }

    // Increment iteration count
    state.iterationCount++;

    // Check for behavioral patterns in learning mode
    this.detectPatterns(state, context);
  }

  /**
   * Detect behavioral patterns for learning mode
   */
  private detectPatterns(state: MonitoringState, context: ExecutionContext): void {
    // Detect repeated tool usage
    const recentTools = state.toolUsageSequence.slice(-10);
    const toolCounts = new Map<string, number>();
    for (const tool of recentTools) {
      toolCounts.set(tool, (toolCounts.get(tool) || 0) + 1);
    }

    for (const [tool, count] of Array.from(toolCounts.entries())) {
      if (count >= 5) {
        this.recordPattern(state, "repeated_tool_usage", tool);
      }
    }

    // Detect file access patterns
    const recentFiles = state.fileAccessSequence.slice(-20);
    const fileCounts = new Map<string, number>();
    for (const file of recentFiles) {
      fileCounts.set(file, (fileCounts.get(file) || 0) + 1);
    }

    for (const [file, count] of Array.from(fileCounts.entries())) {
      if (count >= 3) {
        this.recordPattern(state, "repeated_file_access", file);
      }
    }
  }

  // Maximum number of observed patterns to track per worker
  private static readonly MAX_OBSERVED_PATTERNS = 100;

  // Maximum number of active alerts per worker to prevent unbounded memory growth
  private static readonly MAX_ACTIVE_ALERTS = 50;

  /**
   * Record an observed pattern
   */
  private recordPattern(state: MonitoringState, type: string, example: string): void {
    const existing = state.observedPatterns.find(p => p.type === type);
    const now = new Date().toISOString();

    if (existing) {
      existing.frequency++;
      existing.lastSeen = now;
      if (!existing.examples.includes(example)) {
        existing.examples.push(example);
        // Keep only 5 examples
        if (existing.examples.length > 5) {
          existing.examples.shift();
        }
      }
    } else {
      // Cap the observedPatterns array to prevent unbounded memory growth
      if (state.observedPatterns.length >= EnforcementEngine.MAX_OBSERVED_PATTERNS) {
        // Remove the least recently seen pattern
        state.observedPatterns.sort((a, b) =>
          new Date(a.lastSeen).getTime() - new Date(b.lastSeen).getTime()
        );
        state.observedPatterns.shift();
      }

      state.observedPatterns.push({
        type,
        frequency: 1,
        examples: [example],
        firstSeen: now,
        lastSeen: now,
      });
    }
  }

  /**
   * Check monitoring state and raise alerts if needed
   */
  checkMonitoringAlerts(workerId: string): MonitoringAlert[] {
    const state = this.monitoringStates.get(workerId);
    if (!state) return [];

    const newAlerts: MonitoringAlert[] = [];
    const now = new Date();

    // Check for stuck patterns (same actions repeated many times)
    const toolCounts = new Map<string, number>();
    for (const tool of state.toolUsageSequence.slice(-20)) {
      toolCounts.set(tool, (toolCounts.get(tool) || 0) + 1);
    }

    for (const [tool, count] of Array.from(toolCounts.entries())) {
      if (count >= 15) {
        const alertId = generateAlertId();
        const alert: MonitoringAlert = {
          id: alertId,
          type: "behavioral",
          severity: "warning",
          message: `Worker appears stuck: tool '${tool}' used ${count} times in recent actions`,
          timestamp: now.toISOString(),
          acknowledged: false,
        };
        newAlerts.push(alert);

        // Cap activeAlerts to prevent unbounded memory growth
        if (state.activeAlerts.length >= EnforcementEngine.MAX_ACTIVE_ALERTS) {
          // Remove oldest unacknowledged alert, or oldest overall if all acknowledged
          const unacknowledgedIndex = state.activeAlerts.findIndex(a => !a.acknowledged);
          if (unacknowledgedIndex >= 0) {
            state.activeAlerts.splice(unacknowledgedIndex, 1);
          } else {
            state.activeAlerts.shift();
          }
        }
        state.activeAlerts.push(alert);
      }
    }

    // Check for timeout (no activity)
    // This would require tracking last activity time

    return newAlerts;
  }

  /**
   * Get current monitoring state for a worker
   */
  getMonitoringState(workerId: string): MonitoringState | undefined {
    return this.monitoringStates.get(workerId);
  }

  /**
   * Acknowledge an alert
   */
  acknowledgeAlert(workerId: string, alertId: string): boolean {
    const state = this.monitoringStates.get(workerId);
    if (!state) return false;

    const alert = state.activeAlerts.find(a => a.id === alertId);
    if (alert) {
      alert.acknowledged = true;
      return true;
    }

    return false;
  }

  // ==========================================================================
  // Post-Execution Verification
  // ==========================================================================

  /**
   * Verify an action after execution
   * Checks outcomes and side effects
   */
  verifyPostExecution(
    context: ExecutionContext,
    outcome: {
      success: boolean;
      output?: string;
      sideEffects?: {
        filesModified?: string[];
        filesCreated?: string[];
        filesDeleted?: string[];
        networkRequests?: Array<{ host: string; method: string; status: number }>;
        gitChanges?: Array<{ operation: string; ref?: string }>;
      };
      error?: string;
    }
  ): EnforcementResult {
    const startTime = Date.now();
    const violations: ViolationDetail[] = [];
    const warnings: WarningDetail[] = [];
    const appliedProtocols: string[] = [];

    // Get active protocols
    const activeProtocols = this.registry.getActiveProtocols();

    for (const protocol of activeProtocols) {
      // Skip if post-execution validation is disabled
      if (!protocol.enforcement.postExecutionValidation) {
        continue;
      }

      // Check if protocol applies
      if (!this.protocolApplies(protocol, context)) {
        continue;
      }

      appliedProtocols.push(protocol.id);

      // Get effective constraints
      const effective = this.resolver.getEffectiveConstraints(protocol.id, this.registry);

      // Verify file-related constraints against actual side effects
      if (outcome.sideEffects) {
        for (const constraint of effective.constraints) {
          if (!constraint.enabled) continue;

          if (constraint.rule.type === "file_access") {
            const fileResult = this.verifyFileSideEffects(
              constraint.rule,
              outcome.sideEffects
            );
            if (!fileResult.passed) {
              violations.push({
                protocolId: protocol.id,
                protocolName: protocol.name,
                constraintId: constraint.id,
                constraintType: constraint.type,
                severity: constraint.severity,
                message: fileResult.message || "File access constraint violated",
                context: fileResult.context || {},
              });
            }
          }

          if (constraint.rule.type === "side_effect") {
            const sideEffectResult = this.verifySideEffects(
              constraint.rule,
              outcome.sideEffects
            );
            if (!sideEffectResult.passed) {
              violations.push({
                protocolId: protocol.id,
                protocolName: protocol.name,
                constraintId: constraint.id,
                constraintType: constraint.type,
                severity: constraint.severity,
                message: sideEffectResult.message || "Side effect constraint violated",
                context: sideEffectResult.context || {},
              });
            }
          }
        }
      }

      // Verify output constraints
      if (outcome.output) {
        for (const constraint of effective.constraints) {
          if (!constraint.enabled) continue;

          if (constraint.rule.type === "output_format") {
            const outputContext: ExecutionContext = {
              ...context,
              actionType: "output",
              outputContent: outcome.output,
            };
            const outputResult = this.evaluateOutputFormat(constraint.rule, outputContext);
            if (!outputResult.passed) {
              violations.push({
                protocolId: protocol.id,
                protocolName: protocol.name,
                constraintId: constraint.id,
                constraintType: constraint.type,
                severity: constraint.severity,
                message: outputResult.message || "Output format constraint violated",
                context: outputResult.context || {},
              });
            }
          }
        }
      }
    }

    // Determine if we should take action on post-execution violations
    const shouldBlock = violations.some(v => v.severity === "error");

    // Record violations
    for (const violation of violations) {
      this.registry.recordViolation({
        protocolId: violation.protocolId,
        constraintId: violation.constraintId,
        featureId: context.featureId,
        workerId: context.workerId,
        severity: violation.severity,
        message: `[POST-EXECUTION] ${violation.message}`,
        context: {
          ...violation.context,
          phase: "post-execution",
          outcome: outcome.success ? "success" : "failure",
        },
      });
    }

    return {
      allowed: !shouldBlock,
      violations,
      warnings,
      appliedProtocols,
      evaluationTimeMs: Date.now() - startTime,
      shouldBlock,
      suggestedAction: violations.length > 0 ? "escalate" : "proceed",
    };
  }

  /**
   * Verify file side effects against constraints
   */
  private verifyFileSideEffects(
    rule: FileAccessRule,
    sideEffects: NonNullable<Parameters<typeof this.verifyPostExecution>[1]["sideEffects"]>
  ): { passed: boolean; message?: string; context?: Record<string, unknown> } {
    const allFiles = [
      ...(sideEffects.filesModified || []),
      ...(sideEffects.filesCreated || []),
      ...(sideEffects.filesDeleted || []),
    ];

    for (const file of allFiles) {
      // Check denied paths
      if (rule.deniedPaths) {
        for (const pattern of rule.deniedPaths) {
          if (pathMatchesPattern(file, pattern)) {
            return {
              passed: false,
              message: `File '${file}' was modified but matches denied pattern '${pattern}'`,
              context: { file, pattern, action: "modified" },
            };
          }
        }
      }

      // Check max file size (would need actual file sizes)
      // This is a placeholder for actual implementation
    }

    return { passed: true };
  }

  /**
   * Verify side effects against constraints
   */
  private verifySideEffects(
    rule: SideEffectRule,
    sideEffects: NonNullable<Parameters<typeof this.verifyPostExecution>[1]["sideEffects"]>
  ): { passed: boolean; message?: string; context?: Record<string, unknown> } {
    // Verify network requests
    if (sideEffects.networkRequests && rule.allowNetwork === false) {
      return {
        passed: false,
        message: `Network requests were made but network access is not allowed`,
        context: { requestCount: sideEffects.networkRequests.length },
      };
    }

    if (sideEffects.networkRequests && rule.deniedHosts) {
      for (const request of sideEffects.networkRequests) {
        for (const pattern of rule.deniedHosts) {
          if (matchesAnyPattern(request.host, [pattern])) {
            return {
              passed: false,
              message: `Request to denied host '${request.host}'`,
              context: { host: request.host, pattern },
            };
          }
        }
      }
    }

    // Verify git operations
    if (sideEffects.gitChanges && rule.allowGitOperations === false) {
      return {
        passed: false,
        message: `Git operations were performed but are not allowed`,
        context: { operations: sideEffects.gitChanges.map(g => g.operation) },
      };
    }

    if (sideEffects.gitChanges && rule.deniedGitOps) {
      for (const change of sideEffects.gitChanges) {
        if (rule.deniedGitOps.includes(change.operation)) {
          return {
            passed: false,
            message: `Denied git operation '${change.operation}' was performed`,
            context: { operation: change.operation },
          };
        }
      }
    }

    return { passed: true };
  }

  // ==========================================================================
  // Helper Methods
  // ==========================================================================

  /**
   * Check if a protocol applies to the given context
   */
  private protocolApplies(protocol: Protocol, context: ExecutionContext): boolean {
    const matcher = protocol.applicableContexts;

    // If no matchers specified, protocol applies to everything
    if (!matcher || Object.keys(matcher).length === 0) {
      return true;
    }

    // Check exclusions first
    if (matcher.excludeFeatures && context.featureId) {
      if (matchesAnyPattern(context.featureId, matcher.excludeFeatures)) {
        return false;
      }
    }

    if (matcher.excludeProjects && context.projectDir) {
      if (matchesAnyPattern(context.projectDir, matcher.excludeProjects)) {
        return false;
      }
    }

    // Check positive matches
    let hasPositiveMatch = false;
    let requiresPositiveMatch = false;

    // Feature patterns
    if (matcher.featurePatterns && matcher.featurePatterns.length > 0) {
      requiresPositiveMatch = true;
      if (context.featureId && matchesAnyPattern(context.featureId, matcher.featurePatterns)) {
        hasPositiveMatch = true;
      }
    }

    // Project patterns
    if (matcher.projectPatterns && matcher.projectPatterns.length > 0) {
      requiresPositiveMatch = true;
      if (context.projectDir && matchesAnyPattern(context.projectDir, matcher.projectPatterns)) {
        hasPositiveMatch = true;
      }
    }

    // File patterns
    if (matcher.filePatterns && matcher.filePatterns.length > 0) {
      requiresPositiveMatch = true;
      const files = [...(context.targetFiles || []), ...(context.sourceFiles || [])];
      for (const file of files) {
        if (matchesAnyPattern(file, matcher.filePatterns)) {
          hasPositiveMatch = true;
          break;
        }
      }
    }

    // Worker patterns
    if (matcher.workerPatterns && matcher.workerPatterns.length > 0) {
      requiresPositiveMatch = true;
      if (context.workerId && matchesAnyPattern(context.workerId, matcher.workerPatterns)) {
        hasPositiveMatch = true;
      }
    }

    // If positive matches are required but none found, protocol doesn't apply
    if (requiresPositiveMatch && !hasPositiveMatch) {
      return false;
    }

    return true;
  }

  /**
   * Determine if execution should be blocked based on violations and protocol configs
   */
  private shouldBlockExecution(
    violations: ViolationDetail[],
    activeProtocols: Protocol[]
  ): boolean {
    if (violations.length === 0) {
      return false;
    }

    // Check if any violation is from a protocol in strict mode with error severity
    for (const violation of violations) {
      if (violation.severity !== "error") {
        continue;
      }

      const protocol = activeProtocols.find(p => p.id === violation.protocolId);
      if (!protocol) continue;

      const enforcement = protocol.enforcement;

      // In strict mode, errors always block
      if (enforcement.mode === "strict") {
        return true;
      }

      // In permissive mode, only block if onViolation is "block"
      if (enforcement.mode === "permissive" && enforcement.onViolation === "block") {
        return true;
      }

      // Audit and learning modes never block
    }

    return false;
  }

  /**
   * Convert enforcement result to ProtocolValidationResult for compatibility
   */
  toValidationResult(result: EnforcementResult): ProtocolValidationResult {
    return {
      valid: result.allowed,
      violations: result.violations.map(v => ({
        protocolId: v.protocolId,
        constraintId: v.constraintId,
        severity: v.severity,
        message: v.message,
        context: v.context,
      })),
      warnings: result.warnings,
      appliedProtocols: result.appliedProtocols,
      evaluationTimeMs: result.evaluationTimeMs,
    };
  }

  // ==========================================================================
  // Utility Methods
  // ==========================================================================

  /**
   * Get statistics about enforcement
   */
  getStats(): {
    activeMonitoringSessions: number;
    totalViolationsRecorded: number;
    unresolvedViolations: number;
  } {
    return {
      activeMonitoringSessions: this.monitoringStates.size,
      totalViolationsRecorded: this.registry.getViolationCount(),
      unresolvedViolations: this.registry.getViolationCount({ resolved: false }),
    };
  }

  /**
   * Clear all monitoring state (for testing or reset)
   */
  clearMonitoringState(): void {
    this.monitoringStates.clear();
  }
}
