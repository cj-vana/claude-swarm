/**
 * Protocol Registry - Manages protocol storage, activation, and violation tracking
 *
 * Key design principles:
 * - File-based persistence in .claude/orchestrator/protocols/
 * - Atomic file writes to prevent corruption
 * - Audit log for all protocol operations
 * - Implements ProtocolRegistryLike interface for resolver compatibility
 */

import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { z } from "zod";
import type {
  Protocol,
  ConstraintSeverity,
} from "./schema.js";
import { ProtocolSchema, ConstraintSeveritySchema } from "./schema.js";
import { validateProjectDir } from "../utils/security.js";

// ============================================================================
// Violation and Audit Types
// ============================================================================

/**
 * A recorded protocol violation
 */
export interface ProtocolViolation {
  id: string;
  protocolId: string;
  constraintId: string;
  featureId?: string;
  workerId?: string;
  timestamp: string;
  severity: ConstraintSeverity;
  message: string;
  context: Record<string, unknown>;
  resolved: boolean;
  resolvedAt?: string;
  resolution?: string;
}

/**
 * Actions that can be audited
 */
export type AuditAction =
  | "register"
  | "activate"
  | "deactivate"
  | "update"
  | "delete"
  | "violation"
  | "resolve_violation";

/**
 * An entry in the audit log
 */
export interface AuditEntry {
  id: string;
  timestamp: string;
  action: AuditAction;
  protocolId?: string;
  details: Record<string, unknown>;
  actor?: string;
}

// ============================================================================
// Zod Schemas for Validation
// ============================================================================

export const ProtocolViolationSchema = z.object({
  id: z.string(),
  protocolId: z.string(),
  constraintId: z.string(),
  featureId: z.string().optional(),
  workerId: z.string().optional(),
  timestamp: z.string(),
  severity: ConstraintSeveritySchema,
  message: z.string(),
  context: z.record(z.unknown()),
  resolved: z.boolean(),
  resolvedAt: z.string().optional(),
  resolution: z.string().optional(),
});

export const AuditEntrySchema = z.object({
  id: z.string(),
  timestamp: z.string(),
  action: z.enum([
    "register",
    "activate",
    "deactivate",
    "update",
    "delete",
    "violation",
    "resolve_violation",
  ]),
  protocolId: z.string().optional(),
  details: z.record(z.unknown()),
  actor: z.string().optional(),
});

// ============================================================================
// Registry State
// ============================================================================

/**
 * Persistent state for the registry
 */
interface RegistryState {
  protocols: Record<string, Protocol>;
  activeProtocols: string[];
  violations: ProtocolViolation[];
  auditLog: AuditEntry[];
  lastUpdated: string;
}

const RegistryStateSchema = z.object({
  protocols: z.record(ProtocolSchema),
  activeProtocols: z.array(z.string()),
  violations: z.array(ProtocolViolationSchema),
  auditLog: z.array(AuditEntrySchema),
  lastUpdated: z.string(),
});

// Maximum entries to prevent unbounded growth
const MAX_VIOLATIONS = 1000;
const MAX_AUDIT_ENTRIES = 5000;

/**
 * Generate a unique ID for violations and audit entries
 * Uses crypto.randomUUID for cryptographically secure IDs
 */
function generateId(): string {
  return crypto.randomUUID();
}

// ============================================================================
// ProtocolRegistry Class
// ============================================================================

/**
 * ProtocolRegistry - Central registry for protocol management
 *
 * Implements ProtocolRegistryLike interface for resolver compatibility
 */
export class ProtocolRegistry {
  private readonly projectDir: string;
  private readonly protocolsDir: string;
  private readonly stateFile: string;

  // In-memory state
  private protocols: Map<string, Protocol> = new Map();
  private activeProtocols: Set<string> = new Set();
  private violations: ProtocolViolation[] = [];
  private auditLog: AuditEntry[] = [];

  constructor(projectDir: string) {
    // Validate project directory to prevent path traversal
    this.projectDir = validateProjectDir(projectDir);
    this.protocolsDir = path.join(
      this.projectDir,
      ".claude",
      "orchestrator",
      "protocols"
    );
    this.stateFile = path.join(this.protocolsDir, "registry.json");

    // Ensure protocols directory exists
    if (!fs.existsSync(this.protocolsDir)) {
      fs.mkdirSync(this.protocolsDir, { recursive: true });
    }

    // Load existing state
    this.load();
  }

