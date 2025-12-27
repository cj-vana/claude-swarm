/**
 * Dashboard HTTP Server - Web API for orchestration session monitoring
 *
 * Provides REST endpoints for:
 * - Session status (GET /api/status)
 * - Feature list (GET /api/features)
 * - Worker statuses (GET /api/workers)
 * - Progress log (GET /api/logs)
 *
 * Designed to run alongside the MCP server for real-time dashboard access.
 */

import express, { Request, Response, NextFunction } from "express";
import * as http from "http";
import * as path from "path";
import { fileURLToPath } from "url";
import { StateManager, OrchestratorState, Feature, WorkerStatus } from "../state/manager.js";
import { WorkerManager } from "../workers/manager.js";

// ES module __dirname equivalent
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
import { formatDuration, formatPercent, formatDurationMs, calculateAverage } from "../utils/format.js";

export interface DashboardServerOptions {
  port?: number;
  host?: string;
}

export interface DashboardServer {
  app: express.Application;
  server: http.Server;
  port: number;
  close: () => Promise<void>;
}

// SSE client connection
interface SSEClient {
  id: string;
  res: Response;
}

// State snapshot for change detection
interface StateSnapshot {
  status: string | null;
  features: Map<string, string>; // featureId -> status
  logCount: number;
  workerCount: number;
}

/**
 * Start the dashboard HTTP server
 */
