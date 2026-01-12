/**
 * Security Utilities - Input validation and sanitization
 *
 * This module provides security functions to prevent:
 * - Command injection (CWE-78)
 * - Path traversal (CWE-22)
 * - Unsafe deserialization (CWE-502)
 */

import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { z } from "zod";

/**
 * Validate and sanitize a project directory path
 * Prevents path traversal attacks and symlink escapes
 */
export function validateProjectDir(projectDir: string): string {
  // First resolve .. and . components
  const resolved = path.resolve(projectDir);

  // Use realpathSync to follow all symlinks and get the true path
  // This prevents symlink-based escapes to forbidden directories
  let realPath: string;
  try {
    realPath = fs.realpathSync(resolved);
  } catch (error) {
    throw new Error(`Project directory does not exist or is inaccessible: ${resolved}`);
  }

  // Check it's not a system directory (check the REAL path, not the symlink)
  const forbiddenPrefixes = [
    "/etc",
    "/usr",
    "/bin",
    "/sbin",
    "/var",
    "/tmp",
    "/dev",
    "/proc",
    "/sys",
    "/boot",
    "/run",
    "/root",
    "/System",
    "/Library",
    "/private/var",
    "/private/etc",
    "C:\\Windows",
    "C:\\Program Files",
    "C:\\Program Files (x86)",
  ];

  const normalizedPath = realPath.toLowerCase();
  for (const prefix of forbiddenPrefixes) {
    if (normalizedPath.startsWith(prefix.toLowerCase())) {
      throw new Error(`Cannot use system directory as project: ${prefix}`);
    }
  }

  // Verify it's actually a directory (realpathSync already confirmed it exists)
  const stats = fs.statSync(realPath);
  if (!stats.isDirectory()) {
    throw new Error(`Project path is not a directory: ${realPath}`);
  }

  return realPath;
}

/**
 * Validate feature ID - only allow safe characters
 */
export function validateFeatureId(id: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
    throw new Error(
      "Invalid feature ID: only alphanumeric, dash, and underscore allowed"
    );
  }
  if (id.length > 64) {
    throw new Error("Feature ID too long (max 64 characters)");
  }
  return id;
}

/**
 * Validate tmux session name
 * Supports worker (cc-worker-*), planner (cc-planner-*), and reviewer (cc-reviewer-*) sessions
 * Format: cc-(worker|planner|reviewer)-{featureId}-{hash}
 * Hash must be at least 6 lowercase hex characters
 */
export function validateSessionName(name: string): boolean {
  return /^cc-(worker|planner|reviewer)-[a-zA-Z0-9_-]+-[a-z0-9]{6,}$/.test(name);
}

/**
 * Shell quote a string for safe use in shell commands
 * Uses single quotes which prevent all shell interpretation
 */
export function shellQuote(s: string): string {
  // Single quotes prevent all interpretation, but we need to escape
  // any single quotes in the string itself
  return "'" + s.replace(/'/g, "'\"'\"'") + "'";
}

/**
 * Allowed verification commands patterns
 * These are the only commands that can be run via run_verification
 */
const ALLOWED_COMMAND_PATTERNS = [
  // Node.js / npm / yarn / pnpm
  /^npm\s+(test|run\s+(test|lint|build|check|typecheck))(\s+.*)?$/,
  /^yarn\s+(test|lint|build|check|typecheck)(\s+.*)?$/,
  /^pnpm\s+(test|run\s+(test|lint|build|check|typecheck))(\s+.*)?$/,
  /^npx\s+(vitest|jest|playwright|cypress)(\s+.*)?$/,

  // Python
  /^pytest(\s+.*)?$/,
  /^python\s+-m\s+(pytest|unittest)(\s+.*)?$/,
  /^python3\s+-m\s+(pytest|unittest)(\s+.*)?$/,
  /^mypy(\s+.*)?$/,
  /^ruff(\s+(check|format))(\s+.*)?$/,
  /^black\s+--check(\s+.*)?$/,

  // Rust
  /^cargo\s+(test|check|clippy|build)(\s+.*)?$/,

  // Go
  /^go\s+(test|vet|build)(\s+.*)?$/,

  // Make
  /^make(\s+(test|check|lint|build))?$/,

  // Generic linters/formatters
  /^eslint(\s+.*)?$/,
  /^prettier\s+--check(\s+.*)?$/,
  /^tsc(\s+--noEmit)?(\s+.*)?$/,
];

