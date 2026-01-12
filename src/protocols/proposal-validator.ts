/**
 * Proposal Validator - Validates proposed protocols against base constraints with risk scoring
 *
 * This module provides comprehensive validation of LLM-generated or user-defined
 * protocol proposals to ensure they comply with immutable base security constraints.
 *
 * Key features:
 * - Deep validation of all constraint types against base constraints
 * - Risk scoring system to assess protocol safety (0-100 scale)
 * - Detailed validation reports with recommendations
 * - Automatic adjustment suggestions for non-compliant protocols
 * - Caching for performance optimization
 *
 * @see base-constraints.ts for the base constraint definitions
 * @see schema.ts for type definitions
 */

import { z } from "zod";
import type {
  Protocol,
  ProtocolConstraint,
  ConstraintRule,
  ConstraintType,
  ConstraintSeverity,
  BaseConstraints,
  ToolRestrictionRule,
  FileAccessRule,
  OutputFormatRule,
  BehavioralRule,
  TemporalRule,
  ResourceRule,
  SideEffectRule,
  EnforcementConfig,
} from "./schema.js";
import {
  getBaseConstraints,
  mergeWithDefaults,
  validateProtocolAgainstBaseConstraints,
  type BaseConstraintValidationResult,
  type BaseConstraintViolation,
  type BaseConstraintWarning,
} from "./base-constraints.js";
import { safeRegexTest } from "../utils/security.js";

// ============================================================================
// Risk Score Types
// ============================================================================

/**
 * Risk categories for protocol evaluation
 */
export type RiskCategory =
  | "tool_access"       // Risks from tool permissions
  | "file_access"       // Risks from file system access
  | "side_effects"      // Risks from side effects (network, shell, git)
  | "enforcement"       // Risks from weak enforcement settings
  | "behavioral"        // Risks from behavioral constraints
  | "temporal"          // Risks from temporal/rate limiting
  | "resource"          // Risks from resource limits
  | "complexity"        // Risks from protocol complexity
  | "conflict";         // Risks from protocol conflicts

/**
 * Individual risk factor contributing to overall score
 */
export interface RiskFactor {
  category: RiskCategory;
  score: number;        // 0-100 contribution to risk
  weight: number;       // 0-1 weight for this factor
  description: string;
  details: Record<string, unknown>;
  mitigations?: string[];
}

/**
 * Risk level based on score
 */
export type RiskLevel = "critical" | "high" | "medium" | "low" | "minimal";

/**
 * Overall risk assessment result
 */
export interface RiskAssessment {
  /** Overall risk score 0-100 (higher = more risky) */
  overallScore: number;

  /** Risk level classification */
  riskLevel: RiskLevel;

  /** Individual risk factors */
  factors: RiskFactor[];

  /** Summary of highest risks */
  highestRisks: string[];

  /** Recommended mitigations */
  recommendations: string[];

  /** Whether the protocol is acceptable (score below threshold) */
  isAcceptable: boolean;

  /** Threshold used for acceptability */
  acceptanceThreshold: number;
}

// ============================================================================
// Validation Result Types
// ============================================================================

/**
 * Detailed validation issue
 */
export interface ValidationIssue {
  type: "error" | "warning" | "info";
  category: RiskCategory | "schema" | "base_constraint";
  code: string;
  message: string;
  constraintId?: string;
  path?: string;
  suggestedFix?: string;
  autoFixable: boolean;
}

/**
 * Proposed fix for a validation issue
 */
export interface ProposedFix {
  issueCode: string;
  description: string;
  action: "remove" | "modify" | "add";
  target: string;
  originalValue?: unknown;
  newValue?: unknown;
  autoApply: boolean;
}

/**
 * Complete proposal validation result
 */
export interface ProposalValidationResult {
  /** Whether the proposal is valid */
  isValid: boolean;

  /** Whether the proposal can be made valid with fixes */
  isFixable: boolean;

  /** Validation issues found */
  issues: ValidationIssue[];

  /** Proposed fixes for issues */
  proposedFixes: ProposedFix[];

  /** Risk assessment */
  riskAssessment: RiskAssessment;

  /** Base constraint validation result */
  baseConstraintValidation: BaseConstraintValidationResult;

  /** The validated protocol (or null if fundamentally invalid) */
  validatedProtocol: Protocol | null;

  /** Validation timestamp */
  validatedAt: string;

  /** Validation duration in ms */
  validationTimeMs: number;
}

// ============================================================================
// Zod Schemas for Validation Results
// ============================================================================

export const RiskFactorSchema = z.object({
  category: z.enum([
    "tool_access",
    "file_access",
    "side_effects",
    "enforcement",
    "behavioral",
    "temporal",
    "resource",
    "complexity",
    "conflict",
  ]),
  score: z.number().min(0).max(100),
  weight: z.number().min(0).max(1),
  description: z.string(),
  details: z.record(z.unknown()),
  mitigations: z.array(z.string()).optional(),
});

export const RiskAssessmentSchema = z.object({
  overallScore: z.number().min(0).max(100),
  riskLevel: z.enum(["critical", "high", "medium", "low", "minimal"]),
  factors: z.array(RiskFactorSchema),
  highestRisks: z.array(z.string()),
  recommendations: z.array(z.string()),
  isAcceptable: z.boolean(),
  acceptanceThreshold: z.number(),
});

export const ValidationIssueSchema = z.object({
  type: z.enum(["error", "warning", "info"]),
  category: z.enum([
    "tool_access",
    "file_access",
    "side_effects",
    "enforcement",
    "behavioral",
    "temporal",
    "resource",
    "complexity",
    "conflict",
    "schema",
    "base_constraint",
  ]),
  code: z.string(),
  message: z.string(),
  constraintId: z.string().optional(),
  path: z.string().optional(),
  suggestedFix: z.string().optional(),
  autoFixable: z.boolean(),
});

