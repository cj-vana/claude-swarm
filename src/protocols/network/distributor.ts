/**
 * Protocol Distributor - Export/Import protocol bundles between MCP instances
 *
 * This module enables protocol distribution across multiple MCP server instances,
 * supporting:
 * - Bundling protocols with dependencies for export
 * - Importing and merging protocols with conflict resolution
 * - Peer discovery and synchronization
 * - Version compatibility checking
 * - Secure bundle signing and verification
 *
 * Key design principles:
 * - Bundles are self-contained with all dependencies
 * - Import operations are atomic (all-or-nothing)
 * - Conflict resolution strategies are configurable
 * - Audit trail for all distribution operations
 */

import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { z } from "zod";
import type { Protocol } from "../schema.js";
import { ProtocolSchema } from "../schema.js";
import type { ProtocolRegistry } from "../registry.js";
import { ProtocolResolver } from "../resolver.js";
import { validateProjectDir } from "../../utils/security.js";

// ============================================================================
// Bundle Format Types
// ============================================================================

/**
 * Metadata about the source of a protocol bundle
 */
export const BundleSourceSchema = z.object({
  instanceId: z.string(),              // Unique ID of the source MCP instance
  instanceName: z.string().optional(), // Human-readable name
  hostInfo: z.string().optional(),     // Host information (sanitized)
  exportedAt: z.string(),              // ISO timestamp of export
  exportedBy: z.string().optional(),   // Actor who triggered export
});

export type BundleSource = z.infer<typeof BundleSourceSchema>;

/**
 * Version compatibility information
 */
export const CompatibilityInfoSchema = z.object({
  minVersion: z.string(),              // Minimum compatible distributor version
  maxVersion: z.string().optional(),   // Maximum compatible version (if breaking changes)
  schemaVersion: z.string(),           // Protocol schema version used
  features: z.array(z.string()),       // Features required to use this bundle
});

export type CompatibilityInfo = z.infer<typeof CompatibilityInfoSchema>;

/**
 * Signature for bundle integrity verification
 */
export const BundleSignatureSchema = z.object({
  algorithm: z.enum(["sha256", "sha512"]),
  digest: z.string(),                   // Hash of bundle content
  signedBy: z.string().optional(),      // Identity of signer
  timestamp: z.string(),                // Signing timestamp
});

export type BundleSignature = z.infer<typeof BundleSignatureSchema>;

/**
 * A protocol bundle containing protocols and metadata
 */
export const ProtocolBundleSchema = z.object({
  // Bundle identity
  bundleId: z.string(),                 // Unique bundle identifier
  name: z.string(),                     // Human-readable bundle name
  description: z.string().optional(),   // Bundle description
  version: z.string(),                  // Bundle version (semver)

  // Source information
  source: BundleSourceSchema,

  // Compatibility
  compatibility: CompatibilityInfoSchema,

  // Protocols included
  protocols: z.array(ProtocolSchema),

  // Dependency ordering (protocol IDs in order they should be registered)
  registrationOrder: z.array(z.string()),

  // Bundle metadata
  tags: z.array(z.string()).optional(),
  category: z.string().optional(),

  // Integrity
  signature: BundleSignatureSchema.optional(),

  // Export options that were used
  exportOptions: z.object({
    includeDependencies: z.boolean(),
    includeInactive: z.boolean(),
    filterTags: z.array(z.string()).optional(),
  }).optional(),
});

export type ProtocolBundle = z.infer<typeof ProtocolBundleSchema>;

// ============================================================================
// Import/Export Options
// ============================================================================

/**
 * Options for exporting protocols
 */
export interface ExportOptions {
  /** Include all dependencies of selected protocols */
  includeDependencies?: boolean;
  /** Include inactive protocols */
  includeInactive?: boolean;
  /** Only include protocols with these tags */
  filterTags?: string[];
  /** Bundle name */
  name?: string;
  /** Bundle description */
  description?: string;
  /** Sign the bundle for integrity verification */
  signBundle?: boolean;
}

/**
 * Conflict resolution strategy for imports
 */
export type ConflictStrategy =
  | "skip"           // Skip conflicting protocols (keep existing)
  | "replace"        // Replace existing with imported
  | "rename"         // Rename imported protocol with suffix
  | "merge"          // Attempt to merge (constraints combined)
  | "newest"         // Keep the newest version
  | "highest_priority" // Keep the higher priority protocol
  | "ask";           // Return conflicts for manual resolution

