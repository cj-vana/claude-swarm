/**
 * Base Constraints - Immutable security boundaries for Protocol-Based Behavioral Governance
 *
 * This module defines the foundational constraints that LLM-generated protocols
 * MUST respect. These constraints are immutable and cannot be overridden by
 * any generated or user-defined protocol.
 *
 * Key principles:
 * 1. Defense in Depth: Multiple layers of protection
 * 2. Principle of Least Privilege: Only allow what's explicitly needed
 * 3. Fail Secure: Default to denial when in doubt
 * 4. Immutability: Base constraints cannot be modified at runtime
 *
 * @see schema.ts for BaseConstraints type definition
 */

import { z } from "zod";
import type { BaseConstraints, Protocol, ProtocolConstraint, ConstraintRule } from "./schema.js";
import { BaseConstraintsSchema, ConstraintSeveritySchema } from "./schema.js";

// ============================================================================
// Immutable Default Base Constraints
// ============================================================================

/**
 * The default base constraints that all protocols must respect.
 * This object is frozen to prevent runtime modification.
 *
 * These constraints establish the absolute security boundaries that
 * no generated protocol can violate, regardless of its priority or source.
 */
const DEFAULT_BASE_CONSTRAINTS: BaseConstraints = {
  // Absolute prohibitions - tools that can NEVER be allowed by any protocol
  prohibitedTools: [
    // System modification tools
    "rm -rf",
    "mkfs",
    "dd",
    "format",
    // Privilege escalation
    "sudo",
    "su",
    "doas",
    "pkexec",
    // Dangerous system operations
    "chmod 777",
    "chown root",
    // Network exfiltration tools
    "curl | sh",
    "wget | sh",
    "nc -e",
    "netcat -e",
    // Process injection
    "gdb",
    "ptrace",
    "strace",
  ],

  // Paths that can NEVER be accessed by any protocol
  prohibitedPaths: [
    // System directories
    "/etc/passwd",
    "/etc/shadow",
    "/etc/sudoers",
    "/etc/ssh",
    "/root",
    "/boot",
    "/proc/kcore",
    "/dev/mem",
    "/dev/kmem",
    // User sensitive data
    "~/.ssh",
    "~/.gnupg",
    "~/.aws/credentials",
    "~/.azure",
    "~/.gcloud",
    "~/.config/gcloud",
    // Secrets and credentials
    ".env.production",
    ".env.local",
    "**/credentials.json",
    "**/secrets.yaml",
    "**/secrets.json",
    "**/.vault-token",
    "**/id_rsa",
    "**/id_ed25519",
    // Windows equivalents
    "C:\\Windows\\System32",
    "C:\\Windows\\SysWOW64",
    "%USERPROFILE%\\.ssh",
  ],

  // Operations that are NEVER allowed
  prohibitedOperations: [
    // Destructive git operations
    "git push --force origin main",
    "git push --force origin master",
    "git reset --hard origin",
    "git clean -fdx",
    // Database destruction
    "DROP DATABASE",
    "TRUNCATE TABLE",
    "DELETE FROM * WHERE 1=1",
    // Container escape
    "docker run --privileged",
    "--cap-add=SYS_ADMIN",
    "--security-opt seccomp=unconfined",
    // Kubernetes privilege escalation
    "kubectl exec",
    "kubectl cp",
    // Arbitrary code execution
    "eval()",
    "exec()",
    "Function()",
    "child_process.exec",
    "os.system",
    "subprocess.call",
  ],

  // Minimum severity level required to block an operation
  // Protocols cannot lower this threshold
  minSeverityForBlock: "warning",

  // Pre-validation is always required - cannot be disabled
  requirePreValidation: true,

  // Post-validation is always required - cannot be disabled
  requirePostValidation: true,

  // Maximum tools that any protocol can grant access to
  // If undefined, there's no maximum (all tools allowed except prohibited)
  // This list is the MOST permissive set - protocols can only restrict, not expand
  maxAllowedTools: [
    "Bash",
    "Read",
    "Write",
    "Edit",
    "Glob",
    "Grep",
    "Task",
    "TodoWrite",
    "AskUserQuestion",
  ],

  // Maximum paths that can ever be allowed
  // Protocols can only restrict access within these bounds
  maxAllowedPaths: [
    // Project directory (dynamically validated)
    ".",
    "./**",
    // Standard development directories
    "src/**",
    "lib/**",
    "test/**",
    "tests/**",
    "spec/**",
    "docs/**",
    "scripts/**",
    "config/**",
    "public/**",
    "assets/**",
    "dist/**",
    "build/**",
    "node_modules/**",
    // Configuration files
    "*.json",
    "*.yaml",
    "*.yml",
    "*.toml",
    "*.md",
    "*.txt",
    // Non-sensitive env files
    ".env.example",
    ".env.template",
  ],

  // Audit logging is always required
  requireAuditLog: true,

  // Minimum retention period for audit logs (in days)
  auditRetentionDays: 30,
};

