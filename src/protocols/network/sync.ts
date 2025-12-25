/**
 * Protocol Synchronization - Cross-instance protocol distribution and sync
 *
 * This module handles synchronization of protocols across multiple MCP instances.
 * It implements a peer-to-peer sync model with eventual consistency and conflict
 * resolution based on version vectors.
 *
 * Key features:
 * - Instance discovery via shared state directory
 * - Protocol propagation with acknowledgment
 * - Conflict resolution using version vectors and last-write-wins
 * - Heartbeat-based instance health monitoring
 * - Batch sync for efficiency
 *
 * Security considerations:
 * - All messages are validated against schemas
 * - Instance IDs are cryptographically random
 * - File-based transport uses atomic writes
 */

import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { z } from "zod";
import type { Protocol } from "../schema.js";
import { ProtocolSchema } from "../schema.js";
import { validateProjectDir } from "../../utils/security.js";

// ============================================================================
// Sync Message Types
// ============================================================================

/**
 * Types of sync messages that can be exchanged between instances
 */
export type SyncMessageType =
  | "protocol_update"      // A protocol was created/updated
  | "protocol_delete"      // A protocol was deleted
  | "activation_change"    // Protocol activation/deactivation
  | "sync_request"         // Request full state sync
  | "sync_response"        // Full state sync response
  | "heartbeat"            // Instance health ping
  | "ack"                  // Acknowledgment of received message
  | "nack";                // Negative acknowledgment (conflict/error)

/**
 * Instance information for discovery and routing
 */
export const InstanceInfoSchema = z.object({
  instanceId: z.string().regex(/^[a-f0-9]{32}$/, "Instance ID must be 32 hex chars"),
  projectDir: z.string(),
  startedAt: z.string(),
  lastHeartbeat: z.string(),
  version: z.string(),
  capabilities: z.array(z.string()).optional(),
});

export type InstanceInfo = z.infer<typeof InstanceInfoSchema>;

/**
 * Version vector for conflict detection
 * Maps instance ID to sequence number
 */
export const VersionVectorSchema = z.record(z.string(), z.number().int().min(0));
export type VersionVector = z.infer<typeof VersionVectorSchema>;

/**
 * Base sync message structure
 */
export const SyncMessageBaseSchema = z.object({
  messageId: z.string().uuid(),
  type: z.enum([
    "protocol_update",
    "protocol_delete",
    "activation_change",
    "sync_request",
    "sync_response",
    "heartbeat",
    "ack",
    "nack",
  ]),
  sourceInstance: z.string(),
  targetInstance: z.string().optional(), // undefined = broadcast
  timestamp: z.string(),
  sequenceNumber: z.number().int().min(0),
});

/**
 * Protocol update message - sent when a protocol is created/modified
 */
export const ProtocolUpdateMessageSchema = SyncMessageBaseSchema.extend({
  type: z.literal("protocol_update"),
  payload: z.object({
    protocol: ProtocolSchema,
    versionVector: VersionVectorSchema,
    previousVersion: z.string().optional(), // For conflict detection
  }),
});

export type ProtocolUpdateMessage = z.infer<typeof ProtocolUpdateMessageSchema>;

/**
 * Protocol delete message
 */
export const ProtocolDeleteMessageSchema = SyncMessageBaseSchema.extend({
  type: z.literal("protocol_delete"),
  payload: z.object({
    protocolId: z.string(),
    versionVector: VersionVectorSchema,
    deletedAt: z.string(),
  }),
});

export type ProtocolDeleteMessage = z.infer<typeof ProtocolDeleteMessageSchema>;

/**
 * Activation change message
 */
export const ActivationChangeMessageSchema = SyncMessageBaseSchema.extend({
  type: z.literal("activation_change"),
  payload: z.object({
    protocolId: z.string(),
    active: z.boolean(),
    versionVector: VersionVectorSchema,
  }),
});

export type ActivationChangeMessage = z.infer<typeof ActivationChangeMessageSchema>;

/**
 * Sync request message - request full state from peers
 */
