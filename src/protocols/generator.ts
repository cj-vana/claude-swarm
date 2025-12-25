/**
 * Protocol Generator - Parsing and creating protocols from worker proposals
 *
 * This module provides functionality to:
 * - Parse natural language worker proposals into structured protocols
 * - Create protocols from proposal specifications
 * - Validate generated protocols against base constraints
 * - Suggest constraint improvements based on patterns
 *
 * Key features:
 * - Extracts tool restrictions, file access patterns, and behavioral rules
 * - Validates against immutable base constraints
 * - Supports incremental protocol refinement
 */

import { z } from "zod";
import type {
  Protocol,
  ProtocolConstraint,
  ConstraintRule,
  ConstraintType,
  ConstraintSeverity,
  ContextMatcher,
  EnforcementConfig,
  BaseConstraints,
  ToolRestrictionRule,
  FileAccessRule,
  OutputFormatRule,
  BehavioralRule,
  TemporalRule,
  ResourceRule,
  SideEffectRule,
} from "./schema.js";
import {
  ProtocolSchema,
  ProtocolConstraintSchema,
  BaseConstraintsSchema,
  createEmptyProtocol,
  validateProtocol,
} from "./schema.js";

// ============================================================================
// Proposal Types
// ============================================================================

/**
 * A raw proposal from a worker suggesting protocol constraints
 */
export interface WorkerProposal {
  workerId: string;
  featureId: string;
  timestamp: string;
  proposalText: string;
  suggestedConstraints?: SuggestedConstraint[];
  context?: {
    taskDescription?: string;
    filesModified?: string[];
    toolsUsed?: string[];
  };
}

/**
 * A structured constraint suggestion extracted from a proposal
 */
export interface SuggestedConstraint {
  type: ConstraintType;
  description: string;
  severity: ConstraintSeverity;
  details: Record<string, unknown>;
}

/**
 * Result of parsing a worker proposal
 */
export interface ParsedProposal {
  isValid: boolean;
  extractedConstraints: SuggestedConstraint[];
  warnings: string[];
  errors: string[];
  confidence: number; // 0-1 confidence in the extraction
  rawPatterns: {
    toolMentions: string[];
    fileMentions: string[];
    behaviorMentions: string[];
  };
}

/**
 * Result of validating a protocol against base constraints
 */
export interface BaseConstraintValidation {
  isValid: boolean;
  violations: BaseConstraintViolation[];
  adjustments: ConstraintAdjustment[];
}

/**
 * A violation of base constraints
 */
export interface BaseConstraintViolation {
  constraintId: string;
  violationType: "prohibited_tool" | "prohibited_path" | "prohibited_operation" | "missing_requirement";
  message: string;
  suggestedFix?: string;
}

/**
 * An adjustment made to comply with base constraints
 */
export interface ConstraintAdjustment {
  constraintId: string;
  adjustmentType: "removed" | "modified" | "added";
  reason: string;
  originalValue?: unknown;
  newValue?: unknown;
}

// ============================================================================
// Zod Schemas for Validation
// ============================================================================

export const SuggestedConstraintSchema = z.object({
  type: z.enum([
    "tool_restriction",
    "file_access",
    "output_format",
    "behavioral",
    "temporal",
    "resource",
    "side_effect",
  ]),
  description: z.string(),
  severity: z.enum(["error", "warning", "info"]),
  details: z.record(z.unknown()),
});

export const WorkerProposalSchema = z.object({
  workerId: z.string(),
  featureId: z.string(),
  timestamp: z.string(),
  proposalText: z.string(),
  suggestedConstraints: z.array(SuggestedConstraintSchema).optional(),
  context: z
    .object({
      taskDescription: z.string().optional(),
      filesModified: z.array(z.string()).optional(),
      toolsUsed: z.array(z.string()).optional(),
    })
    .optional(),
});

export const ParsedProposalSchema = z.object({
  isValid: z.boolean(),
  extractedConstraints: z.array(SuggestedConstraintSchema),
  warnings: z.array(z.string()),
  errors: z.array(z.string()),
  confidence: z.number().min(0).max(1),
  rawPatterns: z.object({
    toolMentions: z.array(z.string()),
    fileMentions: z.array(z.string()),
    behaviorMentions: z.array(z.string()),
  }),
});

export const BaseConstraintViolationSchema = z.object({
  constraintId: z.string(),
  violationType: z.enum([
    "prohibited_tool",
    "prohibited_path",
    "prohibited_operation",
    "missing_requirement",
  ]),
  message: z.string(),
  suggestedFix: z.string().optional(),
});

export const ConstraintAdjustmentSchema = z.object({
  constraintId: z.string(),
  adjustmentType: z.enum(["removed", "modified", "added"]),
  reason: z.string(),
  originalValue: z.unknown().optional(),
  newValue: z.unknown().optional(),
});

export const BaseConstraintValidationSchema = z.object({
  isValid: z.boolean(),
  violations: z.array(BaseConstraintViolationSchema),
  adjustments: z.array(ConstraintAdjustmentSchema),
});