// Freeze the object and all nested arrays to prevent runtime modification
Object.freeze(DEFAULT_BASE_CONSTRAINTS);
Object.freeze(DEFAULT_BASE_CONSTRAINTS.prohibitedTools);
Object.freeze(DEFAULT_BASE_CONSTRAINTS.prohibitedPaths);
Object.freeze(DEFAULT_BASE_CONSTRAINTS.prohibitedOperations);
if (DEFAULT_BASE_CONSTRAINTS.maxAllowedTools) {
  Object.freeze(DEFAULT_BASE_CONSTRAINTS.maxAllowedTools);
}
if (DEFAULT_BASE_CONSTRAINTS.maxAllowedPaths) {
  Object.freeze(DEFAULT_BASE_CONSTRAINTS.maxAllowedPaths);
}

// ============================================================================
// Base Constraint Validation Types
// ============================================================================

/**
 * Result of validating a protocol against base constraints
 */
export interface BaseConstraintValidationResult {
  /** Whether the protocol passes all base constraint checks */
  isValid: boolean;

  /** List of violations found */
  violations: BaseConstraintViolation[];

  /** Warnings (issues that don't fail validation but should be noted) */
  warnings: BaseConstraintWarning[];

  /** The protocol ID that was validated */
  protocolId: string;

  /** Timestamp of validation */
  validatedAt: string;
}

/**
 * A violation of base constraints
 */
export interface BaseConstraintViolation {
  /** Type of violation */
  type:
    | "prohibited_tool"
    | "prohibited_path"
    | "prohibited_operation"
    | "severity_too_low"
    | "missing_pre_validation"
    | "missing_post_validation"
    | "exceeded_max_tools"
    | "exceeded_max_paths"
    | "missing_audit_log"
    | "insufficient_audit_retention";

  /** Human-readable message */
  message: string;

  /** The constraint ID that caused the violation */
  constraintId?: string;

  /** Additional context about the violation */
  details: Record<string, unknown>;
}

/**
 * A warning about potential issues
 */
export interface BaseConstraintWarning {
  /** Type of warning */
  type: "permissive_path" | "broad_tool_access" | "low_severity" | "unusual_configuration";

  /** Human-readable message */
  message: string;

  /** Additional context */
  details: Record<string, unknown>;
}

// Zod schemas for validation results
export const BaseConstraintViolationSchema = z.object({
  type: z.enum([
    "prohibited_tool",
    "prohibited_path",
    "prohibited_operation",
    "severity_too_low",
    "missing_pre_validation",
    "missing_post_validation",
    "exceeded_max_tools",
    "exceeded_max_paths",
    "missing_audit_log",
    "insufficient_audit_retention",
  ]),
  message: z.string(),
  constraintId: z.string().optional(),
  details: z.record(z.unknown()),
});

export const BaseConstraintWarningSchema = z.object({
  type: z.enum([
    "permissive_path",
    "broad_tool_access",
    "low_severity",
    "unusual_configuration",
  ]),
  message: z.string(),
  details: z.record(z.unknown()),
});