export const SyncRequestMessageSchema = SyncMessageBaseSchema.extend({
  type: z.literal("sync_request"),
  payload: z.object({
    requestedProtocols: z.array(z.string()).optional(), // undefined = all
    currentVersionVector: VersionVectorSchema,
  }),
});

export type SyncRequestMessage = z.infer<typeof SyncRequestMessageSchema>;

/**
 * Sync response message - full state response
 */
export const SyncResponseMessageSchema = SyncMessageBaseSchema.extend({
  type: z.literal("sync_response"),
  payload: z.object({
    protocols: z.array(ProtocolSchema),
    activeProtocols: z.array(z.string()),
    versionVector: VersionVectorSchema,
    inResponseTo: z.string().uuid(),
  }),
});

export type SyncResponseMessage = z.infer<typeof SyncResponseMessageSchema>;

/**
 * Heartbeat message
 */
export const HeartbeatMessageSchema = SyncMessageBaseSchema.extend({
  type: z.literal("heartbeat"),
  payload: z.object({
    instance: InstanceInfoSchema,
    protocolCount: z.number().int().min(0),
    activeCount: z.number().int().min(0),
  }),
});

export type HeartbeatMessage = z.infer<typeof HeartbeatMessageSchema>;

/**
 * Acknowledgment message
 */
export const AckMessageSchema = SyncMessageBaseSchema.extend({
  type: z.literal("ack"),
  payload: z.object({
    acknowledgedMessageId: z.string().uuid(),
    status: z.enum(["received", "applied", "ignored"]),
  }),
});

export type AckMessage = z.infer<typeof AckMessageSchema>;

/**
 * Negative acknowledgment message
 */
export const NackMessageSchema = SyncMessageBaseSchema.extend({
  type: z.literal("nack"),
  payload: z.object({
    acknowledgedMessageId: z.string().uuid(),
    reason: z.enum(["conflict", "invalid", "outdated", "error"]),
    errorMessage: z.string().optional(),
    conflictInfo: z.object({
      localVersion: z.string().optional(),
      remoteVersion: z.string().optional(),
      localTimestamp: z.string().optional(),
    }).optional(),
  }),
});

export type NackMessage = z.infer<typeof NackMessageSchema>;

/**
 * Union of all sync message types
 */
export const SyncMessageSchema = z.discriminatedUnion("type", [
  ProtocolUpdateMessageSchema,
  ProtocolDeleteMessageSchema,
  ActivationChangeMessageSchema,
  SyncRequestMessageSchema,
  SyncResponseMessageSchema,
  HeartbeatMessageSchema,
  AckMessageSchema,
  NackMessageSchema,
]);

export type SyncMessage = z.infer<typeof SyncMessageSchema>;

// ============================================================================
// Sync State
// ============================================================================

/**
 * State tracked for synchronization
 */
export interface SyncState {
  instanceId: string;
  sequenceNumber: number;
  versionVector: VersionVector;
  knownInstances: Map<string, InstanceInfo>;
  pendingAcks: Map<string, { message: SyncMessage; sentAt: string; retries: number }>;
  lastSyncAt: string | null;
}

/**
 * Configuration for the sync manager
 */
export interface SyncConfig {
  /** Directory for sync messages (default: .claude/orchestrator/sync/) */
  syncDir?: string;
  /** Heartbeat interval in milliseconds (default: 30000) */
  heartbeatIntervalMs?: number;
  /** Message retention time in milliseconds (default: 300000 = 5 min) */
  messageRetentionMs?: number;
  /** Instance timeout in milliseconds (default: 90000 = 3 heartbeats) */
  instanceTimeoutMs?: number;
  /** Max retries for pending acks (default: 3) */
  maxRetries?: number;
  /** Retry delay in milliseconds (default: 5000) */
  retryDelayMs?: number;
}

const DEFAULT_CONFIG: Required<SyncConfig> = {
  syncDir: ".claude/orchestrator/sync",
  heartbeatIntervalMs: 30000,
  messageRetentionMs: 300000,
  instanceTimeoutMs: 90000,
  maxRetries: 3,
  retryDelayMs: 5000,
};