// ============================================================================
// Pattern Extraction Utilities
// ============================================================================

/**
 * Patterns for extracting tool mentions from text
 */
const TOOL_PATTERNS = [
  /\b(Bash|Read|Write|Edit|Glob|Grep|Task|WebFetch|WebSearch)\b/gi,
  /\buse\s+(\w+)\s+tool\b/gi,
  /\bexecute\s+(\w+)\b/gi,
  /\bcall\s+(\w+)\b/gi,
  /\b(npm|yarn|pnpm|node|python|pip|cargo|go|make)\b/gi,
];

/**
 * Patterns for extracting file path mentions
 */
const FILE_PATTERNS = [
  /\b([\w\-./]+\.(ts|js|tsx|jsx|py|rs|go|md|json|yaml|yml|toml))\b/gi,
  /\b(src|lib|dist|build|test|tests|spec|config)\/[\w\-./]+\b/gi,
  /\b\.\/[\w\-./]+\b/g,
  /\b(\/[\w\-./]+)+\b/g,
];

/**
 * Patterns for extracting behavioral constraints
 */
const BEHAVIOR_PATTERNS = [
  /\b(must not|should not|cannot|never|always|must|should|require)\b/gi,
  /\b(forbidden|prohibited|allowed|permitted|restricted)\b/gi,
  /\b(limit|maximum|minimum|timeout|rate|quota)\b/gi,
  /\b(confirm|approve|verify|validate|check)\b/gi,
];

/**
 * Extract patterns from text
 */
function extractPatterns(text: string, patterns: RegExp[]): string[] {
  const matches = new Set<string>();
  for (const pattern of patterns) {
    // Reset lastIndex for global patterns
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(text)) !== null) {
      matches.add(match[1] || match[0]);
    }
  }
  return Array.from(matches);
}

// ============================================================================
// ProtocolGenerator Class
// ============================================================================

/**
 * ProtocolGenerator - Creates and validates protocols from worker proposals
 */
export class ProtocolGenerator {
  private readonly defaultBaseConstraints: BaseConstraints;

  constructor(baseConstraints?: Partial<BaseConstraints>) {
    this.defaultBaseConstraints = {
      prohibitedTools: ["rm", "sudo", "chmod", "chown", "kill", "pkill"],
      prohibitedPaths: [
        "/etc/passwd",
        "/etc/shadow",
        "~/.ssh",
        "~/.gnupg",
        "~/.aws",
        "/root",
      ],
      prohibitedOperations: [
        "format_disk",
        "delete_database",
        "drop_table",
        "modify_system_config",
      ],
      minSeverityForBlock: "error",
      requirePreValidation: true,
      requirePostValidation: true,
      maxAllowedTools: undefined,
      maxAllowedPaths: undefined,
      requireAuditLog: true,
      auditRetentionDays: 30,
      ...baseConstraints,
    };
  }

  /**
   * Parse a worker proposal to extract constraint suggestions
   */
  parseProposal(proposal: WorkerProposal): ParsedProposal {
    const errors: string[] = [];
    const warnings: string[] = [];
    const extractedConstraints: SuggestedConstraint[] = [];

    // Validate proposal structure
    try {
      WorkerProposalSchema.parse(proposal);
    } catch (e) {
      errors.push(`Invalid proposal structure: ${e instanceof Error ? e.message : String(e)}`);
      return {
        isValid: false,
        extractedConstraints: [],
        warnings: [],
        errors,
        confidence: 0,
        rawPatterns: {
          toolMentions: [],
          fileMentions: [],
          behaviorMentions: [],
        },
      };
    }

    const text = proposal.proposalText;

    // Extract raw patterns
    const toolMentions = extractPatterns(text, TOOL_PATTERNS);
    const fileMentions = extractPatterns(text, FILE_PATTERNS);
    const behaviorMentions = extractPatterns(text, BEHAVIOR_PATTERNS);

    // Use pre-extracted constraints if available
    if (proposal.suggestedConstraints && proposal.suggestedConstraints.length > 0) {
      extractedConstraints.push(...proposal.suggestedConstraints);
    }

    // Extract tool restrictions
    const toolConstraints = this.extractToolConstraints(text, toolMentions);
    extractedConstraints.push(...toolConstraints);

    // Extract file access constraints
    const fileConstraints = this.extractFileConstraints(text, fileMentions);
    extractedConstraints.push(...fileConstraints);

    // Extract behavioral constraints
    const behavioralConstraints = this.extractBehavioralConstraints(text, behaviorMentions);
    extractedConstraints.push(...behavioralConstraints);

    // Deduplicate constraints by type and description
    const uniqueConstraints = this.deduplicateConstraints(extractedConstraints);

    // Check for empty extraction
    if (uniqueConstraints.length === 0) {
      warnings.push("No constraints could be extracted from the proposal");
    }

    // Calculate confidence based on extraction quality
    const confidence = this.calculateConfidence(
      text,
      uniqueConstraints,
      toolMentions,
      fileMentions,
      behaviorMentions
    );

    return {
      isValid: errors.length === 0,
      extractedConstraints: uniqueConstraints,
      warnings,
      errors,
      confidence,
      rawPatterns: {
        toolMentions,
        fileMentions,
        behaviorMentions,
      },
    };
  }

