/**
 * Protocol Resolver - Dependency chain resolution for protocol inheritance
 *
 * Resolves protocol dependency chains, handling:
 * - extends: Protocol inheritance (child overrides parent constraints)
 * - requires: Must be active for this protocol to work
 * - conflicts: Cannot be active simultaneously
 *
 * Key features:
 * - Circular dependency detection
 * - Priority-based constraint merging
 * - Efficient caching of resolved chains
 */

import { z } from "zod";
import type { Protocol, ProtocolConstraint } from "./schema.js";

/**
 * Minimal registry interface for resolution
 * Compatible with ProtocolRegistry from registry.ts
 */
export interface ProtocolRegistryLike {
  getProtocol(id: string): Protocol | undefined;
  getActive(): string[];
}

/**
 * Resolution error types
 */
export type ResolutionErrorType =
  | "circular_dependency"
  | "missing_protocol"
  | "missing_required"
  | "conflict_detected";

export interface ResolutionError {
  type: ResolutionErrorType;
  message: string;
  protocolId: string;
  details?: {
    cycle?: string[];
    missing?: string[];
    conflicts?: string[];
  };
}

/**
 * Result of resolving a protocol dependency chain
 */
export interface ResolvedChain {
  /**
   * Ordered list of protocol IDs in the chain
   * First element is the root (most ancestral), last is the requested protocol
   */
  chain: string[];

  /**
   * All protocols that must be active for this chain to work
   */
  requiredProtocols: string[];

  /**
   * All protocols that conflict with this chain
   */
  conflictingProtocols: string[];

  /**
   * Any resolution errors encountered
   */
  errors: ResolutionError[];

  /**
   * Whether the chain is valid (no errors)
   */
  isValid: boolean;
}

/**
 * Result of merging constraints from a protocol chain
 */
export interface EffectiveConstraints {
  /**
   * Merged constraints with priority ordering applied
   */
  constraints: ProtocolConstraint[];

  /**
   * Map of constraint IDs to their source protocol
   */
  sources: Map<string, string>;

  /**
   * Any constraints that were overridden by higher-priority protocols
   */
  overridden: Array<{
    constraintId: string;
    fromProtocol: string;
    byProtocol: string;
  }>;
}

/**
 * Zod schema for resolution errors
 */
export const ResolutionErrorSchema = z.object({
  type: z.enum([
    "circular_dependency",
    "missing_protocol",
    "missing_required",
    "conflict_detected",
  ]),
  message: z.string(),
  protocolId: z.string(),
  details: z
    .object({
      cycle: z.array(z.string()).optional(),
      missing: z.array(z.string()).optional(),
      conflicts: z.array(z.string()).optional(),
    })
    .optional(),
});

/**
 * Zod schema for resolved chain
 */
export const ResolvedChainSchema = z.object({
  chain: z.array(z.string()),
  requiredProtocols: z.array(z.string()),
  conflictingProtocols: z.array(z.string()),
  errors: z.array(ResolutionErrorSchema),
  isValid: z.boolean(),
});

/**
 * ProtocolResolver - Resolves protocol dependency chains
 */
export class ProtocolResolver {
  // Cache resolved chains for efficiency
  private chainCache: Map<string, ResolvedChain> = new Map();
  private constraintCache: Map<string, EffectiveConstraints> = new Map();

  /**
   * Clear all cached resolutions
   * Call when protocols are modified
   */
  clearCache(): void {
    this.chainCache.clear();
    this.constraintCache.clear();
  }