/**
 * Options for importing protocols
 */
export interface ImportOptions {
  /** How to handle conflicts with existing protocols */
  conflictStrategy?: ConflictStrategy;
  /** Activate imported protocols immediately */
  activateImported?: boolean;
  /** Validate dependencies exist before importing */
  validateDependencies?: boolean;
  /** Verify bundle signature if present */
  verifySignature?: boolean;
  /** Actor performing the import (for audit) */
  actor?: string;
  /** Dry run - validate but don't actually import */
  dryRun?: boolean;
}

/**
 * Result of an import conflict
 */
export interface ImportConflict {
  protocolId: string;
  existingVersion: string;
  importedVersion: string;
  existingPriority: number;
  importedPriority: number;
  existingUpdatedAt?: string;
  importedUpdatedAt?: string;
  resolution?: "kept_existing" | "used_imported" | "renamed" | "merged" | "skipped";
  renamedTo?: string;
}

/**
 * Result of an import operation
 */
export interface ImportResult {
  success: boolean;
  imported: string[];           // Protocol IDs successfully imported
  skipped: string[];            // Protocol IDs skipped
  conflicts: ImportConflict[];  // Conflicts encountered
  errors: string[];             // Error messages
  activated: string[];          // Protocols that were activated
  dryRun: boolean;              // Whether this was a dry run
}

// ============================================================================
// Peer Discovery Types
// ============================================================================

/**
 * Information about a peer MCP instance
 */
export const PeerInfoSchema = z.object({
  instanceId: z.string(),
  name: z.string().optional(),
  endpoint: z.string().optional(),       // Network endpoint if available
  lastSeen: z.string(),
  protocolCount: z.number(),
  capabilities: z.array(z.string()),
});

export type PeerInfo = z.infer<typeof PeerInfoSchema>;

/**
 * Synchronization state with a peer
 */
export const SyncStateSchema = z.object({
  peerId: z.string(),
  lastSync: z.string().optional(),
  lastExport: z.string().optional(),
  lastImport: z.string().optional(),
  syncErrors: z.array(z.string()),
});

export type SyncState = z.infer<typeof SyncStateSchema>;

// ============================================================================
// Constants
// ============================================================================

const DISTRIBUTOR_VERSION = "1.0.0";
const SCHEMA_VERSION = "1.0.0";
const SUPPORTED_FEATURES = ["basic_distribution", "dependency_resolution", "conflict_resolution"];

// ============================================================================
// ProtocolDistributor Class
// ============================================================================

/**
 * ProtocolDistributor - Manages protocol import/export between MCP instances
 */
export class ProtocolDistributor {
  private readonly projectDir: string;
  private readonly distributorDir: string;
  private readonly instanceId: string;
  private readonly resolver: ProtocolResolver;

  // Peer tracking
  private peers: Map<string, PeerInfo> = new Map();
  private syncStates: Map<string, SyncState> = new Map();

  constructor(projectDir: string, instanceId?: string) {
    // Validate project directory to prevent path traversal
    this.projectDir = validateProjectDir(projectDir);
    this.distributorDir = path.join(
      this.projectDir,
      ".claude",
      "orchestrator",
      "protocols",
      "distribution"
    );
    this.instanceId = instanceId || this.generateInstanceId();
    this.resolver = new ProtocolResolver();

    // Ensure distribution directory exists
    if (!fs.existsSync(this.distributorDir)) {
      fs.mkdirSync(this.distributorDir, { recursive: true });
    }

    // Load peer state
    this.loadPeerState();
  }

  /**
   * Generate a unique instance ID
   */
  private generateInstanceId(): string {
    return `mcp-${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`;
  }

  /**
   * Load peer state from disk
   */
  private loadPeerState(): void {
    const peerFile = path.join(this.distributorDir, "peers.json");
    if (fs.existsSync(peerFile)) {
      try {
        const data = JSON.parse(fs.readFileSync(peerFile, "utf-8"));
        if (data.peers) {
          this.peers = new Map(Object.entries(data.peers));
        }
        if (data.syncStates) {
          this.syncStates = new Map(Object.entries(data.syncStates));
        }
      } catch {
        // Start fresh on error
        this.peers = new Map();
        this.syncStates = new Map();
      }
    }
  }