// ============================================================================
// Conflict Resolution
// ============================================================================

/**
 * Result of comparing two version vectors
 */
export type VectorComparison =
  | "equal"        // Vectors are identical
  | "before"       // Local is before remote (remote is newer)
  | "after"        // Local is after remote (local is newer)
  | "concurrent";  // Concurrent modifications (conflict)

/**
 * Compare two version vectors
 */
export function compareVersionVectors(
  local: VersionVector,
  remote: VersionVector
): VectorComparison {
  const allKeys = Array.from(new Set([...Object.keys(local), ...Object.keys(remote)]));

  let localAhead = false;
  let remoteAhead = false;

  for (const key of allKeys) {
    const localVal = local[key] ?? 0;
    const remoteVal = remote[key] ?? 0;

    if (localVal > remoteVal) {
      localAhead = true;
    } else if (remoteVal > localVal) {
      remoteAhead = true;
    }
  }

  if (localAhead && remoteAhead) {
    return "concurrent";
  } else if (localAhead) {
    return "after";
  } else if (remoteAhead) {
    return "before";
  } else {
    return "equal";
  }
}

/**
 * Merge two version vectors, taking the max of each component
 */
export function mergeVersionVectors(
  v1: VersionVector,
  v2: VersionVector
): VersionVector {
  const merged: VersionVector = { ...v1 };

  for (const [key, value] of Object.entries(v2)) {
    merged[key] = Math.max(merged[key] ?? 0, value);
  }

  return merged;
}

/**
 * Increment the version vector for the local instance
 */
export function incrementVersionVector(
  vector: VersionVector,
  instanceId: string
): VersionVector {
  return {
    ...vector,
    [instanceId]: (vector[instanceId] ?? 0) + 1,
  };
}

/**
 * Result of conflict resolution
 */
export interface ConflictResolution {
  winner: "local" | "remote" | "merge";
  mergedProtocol?: Protocol;
  reason: string;
}

/**
 * Resolve conflicts between two protocol versions
 * Uses last-write-wins with version vector tiebreaker
 */
export function resolveProtocolConflict(
  localProtocol: Protocol,
  remoteProtocol: Protocol,
  localVector: VersionVector,
  remoteVector: VersionVector
): ConflictResolution {
  // First check version vectors
  const comparison = compareVersionVectors(localVector, remoteVector);

  if (comparison === "before") {
    return {
      winner: "remote",
      reason: "Remote version is newer (version vector comparison)",
    };
  }

  if (comparison === "after") {
    return {
      winner: "local",
      reason: "Local version is newer (version vector comparison)",
    };
  }

  if (comparison === "equal") {
    // Identical vectors - use protocol version as tiebreaker
    const localVer = localProtocol.version.split(".").map(Number);
    const remoteVer = remoteProtocol.version.split(".").map(Number);

    for (let i = 0; i < 3; i++) {
      if (localVer[i] > remoteVer[i]) {
        return {
          winner: "local",
          reason: "Local has higher protocol version",
        };
      }
      if (remoteVer[i] > localVer[i]) {
        return {
          winner: "remote",
          reason: "Remote has higher protocol version",
        };
      }
    }

    // Exactly equal - use updatedAt timestamp
    const localTime = localProtocol.updatedAt || localProtocol.createdAt || "";
    const remoteTime = remoteProtocol.updatedAt || remoteProtocol.createdAt || "";

    if (localTime >= remoteTime) {
      return {
        winner: "local",
        reason: "Local has same or later timestamp",
      };
    }

    return {
      winner: "remote",
      reason: "Remote has later timestamp",
    };
  }

  // Concurrent modifications - use timestamp-based last-write-wins
  const localTime = localProtocol.updatedAt || localProtocol.createdAt || "";
  const remoteTime = remoteProtocol.updatedAt || remoteProtocol.createdAt || "";

  if (localTime >= remoteTime) {
    return {
      winner: "local",
      reason: "Concurrent modification resolved by timestamp (local wins)",
    };
  }

  return {
    winner: "remote",
    reason: "Concurrent modification resolved by timestamp (remote wins)",
  };
}