export const BaseConstraintValidationResultSchema = z.object({
  isValid: z.boolean(),
  violations: z.array(BaseConstraintViolationSchema),
  warnings: z.array(BaseConstraintWarningSchema),
  protocolId: z.string(),
  validatedAt: z.string(),
});

// ============================================================================
// Core Functions
// ============================================================================

/**
 * Get the immutable base constraints.
 *
 * This function returns a deep-frozen copy of the base constraints
 * to prevent any accidental or malicious modification.
 *
 * @returns Readonly base constraints
 */
export function getBaseConstraints(): BaseConstraints {
  // Return the frozen default - it's already immutable
  return DEFAULT_BASE_CONSTRAINTS;
}

/**
 * Validate custom base constraints against the schema.
 *
 * Note: Custom base constraints can only be MORE restrictive than defaults,
 * never less restrictive. This function validates the structure but does
 * not enforce the "more restrictive" rule - use mergeWithDefaults for that.
 *
 * @param constraints - Custom constraints to validate
 * @returns Validated constraints
 * @throws If constraints don't match the schema
 */
export function validateBaseConstraints(constraints: unknown): BaseConstraints {
  return BaseConstraintsSchema.parse(constraints);
}

/**
 * Merge custom constraints with defaults, ensuring we only get MORE restrictive.
 *
 * This function takes custom constraints and merges them with defaults,
 * ensuring that the result is always at least as restrictive as the defaults:
 * - Prohibited items are ADDED (union)
 * - Max allowed items are RESTRICTED (intersection)
 * - Boolean requirements use OR (if either requires it, result requires it)
 * - Numeric thresholds use MAX for requirements, MIN for limits
 *
 * @param custom - Custom constraints to merge
 * @returns Merged constraints that are at least as restrictive as defaults
 */
export function mergeWithDefaults(
  custom: Partial<BaseConstraints>
): BaseConstraints {
  const defaults = getBaseConstraints();

  // Helper to merge arrays by union (more items = more restrictive for prohibitions)
  const unionArrays = (a: string[], b: string[] | undefined): string[] => {
    if (!b) return [...a];
    return [...new Set([...a, ...b])];
  };

  // Helper to merge arrays by intersection (fewer items = more restrictive for allowances)
  const intersectArrays = (
    a: string[] | undefined,
    b: string[] | undefined
  ): string[] | undefined => {
    if (!a) return b ? [...b] : undefined;
    if (!b) return [...a];
    const setB = new Set(b);
    return a.filter((item) => setB.has(item));
  };

  // Helper to get more restrictive severity
  const moreRestrictiveSeverity = (
    a: "error" | "warning" | "info",
    b: "error" | "warning" | "info" | undefined
  ): "error" | "warning" | "info" => {
    if (!b) return a;
    const order = { error: 0, warning: 1, info: 2 };
    return order[a] <= order[b] ? a : b;
  };

  const merged: BaseConstraints = {
    // Prohibited items - use union (more = more restrictive)
    prohibitedTools: unionArrays(defaults.prohibitedTools, custom.prohibitedTools),
    prohibitedPaths: unionArrays(defaults.prohibitedPaths, custom.prohibitedPaths),
    prohibitedOperations: unionArrays(
      defaults.prohibitedOperations,
      custom.prohibitedOperations
    ),

    // Severity - use more restrictive
    minSeverityForBlock: moreRestrictiveSeverity(
      defaults.minSeverityForBlock,
      custom.minSeverityForBlock
    ),

    // Boolean requirements - use OR (if either requires, result requires)
    requirePreValidation: defaults.requirePreValidation || (custom.requirePreValidation ?? false),
    requirePostValidation:
      defaults.requirePostValidation || (custom.requirePostValidation ?? false),
    requireAuditLog: defaults.requireAuditLog || (custom.requireAuditLog ?? false),

    // Max allowed - use intersection (fewer = more restrictive)
    maxAllowedTools: intersectArrays(
      defaults.maxAllowedTools,
      custom.maxAllowedTools
    ),
    maxAllowedPaths: intersectArrays(
      defaults.maxAllowedPaths,
      custom.maxAllowedPaths
    ),

    // Audit retention - use MAX (longer = more restrictive)
    auditRetentionDays: Math.max(
      defaults.auditRetentionDays,
      custom.auditRetentionDays ?? 0
    ),
  };

  // Freeze the merged result to prevent modification
  Object.freeze(merged);
  Object.freeze(merged.prohibitedTools);
  Object.freeze(merged.prohibitedPaths);
  Object.freeze(merged.prohibitedOperations);
  if (merged.maxAllowedTools) Object.freeze(merged.maxAllowedTools);
  if (merged.maxAllowedPaths) Object.freeze(merged.maxAllowedPaths);

  return merged;
}