/**
 * Dangerous shell operators that should never appear in commands
 */
const DANGEROUS_PATTERNS = [
  "&&",
  "||",
  ";",
  "|",
  "$(",
  "`",
  ">",
  "<",
  "&",
  "\n",
  "\r",
];

/**
 * Validate a verification command
 * Returns the command if valid, throws if not
 * SECURITY: Check dangerous patterns BEFORE trimming to prevent bypass
 */
export function validateCommand(command: string): string {
  // Check for dangerous patterns BEFORE trimming (security-critical)
  for (const pattern of DANGEROUS_PATTERNS) {
    if (command.includes(pattern)) {
      throw new Error(
        `Command contains disallowed shell operator: ${pattern}`
      );
    }
  }

  // Now safe to trim
  const trimmed = command.trim();

  // Check against allowed patterns
  const isAllowed = ALLOWED_COMMAND_PATTERNS.some((pattern) =>
    pattern.test(trimmed)
  );

  if (!isAllowed) {
    throw new Error(
      `Command not in allowed list. Allowed: npm test, pytest, cargo test, go test, make test, etc.`
    );
  }

  return trimmed;
}

/**
 * Sanitize a string for safe display in output
 * Removes sensitive paths and truncates
 */
export function sanitizeOutput(output: string, maxLength: number = 5000): string {
  let sanitized = output;

  // Remove home directory paths
  const homeDir = os.homedir();
  sanitized = sanitized.replace(new RegExp(homeDir, "g"), "~");

  // Truncate if too long
  if (sanitized.length > maxLength) {
    sanitized = sanitized.substring(0, maxLength) + "\n... (truncated)";
  }

  return sanitized;
}

/**
 * Escape special regex characters in a string
 * Prevents regex injection (ReDoS) attacks
 */
export function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Detect potentially dangerous regex patterns that could cause catastrophic backtracking (ReDoS)
 * Returns true if the pattern appears dangerous
 */
export function isDangerousRegexPattern(pattern: string): boolean {
  // Detect nested quantifiers like (a+)+ or (a*)*
  if (/\([^)]*[+*][^)]*\)[+*]/.test(pattern)) {
    return true;
  }
  // Detect repeated quantifiers like a++ or a**
  if (/[+*]{2,}/.test(pattern)) {
    return true;
  }
  // Detect overlapping alternation with quantifiers like (a|a)+
  if (/\([^)]*\|[^)]*\)[+*]/.test(pattern)) {
    return true;
  }
  // Detect non-capturing groups with nested quantifiers like (?:a+)+
  if (/\(\?:[^)]*[+*][^)]*\)[+*]/.test(pattern)) {
    return true;
  }
  // Detect range quantifiers in nested groups like (a{2,})+ or (a+){2,}
  if (/\([^)]*[+*][^)]*\)\{/.test(pattern)) {
    return true;
  }
  // Detect nested range quantifiers like (a{1,10}){2,} or groups with ranges followed by quantifiers
  if (/\([^)]*\{[^}]+\}[^)]*\)[+*{]/.test(pattern)) {
    return true;
  }
  // Detect consecutive range quantifiers like a{1,100}{1,100}
  if (/\{[^}]+\}\{/.test(pattern)) {
    return true;
  }
  return false;
}

/**
 * Safely test a regex pattern against a value
 * Falls back to literal matching if pattern is dangerous or invalid
 * Includes null/undefined guards for defensive programming
 */
export function safeRegexTest(pattern: string, value: string): boolean {
  // Defensive null/undefined guards - fail closed (no match)
  if (pattern == null || value == null) {
    return false;
  }

  // Empty pattern should not match anything (security-safe default)
  if (pattern === "") {
    return false;
  }

  // Check for dangerous patterns first
  if (isDangerousRegexPattern(pattern)) {
    // Fall back to literal matching (case-insensitive)
    return value.toLowerCase().includes(pattern.toLowerCase());
  }

  try {
    const regex = new RegExp(pattern, "i");
    return regex.test(value);
  } catch {
    // Invalid regex - fall back to literal matching
    return value.toLowerCase().includes(pattern.toLowerCase());
  }
}

/**
 * Zod schema for complexity signals
 */