// ============================================================================
// Protocol Sync Manager
// ============================================================================

/**
 * Manages protocol synchronization across MCP instances
 */
export class ProtocolSyncManager {
  private readonly projectDir: string;
  private readonly syncDir: string;
  private readonly config: Required<SyncConfig>;

  private state: SyncState;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private cleanupTimer: NodeJS.Timeout | null = null;

  // Callbacks for protocol changes
  private onProtocolReceived?: (protocol: Protocol) => void;
  private onProtocolDeleted?: (protocolId: string) => void;
  private onActivationChanged?: (protocolId: string, active: boolean) => void;
  private onConflict?: (localProtocol: Protocol, remoteProtocol: Protocol, resolution: ConflictResolution) => void;

  constructor(projectDir: string, config?: SyncConfig) {
    // Validate project directory to prevent path traversal
    this.projectDir = validateProjectDir(projectDir);
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.syncDir = path.join(this.projectDir, this.config.syncDir);

    // Generate unique instance ID
    const instanceId = crypto.randomBytes(16).toString("hex");

    this.state = {
      instanceId,
      sequenceNumber: 0,
      versionVector: { [instanceId]: 0 },
      knownInstances: new Map(),
      pendingAcks: new Map(),
      lastSyncAt: null,
    };

    // Ensure sync directory exists
    this.ensureSyncDir();
  }

  /**
   * Ensure the sync directory structure exists
   */
  private ensureSyncDir(): void {
    const dirs = [
      this.syncDir,
      path.join(this.syncDir, "messages"),
      path.join(this.syncDir, "instances"),
    ];

    for (const dir of dirs) {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }
  }

  /**
   * Get the instance ID for this sync manager
   */
  getInstanceId(): string {
    return this.state.instanceId;
  }

  /**
   * Get current version vector
   */
  getVersionVector(): VersionVector {
    return { ...this.state.versionVector };
  }

  /**
   * Get known instances
   */
  getKnownInstances(): InstanceInfo[] {
    return Array.from(this.state.knownInstances.values());
  }

  // ==========================================================================
  // Lifecycle
  // ==========================================================================

  /**
   * Start the sync manager
   */
  start(): void {
    // Register this instance
    this.registerInstance();

    // Start heartbeat
    this.heartbeatTimer = setInterval(() => {
      this.sendHeartbeat();
    }, this.config.heartbeatIntervalMs);

    // Start cleanup
    this.cleanupTimer = setInterval(() => {
      this.cleanupOldMessages();
      this.cleanupStaleInstances();
    }, this.config.messageRetentionMs / 2);

    // Initial heartbeat
    this.sendHeartbeat();

    // Request initial sync from any available peers
    this.requestSync();
  }

  /**
   * Stop the sync manager
   */
  stop(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }

    // Unregister instance
    this.unregisterInstance();
  }

  /**
   * Register callbacks for protocol events
   */
  onProtocolChange(callbacks: {
    onReceived?: (protocol: Protocol) => void;
    onDeleted?: (protocolId: string) => void;
    onActivationChanged?: (protocolId: string, active: boolean) => void;
    onConflict?: (localProtocol: Protocol, remoteProtocol: Protocol, resolution: ConflictResolution) => void;
  }): void {
    this.onProtocolReceived = callbacks.onReceived;
    this.onProtocolDeleted = callbacks.onDeleted;
    this.onActivationChanged = callbacks.onActivationChanged;
    this.onConflict = callbacks.onConflict;
  }

  // ==========================================================================
  // Instance Management
  // ==========================================================================

  /**
   * Register this instance in the shared directory
   */
  private registerInstance(): void {
    const info: InstanceInfo = {
      instanceId: this.state.instanceId,
      projectDir: this.projectDir,
      startedAt: new Date().toISOString(),
      lastHeartbeat: new Date().toISOString(),
      version: "0.1.0", // Should match package version
    };

    const instanceFile = path.join(
      this.syncDir,
      "instances",
      `${this.state.instanceId}.json`
    );

    this.atomicWrite(instanceFile, JSON.stringify(info, null, 2));
    this.state.knownInstances.set(this.state.instanceId, info);
  }

  /**
   * Unregister this instance
   */
  private unregisterInstance(): void {
    const instanceFile = path.join(
      this.syncDir,
      "instances",
      `${this.state.instanceId}.json`
    );

    try {
      if (fs.existsSync(instanceFile)) {
        fs.unlinkSync(instanceFile);
      }
    } catch {
      // Ignore errors during cleanup
    }
  }

  /**
   * Discover other instances from the shared directory
   */
  discoverInstances(): InstanceInfo[] {
    const instancesDir = path.join(this.syncDir, "instances");
    const discovered: InstanceInfo[] = [];

    try {
      const files = fs.readdirSync(instancesDir);

      for (const file of files) {
        if (!file.endsWith(".json")) continue;

        const filePath = path.join(instancesDir, file);
        try {
          const data = fs.readFileSync(filePath, "utf-8");
          const info = InstanceInfoSchema.parse(JSON.parse(data));

          // Check if instance is still alive (has recent heartbeat)
          const lastHeartbeat = new Date(info.lastHeartbeat).getTime();
          const now = Date.now();

          if (now - lastHeartbeat < this.config.instanceTimeoutMs) {
            discovered.push(info);
            this.state.knownInstances.set(info.instanceId, info);
          }
        } catch {
          // Skip invalid instance files
        }
      }
    } catch {
      // Directory might not exist yet
    }

    return discovered;
  }

  /**
   * Cleanup stale instance registrations
   */
  private cleanupStaleInstances(): void {
    const instancesDir = path.join(this.syncDir, "instances");
    const now = Date.now();

    try {
      const files = fs.readdirSync(instancesDir);

      for (const file of files) {
        if (!file.endsWith(".json")) continue;

        const filePath = path.join(instancesDir, file);
        try {
          const data = fs.readFileSync(filePath, "utf-8");
          const info = InstanceInfoSchema.parse(JSON.parse(data));

          const lastHeartbeat = new Date(info.lastHeartbeat).getTime();

          if (now - lastHeartbeat >= this.config.instanceTimeoutMs) {
            // Stale instance - remove
            fs.unlinkSync(filePath);
            this.state.knownInstances.delete(info.instanceId);
          }
        } catch {
          // Remove invalid files
          try {
            fs.unlinkSync(filePath);
          } catch {
            // Ignore
          }
        }
      }
    } catch {
      // Directory might not exist
    }
  }

  // ==========================================================================
  // Message Sending
  // ==========================================================================

  /**
   * Create a base message with common fields
   */
  private createBaseMessage(type: SyncMessageType, targetInstance?: string): {
    messageId: string;
    sourceInstance: string;
    targetInstance?: string;
    timestamp: string;
    sequenceNumber: number;
  } {
    this.state.sequenceNumber++;

    return {
      messageId: crypto.randomUUID(),
      sourceInstance: this.state.instanceId,
      targetInstance,
      timestamp: new Date().toISOString(),
      sequenceNumber: this.state.sequenceNumber,
    };
  }

  /**
   * Send a sync message (writes to shared directory)
   */
  private sendMessage(message: SyncMessage, requireAck = false): void {
    // Validate message
    SyncMessageSchema.parse(message);

    // Write to messages directory
    const messageFile = path.join(
      this.syncDir,
      "messages",
      `${message.timestamp.replace(/[:.]/g, "-")}_${message.messageId}.json`
    );

    this.atomicWrite(messageFile, JSON.stringify(message, null, 2));

    // Track pending ack if required
    if (requireAck && message.targetInstance) {
      this.state.pendingAcks.set(message.messageId, {
        message,
        sentAt: new Date().toISOString(),
        retries: 0,
      });
    }
  }

  /**
   * Atomic file write (temp + rename pattern)
   */
  private atomicWrite(filePath: string, content: string): void {
    const tempFile = `${filePath}.tmp.${Date.now()}`;
    try {
      fs.writeFileSync(tempFile, content, { mode: 0o600 });
      fs.renameSync(tempFile, filePath);
    } catch (error) {
      try {
        fs.unlinkSync(tempFile);
      } catch {
        // Ignore cleanup errors
      }
      throw error;
    }
  }

  /**
   * Send heartbeat message
   */
  private sendHeartbeat(): void {
    // Update instance file
    this.registerInstance();

    const message: HeartbeatMessage = {
      ...this.createBaseMessage("heartbeat"),
      type: "heartbeat",
      payload: {
        instance: {
          instanceId: this.state.instanceId,
          projectDir: this.projectDir,
          startedAt: this.state.knownInstances.get(this.state.instanceId)?.startedAt || new Date().toISOString(),
          lastHeartbeat: new Date().toISOString(),
          version: "0.1.0",
        },
        protocolCount: 0, // Will be updated by registry integration
        activeCount: 0,
      },
    };

    this.sendMessage(message);
  }

  /**
   * Broadcast a protocol update
   */
  broadcastProtocolUpdate(
    protocol: Protocol,
    previousVersion?: string
  ): void {
    // Increment version vector
    this.state.versionVector = incrementVersionVector(
      this.state.versionVector,
      this.state.instanceId
    );

    const message: ProtocolUpdateMessage = {
      ...this.createBaseMessage("protocol_update"),
      type: "protocol_update",
      payload: {
        protocol,
        versionVector: this.state.versionVector,
        previousVersion,
      },
    };

    this.sendMessage(message);
  }

  /**
   * Broadcast a protocol deletion
   */
  broadcastProtocolDeletion(protocolId: string): void {
    // Increment version vector
    this.state.versionVector = incrementVersionVector(
      this.state.versionVector,
      this.state.instanceId
    );

    const message: ProtocolDeleteMessage = {
      ...this.createBaseMessage("protocol_delete"),
      type: "protocol_delete",
      payload: {
        protocolId,
        versionVector: this.state.versionVector,
        deletedAt: new Date().toISOString(),
      },
    };

    this.sendMessage(message);
  }

  /**
   * Broadcast an activation change
   */
  broadcastActivationChange(protocolId: string, active: boolean): void {
    // Increment version vector
    this.state.versionVector = incrementVersionVector(
      this.state.versionVector,
      this.state.instanceId
    );

    const message: ActivationChangeMessage = {
      ...this.createBaseMessage("activation_change"),
      type: "activation_change",
      payload: {
        protocolId,
        active,
        versionVector: this.state.versionVector,
      },
    };

    this.sendMessage(message);
  }

  /**
   * Request sync from peers
   */
  requestSync(targetInstance?: string): void {
    const message: SyncRequestMessage = {
      ...this.createBaseMessage("sync_request", targetInstance),
      type: "sync_request",
      payload: {
        currentVersionVector: this.state.versionVector,
      },
    };

    this.sendMessage(message, !!targetInstance);
  }

  /**
   * Send sync response
   */
  sendSyncResponse(
    targetInstance: string,
    inResponseTo: string,
    protocols: Protocol[],
    activeProtocols: string[]
  ): void {
    const message: SyncResponseMessage = {
      ...this.createBaseMessage("sync_response", targetInstance),
      type: "sync_response",
      payload: {
        protocols,
        activeProtocols,
        versionVector: this.state.versionVector,
        inResponseTo,
      },
    };

    this.sendMessage(message);
  }

  /**
   * Send acknowledgment
   */
  sendAck(
    targetInstance: string,
    acknowledgedMessageId: string,
    status: "received" | "applied" | "ignored"
  ): void {
    const message: AckMessage = {
      ...this.createBaseMessage("ack", targetInstance),
      type: "ack",
      payload: {
        acknowledgedMessageId,
        status,
      },
    };

    this.sendMessage(message);
  }

  /**
   * Send negative acknowledgment
   */
  sendNack(
    targetInstance: string,
    acknowledgedMessageId: string,
    reason: "conflict" | "invalid" | "outdated" | "error",
    errorMessage?: string,
    conflictInfo?: NackMessage["payload"]["conflictInfo"]
  ): void {
    const message: NackMessage = {
      ...this.createBaseMessage("nack", targetInstance),
      type: "nack",
      payload: {
        acknowledgedMessageId,
        reason,
        errorMessage,
        conflictInfo,
      },
    };

    this.sendMessage(message);
  }

  // ==========================================================================
  // Message Processing
  // ==========================================================================

  /**
   * Process incoming messages from the shared directory
   */
  processIncomingMessages(): SyncMessage[] {
    const messagesDir = path.join(this.syncDir, "messages");
    const processed: SyncMessage[] = [];

    try {
      const files = fs.readdirSync(messagesDir);

      for (const file of files) {
        if (!file.endsWith(".json")) continue;

        const filePath = path.join(messagesDir, file);
        try {
          const data = fs.readFileSync(filePath, "utf-8");
          const message = SyncMessageSchema.parse(JSON.parse(data));

          // Skip our own messages
          if (message.sourceInstance === this.state.instanceId) continue;

          // Skip messages not targeted at us (unless broadcast)
          if (
            message.targetInstance &&
            message.targetInstance !== this.state.instanceId
          ) {
            continue;
          }

          // Process the message
          this.handleMessage(message);
          processed.push(message);
        } catch {
          // Skip invalid messages
        }
      }
    } catch {
      // Directory might not exist
    }

    return processed;
  }

  /**
   * Handle a received message
   */
  private handleMessage(message: SyncMessage): void {
    switch (message.type) {
      case "protocol_update":
        this.handleProtocolUpdate(message);
        break;
      case "protocol_delete":
        this.handleProtocolDelete(message);
        break;
      case "activation_change":
        this.handleActivationChange(message);
        break;
      case "sync_request":
        this.handleSyncRequest(message);
        break;
      case "sync_response":
        this.handleSyncResponse(message);
        break;
      case "heartbeat":
        this.handleHeartbeat(message);
        break;
      case "ack":
        this.handleAck(message);
        break;
      case "nack":
        this.handleNack(message);
        break;
    }
  }

  /**
   * Handle protocol update message
   */
  private handleProtocolUpdate(message: ProtocolUpdateMessage): void {
    const { protocol, versionVector } = message.payload;

    // Check version vector for conflict
    const comparison = compareVersionVectors(
      this.state.versionVector,
      versionVector
    );

    if (comparison === "after") {
      // Our version is newer, send nack
      this.sendNack(
        message.sourceInstance,
        message.messageId,
        "outdated",
        "Local version is newer"
      );
      return;
    }

    // Merge version vectors
    this.state.versionVector = mergeVersionVectors(
      this.state.versionVector,
      versionVector
    );

    // Notify callback
    if (this.onProtocolReceived) {
      this.onProtocolReceived(protocol);
    }

    // Send ack
    this.sendAck(message.sourceInstance, message.messageId, "applied");
  }

  /**
   * Handle protocol delete message
   */
  private handleProtocolDelete(message: ProtocolDeleteMessage): void {
    const { protocolId, versionVector } = message.payload;

    // Merge version vectors
    this.state.versionVector = mergeVersionVectors(
      this.state.versionVector,
      versionVector
    );

    // Notify callback
    if (this.onProtocolDeleted) {
      this.onProtocolDeleted(protocolId);
    }

    // Send ack
    this.sendAck(message.sourceInstance, message.messageId, "applied");
  }

  /**
   * Handle activation change message
   */
  private handleActivationChange(message: ActivationChangeMessage): void {
    const { protocolId, active, versionVector } = message.payload;

    // Merge version vectors
    this.state.versionVector = mergeVersionVectors(
      this.state.versionVector,
      versionVector
    );

    // Notify callback
    if (this.onActivationChanged) {
      this.onActivationChanged(protocolId, active);
    }

    // Send ack
    this.sendAck(message.sourceInstance, message.messageId, "applied");
  }

  /**
   * Handle sync request message
   */
  private handleSyncRequest(message: SyncRequestMessage): void {
    // This will be called by the registry integration
    // For now, just acknowledge receipt
    this.sendAck(message.sourceInstance, message.messageId, "received");
  }

  /**
   * Handle sync response message
   */
  private handleSyncResponse(message: SyncResponseMessage): void {
    const { protocols, activeProtocols, versionVector } = message.payload;

    // Merge version vectors
    this.state.versionVector = mergeVersionVectors(
      this.state.versionVector,
      versionVector
    );

    // Process received protocols
    for (const protocol of protocols) {
      if (this.onProtocolReceived) {
        this.onProtocolReceived(protocol);
      }
    }

    // Update activation states
    for (const protocolId of activeProtocols) {
      if (this.onActivationChanged) {
        this.onActivationChanged(protocolId, true);
      }
    }

    this.state.lastSyncAt = new Date().toISOString();

    // Send ack
    this.sendAck(message.sourceInstance, message.messageId, "applied");
  }

  /**
   * Handle heartbeat message
   */
  private handleHeartbeat(message: HeartbeatMessage): void {
    const { instance } = message.payload;

    // Update known instances
    this.state.knownInstances.set(instance.instanceId, instance);
  }

  /**
   * Handle ack message
   */
  private handleAck(message: AckMessage): void {
    const { acknowledgedMessageId } = message.payload;

    // Remove from pending acks
    this.state.pendingAcks.delete(acknowledgedMessageId);
  }

  /**
   * Handle nack message
   */
  private handleNack(message: NackMessage): void {
    const { acknowledgedMessageId, reason } = message.payload;

    // Remove from pending acks
    const pending = this.state.pendingAcks.get(acknowledgedMessageId);
    if (pending) {
      this.state.pendingAcks.delete(acknowledgedMessageId);

      // Log the conflict/error
      console.error(
        `Sync nack received for message ${acknowledgedMessageId}: ${reason}`
      );
    }
  }

  // ==========================================================================
  // Cleanup
  // ==========================================================================

  /**
   * Cleanup old messages from the shared directory
   */
  private cleanupOldMessages(): void {
    const messagesDir = path.join(this.syncDir, "messages");
    const now = Date.now();

    try {
      const files = fs.readdirSync(messagesDir);

      for (const file of files) {
        if (!file.endsWith(".json")) continue;

        const filePath = path.join(messagesDir, file);
        try {
          const stats = fs.statSync(filePath);
          const age = now - stats.mtimeMs;

          if (age >= this.config.messageRetentionMs) {
            fs.unlinkSync(filePath);
          }
        } catch {
          // Skip files we can't access
        }
      }
    } catch {
      // Directory might not exist
    }
  }

  // ==========================================================================
  // Batch Operations
  // ==========================================================================

  /**
   * Perform a full sync with a specific instance
   */
  async fullSync(
    targetInstance: string,
    localProtocols: Protocol[],
    localActiveProtocols: string[]
  ): Promise<void> {
    // Request sync from target
    this.requestSync(targetInstance);

    // Send our state
    this.sendSyncResponse(
      targetInstance,
      crypto.randomUUID(), // Not in response to a specific request
      localProtocols,
      localActiveProtocols
    );
  }

  /**
   * Get sync statistics
   */
  getStats(): {
    instanceId: string;
    sequenceNumber: number;
    knownInstances: number;
    pendingAcks: number;
    lastSyncAt: string | null;
  } {
    return {
      instanceId: this.state.instanceId,
      sequenceNumber: this.state.sequenceNumber,
      knownInstances: this.state.knownInstances.size,
      pendingAcks: this.state.pendingAcks.size,
      lastSyncAt: this.state.lastSyncAt,
    };
  }
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create a new sync manager for a project
 */
export function createSyncManager(
  projectDir: string,
  config?: SyncConfig
): ProtocolSyncManager {
  return new ProtocolSyncManager(projectDir, config);
}