// ============================================================================
// Protocol Validation
// ============================================================================

/**
 * Validate a protocol against base constraints.
 *
 * This is the primary function for checking if an LLM-generated or
 * user-defined protocol respects the immutable base constraints.
 *
 * @param protocol - Protocol to validate
 * @param customBaseConstraints - Optional custom base constraints (merged with defaults)
 * @returns Validation result with violations and warnings
 */
export function validateProtocolAgainstBaseConstraints(
  protocol: Protocol,
  customBaseConstraints?: Partial<BaseConstraints>
): BaseConstraintValidationResult {
  const baseConstraints = customBaseConstraints
    ? mergeWithDefaults(customBaseConstraints)
    : getBaseConstraints();

  const violations: BaseConstraintViolation[] = [];
  const warnings: BaseConstraintWarning[] = [];

  // Check enforcement configuration
  if (
    baseConstraints.requirePreValidation &&
    !protocol.enforcement.preExecutionValidation
  ) {
    violations.push({
      type: "missing_pre_validation",
      message: "Protocol must have pre-execution validation enabled",
      details: { required: true, actual: protocol.enforcement.preExecutionValidation },
    });
  }

  if (
    baseConstraints.requirePostValidation &&
    !protocol.enforcement.postExecutionValidation
  ) {
    violations.push({
      type: "missing_post_validation",
      message: "Protocol must have post-execution validation enabled",
      details: { required: true, actual: protocol.enforcement.postExecutionValidation },
    });
  }

  // Check each constraint in the protocol
  for (const constraint of protocol.constraints) {
    const constraintViolations = validateConstraintAgainstBase(
      constraint,
      baseConstraints
    );
    violations.push(...constraintViolations);

    // Check for warnings
    const constraintWarnings = checkConstraintWarnings(constraint);
    warnings.push(...constraintWarnings);
  }

  // Check logging requirements
  if (baseConstraints.requireAuditLog && protocol.enforcement.logLevel === "none") {
    violations.push({
      type: "missing_audit_log",
      message: "Protocol must have audit logging enabled",
      details: { required: true, actual: protocol.enforcement.logLevel },
    });
  }

  return {
    isValid: violations.length === 0,
    violations,
    warnings,
    protocolId: protocol.id,
    validatedAt: new Date().toISOString(),
  };
}

/**
 * Validate a single constraint against base constraints
 */
function validateConstraintAgainstBase(
  constraint: ProtocolConstraint,
  baseConstraints: Readonly<BaseConstraints>
): BaseConstraintViolation[] {
  const violations: BaseConstraintViolation[] = [];

  // Check based on constraint type
  switch (constraint.rule.type) {
    case "tool_restriction":
      violations.push(
        ...validateToolRestriction(constraint, baseConstraints)
      );
      break;

    case "file_access":
      violations.push(
        ...validateFileAccess(constraint, baseConstraints)
      );
      break;

    case "side_effect":
      violations.push(
        ...validateSideEffect(constraint, baseConstraints)
      );
      break;

    case "behavioral":
      violations.push(
        ...validateBehavioral(constraint, baseConstraints)
      );
      break;
  }

  return violations;
}

