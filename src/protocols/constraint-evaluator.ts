/**
 * Constraint Evaluator - Evaluates individual constraints against actions
 *
 * This module provides evaluation logic for each constraint type:
 * - tool_restriction: Controls which tools can be used
 * - file_access: Controls file read/write permissions
 * - output_format: Controls output structure and content
 * - behavioral: General behavioral guidelines
 * - temporal: Time-based constraints (evaluated separately)
 * - resource: Resource usage limits (evaluated separately)
 * - side_effect: Controls side effects (evaluated separately)
 *
 * Key design principles:
 * - Pure evaluation functions (no side effects during evaluation)
 * - Detailed evaluation results for debugging
 * - Pattern matching with glob and regex support
 * - Performance-optimized for frequent constraint checking
 */

import * as path from "path";
import { z } from "zod";
import type {
  ProtocolConstraint,
  ConstraintRule,
  ConstraintSeverity,
  ToolRestrictionRule,
  FileAccessRule,
  OutputFormatRule,
  BehavioralRule,
  TemporalRule,
  ResourceRule,
  SideEffectRule,
} from "./schema.js";

// ============================================================================
// Evaluation Context Types
// ============================================================================

/**
 * Context for evaluating tool restriction constraints
 */
export interface ToolContext {
  toolName: string;
  toolArgs?: Record<string, unknown>;
  requiresApproval?: boolean;
}

/**
 * Context for evaluating file access constraints
 */
export interface FileContext {
  filePath: string;
  operation: "read" | "write" | "create" | "delete";
  fileSize?: number;
  projectDir: string;
}

/**
 * Context for evaluating output format constraints
 */
export interface OutputContext {
  content: string;
  format?: "json" | "markdown" | "text" | "yaml" | "custom";
  fields?: string[];
}

/**
 * Context for evaluating behavioral constraints
 */
export interface BehavioralContext {
  action: string;
  iterationCount?: number;
  elapsedSeconds?: number;
  hasExplanation?: boolean;
  isConfirmed?: boolean;
}

/**
 * Context for evaluating temporal constraints
 */
export interface TemporalContext {
  timestamp: Date;
  operationsThisMinute?: number;
  operationsThisHour?: number;
  lastOperationTime?: Date;
}

/**
 * Context for evaluating resource constraints
 */
export interface ResourceContext {
  memoryUsageMB?: number;
  cpuPercent?: number;
  concurrentOps?: number;
  diskWriteMB?: number;
  networkRequestsThisMinute?: number;
  tokensUsed?: number;
}

/**
 * Context for evaluating side effect constraints
 */
export interface SideEffectContext {
  networkHost?: string;
  shellCommand?: string;
  gitOperation?: string;
}

/**
 * Combined evaluation context for any constraint type
 */
export interface EvaluationContext {
  tool?: ToolContext;
  file?: FileContext;
  output?: OutputContext;
  behavioral?: BehavioralContext;
  temporal?: TemporalContext;
  resource?: ResourceContext;
  sideEffect?: SideEffectContext;
}

// ============================================================================
// Evaluation Result Types
// ============================================================================

/**
 * Result of evaluating a single constraint
 */
export interface ConstraintEvaluationResult {
  /** Whether the constraint passed */
  passed: boolean;

  /** The constraint that was evaluated */
  constraintId: string;

  /** Severity of violation (if failed) */
  severity: ConstraintSeverity;

  /** Human-readable message describing the result */
  message: string;

  /** Specific reason for failure (if failed) */
  failureReason?: string;

  /** Context that caused the failure */
  failureContext?: Record<string, unknown>;

  /** Time taken to evaluate in milliseconds */
  evaluationTimeMs: number;
}

/**
 * Zod schema for evaluation result
 */
export const ConstraintEvaluationResultSchema = z.object({
  passed: z.boolean(),
  constraintId: z.string(),
  severity: z.enum(["error", "warning", "info"]),
  message: z.string(),
  failureReason: z.string().optional(),
  failureContext: z.record(z.unknown()).optional(),
  evaluationTimeMs: z.number(),
});

// ============================================================================
// Pattern Matching Utilities
// ============================================================================