  /**
   * Resolve the full dependency chain for a protocol
   *
   * @param protocolId - ID of the protocol to resolve
   * @param registry - Registry containing all protocols
   * @returns ResolvedChain with ordered ancestors and any errors
   */
  resolveChain(protocolId: string, registry: ProtocolRegistryLike): ResolvedChain {
    // Check cache first
    const cached = this.chainCache.get(protocolId);
    if (cached) {
      return cached;
    }

    const errors: ResolutionError[] = [];
    const chain: string[] = [];
    const requiredProtocols = new Set<string>();
    const conflictingProtocols = new Set<string>();

    // Track visited nodes for cycle detection
    const visiting = new Set<string>();
    const visited = new Set<string>();

    // Depth-first traversal to build chain
    const visit = (id: string, path: string[]): boolean => {
      // Check for circular dependency
      if (visiting.has(id)) {
        const cycleStart = path.indexOf(id);
        const cycle = [...path.slice(cycleStart), id];
        errors.push({
          type: "circular_dependency",
          message: `Circular dependency detected: ${cycle.join(" -> ")}`,
          protocolId: id,
          details: { cycle },
        });
        return false;
      }

      // Skip if already fully processed
      if (visited.has(id)) {
        return true;
      }

      const protocol = registry.getProtocol(id);
      if (!protocol) {
        errors.push({
          type: "missing_protocol",
          message: `Protocol not found: ${id}`,
          protocolId: id,
        });
        return false;
      }

      visiting.add(id);

      // Process extends (inheritance chain)
      if (protocol.extends && protocol.extends.length > 0) {
        for (const parentId of protocol.extends) {
          const success = visit(parentId, [...path, id]);
          if (!success) {
            // Continue processing to find all errors
          }
        }
      }

      // Collect required protocols
      if (protocol.requires) {
        for (const reqId of protocol.requires) {
          requiredProtocols.add(reqId);
        }
      }

      // Collect conflicting protocols
      if (protocol.conflicts) {
        for (const confId of protocol.conflicts) {
          conflictingProtocols.add(confId);
        }
      }

      visiting.delete(id);
      visited.add(id);

      // Add to chain in post-order (ancestors first)
      if (!chain.includes(id)) {
        chain.push(id);
      }

      return true;
    };

    // Start traversal from the requested protocol
    visit(protocolId, []);

    // Validate required protocols are available
    for (const reqId of requiredProtocols) {
      const protocol = registry.getProtocol(reqId);
      if (!protocol) {
        errors.push({
          type: "missing_required",
          message: `Required protocol not found: ${reqId}`,
          protocolId: protocolId,
          details: { missing: [reqId] },
        });
      }
    }

    // Check for conflicts with active protocols
    const activeProtocols = registry.getActive();
    const activeConflicts = activeProtocols.filter((id) =>
      conflictingProtocols.has(id)
    );
    if (activeConflicts.length > 0) {
      errors.push({
        type: "conflict_detected",
        message: `Protocol conflicts with active protocols: ${activeConflicts.join(", ")}`,
        protocolId: protocolId,
        details: { conflicts: activeConflicts },
      });
    }

    const result: ResolvedChain = {
      chain,
      requiredProtocols: Array.from(requiredProtocols),
      conflictingProtocols: Array.from(conflictingProtocols),
      errors,
      isValid: errors.length === 0,
    };

    // Cache the result
    this.chainCache.set(protocolId, result);

    return result;
  }

  /**
   * Get effective constraints for a protocol, merging from all ancestors
   *
   * Constraints are merged with priority ordering:
   * - Higher priority protocols override lower priority
   * - Child protocols override parent protocols (when same priority)
   * - Constraints are identified by their ID for merging
   *
   * @param protocolId - ID of the protocol
   * @param registry - Registry containing all protocols
   * @returns EffectiveConstraints with merged constraints and metadata
   */
  getEffectiveConstraints(
    protocolId: string,
    registry: ProtocolRegistryLike
  ): EffectiveConstraints {
    // Check cache first
    const cached = this.constraintCache.get(protocolId);
    if (cached) {
      return cached;
    }

    // First resolve the chain
    const resolvedChain = this.resolveChain(protocolId, registry);

    // Maps constraint ID to constraint and source
    const constraintMap = new Map<string, ProtocolConstraint>();
    const sourceMap = new Map<string, string>();
    const overridden: EffectiveConstraints["overridden"] = [];

    // Process chain in order (ancestors first)
    // Each protocol can override constraints from earlier protocols
    for (const protoId of resolvedChain.chain) {
      const protocol = registry.getProtocol(protoId);
      if (!protocol) continue;

      for (const constraint of protocol.constraints) {
        const existingSource = sourceMap.get(constraint.id);
        if (existingSource) {
          // Check if this protocol has higher or equal priority
          const existingProtocol = registry.getProtocol(existingSource);
          if (existingProtocol && protocol.priority >= existingProtocol.priority) {
            // Override the constraint
            overridden.push({
              constraintId: constraint.id,
              fromProtocol: existingSource,
              byProtocol: protoId,
            });
          } else {
            // Keep existing constraint (higher priority)
            continue;
          }
        }

        constraintMap.set(constraint.id, constraint);
        sourceMap.set(constraint.id, protoId);
      }
    }

    const result: EffectiveConstraints = {
      constraints: Array.from(constraintMap.values()),
      sources: sourceMap,
      overridden,
    };

    // Cache the result
    this.constraintCache.set(protocolId, result);

    return result;
  }