  /**
   * Load state from disk with validation
   */
  private load(): void {
    if (!fs.existsSync(this.stateFile)) {
      return;
    }

    try {
      const data = fs.readFileSync(this.stateFile, "utf-8");
      const parsed = JSON.parse(data);
      // Validate and type assert to our interface
      RegistryStateSchema.parse(parsed);
      const validated = parsed as RegistryState;

      // Restore state
      this.protocols = new Map(Object.entries(validated.protocols));
      this.activeProtocols = new Set(validated.activeProtocols);
      this.violations = validated.violations;
      this.auditLog = validated.auditLog;
    } catch (error) {
      console.error(
        "Error loading protocol registry (file may be corrupted):",
        error
      );
      // Start with empty state rather than crashing
      this.protocols = new Map();
      this.activeProtocols = new Set();
      this.violations = [];
      this.auditLog = [];
    }
  }

  /**
   * Save state to disk using atomic write
   */
  private save(): void {
    // Rotate violations and audit log if too large
    if (this.violations.length > MAX_VIOLATIONS) {
      this.violations = this.violations.slice(-MAX_VIOLATIONS);
    }
    if (this.auditLog.length > MAX_AUDIT_ENTRIES) {
      this.auditLog = this.auditLog.slice(-MAX_AUDIT_ENTRIES);
    }

    const state: RegistryState = {
      protocols: Object.fromEntries(this.protocols),
      activeProtocols: Array.from(this.activeProtocols),
      violations: this.violations,
      auditLog: this.auditLog,
      lastUpdated: new Date().toISOString(),
    };

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
  }

  // ==========================================================================
  // Protocol Management (ProtocolRegistryLike interface)
  // ==========================================================================

  /**
   * Register a new protocol
   */
  register(protocol: Protocol, actor?: string): void {
    // Validate protocol
    ProtocolSchema.parse(protocol);

    // Check for conflicts with existing protocols
    if (this.protocols.has(protocol.id)) {
      throw new Error(`Protocol with ID '${protocol.id}' already exists`);
    }

    // Check required protocols exist
    if (protocol.requires) {
      for (const requiredId of protocol.requires) {
        if (!this.protocols.has(requiredId)) {
          throw new Error(
            `Required protocol '${requiredId}' not found for protocol '${protocol.id}'`
          );
        }
      }
    }

    // Store protocol
    this.protocols.set(protocol.id, protocol);

    // Audit log
    this.appendAudit({
      id: generateId(),
      timestamp: new Date().toISOString(),
      action: "register",
      protocolId: protocol.id,
      details: {
        name: protocol.name,
        version: protocol.version,
        constraintCount: protocol.constraints.length,
      },
      actor,
    });

    this.save();
  }

  /**
   * Update an existing protocol
   */
  update(protocol: Protocol, actor?: string): void {
    // Validate protocol
    ProtocolSchema.parse(protocol);

    if (!this.protocols.has(protocol.id)) {
      throw new Error(`Protocol with ID '${protocol.id}' not found`);
    }

    const oldProtocol = this.protocols.get(protocol.id)!;

    // Update the protocol with new timestamp
    const updatedProtocol: Protocol = {
      ...protocol,
      updatedAt: new Date().toISOString(),
    };
    this.protocols.set(protocol.id, updatedProtocol);

    // Audit log
    this.appendAudit({
      id: generateId(),
      timestamp: new Date().toISOString(),
      action: "update",
      protocolId: protocol.id,
      details: {
        oldVersion: oldProtocol.version,
        newVersion: protocol.version,
      },
      actor,
    });

    this.save();
  }

  /**
   * Delete a protocol
   */
  delete(protocolId: string, actor?: string): void {
    if (!this.protocols.has(protocolId)) {
      throw new Error(`Protocol with ID '${protocolId}' not found`);
    }

    // Deactivate first if active
    if (this.activeProtocols.has(protocolId)) {
      this.deactivate(protocolId, actor);
    }

    // Check if other protocols depend on this one
    for (const [id, protocol] of this.protocols.entries()) {
      if (protocol.requires?.includes(protocolId)) {
        throw new Error(
          `Cannot delete protocol '${protocolId}': protocol '${id}' requires it`
        );
      }
      if (protocol.extends?.includes(protocolId)) {
        throw new Error(
          `Cannot delete protocol '${protocolId}': protocol '${id}' extends it`
        );
      }
    }

    this.protocols.delete(protocolId);

    // Audit log
    this.appendAudit({
      id: generateId(),
      timestamp: new Date().toISOString(),
      action: "delete",
      protocolId,
      details: {},
      actor,
    });

    this.save();
  }

