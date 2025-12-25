/**
 * Protocol Schema - Types and validation for Protocol-Based Behavioral Governance
 *
 * This module defines the core schema for protocols that govern worker behavior.
 * Protocols define constraints, enforcement rules, and context matching for
 * controlling how workers interact with tools, files, and outputs.
 *
 * Key concepts:
 * - Protocol: A named, versioned set of constraints with enforcement configuration
 * - ProtocolConstraint: Individual rules within a protocol
 * - ContextMatcher: Determines when a protocol applies
 * - EnforcementConfig: Controls how violations are handled
 */

import { z } from "zod";

// ============================================================================
// Constraint Types Enum
// ============================================================================

/**
 * Types of constraints that can be applied to worker behavior
 */
export const ConstraintTypeSchema = z.enum([
  "tool_restriction",   // Controls which tools can be used
  "file_access",        // Controls file read/write permissions
  "output_format",      // Controls output structure and content
  "behavioral",         // General behavioral guidelines
  "temporal",           // Time-based constraints (e.g., rate limits)
  "resource",           // Resource usage limits (memory, CPU, etc.)
  "side_effect",        // Controls side effects (network, filesystem, etc.)
]);

export type ConstraintType = z.infer<typeof ConstraintTypeSchema>;

// ============================================================================
// Constraint Severity
// ============================================================================

/**
 * Severity levels for constraint violations
 */
export const ConstraintSeveritySchema = z.enum([
  "error",    // Must not proceed - hard failure
  "warning",  // Proceed with caution - logged but allowed
  "info",     // Informational - noted but no action required
]);

export type ConstraintSeverity = z.infer<typeof ConstraintSeveritySchema>;

// ============================================================================
// Constraint Rules
// ============================================================================

/**
 * Tool restriction rule - controls which tools can be used
 */
export const ToolRestrictionRuleSchema = z.object({
  type: z.literal("tool_restriction"),
  allowedTools: z.array(z.string()).optional(),    // Whitelist of allowed tools
  deniedTools: z.array(z.string()).optional(),     // Blacklist of denied tools
  toolPatterns: z.array(z.string()).optional(),    // Regex patterns for tool names
  requireApproval: z.array(z.string()).optional(), // Tools requiring explicit approval
});

export type ToolRestrictionRule = z.infer<typeof ToolRestrictionRuleSchema>;

/**
 * File access rule - controls file read/write permissions
 */
export const FileAccessRuleSchema = z.object({
  type: z.literal("file_access"),
  allowedPaths: z.array(z.string()).optional(),    // Glob patterns for allowed paths
  deniedPaths: z.array(z.string()).optional(),     // Glob patterns for denied paths
  readOnly: z.array(z.string()).optional(),        // Paths with read-only access
  writeOnly: z.array(z.string()).optional(),       // Paths with write-only access
  maxFileSize: z.number().optional(),              // Max file size in bytes
  allowedExtensions: z.array(z.string()).optional(), // Allowed file extensions
  deniedExtensions: z.array(z.string()).optional(),  // Denied file extensions
});

export type FileAccessRule = z.infer<typeof FileAccessRuleSchema>;

/**
 * Output format rule - controls output structure and content
 */
export const OutputFormatRuleSchema = z.object({
  type: z.literal("output_format"),
  maxLength: z.number().optional(),                // Max output length in characters
  requiredFields: z.array(z.string()).optional(),  // Required fields in structured output
  forbiddenPatterns: z.array(z.string()).optional(), // Regex patterns to reject
  requiredPatterns: z.array(z.string()).optional(),  // Regex patterns that must match
  format: z.enum(["json", "markdown", "text", "yaml", "custom"]).optional(),
  schema: z.record(z.unknown()).optional(),        // JSON schema for validation
});

export type OutputFormatRule = z.infer<typeof OutputFormatRuleSchema>;

/**
 * Behavioral rule - general behavioral guidelines
 */
export const BehavioralRuleSchema = z.object({
  type: z.literal("behavioral"),
  requireConfirmation: z.boolean().optional(),     // Require user confirmation
  maxIterations: z.number().optional(),            // Max loop iterations
  timeoutSeconds: z.number().optional(),           // Operation timeout
  requireExplanation: z.boolean().optional(),      // Require explanation for actions
  prohibitedActions: z.array(z.string()).optional(), // Actions that are never allowed
  requiredActions: z.array(z.string()).optional(),   // Actions that must be performed
});