export const ProposedFixSchema = z.object({
  issueCode: z.string(),
  description: z.string(),
  action: z.enum(["remove", "modify", "add"]),
  target: z.string(),
  originalValue: z.unknown().optional(),
  newValue: z.unknown().optional(),
  autoApply: z.boolean(),
});

// ============================================================================
// Risk Weight Configuration
// ============================================================================

/**
 * Default weights for risk categories
 */
const DEFAULT_RISK_WEIGHTS: Record<RiskCategory, number> = {
  tool_access: 0.20,
  file_access: 0.20,
  side_effects: 0.15,
  enforcement: 0.15,
  behavioral: 0.10,
  temporal: 0.05,
  resource: 0.05,
  complexity: 0.05,
  conflict: 0.05,
};

/**
 * Risk score thresholds for classification
 */
const RISK_THRESHOLDS = {
  critical: 80,
  high: 60,
  medium: 40,
  low: 20,
  minimal: 0,
};

/**
 * Default acceptance threshold (protocols with higher risk are rejected)
 */
const DEFAULT_ACCEPTANCE_THRESHOLD = 70;

// ============================================================================
// Proposal Validator Class
// ============================================================================

/**
 * ProposalValidator - Validates proposed protocols against base constraints
 */
export class ProposalValidator {
  private readonly baseConstraints: BaseConstraints;
  private readonly riskWeights: Record<RiskCategory, number>;
  private readonly acceptanceThreshold: number;
  private readonly validationCache: Map<string, ProposalValidationResult>;
  private readonly cacheMaxSize: number;

  constructor(options?: {
    customBaseConstraints?: Partial<BaseConstraints>;
    riskWeights?: Partial<Record<RiskCategory, number>>;
    acceptanceThreshold?: number;
    cacheMaxSize?: number;
  }) {
    this.baseConstraints = options?.customBaseConstraints
      ? mergeWithDefaults(options.customBaseConstraints)
      : getBaseConstraints();

    this.riskWeights = {
      ...DEFAULT_RISK_WEIGHTS,
      ...options?.riskWeights,
    };

    this.acceptanceThreshold = options?.acceptanceThreshold ?? DEFAULT_ACCEPTANCE_THRESHOLD;
    this.cacheMaxSize = options?.cacheMaxSize ?? 100;
    this.validationCache = new Map();
  }

  // ==========================================================================
  // Main Validation Methods
  // ==========================================================================

  /**
   * Validate a proposed protocol against base constraints
   * Returns comprehensive validation result with risk assessment
   */
  validate(protocol: Protocol): ProposalValidationResult {
    const startTime = Date.now();

    // Check cache first
    const cacheKey = this.getCacheKey(protocol);
    const cached = this.validationCache.get(cacheKey);
    if (cached) {
      return { ...cached, validationTimeMs: 0 };
    }

    const issues: ValidationIssue[] = [];
    const proposedFixes: ProposedFix[] = [];

    // 1. Validate against base constraints
    const baseConstraintValidation = validateProtocolAgainstBaseConstraints(
      protocol,
      this.baseConstraints
    );

    // Convert base constraint violations to validation issues
    for (const violation of baseConstraintValidation.violations) {
      issues.push(this.violationToIssue(violation));
      const fix = this.violationToFix(violation, protocol);
      if (fix) proposedFixes.push(fix);
    }

    // Convert warnings to issues
    for (const warning of baseConstraintValidation.warnings) {
      issues.push(this.warningToIssue(warning));
    }

    // 2. Validate individual constraints
    for (const constraint of protocol.constraints) {
      const constraintIssues = this.validateConstraint(constraint, protocol);
      issues.push(...constraintIssues);
    }

    // 3. Validate enforcement configuration
    const enforcementIssues = this.validateEnforcement(protocol.enforcement);
    issues.push(...enforcementIssues);

    // 4. Check for protocol complexity issues
    const complexityIssues = this.validateComplexity(protocol);
    issues.push(...complexityIssues);

    // 5. Calculate risk assessment
    const riskAssessment = this.calculateRiskAssessment(protocol, issues);

    // Determine if valid (no error-level issues)
    const errorIssues = issues.filter(i => i.type === "error");
    const isValid = errorIssues.length === 0 && riskAssessment.isAcceptable;

    // Determine if fixable
    const unfixableIssues = issues.filter(
      i => i.type === "error" && !proposedFixes.some(f => f.issueCode === i.code)
    );
    const isFixable = unfixableIssues.length === 0;

    const result: ProposalValidationResult = {
      isValid,
      isFixable,
      issues,
      proposedFixes,
      riskAssessment,
      baseConstraintValidation,
      validatedProtocol: isValid ? protocol : null,
      validatedAt: new Date().toISOString(),
      validationTimeMs: Date.now() - startTime,
    };

    // Cache result
    this.cacheResult(cacheKey, result);

    return result;
  }

  /**
   * Validate and optionally auto-fix a protocol
   * Returns the fixed protocol if fixable
   */
  validateAndFix(protocol: Protocol): {
    result: ProposalValidationResult;
    fixedProtocol: Protocol | null;
    appliedFixes: ProposedFix[];
  } {
    const result = this.validate(protocol);

    if (result.isValid) {
      return {
        result,
        fixedProtocol: protocol,
        appliedFixes: [],
      };
    }

    if (!result.isFixable) {
      return {
        result,
        fixedProtocol: null,
        appliedFixes: [],
      };
    }

    // Apply auto-fixable fixes
    const autoFixes = result.proposedFixes.filter(f => f.autoApply);
    let fixedProtocol = this.applyFixes(protocol, autoFixes);

    // Re-validate to check if fixes resolved issues
    const revalidation = this.validate(fixedProtocol);

    return {
      result: revalidation,
      fixedProtocol: revalidation.isValid ? fixedProtocol : null,
      appliedFixes: autoFixes,
    };
  }