/**
 * Convert a glob pattern to a regex for matching
 */
function globToRegex(glob: string): RegExp {
  // Escape special regex characters except * and ?
  let regexStr = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "{{DOUBLESTAR}}")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, ".")
    .replace(/{{DOUBLESTAR}}/g, ".*");

  return new RegExp(`^${regexStr}$`);
}

/**
 * Check if a string matches any pattern in a list
 */
function matchesAnyPattern(value: string, patterns: string[]): boolean {
  for (const pattern of patterns) {
    try {
      // First try as a regex
      if (pattern.startsWith("/") && pattern.endsWith("/")) {
        const regexPattern = pattern.slice(1, -1);
        if (new RegExp(regexPattern).test(value)) {
          return true;
        }
      } else {
        // Treat as glob pattern
        if (globToRegex(pattern).test(value)) {
          return true;
        }
      }
    } catch {
      // Invalid pattern, try exact match
      if (value === pattern) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Get file extension from path
 */
function getFileExtension(filePath: string): string {
  const ext = path.extname(filePath);
  return ext.startsWith(".") ? ext.slice(1) : ext;
}

/**
 * Normalize a file path relative to project directory
 */
function normalizeFilePath(filePath: string, projectDir: string): string {
  // If path is already relative, return as-is
  if (!path.isAbsolute(filePath)) {
    return filePath;
  }
  // Make relative to project directory
  return path.relative(projectDir, filePath);
}

// ============================================================================
// Individual Constraint Evaluators
// ============================================================================

/**
 * Evaluate a tool restriction constraint
 */
export function evaluateToolRestriction(
  rule: ToolRestrictionRule,
  context: ToolContext
): { passed: boolean; reason?: string } {
  const { toolName } = context;

  // Check denied tools first (deny takes precedence)
  if (rule.deniedTools && rule.deniedTools.length > 0) {
    if (rule.deniedTools.includes(toolName)) {
      return {
        passed: false,
        reason: `Tool '${toolName}' is explicitly denied`,
      };
    }
  }

  // Check tool patterns for denial
  if (rule.toolPatterns && rule.toolPatterns.length > 0) {
    for (const pattern of rule.toolPatterns) {
      try {
        // Patterns prefixed with ! are deny patterns
        if (pattern.startsWith("!")) {
          const denyPattern = new RegExp(pattern.slice(1));
          if (denyPattern.test(toolName)) {
            return {
              passed: false,
              reason: `Tool '${toolName}' matches deny pattern '${pattern}'`,
            };
          }
        }
      } catch {
        // Invalid regex, skip
      }
    }
  }

  // Check allowed tools (if specified, tool must be in the list)
  if (rule.allowedTools && rule.allowedTools.length > 0) {
    if (!rule.allowedTools.includes(toolName)) {
      // Check if allowed via pattern
      let allowedByPattern = false;
      if (rule.toolPatterns) {
        for (const pattern of rule.toolPatterns) {
          if (!pattern.startsWith("!")) {
            try {
              if (new RegExp(pattern).test(toolName)) {
                allowedByPattern = true;
                break;
              }
            } catch {
              // Invalid regex, skip
            }
          }
        }
      }
      if (!allowedByPattern) {
        return {
          passed: false,
          reason: `Tool '${toolName}' is not in the allowed list`,
        };
      }
    }
  }

  // Check if tool requires approval
  if (rule.requireApproval && rule.requireApproval.length > 0) {
    if (
      rule.requireApproval.includes(toolName) &&
      !context.requiresApproval
    ) {
      return {
        passed: false,
        reason: `Tool '${toolName}' requires explicit approval`,
      };
    }
  }

  return { passed: true };
}

/**
 * Evaluate a file access constraint
 */
export function evaluateFileAccess(
  rule: FileAccessRule,
  context: FileContext
): { passed: boolean; reason?: string } {
  const { filePath, operation, fileSize, projectDir } = context;
  const normalizedPath = normalizeFilePath(filePath, projectDir);
  const extension = getFileExtension(filePath);

  // Check denied paths first
  if (rule.deniedPaths && rule.deniedPaths.length > 0) {
    if (matchesAnyPattern(normalizedPath, rule.deniedPaths)) {
      return {
        passed: false,
        reason: `Path '${normalizedPath}' matches a denied path pattern`,
      };
    }
  }

  // Check denied extensions
  if (rule.deniedExtensions && rule.deniedExtensions.length > 0) {
    if (rule.deniedExtensions.includes(extension)) {
      return {
        passed: false,
        reason: `Extension '.${extension}' is denied`,
      };
    }
  }

  // Check allowed paths (if specified, path must match)
  if (rule.allowedPaths && rule.allowedPaths.length > 0) {
    if (!matchesAnyPattern(normalizedPath, rule.allowedPaths)) {
      return {
        passed: false,
        reason: `Path '${normalizedPath}' does not match any allowed path pattern`,
      };
    }
  }

  // Check allowed extensions (if specified, extension must be in list)
  if (rule.allowedExtensions && rule.allowedExtensions.length > 0) {
    if (!rule.allowedExtensions.includes(extension)) {
      return {
        passed: false,
        reason: `Extension '.${extension}' is not in the allowed list`,
      };
    }
  }

  // Check read-only paths
  if (rule.readOnly && rule.readOnly.length > 0) {
    if (
      matchesAnyPattern(normalizedPath, rule.readOnly) &&
      operation !== "read"
    ) {
      return {
        passed: false,
        reason: `Path '${normalizedPath}' is read-only, cannot ${operation}`,
      };
    }
  }

  // Check write-only paths
  if (rule.writeOnly && rule.writeOnly.length > 0) {
    if (
      matchesAnyPattern(normalizedPath, rule.writeOnly) &&
      operation === "read"
    ) {
      return {
        passed: false,
        reason: `Path '${normalizedPath}' is write-only, cannot read`,
      };
    }
  }

  // Check file size
  if (rule.maxFileSize !== undefined && fileSize !== undefined) {
    if (fileSize > rule.maxFileSize) {
      return {
        passed: false,
        reason: `File size ${fileSize} bytes exceeds maximum ${rule.maxFileSize} bytes`,
      };
    }
  }

  return { passed: true };
}

/**
 * Evaluate an output format constraint
 */
export function evaluateOutputFormat(
  rule: OutputFormatRule,
  context: OutputContext
): { passed: boolean; reason?: string } {
  const { content, format, fields } = context;

  // Check max length
  if (rule.maxLength !== undefined && content.length > rule.maxLength) {
    return {
      passed: false,
      reason: `Output length ${content.length} exceeds maximum ${rule.maxLength}`,
    };
  }

  // Check format
  if (rule.format !== undefined && format !== undefined) {
    if (format !== rule.format) {
      return {
        passed: false,
        reason: `Output format '${format}' does not match required '${rule.format}'`,
      };
    }
  }

  // Check required fields (for structured output)
  if (rule.requiredFields && rule.requiredFields.length > 0) {
    if (!fields) {
      return {
        passed: false,
        reason: `Required fields not provided in output context`,
      };
    }
    const missingFields = rule.requiredFields.filter(
      (f) => !fields.includes(f)
    );
    if (missingFields.length > 0) {
      return {
        passed: false,
        reason: `Missing required fields: ${missingFields.join(", ")}`,
      };
    }
  }

  // Check forbidden patterns
  if (rule.forbiddenPatterns && rule.forbiddenPatterns.length > 0) {
    for (const pattern of rule.forbiddenPatterns) {
      try {
        if (new RegExp(pattern).test(content)) {
          return {
            passed: false,
            reason: `Output matches forbidden pattern: ${pattern}`,
          };
        }
      } catch {
        // Invalid regex, skip
      }
    }
  }

  // Check required patterns
  if (rule.requiredPatterns && rule.requiredPatterns.length > 0) {
    for (const pattern of rule.requiredPatterns) {
      try {
        if (!new RegExp(pattern).test(content)) {
          return {
            passed: false,
            reason: `Output does not match required pattern: ${pattern}`,
          };
        }
      } catch {
        // Invalid regex, skip
      }
    }
  }

  // Validate against JSON schema (if provided)
  if (rule.schema && rule.format === "json") {
    try {
      const parsed = JSON.parse(content);
      // Basic schema validation - full JSON Schema validation would require a library
      // For now, just check that it's valid JSON and has expected structure
      if (typeof parsed !== "object" || parsed === null) {
        return {
          passed: false,
          reason: `Output is not a valid JSON object`,
        };
      }
    } catch (e) {
      return {
        passed: false,
        reason: `Output is not valid JSON: ${e instanceof Error ? e.message : "parse error"}`,
      };
    }
  }

  return { passed: true };
}

/**
 * Evaluate a behavioral constraint
 */
export function evaluateBehavioral(
  rule: BehavioralRule,
  context: BehavioralContext
): { passed: boolean; reason?: string } {
  const { action, iterationCount, elapsedSeconds, hasExplanation, isConfirmed } =
    context;

  // Check prohibited actions
  if (rule.prohibitedActions && rule.prohibitedActions.length > 0) {
    for (const prohibited of rule.prohibitedActions) {
      // Check for exact match or pattern match
      if (action === prohibited || matchesAnyPattern(action, [prohibited])) {
        return {
          passed: false,
          reason: `Action '${action}' is prohibited`,
        };
      }
    }
  }

  // Check required actions (must be one of the required actions)
  if (rule.requiredActions && rule.requiredActions.length > 0) {
    const isAllowed = rule.requiredActions.some(
      (required) =>
        action === required || matchesAnyPattern(action, [required])
    );
    if (!isAllowed) {
      return {
        passed: false,
        reason: `Action '${action}' is not in the list of required actions`,
      };
    }
  }

  // Check confirmation requirement
  if (rule.requireConfirmation && !isConfirmed) {
    return {
      passed: false,
      reason: `Action requires user confirmation`,
    };
  }

  // Check explanation requirement
  if (rule.requireExplanation && !hasExplanation) {
    return {
      passed: false,
      reason: `Action requires an explanation`,
    };
  }

  // Check max iterations
  if (
    rule.maxIterations !== undefined &&
    iterationCount !== undefined &&
    iterationCount > rule.maxIterations
  ) {
    return {
      passed: false,
      reason: `Iteration count ${iterationCount} exceeds maximum ${rule.maxIterations}`,
    };
  }

  // Check timeout
  if (
    rule.timeoutSeconds !== undefined &&
    elapsedSeconds !== undefined &&
    elapsedSeconds > rule.timeoutSeconds
  ) {
    return {
      passed: false,
      reason: `Operation timed out after ${elapsedSeconds}s (limit: ${rule.timeoutSeconds}s)`,
    };
  }

  return { passed: true };
}

/**
 * Evaluate a temporal constraint
 */
export function evaluateTemporal(
  rule: TemporalRule,
  context: TemporalContext
): { passed: boolean; reason?: string } {
  const {
    timestamp,
    operationsThisMinute,
    operationsThisHour,
    lastOperationTime,
  } = context;

  // Check rate limit per minute
  if (
    rule.rateLimitPerMinute !== undefined &&
    operationsThisMinute !== undefined
  ) {
    if (operationsThisMinute >= rule.rateLimitPerMinute) {
      return {
        passed: false,
        reason: `Rate limit exceeded: ${operationsThisMinute}/${rule.rateLimitPerMinute} per minute`,
      };
    }
  }

  // Check rate limit per hour
  if (
    rule.rateLimitPerHour !== undefined &&
    operationsThisHour !== undefined
  ) {
    if (operationsThisHour >= rule.rateLimitPerHour) {
      return {
        passed: false,
        reason: `Rate limit exceeded: ${operationsThisHour}/${rule.rateLimitPerHour} per hour`,
      };
    }
  }

  // Check cooldown
  if (rule.cooldownSeconds !== undefined && lastOperationTime !== undefined) {
    const elapsed = (timestamp.getTime() - lastOperationTime.getTime()) / 1000;
    if (elapsed < rule.cooldownSeconds) {
      return {
        passed: false,
        reason: `Cooldown period not elapsed: ${elapsed.toFixed(1)}s of ${rule.cooldownSeconds}s`,
      };
    }
  }

  // Check valid from/until
  if (rule.validFrom) {
    const validFrom = new Date(rule.validFrom);
    if (timestamp < validFrom) {
      return {
        passed: false,
        reason: `Constraint not yet valid (starts ${rule.validFrom})`,
      };
    }
  }

  if (rule.validUntil) {
    const validUntil = new Date(rule.validUntil);
    if (timestamp > validUntil) {
      return {
        passed: false,
        reason: `Constraint has expired (ended ${rule.validUntil})`,
      };
    }
  }

  // Check allowed hours (0-23)
  if (rule.allowedHours && rule.allowedHours.length > 0) {
    const hour = timestamp.getHours();
    if (!rule.allowedHours.includes(hour)) {
      return {
        passed: false,
        reason: `Operation not allowed at hour ${hour}`,
      };
    }
  }

  // Check allowed days (0=Sunday, 6=Saturday)
  if (rule.allowedDays && rule.allowedDays.length > 0) {
    const day = timestamp.getDay();
    if (!rule.allowedDays.includes(day)) {
      return {
        passed: false,
        reason: `Operation not allowed on day ${day}`,
      };
    }
  }

  return { passed: true };
}

/**
 * Evaluate a resource constraint
 */
export function evaluateResource(
  rule: ResourceRule,
  context: ResourceContext
): { passed: boolean; reason?: string } {
  // Check memory usage
  if (rule.maxMemoryMB !== undefined && context.memoryUsageMB !== undefined) {
    if (context.memoryUsageMB > rule.maxMemoryMB) {
      return {
        passed: false,
        reason: `Memory usage ${context.memoryUsageMB}MB exceeds limit ${rule.maxMemoryMB}MB`,
      };
    }
  }

  // Check CPU usage
  if (rule.maxCpuPercent !== undefined && context.cpuPercent !== undefined) {
    if (context.cpuPercent > rule.maxCpuPercent) {
      return {
        passed: false,
        reason: `CPU usage ${context.cpuPercent}% exceeds limit ${rule.maxCpuPercent}%`,
      };
    }
  }

  // Check concurrent operations
  if (
    rule.maxConcurrentOps !== undefined &&
    context.concurrentOps !== undefined
  ) {
    if (context.concurrentOps >= rule.maxConcurrentOps) {
      return {
        passed: false,
        reason: `Concurrent operations ${context.concurrentOps} exceeds limit ${rule.maxConcurrentOps}`,
      };
    }
  }

  // Check disk write
  if (rule.maxDiskWriteMB !== undefined && context.diskWriteMB !== undefined) {
    if (context.diskWriteMB > rule.maxDiskWriteMB) {
      return {
        passed: false,
        reason: `Disk write ${context.diskWriteMB}MB exceeds limit ${rule.maxDiskWriteMB}MB`,
      };
    }
  }

  // Check network requests per minute
  if (
    rule.maxNetworkRequestsPerMin !== undefined &&
    context.networkRequestsThisMinute !== undefined
  ) {
    if (context.networkRequestsThisMinute >= rule.maxNetworkRequestsPerMin) {
      return {
        passed: false,
        reason: `Network requests ${context.networkRequestsThisMinute}/min exceeds limit ${rule.maxNetworkRequestsPerMin}/min`,
      };
    }
  }

  // Check tokens per request
  if (
    rule.maxTokensPerRequest !== undefined &&
    context.tokensUsed !== undefined
  ) {
    if (context.tokensUsed > rule.maxTokensPerRequest) {
      return {
        passed: false,
        reason: `Token usage ${context.tokensUsed} exceeds limit ${rule.maxTokensPerRequest}`,
      };
    }
  }

  return { passed: true };
}

/**
 * Evaluate a side effect constraint
 */
export function evaluateSideEffect(
  rule: SideEffectRule,
  context: SideEffectContext
): { passed: boolean; reason?: string } {
  // Check network access
  if (context.networkHost !== undefined) {
    // Check if network is allowed at all
    if (rule.allowNetwork === false) {
      return {
        passed: false,
        reason: `Network access is not allowed`,
      };
    }

    // Check denied hosts
    if (rule.deniedHosts && rule.deniedHosts.length > 0) {
      if (matchesAnyPattern(context.networkHost, rule.deniedHosts)) {
        return {
          passed: false,
          reason: `Network host '${context.networkHost}' is denied`,
        };
      }
    }

    // Check allowed hosts (if specified, must be in list)
    if (rule.allowedHosts && rule.allowedHosts.length > 0) {
      if (!matchesAnyPattern(context.networkHost, rule.allowedHosts)) {
        return {
          passed: false,
          reason: `Network host '${context.networkHost}' is not in allowed list`,
        };
      }
    }
  }

  // Check shell commands
  if (context.shellCommand !== undefined) {
    // Check if shell commands are allowed at all
    if (rule.allowShellCommands === false) {
      return {
        passed: false,
        reason: `Shell command execution is not allowed`,
      };
    }

    // Extract the base command (first word)
    const baseCommand = context.shellCommand.trim().split(/\s+/)[0];

    // Check denied commands
    if (rule.deniedCommands && rule.deniedCommands.length > 0) {
      if (
        matchesAnyPattern(baseCommand, rule.deniedCommands) ||
        matchesAnyPattern(context.shellCommand, rule.deniedCommands)
      ) {
        return {
          passed: false,
          reason: `Shell command '${baseCommand}' is denied`,
        };
      }
    }

    // Check allowed commands (if specified, must be in list)
    if (rule.allowedCommands && rule.allowedCommands.length > 0) {
      const isAllowed =
        matchesAnyPattern(baseCommand, rule.allowedCommands) ||
        matchesAnyPattern(context.shellCommand, rule.allowedCommands);
      if (!isAllowed) {
        return {
          passed: false,
          reason: `Shell command '${baseCommand}' is not in allowed list`,
        };
      }
    }
  }

  // Check git operations
  if (context.gitOperation !== undefined) {
    // Check if git operations are allowed at all
    if (rule.allowGitOperations === false) {
      return {
        passed: false,
        reason: `Git operations are not allowed`,
      };
    }

    // Check denied git operations
    if (rule.deniedGitOps && rule.deniedGitOps.length > 0) {
      if (matchesAnyPattern(context.gitOperation, rule.deniedGitOps)) {
        return {
          passed: false,
          reason: `Git operation '${context.gitOperation}' is denied`,
        };
      }
    }

    // Check allowed git operations (if specified, must be in list)
    if (rule.allowedGitOps && rule.allowedGitOps.length > 0) {
      if (!matchesAnyPattern(context.gitOperation, rule.allowedGitOps)) {
        return {
          passed: false,
          reason: `Git operation '${context.gitOperation}' is not in allowed list`,
        };
      }
    }
  }

  return { passed: true };
}

// ============================================================================
// Main Constraint Evaluator Class
// ============================================================================

/**
 * ConstraintEvaluator - Main class for evaluating protocol constraints
 */
export class ConstraintEvaluator {
  /**
   * Evaluate a single constraint against the provided context
   */
  evaluate(
    constraint: ProtocolConstraint,
    context: EvaluationContext
  ): ConstraintEvaluationResult {
    const startTime = Date.now();

    // Skip disabled constraints
    if (!constraint.enabled) {
      return {
        passed: true,
        constraintId: constraint.id,
        severity: constraint.severity,
        message: `Constraint '${constraint.id}' is disabled`,
        evaluationTimeMs: Date.now() - startTime,
      };
    }

    // Evaluate based on constraint type
    let result: { passed: boolean; reason?: string };

    try {
      switch (constraint.rule.type) {
        case "tool_restriction":
          if (!context.tool) {
            result = { passed: true }; // Not applicable
          } else {
            result = evaluateToolRestriction(
              constraint.rule as ToolRestrictionRule,
              context.tool
            );
          }
          break;

        case "file_access":
          if (!context.file) {
            result = { passed: true }; // Not applicable
          } else {
            result = evaluateFileAccess(
              constraint.rule as FileAccessRule,
              context.file
            );
          }
          break;

        case "output_format":
          if (!context.output) {
            result = { passed: true }; // Not applicable
          } else {
            result = evaluateOutputFormat(
              constraint.rule as OutputFormatRule,
              context.output
            );
          }
          break;

        case "behavioral":
          if (!context.behavioral) {
            result = { passed: true }; // Not applicable
          } else {
            result = evaluateBehavioral(
              constraint.rule as BehavioralRule,
              context.behavioral
            );
          }
          break;

        case "temporal":
          if (!context.temporal) {
            result = { passed: true }; // Not applicable
          } else {
            result = evaluateTemporal(
              constraint.rule as TemporalRule,
              context.temporal
            );
          }
          break;

        case "resource":
          if (!context.resource) {
            result = { passed: true }; // Not applicable
          } else {
            result = evaluateResource(
              constraint.rule as ResourceRule,
              context.resource
            );
          }
          break;

        case "side_effect":
          if (!context.sideEffect) {
            result = { passed: true }; // Not applicable
          } else {
            result = evaluateSideEffect(
              constraint.rule as SideEffectRule,
              context.sideEffect
            );
          }
          break;

        default:
          result = {
            passed: false,
            reason: `Unknown constraint type: ${(constraint.rule as any).type}`,
          };
      }
    } catch (error) {
      result = {
        passed: false,
        reason: `Evaluation error: ${error instanceof Error ? error.message : "unknown error"}`,
      };
    }

    const evaluationTimeMs = Date.now() - startTime;

    if (result.passed) {
      return {
        passed: true,
        constraintId: constraint.id,
        severity: constraint.severity,
        message: constraint.message,
        evaluationTimeMs,
      };
    } else {
      return {
        passed: false,
        constraintId: constraint.id,
        severity: constraint.severity,
        message: constraint.message,
        failureReason: result.reason,
        failureContext: this.extractRelevantContext(constraint.rule.type, context),
        evaluationTimeMs,
      };
    }
  }

  /**
   * Evaluate multiple constraints against the provided context
   */
  evaluateAll(
    constraints: ProtocolConstraint[],
    context: EvaluationContext
  ): ConstraintEvaluationResult[] {
    return constraints.map((constraint) => this.evaluate(constraint, context));
  }

  /**
   * Evaluate constraints and return summary result
   */
  evaluateWithSummary(
    constraints: ProtocolConstraint[],
    context: EvaluationContext
  ): {
    allPassed: boolean;
    results: ConstraintEvaluationResult[];
    errors: ConstraintEvaluationResult[];
    warnings: ConstraintEvaluationResult[];
    totalTimeMs: number;
  } {
    const startTime = Date.now();
    const results = this.evaluateAll(constraints, context);

    const errors = results.filter(
      (r) => !r.passed && r.severity === "error"
    );
    const warnings = results.filter(
      (r) => !r.passed && r.severity === "warning"
    );

    return {
      allPassed: errors.length === 0,
      results,
      errors,
      warnings,
      totalTimeMs: Date.now() - startTime,
    };
  }

  /**
   * Extract relevant context for failure reporting
   */
  private extractRelevantContext(
    type: string,
    context: EvaluationContext
  ): Record<string, unknown> {
    switch (type) {
      case "tool_restriction":
        return context.tool ? { tool: context.tool } : {};
      case "file_access":
        return context.file
          ? {
              filePath: context.file.filePath,
              operation: context.file.operation,
            }
          : {};
      case "output_format":
        return context.output
          ? {
              format: context.output.format,
              length: context.output.content.length,
            }
          : {};
      case "behavioral":
        return context.behavioral ? { action: context.behavioral.action } : {};
      case "temporal":
        return context.temporal
          ? { timestamp: context.temporal.timestamp.toISOString() }
          : {};
      case "resource":
        return context.resource
          ? { ...context.resource } as Record<string, unknown>
          : {};
      case "side_effect":
        return context.sideEffect
          ? { ...context.sideEffect } as Record<string, unknown>
          : {};
      default:
        return {};
    }
  }
}

/**
 * Create a default constraint evaluator instance
 */
export function createConstraintEvaluator(): ConstraintEvaluator {
  return new ConstraintEvaluator();
}
