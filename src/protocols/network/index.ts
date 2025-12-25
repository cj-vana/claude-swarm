/**
 * Protocol Networking - MCP Tool handlers for protocol distribution
 *
 * This module provides high-level operations for:
 * - export_protocols: Export protocols to shareable bundles
 * - import_protocols: Import protocols from bundles
 * - discover_protocols: Discover peer MCP instances and their protocols
 * - sync_protocols: Synchronize protocols with peer instances
 */

import { ProtocolDistributor, ProtocolBundle, ExportOptions, ImportOptions, ImportResult, ConflictStrategy, PeerInfo } from "./distributor.js";
import { ProtocolSyncManager, InstanceInfo, createSyncManager } from "./sync.js";
import { ProtocolRegistry } from "../registry.js";
import type { Protocol } from "../schema.js";
import * as fs from "fs";
import * as path from "path";

// ============================================================================
// NetworkingManager - Singleton for managing protocol networking
// ============================================================================

/**
 * Manages protocol networking operations for a project
 */
export class ProtocolNetworkingManager {
  private readonly projectDir: string;
  private readonly distributor: ProtocolDistributor;
  private syncManager: ProtocolSyncManager | null = null;
  private registry: ProtocolRegistry;

  constructor(projectDir: string, registry: ProtocolRegistry) {
    this.projectDir = projectDir;
    this.registry = registry;
    this.distributor = new ProtocolDistributor(projectDir);
  }

  // ==========================================================================
  // Export Operations
  // ==========================================================================