  /**
   * Quick validation check - returns just pass/fail
   */
  isValid(protocol: Protocol): boolean {
    const result = this.validate(protocol);
    return result.isValid;
  }

  /**
   * Get risk score only (faster than full validation)
   */
  getRiskScore(protocol: Protocol): number {
    const result = this.validate(protocol);
    return result.riskAssessment.overallScore;
  }

  // ==========================================================================
  // Constraint Validation Methods
  // ==========================================================================

  /**
   * Validate a single constraint against base constraints
   */
  private validateConstraint(
    constraint: ProtocolConstraint,
    protocol: Protocol
  ): ValidationIssue[] {
    const issues: ValidationIssue[] = [];

    switch (constraint.rule.type) {
      case "tool_restriction":
        issues.push(...this.validateToolRestriction(
          constraint,
          constraint.rule as ToolRestrictionRule
        ));
        break;

      case "file_access":
        issues.push(...this.validateFileAccess(
          constraint,
          constraint.rule as FileAccessRule
        ));
        break;

      case "side_effect":
        issues.push(...this.validateSideEffect(
          constraint,
          constraint.rule as SideEffectRule
        ));
        break;

      case "behavioral":
        issues.push(...this.validateBehavioral(
          constraint,
          constraint.rule as BehavioralRule
        ));
        break;

      case "temporal":
        issues.push(...this.validateTemporal(
          constraint,
          constraint.rule as TemporalRule
        ));
        break;

      case "resource":
        issues.push(...this.validateResource(
          constraint,
          constraint.rule as ResourceRule
        ));
        break;

      case "output_format":
        // Output format constraints have minimal risk
        break;
    }

    return issues;
  }

  /**
   * Validate tool restriction constraint
   */
  private validateToolRestriction(
    constraint: ProtocolConstraint,
    rule: ToolRestrictionRule
  ): ValidationIssue[] {
    const issues: ValidationIssue[] = [];

    // Check for overly permissive tool access
    if (!rule.allowedTools && !rule.deniedTools && !rule.toolPatterns) {
      issues.push({
        type: "warning",
        category: "tool_access",
        code: "UNRESTRICTED_TOOLS",
        message: "Tool restriction constraint has no restrictions defined",
        constraintId: constraint.id,
        suggestedFix: "Define allowedTools, deniedTools, or toolPatterns",
        autoFixable: false,
      });
    }

    // Check for dangerous tool patterns
    if (rule.toolPatterns) {
      for (const pattern of rule.toolPatterns) {
        if (pattern === ".*" || pattern === ".+") {
          issues.push({
            type: "error",
            category: "tool_access",
            code: "WILDCARD_TOOL_PATTERN",
            message: `Tool pattern "${pattern}" allows all tools`,
            constraintId: constraint.id,
            suggestedFix: "Use more specific tool patterns",
            autoFixable: false,
          });
        }
      }
    }

    // Check if allowed tools exceed max allowed
    if (rule.allowedTools && this.baseConstraints.maxAllowedTools) {
      const exceeding = rule.allowedTools.filter(
        t => !this.baseConstraints.maxAllowedTools!.includes(t)
      );
      if (exceeding.length > 0) {
        issues.push({
          type: "error",
          category: "tool_access",
          code: "EXCEEDED_MAX_TOOLS",
          message: `Tools exceed maximum allowed: ${exceeding.join(", ")}`,
          constraintId: constraint.id,
          suggestedFix: `Remove: ${exceeding.join(", ")}`,
          autoFixable: true,
        });
      }
    }

    return issues;
  }

  /**
   * Validate file access constraint
   */
  private validateFileAccess(
    constraint: ProtocolConstraint,
    rule: FileAccessRule
  ): ValidationIssue[] {
    const issues: ValidationIssue[] = [];

    // Check for overly permissive path patterns
    if (rule.allowedPaths) {
      for (const path of rule.allowedPaths) {
        if (this.isOverlyPermissivePath(path)) {
          issues.push({
            type: "warning",
            category: "file_access",
            code: "PERMISSIVE_PATH",
            message: `Path pattern "${path}" may be too permissive`,
            constraintId: constraint.id,
            path: path,
            suggestedFix: "Use more specific path patterns",
            autoFixable: false,
          });
        }

        // Check against prohibited paths
        if (this.matchesProhibitedPath(path)) {
          issues.push({
            type: "error",
            category: "file_access",
            code: "PROHIBITED_PATH",
            message: `Path "${path}" matches a prohibited path pattern`,
            constraintId: constraint.id,
            path: path,
            suggestedFix: "Remove this path from allowedPaths",
            autoFixable: true,
          });
        }
      }
    }

    // Check if no restrictions defined
    if (
      !rule.allowedPaths &&
      !rule.deniedPaths &&
      !rule.readOnly &&
      !rule.allowedExtensions &&
      !rule.deniedExtensions
    ) {
      issues.push({
        type: "warning",
        category: "file_access",
        code: "UNRESTRICTED_FILE_ACCESS",
        message: "File access constraint has no restrictions defined",
        constraintId: constraint.id,
        suggestedFix: "Define path or extension restrictions",
        autoFixable: false,
      });
    }

    return issues;
  }