export const ComplexitySignalsSchema = z.object({
  descriptionLength: z.number(),
  keywordMatches: z.array(z.string()),
  scopeIndicators: z.array(z.string()),
  architecturalTerms: z.array(z.string()),
  uncertaintyIndicators: z.array(z.string()),
  dependencyCount: z.number(),
  estimatedTouchPoints: z.number(),
});

/**
 * Zod schema for complexity result
 */
export const ComplexityResultSchema = z.object({
  score: z.number(),
  isComplex: z.boolean(),
  signals: ComplexitySignalsSchema,
  recommendation: z.enum(["simple", "competitive_planning", "manual_review"]),
  breakdown: z.object({
    lengthScore: z.number(),
    keywordScore: z.number(),
    scopeScore: z.number(),
    dependencyScore: z.number(),
    touchPointScore: z.number(),
  }),
});

/**
 * Zod schema for plan step
 */
export const PlanStepSchema = z.object({
  order: z.number(),
  description: z.string(),
  files: z.array(z.string()),
  validation: z.string().optional(),
});

/**
 * Zod schema for structured plan
 */
export const StructuredPlanSchema = z.object({
  summary: z.string(),
  steps: z.array(PlanStepSchema),
  filesToCreate: z.array(z.string()),
  filesToModify: z.array(z.string()),
  testStrategy: z.string(),
  risks: z.array(z.string()),
  estimatedComplexity: z.enum(["low", "medium", "high"]).optional(),
  dependencies: z.array(z.string()).optional(),
});

/**
 * Zod schema for plan submission
 */
export const PlanSubmissionSchema = z.object({
  workerId: z.string(),
  submittedAt: z.string(),
  plan: StructuredPlanSchema,
  evaluationScore: z.number().optional(),
});

/**
 * Zod schema for competing plans
 */
export const CompetingPlansSchema = z.object({
  planA: PlanSubmissionSchema.optional(),
  planB: PlanSubmissionSchema.optional(),
  selectedPlan: z.enum(["A", "B"]).optional(),
  selectionReason: z.string().optional(),
});

/**
 * Zod schema for documentation reference
 */
export const DocumentationRefSchema = z.object({
  type: z.enum(["file", "url", "snippet"]),
  path: z.string().max(2000),
  title: z.string().max(200).optional(),
  relevance: z.string().max(500).optional(),
  section: z.string().max(200).optional(),
});

/**
 * Zod schema for prepared context
 */
export const PreparedContextSchema = z.object({
  key: z.string().regex(/^[a-zA-Z0-9_-]+$/).max(64),
  content: z.string().max(50000), // Allow up to ~12.5k tokens
  source: z.string().max(500).optional(),
  priority: z.enum(["required", "recommended", "optional"]),
  tokenEstimate: z.number().int().min(0).optional(),
});

/**
 * Zod schema for protocol binding
 */
export const ProtocolBindingSchema = z.object({
  protocolId: z.string().regex(/^[a-zA-Z0-9_-]+$/).max(64),
  version: z.string().max(32).optional(),
  scope: z.enum(["pre_execution", "post_execution", "continuous", "all"]),
  priority: z.number().int().min(0).max(1000),
  parameters: z.record(z.unknown()).optional(),
  overrides: z.record(z.unknown()).optional(),
});

/**
 * Zod schema for feature context
 */
export const FeatureContextSchema = z.object({
  documentation: z.array(DocumentationRefSchema),
  prepared: z.array(PreparedContextSchema),
});

/**
 * Zod schema for routing configuration
 */
export const RoutingConfigSchema = z.object({
  preferredWorkerType: z.string().max(64).optional(),
  requiredCapabilities: z.array(z.string().max(64)).optional(),
  excludeCapabilities: z.array(z.string().max(64)).optional(),
  maxParallelism: z.number().int().min(1).max(100).optional(),
  affinityGroup: z.string().max(64).optional(),
  isolationLevel: z.enum(["none", "session", "process", "container"]).optional(),
});

/**
 * Zod schema for validating feature structure
 */