  /**
   * Save peer state to disk
   */
  private savePeerState(): void {
    const peerFile = path.join(this.distributorDir, "peers.json");
    const data = {
      peers: Object.fromEntries(this.peers),
      syncStates: Object.fromEntries(this.syncStates),
      lastUpdated: new Date().toISOString(),
    };

    // Atomic write
    const tempFile = `${peerFile}.tmp.${Date.now()}`;
    try {
      fs.writeFileSync(tempFile, JSON.stringify(data, null, 2));
      fs.renameSync(tempFile, peerFile);
    } catch (error) {
      try {
        fs.unlinkSync(tempFile);
      } catch {
        // Ignore cleanup errors
      }
      throw error;
    }
  }

  // ==========================================================================
  // Export Operations
  // ==========================================================================

  /**
   * Export protocols to a bundle
   *
   * @param protocolIds - IDs of protocols to export (empty = all active)
   * @param registry - Protocol registry
   * @param options - Export options
   * @returns Protocol bundle ready for distribution
   */
  exportBundle(
    protocolIds: string[],
    registry: ProtocolRegistry,
    options: ExportOptions = {}
  ): ProtocolBundle {
    const {
      includeDependencies = true,
      includeInactive = false,
      filterTags,
      name,
      description,
      signBundle = false,
    } = options;

    // Determine which protocols to export
    let toExport: Set<string>;

    if (protocolIds.length === 0) {
      // Export all active protocols (and optionally inactive)
      const activeIds = registry.getActive();
      toExport = new Set(activeIds);

      if (includeInactive) {
        for (const protocol of registry.getAllProtocols()) {
          toExport.add(protocol.id);
        }
      }
    } else {
      toExport = new Set(protocolIds);
    }

    // Add dependencies if requested
    if (includeDependencies) {
      const withDeps = new Set(toExport);
      for (const id of Array.from(toExport)) {
        const resolved = this.resolver.resolveChain(id, registry);
        for (const depId of resolved.chain) {
          withDeps.add(depId);
        }
      }
      toExport = withDeps;
    }

    // Collect protocols
    const protocols: Protocol[] = [];
    for (const id of Array.from(toExport)) {
      const protocol = registry.getProtocol(id);
      if (protocol) {
        // Filter by tags if specified
        if (filterTags && filterTags.length > 0) {
          if (!protocol.tags?.some((tag) => filterTags.includes(tag))) {
            continue;
          }
        }
        protocols.push(protocol);
      }
    }

    // Determine registration order (dependencies first)
    const registrationOrder = this.computeRegistrationOrder(protocols, registry);

    // Create bundle
    const bundleId = `bundle-${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`;

    const bundle: ProtocolBundle = {
      bundleId,
      name: name || `Protocol Bundle ${bundleId}`,
      description,
      version: "1.0.0",
      source: {
        instanceId: this.instanceId,
        exportedAt: new Date().toISOString(),
      },
      compatibility: {
        minVersion: DISTRIBUTOR_VERSION,
        schemaVersion: SCHEMA_VERSION,
        features: SUPPORTED_FEATURES,
      },
      protocols,
      registrationOrder,
      exportOptions: {
        includeDependencies,
        includeInactive,
        filterTags,
      },
    };

    // Sign if requested
    if (signBundle) {
      bundle.signature = this.signBundle(bundle);
    }

    return bundle;
  }

  /**
   * Compute the order in which protocols should be registered
   * (dependencies before dependents)
   */
  private computeRegistrationOrder(
    protocols: Protocol[],
    registry: ProtocolRegistry
  ): string[] {
    const protocolMap = new Map(protocols.map((p) => [p.id, p]));
    const order: string[] = [];
    const visited = new Set<string>();
    const visiting = new Set<string>();

    const visit = (id: string): void => {
      if (visited.has(id)) return;
      if (visiting.has(id)) return; // Cycle - skip

      const protocol = protocolMap.get(id);
      if (!protocol) return;

      visiting.add(id);

      // Visit dependencies first
      const deps = [...(protocol.extends || []), ...(protocol.requires || [])];
      for (const depId of deps) {
        visit(depId);
      }

      visiting.delete(id);
      visited.add(id);
      order.push(id);
    };

    for (const protocol of protocols) {
      visit(protocol.id);
    }

    return order;
  }