  /**
   * Export protocols to a bundle
   */
  exportProtocols(options: {
    protocolIds?: string[];
    includeDependencies?: boolean;
    includeInactive?: boolean;
    filterTags?: string[];
    name?: string;
    description?: string;
    signBundle?: boolean;
    outputPath?: string;
  }): {
    success: boolean;
    bundle?: ProtocolBundle;
    outputPath?: string;
    error?: string;
  } {
    try {
      const exportOptions: ExportOptions = {
        includeDependencies: options.includeDependencies ?? true,
        includeInactive: options.includeInactive ?? false,
        filterTags: options.filterTags,
        name: options.name,
        description: options.description,
        signBundle: options.signBundle ?? true,
      };

      const protocolIds = options.protocolIds || [];
      const bundle = this.distributor.exportBundle(protocolIds, this.registry, exportOptions);

      // If output path specified, write to file
      if (options.outputPath) {
        const resolvedPath = path.resolve(options.outputPath);
        const dir = path.dirname(resolvedPath);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }

        // Atomic write
        const tempFile = `${resolvedPath}.tmp.${Date.now()}`;
        try {
          fs.writeFileSync(tempFile, JSON.stringify(bundle, null, 2));
          fs.renameSync(tempFile, resolvedPath);
        } catch (writeError) {
          try { fs.unlinkSync(tempFile); } catch { /* ignore */ }
          throw writeError;
        }

        return {
          success: true,
          bundle,
          outputPath: resolvedPath,
        };
      }

      return {
        success: true,
        bundle,
      };
    } catch (error: any) {
      return {
        success: false,
        error: error.message,
      };
    }
  }

  // ==========================================================================
  // Import Operations
  // ==========================================================================

  /**
   * Import protocols from a bundle (either inline or from file)
   */
  importProtocols(options: {
    bundle?: ProtocolBundle;
    bundlePath?: string;
    conflictStrategy?: ConflictStrategy;
    activateImported?: boolean;
    validateDependencies?: boolean;
    verifySignature?: boolean;
    dryRun?: boolean;
    actor?: string;
  }): ImportResult {
    try {
      // Get bundle from file or inline
      let bundle: ProtocolBundle;

      if (options.bundlePath) {
        const resolvedPath = path.resolve(options.bundlePath);
        if (!fs.existsSync(resolvedPath)) {
          return {
            success: false,
            imported: [],
            skipped: [],
            conflicts: [],
            errors: [`File not found: ${resolvedPath}`],
            activated: [],
            dryRun: options.dryRun ?? false,
          };
        }
        const content = fs.readFileSync(resolvedPath, "utf-8");
        bundle = JSON.parse(content);
      } else if (options.bundle) {
        bundle = options.bundle;
      } else {
        return {
          success: false,
          imported: [],
          skipped: [],
          conflicts: [],
          errors: ["Either bundle or bundlePath must be provided"],
          activated: [],
          dryRun: options.dryRun ?? false,
        };
      }

      const importOptions: ImportOptions = {
        conflictStrategy: options.conflictStrategy ?? "skip",
        activateImported: options.activateImported ?? false,
        validateDependencies: options.validateDependencies ?? true,
        verifySignature: options.verifySignature ?? true,
        dryRun: options.dryRun ?? false,
        actor: options.actor,
      };

      return this.distributor.importBundle(bundle, this.registry, importOptions);
    } catch (error: any) {
      return {
        success: false,
        imported: [],
        skipped: [],
        conflicts: [],
        errors: [error.message],
        activated: [],
        dryRun: options.dryRun ?? false,
      };
    }
  }

  // ==========================================================================
  // Discovery Operations
  // ==========================================================================

  /**
   * Discover peer MCP instances and their protocols
   */
  discoverProtocols(options: {
    startSync?: boolean;
    refreshPeers?: boolean;
  }): {
    success: boolean;
    instanceId: string;
    peers: PeerInfo[];
    syncStarted: boolean;
    error?: string;
  } {
    try {
      // Initialize sync manager if needed
      if (!this.syncManager) {
        this.syncManager = createSyncManager(this.projectDir);

        // Register callbacks to handle received protocols
        this.syncManager.onProtocolChange({
          onReceived: (protocol: Protocol) => {
            try {
              if (!this.registry.getProtocol(protocol.id)) {
                this.registry.register(protocol, "sync");
              } else {
                this.registry.update(protocol, "sync");
              }
            } catch {
              // Protocol may already exist or be invalid
            }
          },
          onDeleted: (protocolId: string) => {
            try {
              if (this.registry.getProtocol(protocolId)) {
                this.registry.delete(protocolId, "sync");
              }
            } catch {
              // Protocol may not exist
            }
          },
          onActivationChanged: (protocolId: string, active: boolean) => {
            try {
              if (active) {
                this.registry.activate(protocolId, "sync");
              } else {
                this.registry.deactivate(protocolId, "sync");
              }
            } catch {
              // Protocol may not exist or already be in desired state
            }
          },
        });
      }

      // Start sync if requested
      if (options.startSync) {
        this.syncManager.start();
      }

      // Discover peers
      const peers = this.syncManager.discoverInstances();

      // Also get known peers from distributor
      const distributorPeers = this.distributor.getPeers();

      // Merge peer lists (dedup by instanceId)
      const peerMap = new Map<string, PeerInfo>();
      for (const p of distributorPeers) {
        peerMap.set(p.instanceId, p);
      }
      for (const p of peers) {
        peerMap.set(p.instanceId, {
          instanceId: p.instanceId,
          name: p.instanceId.slice(0, 8),
          lastSeen: p.lastHeartbeat,
          protocolCount: 0, // Will be filled from sync
          capabilities: p.capabilities || [],
        });
      }

      return {
        success: true,
        instanceId: this.syncManager.getInstanceId(),
        peers: Array.from(peerMap.values()).filter(p => p.instanceId !== this.syncManager!.getInstanceId()),
        syncStarted: options.startSync ?? false,
      };
    } catch (error: any) {
      return {
        success: false,
        instanceId: "",
        peers: [],
        syncStarted: false,
        error: error.message,
      };
    }
  }

  // ==========================================================================
  // Sync Operations
  // ==========================================================================

  /**
   * Synchronize protocols with peer instances
   */
  syncProtocols(options: {
    targetInstance?: string;
    direction?: "push" | "pull" | "bidirectional";
    protocolIds?: string[];
    includeInactive?: boolean;
    conflictStrategy?: ConflictStrategy;
  }): {
    success: boolean;
    pushed: number;
    pulled: number;
    conflicts: number;
    error?: string;
  } {
    try {
      // Ensure sync manager is running
      if (!this.syncManager) {
        const discovery = this.discoverProtocols({ startSync: true });
        if (!discovery.success) {
          return {
            success: false,
            pushed: 0,
            pulled: 0,
            conflicts: 0,
            error: discovery.error || "Failed to start sync",
          };
        }
      }

      const direction = options.direction ?? "bidirectional";
      let pushed = 0;
      let pulled = 0;
      let conflicts = 0;

      // Get protocols to push
      const protocolsToPush = options.protocolIds
        ? options.protocolIds.map(id => this.registry.getProtocol(id)).filter((p): p is Protocol => !!p)
        : options.includeInactive
          ? this.registry.getAllProtocols()
          : this.registry.getActiveProtocols();

      // Push protocols
      if (direction === "push" || direction === "bidirectional") {
        for (const protocol of protocolsToPush) {
          this.syncManager!.broadcastProtocolUpdate(protocol);
          pushed++;
        }

        // Also broadcast active state
        const activeIds = this.registry.getActive();
        for (const id of activeIds) {
          this.syncManager!.broadcastActivationChange(id, true);
        }
      }

      // Pull protocols (request sync from peers)
      if (direction === "pull" || direction === "bidirectional") {
        if (options.targetInstance) {
          this.syncManager!.requestSync(options.targetInstance);
        } else {
          this.syncManager!.requestSync();
        }

        // Process any incoming messages
        const processed = this.syncManager!.processIncomingMessages();
        pulled = processed.filter(m => m.type === "protocol_update").length;
        conflicts = processed.filter(m => m.type === "nack").length;
      }

      // If target instance specified, do a full sync
      if (options.targetInstance) {
        const activeIds = this.registry.getActive();
        this.syncManager!.fullSync(
          options.targetInstance,
          protocolsToPush,
          activeIds
        );
      }

      return {
        success: true,
        pushed,
        pulled,
        conflicts,
      };
    } catch (error: any) {
      return {
        success: false,
        pushed: 0,
        pulled: 0,
        conflicts: 0,
        error: error.message,
      };
    }
  }

  // ==========================================================================
  // Utility Methods
  // ==========================================================================

  /**
   * Get networking statistics
   */
  getStats(): {
    instanceId: string;
    peerCount: number;
    exportedBundles: number;
    syncActive: boolean;
    lastSync?: string;
  } {
    const distributorStats = this.distributor.getStats();
    const syncStats = this.syncManager?.getStats();

    return {
      instanceId: distributorStats.instanceId,
      peerCount: distributorStats.peerCount,
      exportedBundles: distributorStats.exportedBundles,
      syncActive: !!this.syncManager,
      lastSync: distributorStats.lastSync || syncStats?.lastSyncAt || undefined,
    };
  }

  /**
   * Stop the sync manager
   */
  stop(): void {
    if (this.syncManager) {
      this.syncManager.stop();
      this.syncManager = null;
    }
  }

  /**
   * List available bundles in the export directory
   */
  listBundles(): Array<{
    filename: string;
    bundleId: string;
    name: string;
    protocolCount: number;
    exportedAt: string;
  }> {
    return this.distributor.listExportedBundles();
  }
}

// ============================================================================
// Factory Function
// ============================================================================

// Cache of networking managers per project
const networkingManagers = new Map<string, ProtocolNetworkingManager>();

/**
 * Get or create a networking manager for a project
 */
export function getNetworkingManager(projectDir: string, registry: ProtocolRegistry): ProtocolNetworkingManager {
  const existing = networkingManagers.get(projectDir);
  if (existing) {
    return existing;
  }

  const manager = new ProtocolNetworkingManager(projectDir, registry);
  networkingManagers.set(projectDir, manager);
  return manager;
}

// Re-export types
export { ProtocolBundle, ExportOptions, ImportOptions, ImportResult, ConflictStrategy, PeerInfo };
export { InstanceInfo };