export type BehavioralRule = z.infer<typeof BehavioralRuleSchema>;

/**
 * Temporal rule - time-based constraints
 */
export const TemporalRuleSchema = z.object({
  type: z.literal("temporal"),
  rateLimitPerMinute: z.number().optional(),       // Max operations per minute
  rateLimitPerHour: z.number().optional(),         // Max operations per hour
  cooldownSeconds: z.number().optional(),          // Required cooldown between operations
  validFrom: z.string().optional(),                // ISO timestamp - constraint starts
  validUntil: z.string().optional(),               // ISO timestamp - constraint ends
  allowedHours: z.array(z.number()).optional(),    // Hours when operation is allowed (0-23)
  allowedDays: z.array(z.number()).optional(),     // Days when allowed (0=Sunday, 6=Saturday)
});

export type TemporalRule = z.infer<typeof TemporalRuleSchema>;

/**
 * Resource rule - resource usage limits
 */
export const ResourceRuleSchema = z.object({
  type: z.literal("resource"),
  maxMemoryMB: z.number().optional(),              // Max memory usage in MB
  maxCpuPercent: z.number().optional(),            // Max CPU usage percent
  maxConcurrentOps: z.number().optional(),         // Max concurrent operations
  maxDiskWriteMB: z.number().optional(),           // Max disk write per operation
  maxNetworkRequestsPerMin: z.number().optional(), // Network rate limit
  maxTokensPerRequest: z.number().optional(),      // LLM token limit
});

export type ResourceRule = z.infer<typeof ResourceRuleSchema>;

/**
 * Side effect rule - controls side effects
 */
export const SideEffectRuleSchema = z.object({
  type: z.literal("side_effect"),
  allowNetwork: z.boolean().optional(),            // Allow network access
  allowedHosts: z.array(z.string()).optional(),    // Allowed network hosts
  deniedHosts: z.array(z.string()).optional(),     // Denied network hosts
  allowShellCommands: z.boolean().optional(),      // Allow shell command execution
  allowedCommands: z.array(z.string()).optional(), // Whitelist of shell commands
  deniedCommands: z.array(z.string()).optional(),  // Blacklist of shell commands
  allowGitOperations: z.boolean().optional(),      // Allow git operations
  allowedGitOps: z.array(z.string()).optional(),   // Allowed git operations
  deniedGitOps: z.array(z.string()).optional(),    // Denied git operations
});

export type SideEffectRule = z.infer<typeof SideEffectRuleSchema>;

/**
 * Union of all constraint rule types
 */
export const ConstraintRuleSchema = z.discriminatedUnion("type", [
  ToolRestrictionRuleSchema,
  FileAccessRuleSchema,
  OutputFormatRuleSchema,
  BehavioralRuleSchema,
  TemporalRuleSchema,
  ResourceRuleSchema,
  SideEffectRuleSchema,
]);

export type ConstraintRule = z.infer<typeof ConstraintRuleSchema>;

// ============================================================================
// Protocol Constraint
// ============================================================================

/**
 * A single constraint within a protocol
 */
export const ProtocolConstraintSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]+$/, "Constraint ID must be alphanumeric with dashes/underscores"),
  type: ConstraintTypeSchema,
  rule: ConstraintRuleSchema,
  severity: ConstraintSeveritySchema,
  message: z.string().max(500),                    // Human-readable description
  enabled: z.boolean().default(true),              // Whether constraint is active
  conditions: z.array(z.string()).optional(),      // Additional conditions for evaluation
});

export type ProtocolConstraint = z.infer<typeof ProtocolConstraintSchema>;

// ============================================================================
// Context Matcher
// ============================================================================

/**
 * Determines when a protocol should be applied
 */