  /**
   * Validate side effect constraint
   */
  private validateSideEffect(
    constraint: ProtocolConstraint,
    rule: SideEffectRule
  ): ValidationIssue[] {
    const issues: ValidationIssue[] = [];

    // Check network access without restrictions
    if (rule.allowNetwork === true && !rule.allowedHosts && !rule.deniedHosts) {
      issues.push({
        type: "warning",
        category: "side_effects",
        code: "UNRESTRICTED_NETWORK",
        message: "Network access allowed without host restrictions",
        constraintId: constraint.id,
        suggestedFix: "Define allowedHosts or deniedHosts",
        autoFixable: false,
      });
    }

    // Check shell commands
    if (rule.allowShellCommands === true && !rule.allowedCommands) {
      issues.push({
        type: "warning",
        category: "side_effects",
        code: "UNRESTRICTED_SHELL",
        message: "Shell commands allowed without command whitelist",
        constraintId: constraint.id,
        suggestedFix: "Define allowedCommands whitelist",
        autoFixable: false,
      });
    }

    // Check for prohibited operations in allowed commands
    if (rule.allowedCommands) {
      for (const cmd of rule.allowedCommands) {
        if (this.isProhibitedOperation(cmd)) {
          issues.push({
            type: "error",
            category: "side_effects",
            code: "PROHIBITED_COMMAND",
            message: `Command "${cmd}" contains prohibited operation`,
            constraintId: constraint.id,
            suggestedFix: "Remove this command from allowedCommands",
            autoFixable: true,
          });
        }
      }
    }

    // Check for dangerous git operations
    if (rule.allowGitOperations === true && rule.allowedGitOps) {
      const dangerousOps = ["push --force", "reset --hard", "clean -fd"];
      for (const op of rule.allowedGitOps) {
        if (dangerousOps.some(d => op.toLowerCase().includes(d))) {
          issues.push({
            type: "warning",
            category: "side_effects",
            code: "DANGEROUS_GIT_OP",
            message: `Git operation "${op}" is potentially dangerous`,
            constraintId: constraint.id,
            suggestedFix: "Consider removing or requiring approval for this operation",
            autoFixable: false,
          });
        }
      }
    }

    return issues;
  }

  /**
   * Validate behavioral constraint
   */
  private validateBehavioral(
    constraint: ProtocolConstraint,
    rule: BehavioralRule
  ): ValidationIssue[] {
    const issues: ValidationIssue[] = [];

    // Check for prohibited operations in required actions
    if (rule.requiredActions) {
      for (const action of rule.requiredActions) {
        if (this.isProhibitedOperation(action)) {
          issues.push({
            type: "error",
            category: "behavioral",
            code: "PROHIBITED_REQUIRED_ACTION",
            message: `Required action "${action}" is prohibited`,
            constraintId: constraint.id,
            suggestedFix: "Remove this action from requiredActions",
            autoFixable: true,
          });
        }
      }
    }

    // Check for reasonable iteration limits
    if (rule.maxIterations !== undefined) {
      if (rule.maxIterations > 1000) {
        issues.push({
          type: "warning",
          category: "behavioral",
          code: "HIGH_ITERATION_LIMIT",
          message: `Max iterations (${rule.maxIterations}) is very high`,
          constraintId: constraint.id,
          suggestedFix: "Consider a lower iteration limit",
          autoFixable: false,
        });
      }
    }

    // Check for reasonable timeout
    if (rule.timeoutSeconds !== undefined) {
      if (rule.timeoutSeconds > 3600) {
        issues.push({
          type: "warning",
          category: "behavioral",
          code: "LONG_TIMEOUT",
          message: `Timeout (${rule.timeoutSeconds}s) exceeds 1 hour`,
          constraintId: constraint.id,
          suggestedFix: "Consider a shorter timeout",
          autoFixable: false,
        });
      }
    }

    return issues;
  }

  /**
   * Validate temporal constraint
   */
  private validateTemporal(
    constraint: ProtocolConstraint,
    rule: TemporalRule
  ): ValidationIssue[] {
    const issues: ValidationIssue[] = [];

    // Check for very high rate limits
    if (rule.rateLimitPerMinute !== undefined && rule.rateLimitPerMinute > 1000) {
      issues.push({
        type: "info",
        category: "temporal",
        code: "HIGH_RATE_LIMIT",
        message: `Rate limit (${rule.rateLimitPerMinute}/min) is very high`,
        constraintId: constraint.id,
        suggestedFix: "Consider a lower rate limit",
        autoFixable: false,
      });
    }

    // Check for expired constraints
    if (rule.validUntil) {
      const validUntil = new Date(rule.validUntil);
      if (validUntil < new Date()) {
        issues.push({
          type: "warning",
          category: "temporal",
          code: "EXPIRED_CONSTRAINT",
          message: `Temporal constraint expired on ${rule.validUntil}`,
          constraintId: constraint.id,
          suggestedFix: "Update validUntil or remove the constraint",
          autoFixable: false,
        });
      }
    }

    return issues;
  }

  /**
   * Validate resource constraint
   */
  private validateResource(
    constraint: ProtocolConstraint,
    rule: ResourceRule
  ): ValidationIssue[] {
    const issues: ValidationIssue[] = [];

    // Check for very high resource limits
    if (rule.maxMemoryMB !== undefined && rule.maxMemoryMB > 16384) {
      issues.push({
        type: "info",
        category: "resource",
        code: "HIGH_MEMORY_LIMIT",
        message: `Memory limit (${rule.maxMemoryMB}MB) is very high`,
        constraintId: constraint.id,
        suggestedFix: "Consider a lower memory limit",
        autoFixable: false,
      });
    }

    if (rule.maxConcurrentOps !== undefined && rule.maxConcurrentOps > 100) {
      issues.push({
        type: "warning",
        category: "resource",
        code: "HIGH_CONCURRENT_OPS",
        message: `Concurrent ops limit (${rule.maxConcurrentOps}) is very high`,
        constraintId: constraint.id,
        suggestedFix: "Consider a lower limit for concurrent operations",
        autoFixable: false,
      });
    }

    return issues;
  }