/**
 * Validate tool_restriction rule against base constraints
 */
function validateToolRestriction(
  constraint: ProtocolConstraint,
  baseConstraints: Readonly<BaseConstraints>
): BaseConstraintViolation[] {
  const violations: BaseConstraintViolation[] = [];
  const rule = constraint.rule as { type: "tool_restriction"; allowedTools?: string[]; deniedTools?: string[] };

  // Check if any allowed tools are in the prohibited list
  if (rule.allowedTools) {
    for (const tool of rule.allowedTools) {
      if (isToolProhibited(tool, baseConstraints.prohibitedTools)) {
        violations.push({
          type: "prohibited_tool",
          message: `Tool "${tool}" is prohibited by base constraints`,
          constraintId: constraint.id,
          details: { tool, prohibitedTools: baseConstraints.prohibitedTools },
        });
      }
    }

    // Check against max allowed tools
    if (baseConstraints.maxAllowedTools) {
      for (const tool of rule.allowedTools) {
        if (!baseConstraints.maxAllowedTools.includes(tool)) {
          violations.push({
            type: "exceeded_max_tools",
            message: `Tool "${tool}" exceeds maximum allowed tools`,
            constraintId: constraint.id,
            details: { tool, maxAllowedTools: baseConstraints.maxAllowedTools },
          });
        }
      }
    }
  }

  return violations;
}

/**
 * Validate file_access rule against base constraints
 */
function validateFileAccess(
  constraint: ProtocolConstraint,
  baseConstraints: Readonly<BaseConstraints>
): BaseConstraintViolation[] {
  const violations: BaseConstraintViolation[] = [];
  const rule = constraint.rule as { type: "file_access"; allowedPaths?: string[]; deniedPaths?: string[] };

  // Check if any allowed paths are in the prohibited list
  if (rule.allowedPaths) {
    for (const path of rule.allowedPaths) {
      if (isPathProhibited(path, baseConstraints.prohibitedPaths)) {
        violations.push({
          type: "prohibited_path",
          message: `Path "${path}" is prohibited by base constraints`,
          constraintId: constraint.id,
          details: { path, prohibitedPaths: baseConstraints.prohibitedPaths },
        });
      }
    }
  }

  return violations;
}

/**
 * Validate side_effect rule against base constraints
 */
function validateSideEffect(
  constraint: ProtocolConstraint,
  baseConstraints: Readonly<BaseConstraints>
): BaseConstraintViolation[] {
  const violations: BaseConstraintViolation[] = [];
  const rule = constraint.rule as { type: "side_effect"; allowedCommands?: string[] };

  // Check if any allowed commands contain prohibited operations
  if (rule.allowedCommands) {
    for (const cmd of rule.allowedCommands) {
      if (isOperationProhibited(cmd, baseConstraints.prohibitedOperations)) {
        violations.push({
          type: "prohibited_operation",
          message: `Command "${cmd}" contains prohibited operation`,
          constraintId: constraint.id,
          details: { command: cmd },
        });
      }
    }
  }

  return violations;
}

/**
 * Validate behavioral rule against base constraints
 */
function validateBehavioral(
  constraint: ProtocolConstraint,
  baseConstraints: Readonly<BaseConstraints>
): BaseConstraintViolation[] {
  const violations: BaseConstraintViolation[] = [];
  const rule = constraint.rule as { type: "behavioral"; prohibitedActions?: string[] };

  // Check if the constraint allows any prohibited operations
  // (inverse check - we want prohibitedActions to NOT overlap with allowed operations)
  // This is actually fine - adding to prohibitedActions is always allowed

  return violations;
}

/**
 * Check for warnings in a constraint
 */