  /**
   * Activate a protocol
   */
  activate(protocolId: string, actor?: string): void {
    const protocol = this.protocols.get(protocolId);
    if (!protocol) {
      throw new Error(`Protocol with ID '${protocolId}' not found`);
    }

    if (this.activeProtocols.has(protocolId)) {
      return; // Already active
    }

    // Check for conflicts with currently active protocols
    if (protocol.conflicts) {
      for (const conflictId of protocol.conflicts) {
        if (this.activeProtocols.has(conflictId)) {
          throw new Error(
            `Cannot activate '${protocolId}': conflicts with active protocol '${conflictId}'`
          );
        }
      }
    }

    // Check conflicts from the other direction
    for (const activeId of Array.from(this.activeProtocols)) {
      const activeProtocol = this.protocols.get(activeId);
      if (activeProtocol?.conflicts?.includes(protocolId)) {
        throw new Error(
          `Cannot activate '${protocolId}': active protocol '${activeId}' conflicts with it`
        );
      }
    }

    // Ensure required protocols are active
    if (protocol.requires) {
      for (const requiredId of protocol.requires) {
        if (!this.activeProtocols.has(requiredId)) {
          throw new Error(
            `Cannot activate '${protocolId}': required protocol '${requiredId}' is not active`
          );
        }
      }
    }

    this.activeProtocols.add(protocolId);

    // Audit log
    this.appendAudit({
      id: generateId(),
      timestamp: new Date().toISOString(),
      action: "activate",
      protocolId,
      details: {
        activeCount: this.activeProtocols.size,
      },
      actor,
    });

    this.save();
  }

  /**
   * Deactivate a protocol
   */
  deactivate(protocolId: string, actor?: string): void {
    if (!this.protocols.has(protocolId)) {
      throw new Error(`Protocol with ID '${protocolId}' not found`);
    }

    if (!this.activeProtocols.has(protocolId)) {
      return; // Already inactive
    }

    // Check if other active protocols require this one
    for (const activeId of Array.from(this.activeProtocols)) {
      if (activeId === protocolId) continue;
      const activeProtocol = this.protocols.get(activeId);
      if (activeProtocol?.requires?.includes(protocolId)) {
        throw new Error(
          `Cannot deactivate '${protocolId}': active protocol '${activeId}' requires it`
        );
      }
    }

    this.activeProtocols.delete(protocolId);

    // Audit log
    this.appendAudit({
      id: generateId(),
      timestamp: new Date().toISOString(),
      action: "deactivate",
      protocolId,
      details: {
        activeCount: this.activeProtocols.size,
      },
      actor,
    });

    this.save();
  }

  /**
   * Get all active protocol IDs
   * (Part of ProtocolRegistryLike interface)
   */
  getActive(): string[] {
    return Array.from(this.activeProtocols);
  }

  /**
   * Get all active protocols sorted by priority
   */
  getActiveProtocols(): Protocol[] {
    const active: Protocol[] = [];
    for (const id of Array.from(this.activeProtocols)) {
      const protocol = this.protocols.get(id);
      if (protocol) {
        active.push(protocol);
      }
    }
    // Sort by priority (higher priority first)
    return active.sort((a, b) => b.priority - a.priority);
  }

  /**
   * Get a protocol by ID
   * (Part of ProtocolRegistryLike interface)
   */
  getProtocol(protocolId: string): Protocol | undefined {
    return this.protocols.get(protocolId);
  }

  /**
   * Get all registered protocols
   */
  getAllProtocols(): Protocol[] {
    return Array.from(this.protocols.values());
  }

  /**
   * Get all protocol IDs
   * (Used by resolver.getDependents)
   */
  getAllProtocolIds(): string[] {
    return Array.from(this.protocols.keys());
  }

  /**
   * Check if a protocol is active
   */
  isActive(protocolId: string): boolean {
    return this.activeProtocols.has(protocolId);
  }

  // ==========================================================================
  // Violation Tracking
  // ==========================================================================

  /**
   * Record a protocol violation
   */
  recordViolation(
    violation: Omit<ProtocolViolation, "id" | "timestamp" | "resolved">
  ): ProtocolViolation {
    const fullViolation: ProtocolViolation = {
      ...violation,
      id: generateId(),
      timestamp: new Date().toISOString(),
      resolved: false,
    };

    // Validate
    ProtocolViolationSchema.parse(fullViolation);

    this.violations.push(fullViolation);

    // Audit log
    this.appendAudit({
      id: generateId(),
      timestamp: new Date().toISOString(),
      action: "violation",
      protocolId: violation.protocolId,
      details: {
        constraintId: violation.constraintId,
        severity: violation.severity,
        featureId: violation.featureId,
        workerId: violation.workerId,
      },
    });

    this.save();
    return fullViolation;
  }