  /**
   * Validate enforcement configuration
   */
  private validateEnforcement(enforcement: EnforcementConfig): ValidationIssue[] {
    const issues: ValidationIssue[] = [];

    // Check for permissive mode with error-level constraints
    if (enforcement.mode === "permissive" || enforcement.mode === "audit") {
      issues.push({
        type: "info",
        category: "enforcement",
        code: "PERMISSIVE_MODE",
        message: `Enforcement mode "${enforcement.mode}" allows violations`,
        suggestedFix: "Consider using 'strict' mode for security",
        autoFixable: false,
      });
    }

    // Check for disabled pre/post validation
    if (!enforcement.preExecutionValidation) {
      if (this.baseConstraints.requirePreValidation) {
        issues.push({
          type: "error",
          category: "enforcement",
          code: "DISABLED_PRE_VALIDATION",
          message: "Pre-execution validation is disabled but required",
          suggestedFix: "Enable preExecutionValidation",
          autoFixable: true,
        });
      }
    }

    if (!enforcement.postExecutionValidation) {
      if (this.baseConstraints.requirePostValidation) {
        issues.push({
          type: "error",
          category: "enforcement",
          code: "DISABLED_POST_VALIDATION",
          message: "Post-execution validation is disabled but required",
          suggestedFix: "Enable postExecutionValidation",
          autoFixable: true,
        });
      }
    }

    // Check for disabled logging
    if (enforcement.logLevel === "none" && this.baseConstraints.requireAuditLog) {
      issues.push({
        type: "error",
        category: "enforcement",
        code: "DISABLED_AUDIT_LOG",
        message: "Audit logging is disabled but required",
        suggestedFix: "Set logLevel to at least 'minimal'",
        autoFixable: true,
      });
    }

    // Check for override settings
    if (enforcement.allowOverride && !enforcement.overrideRequiresApproval) {
      issues.push({
        type: "warning",
        category: "enforcement",
        code: "OVERRIDE_WITHOUT_APPROVAL",
        message: "Constraint override allowed without approval requirement",
        suggestedFix: "Enable overrideRequiresApproval",
        autoFixable: true,
      });
    }

    return issues;
  }

  /**
   * Validate protocol complexity
   */
  private validateComplexity(protocol: Protocol): ValidationIssue[] {
    const issues: ValidationIssue[] = [];

    // Check for excessive constraints
    if (protocol.constraints.length > 50) {
      issues.push({
        type: "warning",
        category: "complexity",
        code: "EXCESSIVE_CONSTRAINTS",
        message: `Protocol has ${protocol.constraints.length} constraints (recommended: <50)`,
        suggestedFix: "Consider splitting into multiple protocols",
        autoFixable: false,
      });
    }

    // Check for deeply nested extends
    if (protocol.extends && protocol.extends.length > 5) {
      issues.push({
        type: "info",
        category: "complexity",
        code: "DEEP_INHERITANCE",
        message: `Protocol extends ${protocol.extends.length} other protocols`,
        suggestedFix: "Consider flattening the protocol hierarchy",
        autoFixable: false,
      });
    }

    // Check for conflicting constraints
    const toolConstraints = protocol.constraints.filter(
      c => c.rule.type === "tool_restriction"
    );
    if (toolConstraints.length > 1) {
      // Check for allow/deny conflicts
      for (let i = 0; i < toolConstraints.length; i++) {
        for (let j = i + 1; j < toolConstraints.length; j++) {
          const conflict = this.detectToolConflict(
            toolConstraints[i].rule as ToolRestrictionRule,
            toolConstraints[j].rule as ToolRestrictionRule
          );
          if (conflict) {
            issues.push({
              type: "warning",
              category: "conflict",
              code: "TOOL_CONSTRAINT_CONFLICT",
              message: conflict,
              constraintId: `${toolConstraints[i].id}, ${toolConstraints[j].id}`,
              suggestedFix: "Resolve conflicting tool restrictions",
              autoFixable: false,
            });
          }
        }
      }
    }

    return issues;
  }

  // ==========================================================================
  // Risk Assessment Methods
  // ==========================================================================

  /**
   * Calculate comprehensive risk assessment
   */
  private calculateRiskAssessment(
    protocol: Protocol,
    issues: ValidationIssue[]
  ): RiskAssessment {
    const factors: RiskFactor[] = [];

    // Calculate risk for each category
    factors.push(this.assessToolAccessRisk(protocol, issues));
    factors.push(this.assessFileAccessRisk(protocol, issues));
    factors.push(this.assessSideEffectsRisk(protocol, issues));
    factors.push(this.assessEnforcementRisk(protocol, issues));
    factors.push(this.assessBehavioralRisk(protocol, issues));
    factors.push(this.assessTemporalRisk(protocol, issues));
    factors.push(this.assessResourceRisk(protocol, issues));
    factors.push(this.assessComplexityRisk(protocol, issues));
    factors.push(this.assessConflictRisk(protocol, issues));

    // Calculate weighted overall score
    const overallScore = factors.reduce(
      (sum, f) => sum + f.score * this.riskWeights[f.category],
      0
    );

    // Determine risk level
    const riskLevel = this.scoreToRiskLevel(overallScore);

    // Get highest risks
    const sortedFactors = [...factors].sort((a, b) => b.score - a.score);
    const highestRisks = sortedFactors
      .filter(f => f.score >= 40)
      .slice(0, 3)
      .map(f => f.description);

    // Collect all mitigations
    const recommendations = sortedFactors
      .filter(f => f.mitigations && f.mitigations.length > 0)
      .flatMap(f => f.mitigations!)
      .slice(0, 5);

    return {
      overallScore: Math.round(overallScore),
      riskLevel,
      factors,
      highestRisks,
      recommendations,
      isAcceptable: overallScore <= this.acceptanceThreshold,
      acceptanceThreshold: this.acceptanceThreshold,
    };
  }