function checkConstraintWarnings(
  constraint: ProtocolConstraint
): BaseConstraintWarning[] {
  const warnings: BaseConstraintWarning[] = [];

  // Warn about info-level severity for non-trivial constraints
  if (constraint.severity === "info" && constraint.type !== "output_format") {
    warnings.push({
      type: "low_severity",
      message: `Constraint "${constraint.id}" has info-level severity which won't block violations`,
      details: { constraintId: constraint.id, severity: constraint.severity },
    });
  }

  // Warn about broad tool access
  if (constraint.rule.type === "tool_restriction") {
    const rule = constraint.rule as { allowedTools?: string[] };
    if (rule.allowedTools && rule.allowedTools.length > 5) {
      warnings.push({
        type: "broad_tool_access",
        message: `Constraint "${constraint.id}" allows ${rule.allowedTools.length} tools`,
        details: { constraintId: constraint.id, toolCount: rule.allowedTools.length },
      });
    }
  }

  // Warn about permissive paths
  if (constraint.rule.type === "file_access") {
    const rule = constraint.rule as { allowedPaths?: string[] };
    if (rule.allowedPaths) {
      for (const path of rule.allowedPaths) {
        if (path.includes("**") || path === "*" || path === ".") {
          warnings.push({
            type: "permissive_path",
            message: `Constraint "${constraint.id}" has very permissive path pattern: ${path}`,
            details: { constraintId: constraint.id, path },
          });
        }
      }
    }
  }

  return warnings;
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Check if a tool is prohibited
 * Uses exact match for single-word tools, token-based matching for command patterns
 * This prevents false positives (e.g., "npm" being blocked when "rm" is prohibited)
 */
function isToolProhibited(tool: string, prohibitedTools: string[]): boolean {
  const normalizedTool = tool.toLowerCase().trim();
  return prohibitedTools.some((prohibited) => {
    const normalizedProhibited = prohibited.toLowerCase().trim();

    // Exact match only for single-word tools
    if (!normalizedProhibited.includes(" ")) {
      return normalizedTool === normalizedProhibited;
    }

    // For command patterns (e.g., "rm -rf"), check if tool starts with command
    // and the prohibited pattern appears as a complete token sequence
    const prohibitedTokens = normalizedProhibited.split(/\s+/);
    const toolTokens = normalizedTool.split(/\s+/);

    if (toolTokens.length < prohibitedTokens.length) return false;

    // Check if all prohibited tokens match at the start of tool tokens
    return prohibitedTokens.every((token, i) => toolTokens[i] === token);
  });
}

/**
 * Check if a path is prohibited
 * Protected against ReDoS by escaping all regex metacharacters before glob conversion
 */
function isPathProhibited(path: string, prohibitedPaths: string[]): boolean {
  const normalizedPath = path.toLowerCase().trim();
  return prohibitedPaths.some((prohibited) => {
    const normalizedProhibited = prohibited.toLowerCase().trim();

    // Handle glob patterns
    if (normalizedProhibited.includes("*") || normalizedProhibited.includes("?")) {
      // Convert glob to regex with proper escaping
      // First escape ALL regex metacharacters except * and ?
      const regexPattern = normalizedProhibited
        .replace(/[.+^${}()|[\]\\]/g, "\\$&") // Escape regex metacharacters first
        .replace(/\*\*/g, "<<<GLOBSTAR>>>")    // Preserve globstar
        .replace(/\*/g, "[^/]*")               // Single star = anything except /
        .replace(/<<<GLOBSTAR>>>/g, ".*")      // Globstar = anything including /
        .replace(/\?/g, "[^/]");               // Question mark = single char except /

      try {
        const regex = new RegExp(`^${regexPattern}$`);
        return regex.test(normalizedPath);
      } catch {
        // Invalid regex, fall back to substring
        return normalizedPath.includes(normalizedProhibited.replace(/[*?]/g, ""));
      }
    }

    // Exact match or prefix match (with path separator boundary check)
    if (normalizedPath === normalizedProhibited) {
      return true;
    }
    // Prefix match: ensure it's a directory boundary (ends with / or the path has / after)
    if (normalizedPath.startsWith(normalizedProhibited)) {
      const charAfter = normalizedPath[normalizedProhibited.length];
      return charAfter === "/" || charAfter === undefined;
    }
    return false;
  });
}

/**
 * Check if an operation/command is prohibited
 */
function isOperationProhibited(
  operation: string,
  prohibitedOperations: string[]
): boolean {
  const normalizedOp = operation.toLowerCase().trim();
  return prohibitedOperations.some((prohibited) => {
    const normalizedProhibited = prohibited.toLowerCase().trim();
    // Substring match for operations
    return normalizedOp.includes(normalizedProhibited);
  });
}

/**
 * Create a strict protocol that enforces all base constraints
 *
 * This is a factory function to create a protocol that incorporates
 * all base constraints as actual protocol constraints. Useful for
 * creating a "meta-protocol" that other protocols must satisfy.
 *
 * @param id - Protocol ID
 * @param name - Protocol name
 * @returns A protocol with all base constraints as protocol constraints
 */
export function createBaseConstraintProtocol(
  id: string = "base-security",
  name: string = "Base Security Protocol"
): Protocol {
  const baseConstraints = getBaseConstraints();

  const constraints: ProtocolConstraint[] = [];

  // Create tool restriction constraint from prohibited tools
  constraints.push({
    id: "base-prohibited-tools",
    type: "tool_restriction",
    rule: {
      type: "tool_restriction",
      deniedTools: [...baseConstraints.prohibitedTools],
      allowedTools: baseConstraints.maxAllowedTools
        ? [...baseConstraints.maxAllowedTools]
        : undefined,
    },
    severity: "error",
    message: "Tool is prohibited by base security constraints",
    enabled: true,
  });

  // Create file access constraint from prohibited paths
  constraints.push({
    id: "base-prohibited-paths",
    type: "file_access",
    rule: {
      type: "file_access",
      deniedPaths: [...baseConstraints.prohibitedPaths],
      allowedPaths: baseConstraints.maxAllowedPaths
        ? [...baseConstraints.maxAllowedPaths]
        : undefined,
    },
    severity: "error",
    message: "Path is prohibited by base security constraints",
    enabled: true,
  });

  // Create side effect constraint from prohibited operations
  constraints.push({
    id: "base-prohibited-operations",
    type: "side_effect",
    rule: {
      type: "side_effect",
      deniedCommands: [...baseConstraints.prohibitedOperations],
    },
    severity: "error",
    message: "Operation is prohibited by base security constraints",
    enabled: true,
  });

  // Create behavioral constraint requiring audit logging
  constraints.push({
    id: "base-audit-requirement",
    type: "behavioral",
    rule: {
      type: "behavioral",
      requireExplanation: true,
      requiredActions: ["log_audit_entry"],
    },
    severity: "warning",
    message: "All operations must be logged to the audit trail",
    enabled: baseConstraints.requireAuditLog,
  });

  return {
    id,
    version: "1.0.0",
    name,
    description:
      "Immutable base security protocol that enforces foundational constraints. " +
      "This protocol cannot be overridden and all other protocols must respect its constraints.",
    constraints,
    enforcement: {
      mode: "strict",
      preExecutionValidation: baseConstraints.requirePreValidation,
      postExecutionValidation: baseConstraints.requirePostValidation,
      onViolation: "block",
      maxRetries: 0,
      retryDelaySeconds: 0,
      logLevel: "verbose",
      includeContext: true,
      allowOverride: false, // Critical: base constraints cannot be overridden
      overrideRequiresApproval: true,
    },
    applicableContexts: {
      // Applies to everything
    },
    priority: 1000, // Maximum priority
    enabled: true,
    deprecated: false,
    createdAt: new Date().toISOString(),
    tags: ["security", "base", "immutable"],
  };
}

// ============================================================================
// Exports
// ============================================================================

export {
  DEFAULT_BASE_CONSTRAINTS,
};