export async function startDashboardServer(
  getStateManager: () => StateManager | null,
  options: DashboardServerOptions = {}
): Promise<DashboardServer> {
  const port = options.port || 3456;
  const host = options.host || "127.0.0.1";

  const app = express();

  // SSE client management
  const sseClients: SSEClient[] = [];
  let lastSnapshot: StateSnapshot | null = null;
  let ssePollingInterval: NodeJS.Timeout | null = null;

  // Generate unique client ID
  const generateClientId = () => `client-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

  // Send SSE event to all connected clients
  const broadcastSSE = (eventType: string, data: unknown) => {
    const message = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
    sseClients.forEach((client) => {
      try {
        client.res.write(message);
      } catch (err) {
        // Client disconnected, will be cleaned up
      }
    });
  };

  // Create a snapshot of current state for change detection
  const createSnapshot = (state: OrchestratorState | null): StateSnapshot => {
    if (!state) {
      return {
        status: null,
        features: new Map(),
        logCount: 0,
        workerCount: 0,
      };
    }

    const features = new Map<string, string>();
    let workerCount = 0;
    for (const f of state.features) {
      features.set(f.id, f.status);
      if (f.status === "in_progress" && f.workerId) {
        workerCount++;
      }
    }

    return {
      status: state.status,
      features,
      logCount: state.progressLog.length,
      workerCount,
    };
  };

  // Helper to get current state manager
  const getState = () => {
    const sm = getStateManager();
    return sm ? sm.load() : null;
  };

  // Detect and broadcast changes between snapshots
  const detectAndBroadcastChanges = (oldSnap: StateSnapshot | null, newSnap: StateSnapshot, state: OrchestratorState | null) => {
    // Status change
    if (!oldSnap || oldSnap.status !== newSnap.status) {
      broadcastSSE("status", {
        status: newSnap.status,
        projectDir: state?.projectDir,
        taskDescription: state?.taskDescription,
        startTime: state?.startTime,
        lastUpdated: state?.lastUpdated,
      });
    }

    // Feature changes
    if (state) {
      for (const feature of state.features) {
        const oldStatus = oldSnap?.features.get(feature.id);
        const newStatus = newSnap.features.get(feature.id);
        if (oldStatus !== newStatus) {
          broadcastSSE("feature", {
            id: feature.id,
            description: feature.description,
            status: feature.status,
            attempts: feature.attempts,
            workerId: feature.workerId,
            startedAt: feature.startedAt,
            completedAt: feature.completedAt,
            lastError: feature.lastError,
            notes: feature.notes,
          });
        }
      }
    }

    // New log entries
    if (state && oldSnap && newSnap.logCount > oldSnap.logCount) {
      const newLogs = state.progressLog.slice(oldSnap.logCount);
      for (const log of newLogs) {
        const match = log.match(/^\[([^\]]+)\]\s*(.*)$/);
        broadcastSSE("log", {
          timestamp: match ? match[1] : new Date().toISOString(),
          message: match ? match[2] : log,
          raw: log,
        });
      }
    }

    // Worker count change
    if (!oldSnap || oldSnap.workerCount !== newSnap.workerCount) {
      broadcastSSE("worker", {
        activeCount: newSnap.workerCount,
      });
    }
  };

  // Start polling for state changes (called when first SSE client connects)
  const startSSEPolling = () => {
    if (ssePollingInterval) return;

    ssePollingInterval = setInterval(() => {
      if (sseClients.length === 0) {
        // No clients, stop polling
        if (ssePollingInterval) {
          clearInterval(ssePollingInterval);
          ssePollingInterval = null;
        }
        return;
      }

      const state = getState();
      const newSnapshot = createSnapshot(state);
      detectAndBroadcastChanges(lastSnapshot, newSnapshot, state);
      lastSnapshot = newSnapshot;
    }, 1000); // Check every 1 second
  };

  // CORS middleware for local development
  app.use((req: Request, res: Response, next: NextFunction) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.header("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") {
      res.sendStatus(200);
      return;
    }
    next();
  });

  // Serve static files from the public directory
  // In dev: src/dashboard/public, in dist: dist/dashboard/public
  const publicPath = path.join(__dirname, "public");
  app.use(express.static(publicPath));

  // Serve index.html for root path
  app.get("/", (req: Request, res: Response) => {
    res.sendFile(path.join(publicPath, "index.html"));
  });

  // JSON response helper
  const sendJson = (res: Response, data: unknown) => {
    res.setHeader("Content-Type", "application/json");
    res.json(data);
  };

  // Error handling wrapper
  const asyncHandler = (
    fn: (req: Request, res: Response) => Promise<void>
  ) => {
    return (req: Request, res: Response, next: NextFunction) => {
      Promise.resolve(fn(req, res)).catch(next);
    };
  };

  // ============================================================================
  // GET /api/status - Session status overview
  // ============================================================================
  app.get(
    "/api/status",
    asyncHandler(async (req: Request, res: Response) => {
      const state = getState();

      if (!state) {
        sendJson(res, {
          active: false,
          message: "No active orchestration session",
        });
        return;
      }

      const completed = state.features.filter((f) => f.status === "completed").length;
      const failed = state.features.filter((f) => f.status === "failed").length;
      const inProgress = state.features.filter((f) => f.status === "in_progress").length;
      const pending = state.features.filter((f) => f.status === "pending").length;

      const startTime = new Date(state.startTime);
      const now = new Date();
      const elapsedMs = now.getTime() - startTime.getTime();
      const elapsed = formatDuration(startTime, now);

      // Calculate success rate
      const totalFinished = completed + failed;
      const successRate = totalFinished > 0 ? completed / totalFinished : 0;

      sendJson(res, {
        active: true,
        projectDir: state.projectDir,
        status: state.status,
        taskDescription: state.taskDescription,
        startTime: state.startTime,
        lastUpdated: state.lastUpdated,
        completedAt: state.completedAt,
        elapsed,
        elapsedMs,
        summary: {
          total: state.features.length,
          completed,
          failed,
          inProgress,
          pending,
          successRate: formatPercent(successRate),
          successRateRaw: successRate,
        },
      });
    })
  );

  // ============================================================================
  // GET /api/features - Feature list with details
  // ============================================================================
  app.get(
    "/api/features",
    asyncHandler(async (req: Request, res: Response) => {
      const state = getState();

      if (!state) {
        sendJson(res, {
          features: [],
          message: "No active orchestration session",
        });
        return;
      }

      // Optional status filter
      const statusFilter = req.query.status as string | undefined;

      let features = state.features;
      if (statusFilter) {
        features = features.filter((f) => f.status === statusFilter);
      }

      const featureData = features.map((f) => ({
        id: f.id,
        description: f.description,
        status: f.status,
        attempts: f.attempts,
        workerId: f.workerId,
        startedAt: f.startedAt,
        completedAt: f.completedAt,
        lastError: f.lastError,
        notes: f.notes,
        dependsOn: f.dependsOn,
      }));

      sendJson(res, {
        features: featureData,
        total: state.features.length,
        filtered: featureData.length,
      });
    })
  );

  // ============================================================================
  // GET /api/workers - Worker statuses
  // ============================================================================
  app.get(
    "/api/workers",
    asyncHandler(async (req: Request, res: Response) => {
      const state = getState();

      if (!state) {
        sendJson(res, {
          workers: [],
          message: "No active orchestration session",
        });
        return;
      }

      // Create a temporary WorkerManager to check worker statuses
      const sm = getStateManager();
      if (!sm) {
        sendJson(res, {
          workers: [],
          message: "No state manager available",
        });
        return;
      }
      const workerManager = new WorkerManager(sm.projectDir, sm);
      const workerStatuses = await workerManager.checkAllWorkers();

      const workerData = workerStatuses.map((w) => {
        const feature = state.features.find((f) => f.id === w.featureId);
        return {
          sessionName: w.sessionName,
          featureId: w.featureId,
          featureDescription: feature?.description,
          status: w.status,
          startedAt: w.startedAt,
          lastChecked: w.lastChecked,
        };
      });

      // Summary counts
      const running = workerData.filter((w) => w.status === "running").length;
      const completed = workerData.filter((w) => w.status === "completed").length;
      const crashed = workerData.filter((w) => w.status === "crashed").length;

      sendJson(res, {
        workers: workerData,
        summary: {
          total: workerData.length,
          running,
          completed,
          crashed,
        },
      });
    })
  );

  // ============================================================================
  // GET /api/workers/:featureId/output - Stream worker terminal output via SSE
  // ============================================================================
  app.get(
    "/api/workers/:featureId/output",
    asyncHandler(async (req: Request, res: Response) => {
      const featureId = req.params.featureId;
      const state = getState();

      if (!state) {
        res.status(404).json({
          error: "No active orchestration session",
        });
        return;
      }

      // Find the feature
      const feature = state.features.find((f) => f.id === featureId);
      if (!feature) {
        res.status(404).json({
          error: `Feature not found: ${featureId}`,
        });
        return;
      }

      // Check if feature has an active worker
      if (!feature.workerId) {
        res.status(404).json({
          error: `No active worker for feature: ${featureId}`,
        });
        return;
      }

      // Set SSE headers
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      res.flushHeaders();

      // Send initial output
      const sendOutput = async () => {
        try {
          // Get the worker output using tmux capture-pane (100 lines)
          const { execFile } = await import("child_process");
          const { promisify } = await import("util");
          const execFileAsync = promisify(execFile);

          try {
            const { stdout } = await execFileAsync("tmux", [
              "capture-pane",
              "-t",
              feature.workerId!,
              "-p",
              "-S",
              "-100", // Last 100 lines
            ]);

            res.write(`event: output\ndata: ${JSON.stringify({
              featureId,
              output: stdout,
              timestamp: new Date().toISOString(),
            })}\n\n`);
          } catch (tmuxError: any) {
            // Session might have ended
            res.write(`event: ended\ndata: ${JSON.stringify({
              featureId,
              message: "Worker session ended or not found",
              timestamp: new Date().toISOString(),
            })}\n\n`);
            clearInterval(outputInterval);
            res.end();
          }
        } catch (error: any) {
          res.write(`event: error\ndata: ${JSON.stringify({
            featureId,
            error: error.message,
            timestamp: new Date().toISOString(),
          })}\n\n`);
        }
      };

      // Send initial output immediately
      await sendOutput();

      // Stream updates every 2 seconds
      const outputInterval = setInterval(async () => {
        // Check if feature still has active worker
        const currentState = getState();
        const currentFeature = currentState?.features.find((f) => f.id === featureId);

        if (!currentFeature || !currentFeature.workerId) {
          res.write(`event: ended\ndata: ${JSON.stringify({
            featureId,
            message: "Worker completed or stopped",
            timestamp: new Date().toISOString(),
          })}\n\n`);
          clearInterval(outputInterval);
          res.end();
          return;
        }

        await sendOutput();
      }, 2000);

      // Handle client disconnect
      req.on("close", () => {
        clearInterval(outputInterval);
      });
    })
  );

  // ============================================================================
  // GET /api/logs - Progress log entries
  // ============================================================================
  app.get(
    "/api/logs",
    asyncHandler(async (req: Request, res: Response) => {
      const state = getState();

      if (!state) {
        sendJson(res, {
          logs: [],
          message: "No active orchestration session",
        });
        return;
      }

      // Optional limit parameter
      const limitParam = req.query.limit as string | undefined;
      const limit = limitParam ? parseInt(limitParam, 10) : undefined;

      let logs = state.progressLog;
      if (limit && limit > 0) {
        logs = logs.slice(-limit);
      }

      // Parse logs into structured format
      const parsedLogs = logs.map((log) => {
        const match = log.match(/^\[([^\]]+)\]\s*(.*)$/);
        if (match) {
          return {
            timestamp: match[1],
            message: match[2],
            raw: log,
          };
        }
        return {
          timestamp: null,
          message: log,
          raw: log,
        };
      });

      sendJson(res, {
        logs: parsedLogs,
        total: state.progressLog.length,
        returned: parsedLogs.length,
      });
    })
  );

  // ============================================================================
  // GET /api/stats - Session statistics
  // ============================================================================
  app.get(
    "/api/stats",
    asyncHandler(async (req: Request, res: Response) => {
      const state = getState();

      if (!state) {
        sendJson(res, {
          stats: null,
          message: "No active orchestration session",
        });
        return;
      }

      const completed = state.features.filter((f) => f.status === "completed");
      const failed = state.features.filter((f) => f.status === "failed");

      // Calculate completion times
      const completionTimes: number[] = [];
      for (const feature of completed) {
        if (feature.startedAt && feature.completedAt) {
          const startTime = new Date(feature.startedAt).getTime();
          const endTime = new Date(feature.completedAt).getTime();
          if (startTime > 0 && endTime > startTime) {
            completionTimes.push(endTime - startTime);
          }
        }
      }

      const avgCompletionTimeMs = calculateAverage(completionTimes);
      const minCompletionTimeMs = completionTimes.length > 0 ? Math.min(...completionTimes) : 0;
      const maxCompletionTimeMs = completionTimes.length > 0 ? Math.max(...completionTimes) : 0;

      // Attempt statistics
      const attemptCounts = state.features.map((f) => f.attempts);
      const totalAttempts = attemptCounts.reduce((sum, val) => sum + val, 0);
      const avgAttempts = calculateAverage(attemptCounts);
      const maxAttempts = attemptCounts.length > 0 ? Math.max(...attemptCounts) : 0;

      // Success rate
      const totalFinished = completed.length + failed.length;
      const successRate = totalFinished > 0 ? completed.length / totalFinished : 0;

      // Total elapsed time
      const startTime = new Date(state.startTime);
      const now = new Date();
      const totalElapsedMs = now.getTime() - startTime.getTime();

      sendJson(res, {
        stats: {
          time: {
            totalElapsedMs,
            totalElapsed: formatDuration(startTime, now),
            avgCompletionTimeMs,
            avgCompletionTime: avgCompletionTimeMs > 0 ? formatDurationMs(avgCompletionTimeMs) : null,
            minCompletionTimeMs,
            minCompletionTime: minCompletionTimeMs > 0 ? formatDurationMs(minCompletionTimeMs) : null,
            maxCompletionTimeMs,
            maxCompletionTime: maxCompletionTimeMs > 0 ? formatDurationMs(maxCompletionTimeMs) : null,
          },
          success: {
            rate: successRate,
            rateFormatted: formatPercent(successRate),
            completed: completed.length,
            failed: failed.length,
            total: state.features.length,
          },
          attempts: {
            total: totalAttempts,
            average: avgAttempts,
            max: maxAttempts,
          },
        },
      });
    })
  );

  // ============================================================================
  // GET /api/events - Server-Sent Events for real-time updates
  // ============================================================================
  app.get("/api/events", (req: Request, res: Response) => {
    // Set SSE headers
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no"); // Disable nginx buffering
    res.flushHeaders();

    // Create client
    const clientId = generateClientId();
    const client: SSEClient = { id: clientId, res };
    sseClients.push(client);

    console.log(`SSE client connected: ${clientId} (total: ${sseClients.length})`);

    // Send initial connection event
    res.write(`event: connected\ndata: ${JSON.stringify({ clientId, timestamp: new Date().toISOString() })}\n\n`);

    // Send current state immediately
    const state = getState();
    if (state) {
      // Send full status
      res.write(`event: status\ndata: ${JSON.stringify({
        status: state.status,
        projectDir: state.projectDir,
        taskDescription: state.taskDescription,
        startTime: state.startTime,
        lastUpdated: state.lastUpdated,
      })}\n\n`);

      // Send all features
      for (const feature of state.features) {
        res.write(`event: feature\ndata: ${JSON.stringify({
          id: feature.id,
          description: feature.description,
          status: feature.status,
          attempts: feature.attempts,
          workerId: feature.workerId,
          startedAt: feature.startedAt,
          completedAt: feature.completedAt,
          lastError: feature.lastError,
          notes: feature.notes,
        })}\n\n`);
      }

      // Initialize snapshot with current state
      lastSnapshot = createSnapshot(state);
    }

    // Start SSE polling if not already running
    startSSEPolling();

    // Send heartbeat every 15 seconds to keep connection alive
    // (15s is a good balance - browsers typically timeout at 45-60s)
    const heartbeatInterval = setInterval(() => {
      try {
        res.write(`event: heartbeat\ndata: ${JSON.stringify({ timestamp: new Date().toISOString() })}\n\n`);
      } catch (err) {
        clearInterval(heartbeatInterval);
      }
    }, 15000);

    // Handle client disconnect
    req.on("close", () => {
      clearInterval(heartbeatInterval);
      const index = sseClients.findIndex((c) => c.id === clientId);
      if (index !== -1) {
        sseClients.splice(index, 1);
      }
      console.log(`SSE client disconnected: ${clientId} (remaining: ${sseClients.length})`);
    });
  });

  // ============================================================================
  // GET /health - Health check endpoint
  // ============================================================================
  app.get("/health", (req: Request, res: Response) => {
    sendJson(res, {
      status: "ok",
      timestamp: new Date().toISOString(),
    });
  });

  // ============================================================================
  // Error handling middleware
  // ============================================================================
  app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
    console.error("Dashboard server error:", err);
    res.status(500).json({
      error: "Internal server error",
      message: err.message,
    });
  });

  // ============================================================================
  // 404 handler
  // ============================================================================
  app.use((req: Request, res: Response) => {
    res.status(404).json({
      error: "Not found",
      path: req.path,
      availableEndpoints: [
        "GET /api/status",
        "GET /api/features",
        "GET /api/features?status=pending|in_progress|completed|failed",
        "GET /api/workers",
        "GET /api/workers/:featureId/output (SSE)",
        "GET /api/logs",
        "GET /api/logs?limit=N",
        "GET /api/stats",
        "GET /api/events (SSE)",
        "GET /health",
      ],
    });
  });

  // Start the server
  return new Promise((resolve, reject) => {
    const server = app.listen(port, host, () => {
      console.log(`Dashboard server running at http://${host}:${port}`);

      const dashboardServer: DashboardServer = {
        app,
        server,
        port,
        close: async () => {
          // Clean up SSE resources
          if (ssePollingInterval) {
            clearInterval(ssePollingInterval);
            ssePollingInterval = null;
          }
          // Close all SSE client connections
          for (const client of sseClients) {
            try {
              client.res.end();
            } catch (err) {
              // Ignore errors during cleanup
            }
          }
          sseClients.length = 0;

          return new Promise((resolveClose, rejectClose) => {
            server.close((err) => {
              if (err) {
                rejectClose(err);
              } else {
                resolveClose();
              }
            });
          });
        },
      };

      resolve(dashboardServer);
    });

    server.on("error", (err) => {
      reject(err);
    });
  });
}