  /**
   * Assess tool access risk
   */
  private assessToolAccessRisk(protocol: Protocol, issues: ValidationIssue[]): RiskFactor {
    let score = 0;
    const details: Record<string, unknown> = {};
    const mitigations: string[] = [];

    const toolConstraints = protocol.constraints.filter(
      c => c.rule.type === "tool_restriction"
    );

    if (toolConstraints.length === 0) {
      score = 50;
      details.noToolConstraints = true;
      mitigations.push("Add explicit tool restrictions");
    } else {
      // Check for allowed tools count
      for (const constraint of toolConstraints) {
        const rule = constraint.rule as ToolRestrictionRule;
        if (rule.allowedTools) {
          const count = rule.allowedTools.length;
          score += Math.min(count * 5, 30);
          details.allowedToolsCount = count;
        }
        if (!rule.deniedTools && !rule.toolPatterns) {
          score += 10;
          details.noExplicitDenials = true;
        }
      }
    }

    // Add score from issues
    const toolIssues = issues.filter(i => i.category === "tool_access");
    score += toolIssues.filter(i => i.type === "error").length * 20;
    score += toolIssues.filter(i => i.type === "warning").length * 10;

    return {
      category: "tool_access",
      score: Math.min(score, 100),
      weight: this.riskWeights.tool_access,
      description: score > 60 ? "High tool access risk" : score > 30 ? "Moderate tool access risk" : "Low tool access risk",
      details,
      mitigations: mitigations.length > 0 ? mitigations : undefined,
    };
  }

  /**
   * Assess file access risk
   */
  private assessFileAccessRisk(protocol: Protocol, issues: ValidationIssue[]): RiskFactor {
    let score = 0;
    const details: Record<string, unknown> = {};
    const mitigations: string[] = [];

    const fileConstraints = protocol.constraints.filter(
      c => c.rule.type === "file_access"
    );

    if (fileConstraints.length === 0) {
      score = 40;
      details.noFileConstraints = true;
      mitigations.push("Add explicit file access restrictions");
    } else {
      for (const constraint of fileConstraints) {
        const rule = constraint.rule as FileAccessRule;
        if (rule.allowedPaths) {
          for (const path of rule.allowedPaths) {
            if (path.includes("**")) score += 15;
            else if (path.includes("*")) score += 10;
          }
        }
        if (!rule.deniedPaths) {
          score += 10;
          details.noDeniedPaths = true;
          mitigations.push("Add deniedPaths for sensitive areas");
        }
      }
    }

    // Add score from issues
    const fileIssues = issues.filter(i => i.category === "file_access");
    score += fileIssues.filter(i => i.type === "error").length * 25;
    score += fileIssues.filter(i => i.type === "warning").length * 10;

    return {
      category: "file_access",
      score: Math.min(score, 100),
      weight: this.riskWeights.file_access,
      description: score > 60 ? "High file access risk" : score > 30 ? "Moderate file access risk" : "Low file access risk",
      details,
      mitigations: mitigations.length > 0 ? mitigations : undefined,
    };
  }

  /**
   * Assess side effects risk
   */
  private assessSideEffectsRisk(protocol: Protocol, issues: ValidationIssue[]): RiskFactor {
    let score = 0;
    const details: Record<string, unknown> = {};
    const mitigations: string[] = [];

    const sideEffectConstraints = protocol.constraints.filter(
      c => c.rule.type === "side_effect"
    );

    for (const constraint of sideEffectConstraints) {
      const rule = constraint.rule as SideEffectRule;

      if (rule.allowNetwork === true) {
        score += 20;
        if (!rule.allowedHosts) {
          score += 15;
          mitigations.push("Define allowedHosts whitelist");
        }
      }

      if (rule.allowShellCommands === true) {
        score += 25;
        if (!rule.allowedCommands) {
          score += 20;
          mitigations.push("Define allowedCommands whitelist");
        }
      }

      if (rule.allowGitOperations === true) {
        score += 10;
        details.gitAllowed = true;
      }
    }

    // Add score from issues
    const sideEffectIssues = issues.filter(i => i.category === "side_effects");
    score += sideEffectIssues.filter(i => i.type === "error").length * 25;
    score += sideEffectIssues.filter(i => i.type === "warning").length * 10;

    return {
      category: "side_effects",
      score: Math.min(score, 100),
      weight: this.riskWeights.side_effects,
      description: score > 60 ? "High side effects risk" : score > 30 ? "Moderate side effects risk" : "Low side effects risk",
      details,
      mitigations: mitigations.length > 0 ? mitigations : undefined,
    };
  }

  /**
   * Assess enforcement risk
   */
  private assessEnforcementRisk(protocol: Protocol, issues: ValidationIssue[]): RiskFactor {
    let score = 0;
    const details: Record<string, unknown> = {};
    const mitigations: string[] = [];

    const enforcement = protocol.enforcement;

    if (enforcement.mode !== "strict") {
      score += 20;
      details.nonStrictMode = enforcement.mode;
      mitigations.push("Consider using strict enforcement mode");
    }

    if (!enforcement.preExecutionValidation) {
      score += 25;
      mitigations.push("Enable pre-execution validation");
    }

    if (!enforcement.postExecutionValidation) {
      score += 15;
      mitigations.push("Enable post-execution validation");
    }

    if (enforcement.logLevel === "none" || enforcement.logLevel === "minimal") {
      score += 10;
      details.minimalLogging = true;
      mitigations.push("Increase log level for better auditability");
    }

    if (enforcement.allowOverride && !enforcement.overrideRequiresApproval) {
      score += 20;
      mitigations.push("Require approval for overrides");
    }

    // Add score from issues
    const enforcementIssues = issues.filter(i => i.category === "enforcement");
    score += enforcementIssues.filter(i => i.type === "error").length * 20;
    score += enforcementIssues.filter(i => i.type === "warning").length * 10;

    return {
      category: "enforcement",
      score: Math.min(score, 100),
      weight: this.riskWeights.enforcement,
      description: score > 60 ? "Weak enforcement configuration" : score > 30 ? "Moderate enforcement gaps" : "Strong enforcement",
      details,
      mitigations: mitigations.length > 0 ? mitigations : undefined,
    };
  }