  /**
   * Extract tool restriction constraints from text
   */
  private extractToolConstraints(text: string, toolMentions: string[]): SuggestedConstraint[] {
    const constraints: SuggestedConstraint[] = [];
    const lowerText = text.toLowerCase();

    // Check for allow patterns
    const allowPatterns = [
      /only\s+(?:use|allow)\s+([\w,\s]+)/gi,
      /allowed?\s+tools?:\s*([\w,\s]+)/gi,
      /restrict\s+to\s+([\w,\s]+)/gi,
    ];

    for (const pattern of allowPatterns) {
      pattern.lastIndex = 0;
      const match = pattern.exec(text);
      if (match) {
        const tools = match[1].split(/[,\s]+/).filter(t => t.length > 0);
        if (tools.length > 0) {
          constraints.push({
            type: "tool_restriction",
            description: `Only allow tools: ${tools.join(", ")}`,
            severity: "error",
            details: { allowedTools: tools },
          });
        }
      }
    }

    // Check for deny patterns
    const denyPatterns = [
      /(?:do not|don't|never)\s+use\s+([\w,\s]+)/gi,
      /denied?\s+tools?:\s*([\w,\s]+)/gi,
      /(?:forbid|prohibit)\s+([\w,\s]+)/gi,
    ];

    for (const pattern of denyPatterns) {
      pattern.lastIndex = 0;
      const match = pattern.exec(text);
      if (match) {
        const tools = match[1].split(/[,\s]+/).filter(t => t.length > 0);
        if (tools.length > 0) {
          constraints.push({
            type: "tool_restriction",
            description: `Deny tools: ${tools.join(", ")}`,
            severity: "error",
            details: { deniedTools: tools },
          });
        }
      }
    }

    // Check for approval patterns
    if (lowerText.includes("require approval") || lowerText.includes("need confirmation")) {
      const approvalTools = toolMentions.filter(t =>
        lowerText.includes(`approve ${t.toLowerCase()}`) ||
        lowerText.includes(`confirm ${t.toLowerCase()}`)
      );
      if (approvalTools.length > 0) {
        constraints.push({
          type: "tool_restriction",
          description: `Require approval for: ${approvalTools.join(", ")}`,
          severity: "warning",
          details: { requireApproval: approvalTools },
        });
      }
    }

    return constraints;
  }

  /**
   * Extract file access constraints from text
   */
  private extractFileConstraints(text: string, fileMentions: string[]): SuggestedConstraint[] {
    const constraints: SuggestedConstraint[] = [];
    const lowerText = text.toLowerCase();

    // Check for read-only patterns
    if (lowerText.includes("read-only") || lowerText.includes("readonly") || lowerText.includes("read only")) {
      const readOnlyPaths = fileMentions.filter(f =>
        lowerText.includes(`read-only ${f.toLowerCase()}`) ||
        lowerText.includes(`readonly ${f.toLowerCase()}`)
      );
      if (readOnlyPaths.length > 0 || lowerText.includes("all files read-only")) {
        constraints.push({
          type: "file_access",
          description: "Read-only file access",
          severity: "error",
          details: {
            readOnly: readOnlyPaths.length > 0 ? readOnlyPaths : ["**/*"],
          },
        });
      }
    }

    // Check for allowed paths patterns
    const allowPathPatterns = [
      /only\s+(?:access|modify)\s+(?:files?\s+in\s+)?([\w\-./,\s*]+)/gi,
      /allowed?\s+paths?:\s*([\w\-./,\s*]+)/gi,
      /restrict\s+(?:to|access\s+to)\s+([\w\-./,\s*]+)/gi,
    ];

    for (const pattern of allowPathPatterns) {
      pattern.lastIndex = 0;
      const match = pattern.exec(text);
      if (match) {
        const paths = match[1].split(/[,\s]+/).filter(p => p.length > 0 && p !== "in");
        if (paths.length > 0) {
          constraints.push({
            type: "file_access",
            description: `Restrict file access to: ${paths.join(", ")}`,
            severity: "error",
            details: { allowedPaths: paths },
          });
        }
      }
    }

    // Check for denied paths patterns
    const denyPathPatterns = [
      /(?:do not|don't|never)\s+(?:access|modify|touch)\s+([\w\-./,\s*]+)/gi,
      /denied?\s+paths?:\s*([\w\-./,\s*]+)/gi,
      /(?:forbid|prohibit)\s+access\s+to\s+([\w\-./,\s*]+)/gi,
    ];

    for (const pattern of denyPathPatterns) {
      pattern.lastIndex = 0;
      const match = pattern.exec(text);
      if (match) {
        const paths = match[1].split(/[,\s]+/).filter(p => p.length > 0);
        if (paths.length > 0) {
          constraints.push({
            type: "file_access",
            description: `Deny access to: ${paths.join(", ")}`,
            severity: "error",
            details: { deniedPaths: paths },
          });
        }
      }
    }

    // Check for file extension patterns
    const extPatterns = [
      /only\s+(?:\w+\s+)?(\.[\w,\s.]+)\s+files?/gi,
      /allowed?\s+extensions?:\s*(\.[\w,\s.]+)/gi,
    ];

    for (const pattern of extPatterns) {
      pattern.lastIndex = 0;
      const match = pattern.exec(text);
      if (match) {
        const extensions = match[1].split(/[,\s]+/).filter(e => e.startsWith("."));
        if (extensions.length > 0) {
          constraints.push({
            type: "file_access",
            description: `Restrict to file extensions: ${extensions.join(", ")}`,
            severity: "warning",
            details: { allowedExtensions: extensions },
          });
        }
      }
    }

    return constraints;
  }

  /**
   * Extract behavioral constraints from text
   */
  private extractBehavioralConstraints(text: string, behaviorMentions: string[]): SuggestedConstraint[] {
    const constraints: SuggestedConstraint[] = [];
    const lowerText = text.toLowerCase();

    // Check for confirmation requirements
    if (
      lowerText.includes("require confirmation") ||
      lowerText.includes("must confirm") ||
      lowerText.includes("user approval")
    ) {
      constraints.push({
        type: "behavioral",
        description: "Require user confirmation for actions",
        severity: "warning",
        details: { requireConfirmation: true },
      });
    }

    // Check for explanation requirements
    if (
      lowerText.includes("explain") ||
      lowerText.includes("provide reason") ||
      lowerText.includes("document changes")
    ) {
      constraints.push({
        type: "behavioral",
        description: "Require explanation for actions",
        severity: "info",
        details: { requireExplanation: true },
      });
    }

    // Check for iteration limits
    const iterPattern = /(?:max(?:imum)?|limit)\s+(?:of\s+)?(\d+)\s+(?:iteration|loop|attempt)/gi;
    const iterMatch = iterPattern.exec(text);
    if (iterMatch) {
      constraints.push({
        type: "behavioral",
        description: `Limit iterations to ${iterMatch[1]}`,
        severity: "warning",
        details: { maxIterations: parseInt(iterMatch[1], 10) },
      });
    }

    // Check for timeout patterns
    const timeoutPattern = /timeout\s+(?:of\s+)?(\d+)\s*(second|minute|hour)/gi;
    const timeoutMatch = timeoutPattern.exec(text);
    if (timeoutMatch) {
      let seconds = parseInt(timeoutMatch[1], 10);
      const unit = timeoutMatch[2].toLowerCase();
      if (unit.startsWith("minute")) seconds *= 60;
      if (unit.startsWith("hour")) seconds *= 3600;
      constraints.push({
        type: "behavioral",
        description: `Timeout after ${timeoutMatch[1]} ${timeoutMatch[2]}s`,
        severity: "error",
        details: { timeoutSeconds: seconds },
      });
    }

    // Check for prohibited actions
    const prohibitedPattern = /(?:never|must not|cannot|do not)\s+(\w+(?:\s+\w+){0,3})/gi;
    let prohibMatch;
    const prohibitedActions: string[] = [];
    while ((prohibMatch = prohibitedPattern.exec(text)) !== null) {
      prohibitedActions.push(prohibMatch[1].trim());
    }
    if (prohibitedActions.length > 0) {
      constraints.push({
        type: "behavioral",
        description: `Prohibited actions: ${prohibitedActions.join(", ")}`,
        severity: "error",
        details: { prohibitedActions },
      });
    }

    return constraints;
  }

  /**
   * Remove duplicate constraints
   */
  private deduplicateConstraints(constraints: SuggestedConstraint[]): SuggestedConstraint[] {
    const seen = new Set<string>();
    return constraints.filter(c => {
      const key = `${c.type}:${JSON.stringify(c.details)}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
  }

  /**
   * Calculate confidence score for extraction
   */
  private calculateConfidence(
    text: string,
    constraints: SuggestedConstraint[],
    toolMentions: string[],
    fileMentions: string[],
    behaviorMentions: string[]
  ): number {
    if (constraints.length === 0) {
      return 0;
    }

    let score = 0;

    // Base score for having constraints
    score += Math.min(constraints.length * 0.15, 0.45);

    // Bonus for having pattern matches
    if (toolMentions.length > 0) score += 0.1;
    if (fileMentions.length > 0) score += 0.1;
    if (behaviorMentions.length > 0) score += 0.1;

    // Bonus for text length (indicates more detailed proposal)
    if (text.length > 100) score += 0.05;
    if (text.length > 300) score += 0.05;
    if (text.length > 500) score += 0.05;

    // Bonus for explicit constraint keywords
    const explicitKeywords = ["constraint", "rule", "policy", "restrict", "limit", "require"];
    const keywordMatches = explicitKeywords.filter(k => text.toLowerCase().includes(k));
    score += Math.min(keywordMatches.length * 0.05, 0.1);

    return Math.min(score, 1);
  }

  /**
   * Create a protocol from a parsed proposal
   */
  createProtocolFromProposal(
    proposalId: string,
    parsed: ParsedProposal,
    options?: {
      name?: string;
      description?: string;
      priority?: number;
      enforcement?: Partial<EnforcementConfig>;
      applicableContexts?: ContextMatcher;
    }
  ): Protocol {
    const protocol = createEmptyProtocol(
      `proposal-${proposalId}`,
      options?.name || `Protocol from proposal ${proposalId}`
    );

    // Set optional fields
    if (options?.description) {
      protocol.description = options.description;
    }
    if (options?.priority !== undefined) {
      protocol.priority = options.priority;
    }
    if (options?.applicableContexts) {
      protocol.applicableContexts = options.applicableContexts;
    }
    if (options?.enforcement) {
      protocol.enforcement = {
        ...protocol.enforcement,
        ...options.enforcement,
      };
    }

    // Convert extracted constraints to protocol constraints
    protocol.constraints = parsed.extractedConstraints.map((sc, index) =>
      this.suggestedToProtocolConstraint(sc, `constraint-${index + 1}`)
    );

    // Set timestamps
    protocol.createdAt = new Date().toISOString();

    return protocol;
  }

  /**
   * Convert a suggested constraint to a protocol constraint
   */
  private suggestedToProtocolConstraint(
    suggested: SuggestedConstraint,
    id: string
  ): ProtocolConstraint {
    const rule = this.buildConstraintRule(suggested);

    return {
      id,
      type: suggested.type,
      rule,
      severity: suggested.severity,
      message: suggested.description,
      enabled: true,
    };
  }

  /**
   * Build a constraint rule from suggested constraint details
   */
  private buildConstraintRule(suggested: SuggestedConstraint): ConstraintRule {
    const details = suggested.details;

    switch (suggested.type) {
      case "tool_restriction":
        return {
          type: "tool_restriction",
          allowedTools: details.allowedTools as string[] | undefined,
          deniedTools: details.deniedTools as string[] | undefined,
          toolPatterns: details.toolPatterns as string[] | undefined,
          requireApproval: details.requireApproval as string[] | undefined,
        } as ToolRestrictionRule;

      case "file_access":
        return {
          type: "file_access",
          allowedPaths: details.allowedPaths as string[] | undefined,
          deniedPaths: details.deniedPaths as string[] | undefined,
          readOnly: details.readOnly as string[] | undefined,
          writeOnly: details.writeOnly as string[] | undefined,
          maxFileSize: details.maxFileSize as number | undefined,
          allowedExtensions: details.allowedExtensions as string[] | undefined,
          deniedExtensions: details.deniedExtensions as string[] | undefined,
        } as FileAccessRule;

      case "output_format":
        return {
          type: "output_format",
          maxLength: details.maxLength as number | undefined,
          requiredFields: details.requiredFields as string[] | undefined,
          forbiddenPatterns: details.forbiddenPatterns as string[] | undefined,
          requiredPatterns: details.requiredPatterns as string[] | undefined,
          format: details.format as "json" | "markdown" | "text" | "yaml" | "custom" | undefined,
          schema: details.schema as Record<string, unknown> | undefined,
        } as OutputFormatRule;

      case "behavioral":
        return {
          type: "behavioral",
          requireConfirmation: details.requireConfirmation as boolean | undefined,
          maxIterations: details.maxIterations as number | undefined,
          timeoutSeconds: details.timeoutSeconds as number | undefined,
          requireExplanation: details.requireExplanation as boolean | undefined,
          prohibitedActions: details.prohibitedActions as string[] | undefined,
          requiredActions: details.requiredActions as string[] | undefined,
        } as BehavioralRule;

      case "temporal":
        return {
          type: "temporal",
          rateLimitPerMinute: details.rateLimitPerMinute as number | undefined,
          rateLimitPerHour: details.rateLimitPerHour as number | undefined,
          cooldownSeconds: details.cooldownSeconds as number | undefined,
          validFrom: details.validFrom as string | undefined,
          validUntil: details.validUntil as string | undefined,
          allowedHours: details.allowedHours as number[] | undefined,
          allowedDays: details.allowedDays as number[] | undefined,
        } as TemporalRule;

      case "resource":
        return {
          type: "resource",
          maxMemoryMB: details.maxMemoryMB as number | undefined,
          maxCpuPercent: details.maxCpuPercent as number | undefined,
          maxConcurrentOps: details.maxConcurrentOps as number | undefined,
          maxDiskWriteMB: details.maxDiskWriteMB as number | undefined,
          maxNetworkRequestsPerMin: details.maxNetworkRequestsPerMin as number | undefined,
          maxTokensPerRequest: details.maxTokensPerRequest as number | undefined,
        } as ResourceRule;

      case "side_effect":
        return {
          type: "side_effect",
          allowNetwork: details.allowNetwork as boolean | undefined,
          allowedHosts: details.allowedHosts as string[] | undefined,
          deniedHosts: details.deniedHosts as string[] | undefined,
          allowShellCommands: details.allowShellCommands as boolean | undefined,
          allowedCommands: details.allowedCommands as string[] | undefined,
          deniedCommands: details.deniedCommands as string[] | undefined,
          allowGitOperations: details.allowGitOperations as boolean | undefined,
          allowedGitOps: details.allowedGitOps as string[] | undefined,
          deniedGitOps: details.deniedGitOps as string[] | undefined,
        } as SideEffectRule;

      default:
        throw new Error(`Unknown constraint type: ${suggested.type}`);
    }
  }

  /**
   * Validate a protocol against base constraints
   * Returns validation result with any violations and required adjustments
   */
  validateAgainstBaseConstraints(
    protocol: Protocol,
    baseConstraints?: BaseConstraints
  ): BaseConstraintValidation {
    const base = baseConstraints || this.defaultBaseConstraints;
    const violations: BaseConstraintViolation[] = [];
    const adjustments: ConstraintAdjustment[] = [];

    // Validate each constraint in the protocol
    for (const constraint of protocol.constraints) {
      const rule = constraint.rule;

      // Check tool restrictions
      if (rule.type === "tool_restriction") {
        const toolRule = rule as ToolRestrictionRule;

        // Check if any allowed tools are prohibited
        if (toolRule.allowedTools) {
          const prohibited = toolRule.allowedTools.filter(t =>
            base.prohibitedTools.some(pt => t.toLowerCase().includes(pt.toLowerCase()))
          );
          if (prohibited.length > 0) {
            violations.push({
              constraintId: constraint.id,
              violationType: "prohibited_tool",
              message: `Attempted to allow prohibited tools: ${prohibited.join(", ")}`,
              suggestedFix: `Remove ${prohibited.join(", ")} from allowed tools`,
            });
          }
        }

        // Check if maxAllowedTools is specified and exceeded
        if (base.maxAllowedTools && toolRule.allowedTools) {
          const unauthorized = toolRule.allowedTools.filter(
            t => !base.maxAllowedTools!.includes(t)
          );
          if (unauthorized.length > 0) {
            violations.push({
              constraintId: constraint.id,
              violationType: "prohibited_tool",
              message: `Tools not in maximum allowed set: ${unauthorized.join(", ")}`,
              suggestedFix: `Restrict to: ${base.maxAllowedTools.join(", ")}`,
            });
          }
        }
      }

      // Check file access restrictions
      if (rule.type === "file_access") {
        const fileRule = rule as FileAccessRule;

        // Check if any allowed paths include prohibited paths
        if (fileRule.allowedPaths) {
          const prohibited = fileRule.allowedPaths.filter(p =>
            base.prohibitedPaths.some(pp =>
              p.includes(pp) || this.pathMatches(p, pp)
            )
          );
          if (prohibited.length > 0) {
            violations.push({
              constraintId: constraint.id,
              violationType: "prohibited_path",
              message: `Attempted to allow access to prohibited paths: ${prohibited.join(", ")}`,
              suggestedFix: `Remove ${prohibited.join(", ")} from allowed paths`,
            });
          }
        }

        // Check if maxAllowedPaths is specified and exceeded
        if (base.maxAllowedPaths && fileRule.allowedPaths) {
          const unauthorized = fileRule.allowedPaths.filter(
            p => !base.maxAllowedPaths!.some(mp => this.pathMatches(p, mp))
          );
          if (unauthorized.length > 0) {
            violations.push({
              constraintId: constraint.id,
              violationType: "prohibited_path",
              message: `Paths not in maximum allowed set: ${unauthorized.join(", ")}`,
              suggestedFix: `Restrict paths to match: ${base.maxAllowedPaths.join(", ")}`,
            });
          }
        }
      }

      // Check behavioral constraints for prohibited operations
      if (rule.type === "behavioral") {
        const behaviorRule = rule as BehavioralRule;

        // Ensure prohibited actions don't include any that base constraints require
        if (behaviorRule.requiredActions) {
          const prohibited = behaviorRule.requiredActions.filter(a =>
            base.prohibitedOperations.some(po => a.toLowerCase().includes(po.toLowerCase()))
          );
          if (prohibited.length > 0) {
            violations.push({
              constraintId: constraint.id,
              violationType: "prohibited_operation",
              message: `Cannot require prohibited operations: ${prohibited.join(", ")}`,
              suggestedFix: `Remove ${prohibited.join(", ")} from required actions`,
            });
          }
        }
      }
    }

    // Check enforcement requirements
    if (base.requirePreValidation && !protocol.enforcement.preExecutionValidation) {
      violations.push({
        constraintId: "enforcement",
        violationType: "missing_requirement",
        message: "Pre-execution validation is required but disabled",
        suggestedFix: "Enable preExecutionValidation in enforcement config",
      });
      adjustments.push({
        constraintId: "enforcement",
        adjustmentType: "modified",
        reason: "Base constraints require pre-execution validation",
        originalValue: false,
        newValue: true,
      });
    }

    if (base.requirePostValidation && !protocol.enforcement.postExecutionValidation) {
      violations.push({
        constraintId: "enforcement",
        violationType: "missing_requirement",
        message: "Post-execution validation is required but disabled",
        suggestedFix: "Enable postExecutionValidation in enforcement config",
      });
      adjustments.push({
        constraintId: "enforcement",
        adjustmentType: "modified",
        reason: "Base constraints require post-execution validation",
        originalValue: false,
        newValue: true,
      });
    }

    // Check audit logging requirement
    if (base.requireAuditLog && protocol.enforcement.logLevel === "none") {
      violations.push({
        constraintId: "enforcement",
        violationType: "missing_requirement",
        message: "Audit logging is required but log level is 'none'",
        suggestedFix: "Set logLevel to at least 'minimal'",
      });
      adjustments.push({
        constraintId: "enforcement",
        adjustmentType: "modified",
        reason: "Base constraints require audit logging",
        originalValue: "none",
        newValue: "standard",
      });
    }

    return {
      isValid: violations.length === 0,
      violations,
      adjustments,
    };
  }

  /**
   * Check if a path matches a pattern (simple glob matching)
   */
  private pathMatches(path: string, pattern: string): boolean {
    // Simple pattern matching
    if (pattern === path) return true;
    if (pattern.endsWith("*")) {
      const prefix = pattern.slice(0, -1);
      return path.startsWith(prefix);
    }
    if (pattern.startsWith("*")) {
      const suffix = pattern.slice(1);
      return path.endsWith(suffix);
    }
    if (pattern.includes("*")) {
      const [prefix, suffix] = pattern.split("*");
      return path.startsWith(prefix) && path.endsWith(suffix);
    }
    return path.includes(pattern);
  }

  /**
   * Apply adjustments to a protocol to make it comply with base constraints
   */
  applyAdjustments(
    protocol: Protocol,
    adjustments: ConstraintAdjustment[]
  ): Protocol {
    const adjusted = { ...protocol };

    for (const adjustment of adjustments) {
      if (adjustment.constraintId === "enforcement") {
        // Apply enforcement adjustments
        if (adjustment.originalValue === false && adjustment.newValue === true) {
          // Enable validation flags
          if (adjusted.enforcement.preExecutionValidation === false) {
            adjusted.enforcement = {
              ...adjusted.enforcement,
              preExecutionValidation: true,
            };
          }
          if (adjusted.enforcement.postExecutionValidation === false) {
            adjusted.enforcement = {
              ...adjusted.enforcement,
              postExecutionValidation: true,
            };
          }
        }
        if (adjustment.originalValue === "none") {
          // Enable logging
          adjusted.enforcement = {
            ...adjusted.enforcement,
            logLevel: (adjustment.newValue as "minimal" | "standard" | "verbose" | "debug") || "standard",
          };
        }
      }
    }

    return adjusted;
  }

  /**
   * Generate a protocol from a task description
   * Creates a minimal protocol with sensible defaults for the task
   */
  generateFromTask(
    taskId: string,
    taskDescription: string,
    options?: {
      strict?: boolean;
      allowedTools?: string[];
      allowedPaths?: string[];
    }
  ): Protocol {
    const protocol = createEmptyProtocol(
      `task-${taskId}`,
      `Protocol for task: ${taskDescription.slice(0, 50)}${taskDescription.length > 50 ? "..." : ""}`
    );

    protocol.description = taskDescription;
    protocol.createdAt = new Date().toISOString();

    // Set enforcement based on strictness
    if (options?.strict) {
      protocol.enforcement.mode = "strict";
      protocol.enforcement.onViolation = "block";
    } else {
      protocol.enforcement.mode = "permissive";
      protocol.enforcement.onViolation = "warn";
    }

    // Add tool restriction if specified
    if (options?.allowedTools) {
      protocol.constraints.push({
        id: "tool-restriction",
        type: "tool_restriction",
        rule: {
          type: "tool_restriction",
          allowedTools: options.allowedTools,
        },
        severity: "error",
        message: `Only allowed tools: ${options.allowedTools.join(", ")}`,
        enabled: true,
      });
    }

    // Add file restriction if specified
    if (options?.allowedPaths) {
      protocol.constraints.push({
        id: "file-restriction",
        type: "file_access",
        rule: {
          type: "file_access",
          allowedPaths: options.allowedPaths,
        },
        severity: "error",
        message: `File access restricted to: ${options.allowedPaths.join(", ")}`,
        enabled: true,
      });
    }

    // Set applicable contexts based on task
    protocol.applicableContexts = {
      taskPatterns: [taskDescription.slice(0, 100)],
    };

    return protocol;
  }

  /**
   * Merge multiple protocols into a single protocol
   * Higher priority protocols override lower priority ones
   */
  mergeProtocols(
    protocols: Protocol[],
    newId: string,
    newName: string
  ): Protocol {
    // Sort by priority (ascending so higher priority comes last and overrides)
    const sorted = [...protocols].sort((a, b) => a.priority - b.priority);

    const merged = createEmptyProtocol(newId, newName);
    const constraintMap = new Map<string, ProtocolConstraint>();
    const sources: string[] = [];

    for (const protocol of sorted) {
      sources.push(protocol.id);

      // Merge constraints (later protocols override)
      for (const constraint of protocol.constraints) {
        constraintMap.set(constraint.id, constraint);
      }

      // Merge enforcement (later protocols override)
      merged.enforcement = {
        ...merged.enforcement,
        ...protocol.enforcement,
      };

      // Merge contexts (union)
      merged.applicableContexts = this.mergeContexts(
        merged.applicableContexts,
        protocol.applicableContexts
      );
    }

    merged.constraints = Array.from(constraintMap.values());
    merged.extends = sources;
    merged.priority = Math.max(...protocols.map(p => p.priority));
    merged.createdAt = new Date().toISOString();
    merged.description = `Merged from: ${sources.join(", ")}`;

    return merged;
  }

  /**
   * Merge two context matchers (union operation)
   */
  private mergeContexts(a: ContextMatcher, b: ContextMatcher): ContextMatcher {
    const mergeArrays = <T>(arr1?: T[], arr2?: T[]): T[] | undefined => {
      if (!arr1 && !arr2) return undefined;
      const result = [...(arr1 || []), ...(arr2 || [])];
      return result.length > 0 ? Array.from(new Set(result)) : undefined;
    };

    return {
      featurePatterns: mergeArrays(a.featurePatterns, b.featurePatterns),
      featureDescriptionPatterns: mergeArrays(a.featureDescriptionPatterns, b.featureDescriptionPatterns),
      filePatterns: mergeArrays(a.filePatterns, b.filePatterns),
      fileExtensions: mergeArrays(a.fileExtensions, b.fileExtensions),
      projectPatterns: mergeArrays(a.projectPatterns, b.projectPatterns),
      projectTypes: mergeArrays(a.projectTypes, b.projectTypes),
      taskPatterns: mergeArrays(a.taskPatterns, b.taskPatterns),
      taskTypes: mergeArrays(a.taskTypes, b.taskTypes),
      environments: mergeArrays(a.environments, b.environments),
      branches: mergeArrays(a.branches, b.branches),
      workerPatterns: mergeArrays(a.workerPatterns, b.workerPatterns),
      workerTags: mergeArrays(a.workerTags, b.workerTags),
      excludeFeatures: mergeArrays(a.excludeFeatures, b.excludeFeatures),
      excludeFiles: mergeArrays(a.excludeFiles, b.excludeFiles),
      excludeProjects: mergeArrays(a.excludeProjects, b.excludeProjects),
      excludeTasks: mergeArrays(a.excludeTasks, b.excludeTasks),
      excludeEnvironments: mergeArrays(a.excludeEnvironments, b.excludeEnvironments),
      excludeBranches: mergeArrays(a.excludeBranches, b.excludeBranches),
    };
  }

  /**
   * Get the default base constraints
   */
  getDefaultBaseConstraints(): BaseConstraints {
    return { ...this.defaultBaseConstraints };
  }
}

// ============================================================================
// Convenience Factory Functions
// ============================================================================

/**
 * Create a protocol generator with default settings
 */
export function createProtocolGenerator(
  baseConstraints?: Partial<BaseConstraints>
): ProtocolGenerator {
  return new ProtocolGenerator(baseConstraints);
}

/**
 * Quick parse of a proposal text
 */
export function parseProposalText(
  workerId: string,
  featureId: string,
  proposalText: string
): ParsedProposal {
  const generator = new ProtocolGenerator();
  return generator.parseProposal({
    workerId,
    featureId,
    timestamp: new Date().toISOString(),
    proposalText,
  });
}

/**
 * Quick creation of a protocol from a proposal
 */
export function createProtocolFromText(
  proposalId: string,
  proposalText: string,
  options?: {
    name?: string;
    description?: string;
  }
): Protocol | null {
  const generator = new ProtocolGenerator();
  const parsed = generator.parseProposal({
    workerId: "system",
    featureId: "auto",
    timestamp: new Date().toISOString(),
    proposalText,
  });

  if (!parsed.isValid || parsed.extractedConstraints.length === 0) {
    return null;
  }

  return generator.createProtocolFromProposal(proposalId, parsed, options);
}