  /**
   * Check if activating a protocol would cause conflicts
   *
   * @param protocolId - Protocol to check
   * @param registry - Registry containing all protocols
   * @returns Array of conflict errors, empty if no conflicts
   */
  checkActivationConflicts(
    protocolId: string,
    registry: ProtocolRegistryLike
  ): ResolutionError[] {
    const errors: ResolutionError[] = [];
    const protocol = registry.getProtocol(protocolId);

    if (!protocol) {
      errors.push({
        type: "missing_protocol",
        message: `Protocol not found: ${protocolId}`,
        protocolId,
      });
      return errors;
    }

    // Check direct conflicts
    const activeProtocols = registry.getActive();
    if (protocol.conflicts) {
      const conflicts = protocol.conflicts.filter((id) =>
        activeProtocols.includes(id)
      );
      if (conflicts.length > 0) {
        errors.push({
          type: "conflict_detected",
          message: `Cannot activate: conflicts with ${conflicts.join(", ")}`,
          protocolId,
          details: { conflicts },
        });
      }
    }

    // Check if any active protocol conflicts with this one
    for (const activeId of activeProtocols) {
      const activeProtocol = registry.getProtocol(activeId);
      if (activeProtocol?.conflicts?.includes(protocolId)) {
        errors.push({
          type: "conflict_detected",
          message: `Active protocol ${activeId} conflicts with ${protocolId}`,
          protocolId,
          details: { conflicts: [activeId] },
        });
      }
    }

    // Check required protocols
    if (protocol.requires) {
      const missing = protocol.requires.filter(
        (id) => !activeProtocols.includes(id)
      );
      if (missing.length > 0) {
        errors.push({
          type: "missing_required",
          message: `Missing required protocols: ${missing.join(", ")}`,
          protocolId,
          details: { missing },
        });
      }
    }

    return errors;
  }

  /**
   * Get all protocols that would be affected if the given protocol changes
   *
   * @param protocolId - Protocol that changed
   * @param registry - Registry containing all protocols
   * @returns Array of protocol IDs that depend on the changed protocol
   */
  getDependents(protocolId: string, registry: ProtocolRegistryLike): string[] {
    const dependents: string[] = [];

    // This is a simple implementation that checks all protocols
    // A more efficient implementation would maintain a reverse dependency graph
    const allProtocols = this.getAllProtocolIds(registry);

    for (const id of allProtocols) {
      if (id === protocolId) continue;

      const protocol = registry.getProtocol(id);
      if (!protocol) continue;

      // Check if this protocol extends or requires the target
      const dependsOn = [
        ...(protocol.extends || []),
        ...(protocol.requires || []),
      ];

      if (dependsOn.includes(protocolId)) {
        dependents.push(id);
      }
    }

    return dependents;
  }

  /**
   * Helper to get all protocol IDs from registry
   * Note: This is a workaround since ProtocolRegistryLike doesn't expose all IDs
   */
  private getAllProtocolIds(registry: ProtocolRegistryLike): string[] {
    // If registry has a method to list all protocols, use it
    // Otherwise, this functionality would need to be added to the registry interface
    if ("getAllProtocolIds" in registry && typeof (registry as any).getAllProtocolIds === "function") {
      return (registry as any).getAllProtocolIds();
    }
    // Return empty array if no method available
    // In production, the registry interface should be extended to support this
    return [];
  }

  /**
   * Validate a protocol's dependency configuration
   *
   * @param protocol - Protocol to validate
   * @param registry - Registry containing all protocols
   * @returns Array of validation errors
   */
  validateProtocolDependencies(
    protocol: Protocol,
    registry: ProtocolRegistryLike
  ): ResolutionError[] {
    const errors: ResolutionError[] = [];

    // Check that extended protocols exist
    if (protocol.extends) {
      for (const extendId of protocol.extends) {
        if (!registry.getProtocol(extendId)) {
          errors.push({
            type: "missing_protocol",
            message: `Extended protocol not found: ${extendId}`,
            protocolId: protocol.id,
            details: { missing: [extendId] },
          });
        }
      }
    }

    // Check that required protocols exist
    if (protocol.requires) {
      for (const reqId of protocol.requires) {
        if (!registry.getProtocol(reqId)) {
          errors.push({
            type: "missing_required",
            message: `Required protocol not found: ${reqId}`,
            protocolId: protocol.id,
            details: { missing: [reqId] },
          });
        }
      }
    }

    // Check for self-reference
    if (protocol.extends?.includes(protocol.id)) {
      errors.push({
        type: "circular_dependency",
        message: `Protocol cannot extend itself`,
        protocolId: protocol.id,
        details: { cycle: [protocol.id] },
      });
    }

    if (protocol.requires?.includes(protocol.id)) {
      errors.push({
        type: "circular_dependency",
        message: `Protocol cannot require itself`,
        protocolId: protocol.id,
        details: { cycle: [protocol.id] },
      });
    }

    // Check for extend/require overlap (unusual but allowed with warning)
    if (protocol.extends && protocol.requires) {
      const overlap = protocol.extends.filter((id) =>
        protocol.requires!.includes(id)
      );
      // This is logged but not treated as an error
      // An extended protocol is implicitly required
    }

    return errors;
  }
}