  /**
   * Assess behavioral risk
   */
  private assessBehavioralRisk(protocol: Protocol, issues: ValidationIssue[]): RiskFactor {
    let score = 0;
    const details: Record<string, unknown> = {};

    const behavioralConstraints = protocol.constraints.filter(
      c => c.rule.type === "behavioral"
    );

    for (const constraint of behavioralConstraints) {
      const rule = constraint.rule as BehavioralRule;

      if (!rule.requireConfirmation && !rule.maxIterations && !rule.timeoutSeconds) {
        score += 15;
        details.noLimits = true;
      }

      if (rule.maxIterations && rule.maxIterations > 100) {
        score += 10;
      }

      if (rule.timeoutSeconds && rule.timeoutSeconds > 600) {
        score += 10;
      }
    }

    // Add score from issues
    const behavioralIssues = issues.filter(i => i.category === "behavioral");
    score += behavioralIssues.filter(i => i.type === "error").length * 20;
    score += behavioralIssues.filter(i => i.type === "warning").length * 10;

    return {
      category: "behavioral",
      score: Math.min(score, 100),
      weight: this.riskWeights.behavioral,
      description: score > 60 ? "High behavioral risk" : score > 30 ? "Moderate behavioral risk" : "Low behavioral risk",
      details,
    };
  }

  /**
   * Assess temporal risk
   */
  private assessTemporalRisk(protocol: Protocol, issues: ValidationIssue[]): RiskFactor {
    let score = 0;
    const details: Record<string, unknown> = {};

    const temporalConstraints = protocol.constraints.filter(
      c => c.rule.type === "temporal"
    );

    // No temporal constraints means no rate limiting
    if (temporalConstraints.length === 0) {
      score = 20;
      details.noRateLimits = true;
    }

    // Add score from issues
    const temporalIssues = issues.filter(i => i.category === "temporal");
    score += temporalIssues.filter(i => i.type === "error").length * 15;
    score += temporalIssues.filter(i => i.type === "warning").length * 5;

    return {
      category: "temporal",
      score: Math.min(score, 100),
      weight: this.riskWeights.temporal,
      description: score > 40 ? "Limited rate control" : "Adequate rate control",
      details,
    };
  }

  /**
   * Assess resource risk
   */
  private assessResourceRisk(protocol: Protocol, issues: ValidationIssue[]): RiskFactor {
    let score = 0;
    const details: Record<string, unknown> = {};

    const resourceConstraints = protocol.constraints.filter(
      c => c.rule.type === "resource"
    );

    // No resource constraints
    if (resourceConstraints.length === 0) {
      score = 15;
      details.noResourceLimits = true;
    }

    // Add score from issues
    const resourceIssues = issues.filter(i => i.category === "resource");
    score += resourceIssues.filter(i => i.type === "error").length * 15;
    score += resourceIssues.filter(i => i.type === "warning").length * 5;

    return {
      category: "resource",
      score: Math.min(score, 100),
      weight: this.riskWeights.resource,
      description: score > 40 ? "Limited resource controls" : "Adequate resource controls",
      details,
    };
  }

  /**
   * Assess complexity risk
   */
  private assessComplexityRisk(protocol: Protocol, issues: ValidationIssue[]): RiskFactor {
    let score = 0;
    const details: Record<string, unknown> = {};

    // Score based on constraint count
    const constraintCount = protocol.constraints.length;
    if (constraintCount > 30) {
      score += 20;
    } else if (constraintCount > 20) {
      score += 10;
    }
    details.constraintCount = constraintCount;

    // Score based on inheritance depth
    if (protocol.extends && protocol.extends.length > 3) {
      score += 15;
      details.inheritanceDepth = protocol.extends.length;
    }

    // Add score from issues
    const complexityIssues = issues.filter(i => i.category === "complexity");
    score += complexityIssues.filter(i => i.type === "warning").length * 10;

    return {
      category: "complexity",
      score: Math.min(score, 100),
      weight: this.riskWeights.complexity,
      description: score > 40 ? "High protocol complexity" : "Manageable complexity",
      details,
    };
  }

  /**
   * Assess conflict risk
   */
  private assessConflictRisk(protocol: Protocol, issues: ValidationIssue[]): RiskFactor {
    let score = 0;
    const details: Record<string, unknown> = {};

    // Check declared conflicts
    if (protocol.conflicts && protocol.conflicts.length > 0) {
      score += protocol.conflicts.length * 10;
      details.declaredConflicts = protocol.conflicts.length;
    }

    // Add score from issues
    const conflictIssues = issues.filter(i => i.category === "conflict");
    score += conflictIssues.filter(i => i.type === "error").length * 25;
    score += conflictIssues.filter(i => i.type === "warning").length * 15;
    details.detectedConflicts = conflictIssues.length;

    return {
      category: "conflict",
      score: Math.min(score, 100),
      weight: this.riskWeights.conflict,
      description: score > 30 ? "Potential conflicts detected" : "No significant conflicts",
      details,
    };
  }

  // ==========================================================================
  // Helper Methods
  // ==========================================================================

  /**
   * Convert risk score to risk level
   */
  private scoreToRiskLevel(score: number): RiskLevel {
    if (score >= RISK_THRESHOLDS.critical) return "critical";
    if (score >= RISK_THRESHOLDS.high) return "high";
    if (score >= RISK_THRESHOLDS.medium) return "medium";
    if (score >= RISK_THRESHOLDS.low) return "low";
    return "minimal";
  }

  /**
   * Check if a path pattern is overly permissive
   */
  private isOverlyPermissivePath(path: string): boolean {
    return (
      path === "*" ||
      path === "**" ||
      path === "**/*" ||
      path === "/" ||
      path === "~" ||
      path === "~/*"
    );
  }