  /**
   * Resolve a violation
   */
  resolveViolation(
    violationId: string,
    resolution: string,
    actor?: string
  ): void {
    const violation = this.violations.find((v) => v.id === violationId);
    if (!violation) {
      throw new Error(`Violation with ID '${violationId}' not found`);
    }

    if (violation.resolved) {
      throw new Error(`Violation '${violationId}' is already resolved`);
    }

    violation.resolved = true;
    violation.resolvedAt = new Date().toISOString();
    violation.resolution = resolution;

    // Audit log
    this.appendAudit({
      id: generateId(),
      timestamp: new Date().toISOString(),
      action: "resolve_violation",
      protocolId: violation.protocolId,
      details: {
        violationId,
        resolution,
      },
      actor,
    });

    this.save();
  }

  /**
   * Get violations with optional filtering
   */
  getViolations(options?: {
    protocolId?: string;
    featureId?: string;
    workerId?: string;
    resolved?: boolean;
    severity?: ConstraintSeverity;
    limit?: number;
    offset?: number;
  }): ProtocolViolation[] {
    let filtered = this.violations;

    if (options?.protocolId) {
      filtered = filtered.filter((v) => v.protocolId === options.protocolId);
    }
    if (options?.featureId) {
      filtered = filtered.filter((v) => v.featureId === options.featureId);
    }
    if (options?.workerId) {
      filtered = filtered.filter((v) => v.workerId === options.workerId);
    }
    if (options?.resolved !== undefined) {
      filtered = filtered.filter((v) => v.resolved === options.resolved);
    }
    if (options?.severity) {
      filtered = filtered.filter((v) => v.severity === options.severity);
    }

    // Apply pagination
    const offset = options?.offset ?? 0;
    const limit = options?.limit ?? filtered.length;
    return filtered.slice(offset, offset + limit);
  }

  /**
   * Get violation count
   */
  getViolationCount(options?: {
    protocolId?: string;
    resolved?: boolean;
  }): number {
    let filtered = this.violations;

    if (options?.protocolId) {
      filtered = filtered.filter((v) => v.protocolId === options.protocolId);
    }
    if (options?.resolved !== undefined) {
      filtered = filtered.filter((v) => v.resolved === options.resolved);
    }

    return filtered.length;
  }

  // ==========================================================================
  // Audit Logging
  // ==========================================================================

  /**
   * Append an entry to the audit log
   */
  appendAudit(entry: AuditEntry): void {
    AuditEntrySchema.parse(entry);
    this.auditLog.push(entry);
    // Note: save() will be called by the parent operation
  }

  /**
   * Get audit log with optional filtering and pagination
   */
  getAuditLog(options?: {
    protocolId?: string;
    action?: AuditAction;
    limit?: number;
    offset?: number;
  }): AuditEntry[] {
    let filtered = this.auditLog;

    if (options?.protocolId) {
      filtered = filtered.filter((e) => e.protocolId === options.protocolId);
    }
    if (options?.action) {
      filtered = filtered.filter((e) => e.action === options.action);
    }

    // Apply pagination (most recent first)
    const reversed = [...filtered].reverse();
    const offset = options?.offset ?? 0;
    const limit = options?.limit ?? reversed.length;
    return reversed.slice(offset, offset + limit);
  }

  // ==========================================================================
  // Utility Methods
  // ==========================================================================

  /**
   * Clear all state (for testing or reset)
   */
  clear(): void {
    this.protocols.clear();
    this.activeProtocols.clear();
    this.violations = [];
    this.auditLog = [];

    if (fs.existsSync(this.stateFile)) {
      fs.unlinkSync(this.stateFile);
    }
  }

  /**
   * Get registry statistics
   */
  getStats(): {
    totalProtocols: number;
    activeProtocols: number;
    totalViolations: number;
    unresolvedViolations: number;
    auditLogSize: number;
  } {
    return {
      totalProtocols: this.protocols.size,
      activeProtocols: this.activeProtocols.size,
      totalViolations: this.violations.length,
      unresolvedViolations: this.violations.filter((v) => !v.resolved).length,
      auditLogSize: this.auditLog.length,
    };
  }
}