export const ContextMatcherSchema = z.object({
  // Feature-based matching
  featurePatterns: z.array(z.string()).optional(),     // Regex patterns for feature IDs
  featureDescriptionPatterns: z.array(z.string()).optional(), // Patterns for feature descriptions

  // File-based matching
  filePatterns: z.array(z.string()).optional(),        // Glob patterns for files being modified
  fileExtensions: z.array(z.string()).optional(),      // File extensions to match

  // Project-based matching
  projectPatterns: z.array(z.string()).optional(),     // Patterns for project paths
  projectTypes: z.array(z.string()).optional(),        // Project types (node, python, rust, etc.)

  // Task-based matching
  taskPatterns: z.array(z.string()).optional(),        // Patterns for task descriptions
  taskTypes: z.array(z.string()).optional(),           // Task types (refactor, implement, fix, etc.)

  // Environment-based matching
  environments: z.array(z.string()).optional(),        // Environments (development, staging, production)
  branches: z.array(z.string()).optional(),            // Git branch patterns

  // Worker-based matching
  workerPatterns: z.array(z.string()).optional(),      // Patterns for worker IDs
  workerTags: z.array(z.string()).optional(),          // Tags assigned to workers

  // Exclusions - contexts where protocol should NOT apply
  excludeFeatures: z.array(z.string()).optional(),
  excludeFiles: z.array(z.string()).optional(),
  excludeProjects: z.array(z.string()).optional(),
  excludeTasks: z.array(z.string()).optional(),
  excludeEnvironments: z.array(z.string()).optional(),
  excludeBranches: z.array(z.string()).optional(),
});

export type ContextMatcher = z.infer<typeof ContextMatcherSchema>;

// ============================================================================
// Enforcement Configuration
// ============================================================================

/**
 * Controls how protocol violations are handled
 */
export const EnforcementConfigSchema = z.object({
  // Enforcement mode
  mode: z.enum([
    "strict",     // Block all violations
    "permissive", // Log violations but allow
    "audit",      // Only log, no blocking
    "learning",   // Learn patterns without enforcement
  ]).default("strict"),

  // Pre-execution validation
  preExecutionValidation: z.boolean().default(true),   // Validate before execution

  // Post-execution validation
  postExecutionValidation: z.boolean().default(true),  // Validate after execution

  // Violation handling
  onViolation: z.enum([
    "block",      // Prevent the operation
    "warn",       // Allow but warn
    "log",        // Silent logging only
    "notify",     // Send notification
    "rollback",   // Attempt to rollback
  ]).default("block"),

  // Retry behavior
  maxRetries: z.number().int().min(0).max(10).default(0), // Retries on failure
  retryDelaySeconds: z.number().min(0).max(300).default(0), // Delay between retries

  // Escalation
  escalateAfterViolations: z.number().int().min(0).optional(), // Escalate after N violations
  escalationTarget: z.string().optional(),             // Who to escalate to

  // Logging
  logLevel: z.enum(["none", "minimal", "standard", "verbose", "debug"]).default("standard"),
  includeContext: z.boolean().default(true),           // Include context in logs

  // Override capabilities
  allowOverride: z.boolean().default(false),           // Allow constraint override
  overrideRequiresApproval: z.boolean().default(true), // Require approval for override
  overrideApprovers: z.array(z.string()).optional(),   // Who can approve overrides
});

export type EnforcementConfig = z.infer<typeof EnforcementConfigSchema>;

// ============================================================================
// Protocol
// ============================================================================

/**
 * A complete protocol definition
 */
export const ProtocolSchema = z.object({
  // Identity
  id: z.string().regex(/^[a-zA-Z0-9_-]+$/, "Protocol ID must be alphanumeric with dashes/underscores"),
  version: z.string().regex(/^\d+\.\d+\.\d+$/, "Version must be semver format (x.y.z)"),
  name: z.string().min(1).max(100),
  description: z.string().max(1000).optional(),

  // Protocol relationships
  extends: z.array(z.string()).optional(),             // Protocols this extends
  requires: z.array(z.string()).optional(),            // Required protocols
  conflicts: z.array(z.string()).optional(),           // Conflicting protocols

  // Core content
  constraints: z.array(ProtocolConstraintSchema),
  enforcement: EnforcementConfigSchema,
  applicableContexts: ContextMatcherSchema,

  // Priority and ordering
  priority: z.number().int().min(0).max(1000).default(100), // Higher = more important

  // Metadata
  author: z.string().optional(),
  tags: z.array(z.string()).optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),

  // Status
  enabled: z.boolean().default(true),
  deprecated: z.boolean().default(false),
  deprecationMessage: z.string().optional(),
});

export type Protocol = z.infer<typeof ProtocolSchema>;

// ============================================================================
// Protocol Instance (Runtime)
// ============================================================================

/**
 * A protocol instance bound to a specific context at runtime
 */