  /**
   * Check if a path matches prohibited paths
   * Protected against ReDoS using safeRegexTest from security.ts
   */
  private matchesProhibitedPath(path: string): boolean {
    const normalizedPath = path.toLowerCase();
    return this.baseConstraints.prohibitedPaths.some(prohibited => {
      const normalizedProhibited = prohibited.toLowerCase();
      if (normalizedProhibited.includes("*")) {
        // Escape regex metacharacters first, then convert glob patterns
        const regexPattern = normalizedProhibited
          .replace(/[.+^${}()|[\]\\]/g, "\\$&")  // Escape regex metacharacters
          .replace(/\*\*/g, ".*")                 // ** = any characters
          .replace(/\*/g, "[^/]*");               // * = any except /
        // Use safeRegexTest for ReDoS protection
        return safeRegexTest(`^${regexPattern}$`, normalizedPath);
      }
      return normalizedPath === normalizedProhibited ||
        normalizedPath.startsWith(normalizedProhibited);
    });
  }

  /**
   * Check if an operation is prohibited
   */
  private isProhibitedOperation(operation: string): boolean {
    const normalizedOp = operation.toLowerCase();
    return this.baseConstraints.prohibitedOperations.some(prohibited =>
      normalizedOp.includes(prohibited.toLowerCase())
    );
  }

  /**
   * Detect conflicts between tool restriction rules
   */
  private detectToolConflict(
    rule1: ToolRestrictionRule,
    rule2: ToolRestrictionRule
  ): string | null {
    // Check if same tool is in allowed of one and denied of another
    if (rule1.allowedTools && rule2.deniedTools) {
      const conflict = rule1.allowedTools.find(t => rule2.deniedTools?.includes(t));
      if (conflict) {
        return `Tool "${conflict}" is both allowed and denied`;
      }
    }
    if (rule2.allowedTools && rule1.deniedTools) {
      const conflict = rule2.allowedTools.find(t => rule1.deniedTools?.includes(t));
      if (conflict) {
        return `Tool "${conflict}" is both allowed and denied`;
      }
    }
    return null;
  }

  /**
   * Convert base constraint violation to validation issue
   */
  private violationToIssue(violation: BaseConstraintViolation): ValidationIssue {
    return {
      type: "error",
      category: "base_constraint",
      code: violation.type.toUpperCase(),
      message: violation.message,
      constraintId: violation.constraintId,
      suggestedFix: undefined,
      autoFixable: false,
    };
  }

  /**
   * Convert base constraint warning to validation issue
   */
  private warningToIssue(warning: BaseConstraintWarning): ValidationIssue {
    return {
      type: "warning",
      category: "base_constraint",
      code: warning.type.toUpperCase(),
      message: warning.message,
      autoFixable: false,
    };
  }

  /**
   * Create a fix for a violation
   */
  private violationToFix(
    violation: BaseConstraintViolation,
    protocol: Protocol
  ): ProposedFix | null {
    switch (violation.type) {
      case "missing_pre_validation":
        return {
          issueCode: "MISSING_PRE_VALIDATION",
          description: "Enable pre-execution validation",
          action: "modify",
          target: "enforcement.preExecutionValidation",
          originalValue: false,
          newValue: true,
          autoApply: true,
        };

      case "missing_post_validation":
        return {
          issueCode: "MISSING_POST_VALIDATION",
          description: "Enable post-execution validation",
          action: "modify",
          target: "enforcement.postExecutionValidation",
          originalValue: false,
          newValue: true,
          autoApply: true,
        };

      case "missing_audit_log":
        return {
          issueCode: "MISSING_AUDIT_LOG",
          description: "Enable audit logging",
          action: "modify",
          target: "enforcement.logLevel",
          originalValue: protocol.enforcement.logLevel,
          newValue: "standard",
          autoApply: true,
        };

      default:
        return null;
    }
  }

  /**
   * Apply fixes to a protocol
   */
  private applyFixes(protocol: Protocol, fixes: ProposedFix[]): Protocol {
    const fixed = JSON.parse(JSON.stringify(protocol)) as Protocol;

    for (const fix of fixes) {
      if (fix.target.startsWith("enforcement.")) {
        const key = fix.target.split(".")[1] as keyof EnforcementConfig;
        (fixed.enforcement as any)[key] = fix.newValue;
      }
    }

    return fixed;
  }

  /**
   * Get cache key for a protocol
   */
  private getCacheKey(protocol: Protocol): string {
    return `${protocol.id}:${protocol.version}:${JSON.stringify(protocol.constraints)}`;
  }

  /**
   * Cache validation result
   */
  private cacheResult(key: string, result: ProposalValidationResult): void {
    // Evict oldest if at max size
    if (this.validationCache.size >= this.cacheMaxSize) {
      const firstKey = this.validationCache.keys().next().value;
      if (firstKey) {
        this.validationCache.delete(firstKey);
      }
    }
    this.validationCache.set(key, result);
  }

  /**
   * Clear the validation cache
   */
  clearCache(): void {
    this.validationCache.clear();
  }

  /**
   * Get the base constraints being used
   */
  getBaseConstraints(): BaseConstraints {
    return this.baseConstraints;
  }

  /**
   * Get the acceptance threshold
   */
  getAcceptanceThreshold(): number {
    return this.acceptanceThreshold;
  }
}

// ============================================================================
// Factory Functions
// ============================================================================

/**
 * Create a proposal validator with default settings
 */
export function createProposalValidator(options?: {
  customBaseConstraints?: Partial<BaseConstraints>;
  riskWeights?: Partial<Record<RiskCategory, number>>;
  acceptanceThreshold?: number;
}): ProposalValidator {
  return new ProposalValidator(options);
}

/**
 * Quick validation of a protocol proposal
 */
export function validateProposal(protocol: Protocol): ProposalValidationResult {
  const validator = new ProposalValidator();
  return validator.validate(protocol);
}

/**
 * Quick risk score calculation
 */
export function calculateRiskScore(protocol: Protocol): number {
  const validator = new ProposalValidator();
  return validator.getRiskScore(protocol);
}

/**
 * Check if a protocol is valid against base constraints
 */
export function isProtocolValid(protocol: Protocol): boolean {
  const validator = new ProposalValidator();
  return validator.isValid(protocol);
}