  /**
   * Sign a bundle for integrity verification
   */
  private signBundle(bundle: ProtocolBundle): BundleSignature {
    // Create deterministic content for signing (exclude signature field)
    const contentToSign = JSON.stringify({
      bundleId: bundle.bundleId,
      name: bundle.name,
      version: bundle.version,
      protocols: bundle.protocols,
      registrationOrder: bundle.registrationOrder,
    });

    const hash = crypto.createHash("sha256").update(contentToSign).digest("hex");

    return {
      algorithm: "sha256",
      digest: hash,
      signedBy: this.instanceId,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Export bundle to a file
   */
  exportToFile(
    protocolIds: string[],
    registry: ProtocolRegistry,
    filePath: string,
    options: ExportOptions = {}
  ): void {
    const bundle = this.exportBundle(protocolIds, registry, options);

    // Validate the file path is within the project directory
    const resolvedPath = path.resolve(filePath);
    const realProjectDir = fs.realpathSync(this.projectDir);
    if (!resolvedPath.startsWith(realProjectDir)) {
      throw new Error(`Export path must be within project directory: ${filePath}`);
    }

    // Atomic write
    const tempFile = `${resolvedPath}.tmp.${Date.now()}`;
    try {
      fs.writeFileSync(tempFile, JSON.stringify(bundle, null, 2));
      fs.renameSync(tempFile, resolvedPath);
    } catch (error) {
      try {
        fs.unlinkSync(tempFile);
      } catch {
        // Ignore cleanup errors
      }
      throw error;
    }
  }

  // ==========================================================================
  // Import Operations
  // ==========================================================================

  /**
   * Import protocols from a bundle
   *
   * @param bundle - Protocol bundle to import
   * @param registry - Protocol registry to import into
   * @param options - Import options
   * @returns Import result with details of what was imported
   */
  importBundle(
    bundle: ProtocolBundle,
    registry: ProtocolRegistry,
    options: ImportOptions = {}
  ): ImportResult {
    const {
      conflictStrategy = "skip",
      activateImported = false,
      validateDependencies = true,
      verifySignature = true,
      actor,
      dryRun = false,
    } = options;

    const result: ImportResult = {
      success: true,
      imported: [],
      skipped: [],
      conflicts: [],
      errors: [],
      activated: [],
      dryRun,
    };

    // Validate bundle schema
    try {
      ProtocolBundleSchema.parse(bundle);
    } catch (error) {
      result.success = false;
      result.errors.push(`Invalid bundle format: ${error}`);
      return result;
    }

    // Check compatibility
    const compatResult = this.checkCompatibility(bundle.compatibility);
    if (!compatResult.compatible) {
      result.success = false;
      result.errors.push(`Bundle not compatible: ${compatResult.reason}`);
      return result;
    }

    // Verify signature if present and requested
    if (verifySignature && bundle.signature) {
      if (!this.verifyBundleSignature(bundle)) {
        result.success = false;
        result.errors.push("Bundle signature verification failed");
        return result;
      }
    }

    // Process protocols in registration order
    const orderedProtocols = this.orderByRegistration(bundle);

    for (const protocol of orderedProtocols) {
      const existing = registry.getProtocol(protocol.id);

      if (existing) {
        // Handle conflict
        const conflict = this.handleConflict(
          protocol,
          existing,
          conflictStrategy,
          registry,
          dryRun,
          actor
        );

        result.conflicts.push(conflict);

        if (conflict.resolution === "used_imported" || conflict.resolution === "renamed") {
          if (!dryRun) {
            const idToUse = conflict.renamedTo || protocol.id;
            const protocolToRegister = conflict.renamedTo
              ? { ...protocol, id: conflict.renamedTo }
              : protocol;

            try {
              if (conflict.resolution === "used_imported") {
                registry.update(protocolToRegister, actor);
              } else {
                registry.register(protocolToRegister, actor);
              }
              result.imported.push(idToUse);
            } catch (error) {
              result.errors.push(`Failed to import ${protocol.id}: ${error}`);
            }
          } else {
            result.imported.push(conflict.renamedTo || protocol.id);
          }
        } else if (conflict.resolution === "merged") {
          // Merge is handled in handleConflict
          result.imported.push(protocol.id);
        } else {
          result.skipped.push(protocol.id);
        }
      } else {
        // No conflict - validate dependencies and import
        if (validateDependencies) {
          const missingDeps = this.findMissingDependencies(protocol, registry, bundle);
          if (missingDeps.length > 0) {
            result.errors.push(
              `Protocol ${protocol.id} missing dependencies: ${missingDeps.join(", ")}`
            );
            result.skipped.push(protocol.id);
            continue;
          }
        }

        if (!dryRun) {
          try {
            registry.register(protocol, actor);
            result.imported.push(protocol.id);
          } catch (error) {
            result.errors.push(`Failed to register ${protocol.id}: ${error}`);
            result.skipped.push(protocol.id);
          }
        } else {
          result.imported.push(protocol.id);
        }
      }
    }

    // Activate if requested
    if (activateImported && !dryRun) {
      for (const id of result.imported) {
        try {
          registry.activate(id, actor);
          result.activated.push(id);
        } catch (error) {
          // Activation failure is not fatal, just log it
          result.errors.push(`Failed to activate ${id}: ${error}`);
        }
      }
    }

    // Overall success if we imported at least one protocol without fatal errors
    result.success = result.imported.length > 0 || result.errors.length === 0;

    // Update sync state if we have source info
    if (!dryRun && bundle.source.instanceId !== this.instanceId) {
      this.updateSyncState(bundle.source.instanceId, "import");
    }

    return result;
  }

  /**
   * Handle a conflict between existing and imported protocol
   */
  private handleConflict(
    imported: Protocol,
    existing: Protocol,
    strategy: ConflictStrategy,
    registry: ProtocolRegistry,
    dryRun: boolean,
    actor?: string
  ): ImportConflict {
    const conflict: ImportConflict = {
      protocolId: imported.id,
      existingVersion: existing.version,
      importedVersion: imported.version,
      existingPriority: existing.priority,
      importedPriority: imported.priority,
      existingUpdatedAt: existing.updatedAt,
      importedUpdatedAt: imported.updatedAt,
    };

    switch (strategy) {
      case "skip":
        conflict.resolution = "skipped";
        break;

      case "replace":
        conflict.resolution = "used_imported";
        break;

      case "rename":
        const newId = `${imported.id}_imported_${Date.now().toString(36)}`;
        conflict.resolution = "renamed";
        conflict.renamedTo = newId;
        break;

      case "merge":
        if (!dryRun) {
          const merged = this.mergeProtocols(existing, imported);
          registry.update(merged, actor);
        }
        conflict.resolution = "merged";
        break;

      case "newest":
        const existingTime = existing.updatedAt
          ? new Date(existing.updatedAt).getTime()
          : 0;
        const importedTime = imported.updatedAt
          ? new Date(imported.updatedAt).getTime()
          : 0;
        conflict.resolution = importedTime > existingTime ? "used_imported" : "kept_existing";
        break;

      case "highest_priority":
        conflict.resolution =
          imported.priority > existing.priority ? "used_imported" : "kept_existing";
        break;

      case "ask":
      default:
        // Return without resolution for manual handling
        break;
    }

    return conflict;
  }

  /**
   * Merge two protocols (constraints are combined, higher priority wins for settings)
   */
  private mergeProtocols(existing: Protocol, imported: Protocol): Protocol {
    // Combine constraints (imported constraints override existing with same ID)
    const constraintMap = new Map(
      existing.constraints.map((c) => [c.id, c])
    );
    for (const constraint of imported.constraints) {
      constraintMap.set(constraint.id, constraint);
    }

    // Use higher priority protocol's settings
    const base = imported.priority >= existing.priority ? imported : existing;
    const other = imported.priority >= existing.priority ? existing : imported;

    return {
      ...base,
      constraints: Array.from(constraintMap.values()),
      // Combine tags
      tags: Array.from(new Set([...(base.tags || []), ...(other.tags || [])])),
      // Update version to indicate merge
      version: this.incrementVersion(base.version),
      updatedAt: new Date().toISOString(),
    };
  }

  /**
   * Increment a semver version (patch level)
   */
  private incrementVersion(version: string): string {
    const parts = version.split(".").map(Number);
    parts[2] = (parts[2] || 0) + 1;
    return parts.join(".");
  }

  /**
   * Find missing dependencies for a protocol
   */
  private findMissingDependencies(
    protocol: Protocol,
    registry: ProtocolRegistry,
    bundle: ProtocolBundle
  ): string[] {
    const missing: string[] = [];
    const bundleIds = new Set(bundle.protocols.map((p) => p.id));

    const deps = [...(protocol.extends || []), ...(protocol.requires || [])];
    for (const depId of deps) {
      if (!registry.getProtocol(depId) && !bundleIds.has(depId)) {
        missing.push(depId);
      }
    }

    return missing;
  }

  /**
   * Order protocols by registration order from bundle
   */
  private orderByRegistration(bundle: ProtocolBundle): Protocol[] {
    const protocolMap = new Map(bundle.protocols.map((p) => [p.id, p]));
    const ordered: Protocol[] = [];

    for (const id of bundle.registrationOrder) {
      const protocol = protocolMap.get(id);
      if (protocol) {
        ordered.push(protocol);
      }
    }

    // Add any protocols not in the order (shouldn't happen, but be safe)
    for (const protocol of bundle.protocols) {
      if (!bundle.registrationOrder.includes(protocol.id)) {
        ordered.push(protocol);
      }
    }

    return ordered;
  }

  /**
   * Import bundle from a file
   */
  importFromFile(
    filePath: string,
    registry: ProtocolRegistry,
    options: ImportOptions = {}
  ): ImportResult {
    const resolvedPath = path.resolve(filePath);

    // Validate the file path is within the project directory
    const realProjectDir = fs.realpathSync(this.projectDir);
    if (!resolvedPath.startsWith(realProjectDir)) {
      return {
        success: false,
        imported: [],
        skipped: [],
        conflicts: [],
        errors: [`Import path must be within project directory: ${filePath}`],
        activated: [],
        dryRun: options.dryRun || false,
      };
    }

    if (!fs.existsSync(resolvedPath)) {
      return {
        success: false,
        imported: [],
        skipped: [],
        conflicts: [],
        errors: [`File not found: ${resolvedPath}`],
        activated: [],
        dryRun: options.dryRun || false,
      };
    }

    try {
      const content = fs.readFileSync(resolvedPath, "utf-8");
      const bundle = JSON.parse(content) as ProtocolBundle;
      return this.importBundle(bundle, registry, options);
    } catch (error) {
      return {
        success: false,
        imported: [],
        skipped: [],
        conflicts: [],
        errors: [`Failed to read bundle file: ${error}`],
        activated: [],
        dryRun: options.dryRun || false,
      };
    }
  }

  // ==========================================================================
  // Verification
  // ==========================================================================

  /**
   * Verify bundle signature
   */
  verifyBundleSignature(bundle: ProtocolBundle): boolean {
    if (!bundle.signature) {
      return true; // No signature to verify
    }

    const contentToSign = JSON.stringify({
      bundleId: bundle.bundleId,
      name: bundle.name,
      version: bundle.version,
      protocols: bundle.protocols,
      registrationOrder: bundle.registrationOrder,
    });

    const hash = crypto
      .createHash(bundle.signature.algorithm)
      .update(contentToSign)
      .digest("hex");

    return hash === bundle.signature.digest;
  }

  /**
   * Check compatibility with a bundle
   */
  checkCompatibility(compatibility: CompatibilityInfo): {
    compatible: boolean;
    reason?: string;
  } {
    // Check version
    const minParts = compatibility.minVersion.split(".").map(Number);
    const currentParts = DISTRIBUTOR_VERSION.split(".").map(Number);

    for (let i = 0; i < 3; i++) {
      if (currentParts[i] < minParts[i]) {
        return {
          compatible: false,
          reason: `Distributor version ${DISTRIBUTOR_VERSION} is below minimum ${compatibility.minVersion}`,
        };
      }
      if (currentParts[i] > minParts[i]) break;
    }

    // Check max version if specified
    if (compatibility.maxVersion) {
      const maxParts = compatibility.maxVersion.split(".").map(Number);
      for (let i = 0; i < 3; i++) {
        if (currentParts[i] > maxParts[i]) {
          return {
            compatible: false,
            reason: `Distributor version ${DISTRIBUTOR_VERSION} exceeds maximum ${compatibility.maxVersion}`,
          };
        }
        if (currentParts[i] < maxParts[i]) break;
      }
    }

    // Check required features
    const missingFeatures = compatibility.features.filter(
      (f) => !SUPPORTED_FEATURES.includes(f)
    );
    if (missingFeatures.length > 0) {
      return {
        compatible: false,
        reason: `Missing required features: ${missingFeatures.join(", ")}`,
      };
    }

    return { compatible: true };
  }

  // ==========================================================================
  // Peer Discovery and Sync
  // ==========================================================================

  /**
   * Register a peer MCP instance
   */
  registerPeer(peer: PeerInfo): void {
    PeerInfoSchema.parse(peer);
    this.peers.set(peer.instanceId, peer);

    // Initialize sync state if needed
    if (!this.syncStates.has(peer.instanceId)) {
      this.syncStates.set(peer.instanceId, {
        peerId: peer.instanceId,
        syncErrors: [],
      });
    }

    this.savePeerState();
  }

  /**
   * Update sync state after an operation
   */
  private updateSyncState(
    peerId: string,
    operation: "import" | "export"
  ): void {
    let state = this.syncStates.get(peerId);
    if (!state) {
      state = {
        peerId,
        syncErrors: [],
      };
    }

    const now = new Date().toISOString();
    state.lastSync = now;
    if (operation === "import") {
      state.lastImport = now;
    } else {
      state.lastExport = now;
    }

    this.syncStates.set(peerId, state);
    this.savePeerState();
  }

  /**
   * Get all known peers
   */
  getPeers(): PeerInfo[] {
    return Array.from(this.peers.values());
  }

  /**
   * Get sync state for a peer
   */
  getSyncState(peerId: string): SyncState | undefined {
    return this.syncStates.get(peerId);
  }

  /**
   * Get this instance's ID
   */
  getInstanceId(): string {
    return this.instanceId;
  }

  /**
   * Create peer info for this instance
   */
  createPeerInfo(registry: ProtocolRegistry): PeerInfo {
    return {
      instanceId: this.instanceId,
      lastSeen: new Date().toISOString(),
      protocolCount: registry.getAllProtocols().length,
      capabilities: SUPPORTED_FEATURES,
    };
  }

  // ==========================================================================
  // Utility Methods
  // ==========================================================================

  /**
   * List all exported bundles in the distribution directory
   */
  listExportedBundles(): Array<{
    filename: string;
    bundleId: string;
    name: string;
    protocolCount: number;
    exportedAt: string;
  }> {
    const bundles: Array<{
      filename: string;
      bundleId: string;
      name: string;
      protocolCount: number;
      exportedAt: string;
    }> = [];

    const bundlesDir = path.join(this.distributorDir, "exports");
    if (!fs.existsSync(bundlesDir)) {
      return bundles;
    }

    const files = fs.readdirSync(bundlesDir);
    for (const file of files) {
      if (!file.endsWith(".json")) continue;

      try {
        const content = fs.readFileSync(path.join(bundlesDir, file), "utf-8");
        const bundle = JSON.parse(content) as ProtocolBundle;
        bundles.push({
          filename: file,
          bundleId: bundle.bundleId,
          name: bundle.name,
          protocolCount: bundle.protocols.length,
          exportedAt: bundle.source.exportedAt,
        });
      } catch {
        // Skip invalid bundles
      }
    }

    return bundles.sort(
      (a, b) => new Date(b.exportedAt).getTime() - new Date(a.exportedAt).getTime()
    );
  }

  /**
   * Get distribution statistics
   */
  getStats(): {
    instanceId: string;
    peerCount: number;
    exportedBundles: number;
    lastSync?: string;
  } {
    const bundles = this.listExportedBundles();
    let lastSync: string | undefined;

    for (const state of Array.from(this.syncStates.values())) {
      if (state.lastSync) {
        if (!lastSync || new Date(state.lastSync) > new Date(lastSync)) {
          lastSync = state.lastSync;
        }
      }
    }

    return {
      instanceId: this.instanceId,
      peerCount: this.peers.size,
      exportedBundles: bundles.length,
      lastSync,
    };
  }
}