export const ProtocolInstanceSchema = z.object({
  protocol: ProtocolSchema,
  boundAt: z.string(),                               // ISO timestamp when bound
  boundTo: z.object({
    featureId: z.string().optional(),
    workerId: z.string().optional(),
    projectDir: z.string().optional(),
  }),
  overrides: z.array(z.object({
    constraintId: z.string(),
    override: z.enum(["enable", "disable", "modify"]),
    reason: z.string(),
    approvedBy: z.string().optional(),
    approvedAt: z.string().optional(),
  })).optional(),
  violationCount: z.number().int().min(0).default(0),
  lastViolation: z.string().optional(),
});

export type ProtocolInstance = z.infer<typeof ProtocolInstanceSchema>;

// ============================================================================
// Protocol Validation Result
// ============================================================================

/**
 * Result of validating an action against protocols
 */
export const ProtocolValidationResultSchema = z.object({
  valid: z.boolean(),
  violations: z.array(z.object({
    protocolId: z.string(),
    constraintId: z.string(),
    severity: ConstraintSeveritySchema,
    message: z.string(),
    context: z.record(z.unknown()).optional(),
  })),
  warnings: z.array(z.object({
    protocolId: z.string(),
    constraintId: z.string(),
    message: z.string(),
  })),
  appliedProtocols: z.array(z.string()),
  evaluationTimeMs: z.number(),
});

export type ProtocolValidationResult = z.infer<typeof ProtocolValidationResultSchema>;

// ============================================================================
// Base Constraints (for LLM-generated protocol validation)
// ============================================================================

/**
 * Base constraints that LLM-generated protocols must respect
 * These are immutable and cannot be overridden
 */
export const BaseConstraintsSchema = z.object({
  // Absolute prohibitions
  prohibitedTools: z.array(z.string()),              // Tools that can never be allowed
  prohibitedPaths: z.array(z.string()),              // Paths that can never be accessed
  prohibitedOperations: z.array(z.string()),         // Operations that are never allowed

  // Minimum requirements
  minSeverityForBlock: ConstraintSeveritySchema,     // Minimum severity to block
  requirePreValidation: z.boolean(),                 // Must have pre-validation
  requirePostValidation: z.boolean(),                // Must have post-validation

  // Maximum allowances
  maxAllowedTools: z.array(z.string()).optional(),   // Maximum set of tools that can be allowed
  maxAllowedPaths: z.array(z.string()).optional(),   // Maximum set of paths that can be allowed

  // Audit requirements
  requireAuditLog: z.boolean(),
  auditRetentionDays: z.number().int().min(1),
});

export type BaseConstraints = z.infer<typeof BaseConstraintsSchema>;


// ============================================================================
// Helper functions
// ============================================================================

/**
 * Create a minimal valid protocol
 */
export function createEmptyProtocol(id: string, name: string): Protocol {
  return {
    id,
    version: "1.0.0",
    name,
    constraints: [],
    enforcement: {
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
    },
    applicableContexts: {},
    priority: 100,
    enabled: true,
    deprecated: false,
  };
}

/**
 * Validate a protocol against the schema
 */
export function validateProtocol(protocol: unknown): Protocol {
  return ProtocolSchema.parse(protocol);
}

/**
 * Validate a protocol constraint against the schema
 */
export function validateConstraint(constraint: unknown): ProtocolConstraint {
  return ProtocolConstraintSchema.parse(constraint);
}

/**
 * Check if a protocol extends another (directly or transitively)
 */
export function protocolExtends(
  protocol: Protocol,
  targetId: string,
  allProtocols: Map<string, Protocol>
): boolean {
  if (!protocol.extends) return false;

  for (const parentId of protocol.extends) {
    if (parentId === targetId) return true;

    const parent = allProtocols.get(parentId);
    if (parent && protocolExtends(parent, targetId, allProtocols)) {
      return true;
    }
  }

  return false;
}

/**
 * Check for conflicts between two protocols
 */
export function protocolsConflict(
  protocol1: Protocol,
  protocol2: Protocol
): boolean {
  // Direct conflict declaration
  if (protocol1.conflicts?.includes(protocol2.id)) return true;
  if (protocol2.conflicts?.includes(protocol1.id)) return true;

  return false;
}

/**
 * Merge enforcement configs with priority to the higher-priority protocol
 */
export function mergeEnforcementConfigs(
  base: EnforcementConfig,
  override: Partial<EnforcementConfig>
): EnforcementConfig {
  return {
    ...base,
    ...override,
  };
}