export const FeatureSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]+$/),
  description: z.string().max(2000),
  status: z.enum(["pending", "in_progress", "completed", "failed"]),
  attempts: z.number().int().min(0),
  workerId: z.string().optional(),
  startedAt: z.string().optional(),
  completedAt: z.string().optional(),
  lastError: z.string().optional(),
  notes: z.string().optional(),
  dependsOn: z.array(z.string().regex(/^[a-zA-Z0-9_-]+$/)).optional(),
  // Competitive planning fields
  complexity: ComplexityResultSchema.optional(),
  planningPhase: z.enum(["planning", "evaluating", "implementing"]).nullable().optional(),
  competingPlans: CompetingPlansSchema.optional(),
  // Protocol-based behavioral governance fields
  context: FeatureContextSchema.optional(),
  protocolBindings: z.array(ProtocolBindingSchema).optional(),
  routing: RoutingConfigSchema.optional(),
  // Files modified by this feature's worker
  modifiedFiles: z.array(z.string()).optional(),
});

/**
 * Zod schema for confidence alert
 */
export const ConfidenceAlertSchema = z.object({
  type: z.enum(["idle", "stuck_loop", "high_errors", "self_reported_low", "declining_trend"]),
  message: z.string(),
  severity: z.enum(["warning", "critical"]),
  timestamp: z.string(),
});

/**
 * Zod schema for confidence config
 */
export const ConfidenceConfigSchema = z.object({
  threshold: z.number().min(0).max(100),
  autoAlert: z.boolean(),
});

/**
 * Zod schema for verification config
 */
export const VerificationConfigSchema = z.object({
  commands: z.array(z.string().max(500)),
  failOnError: z.boolean(),
});

/**
 * Zod schema for review issue
 */
export const ReviewIssueSchema = z.object({
  category: z.string().max(100),
  severity: z.enum(["info", "warning", "error"]),
  file: z.string().max(500).optional(),
  line: z.number().int().min(1).optional(),
  message: z.string().max(1000),
  suggestion: z.string().max(1000).optional(),
});

/**
 * Zod schema for review findings
 */
export const ReviewFindingsSchema = z.object({
  summary: z.string().max(2000),
  severity: z.enum(["clean", "minor", "moderate", "major", "critical"]),
  issues: z.array(ReviewIssueSchema),
  recommendations: z.array(z.string().max(500)),
});

/**
 * Zod schema for review worker
 */
export const ReviewWorkerSchema = z.object({
  type: z.enum(["code", "architecture"]),
  workerId: z.string(),
  sessionName: z.string(),
  status: z.enum(["running", "completed", "failed"]),
  startedAt: z.string(),
  completedAt: z.string().optional(),
  findings: ReviewFindingsSchema.optional(),
});

/**
 * Zod schema for review config
 */
export const ReviewConfigSchema = z.object({
  enabled: z.boolean(),
  skipOnFailure: z.boolean(),
  codeReviewEnabled: z.boolean(),
  architectureReviewEnabled: z.boolean(),
  autoTrigger: z.boolean().optional(), // Optional for backwards compatibility
});

/**
 * Zod schema for aggregated review
 */
export const AggregatedReviewSchema = z.object({
  completedAt: z.string(),
  codeReview: ReviewFindingsSchema.optional(),
  architectureReview: ReviewFindingsSchema.optional(),
  overallAssessment: z.string().max(2000),
});

/**
 * Zod schema for validating orchestrator state
 */
export const OrchestratorStateSchema = z.object({
  projectDir: z.string(),
  taskDescription: z.string(),
  features: z.array(FeatureSchema),
  workers: z.array(
    z.object({
      sessionName: z.string(),
      featureId: z.string(),
      status: z.enum(["running", "completed", "crashed", "unknown"]),
      startedAt: z.string(),
      lastChecked: z.string().optional(),
    })
  ),
  status: z.enum([
    "in_progress",
    "reviewing",
    "completed",
    "completed_with_failures",
    "paused",
  ]),
  startTime: z.string(),
  lastUpdated: z.string(),
  completedAt: z.string().optional(),
  progressLog: z.array(z.string()),
  // Confidence monitoring
  confidenceConfig: ConfidenceConfigSchema.optional(),
  confidenceAlerts: z.array(ConfidenceAlertSchema).optional(),
  // Post-completion reviews
  reviewConfig: ReviewConfigSchema.optional(),
  reviewWorkers: z.array(ReviewWorkerSchema).optional(),
  aggregatedReview: AggregatedReviewSchema.optional(),
  // Pre-completion verification
  verificationConfig: VerificationConfigSchema.optional(),
});
