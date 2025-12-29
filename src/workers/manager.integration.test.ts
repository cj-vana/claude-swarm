import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { WorkerManager } from "./manager.js";
import { StateManager, Feature } from "../state/manager.js";
import * as fs from "fs";
import * as path from "path";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);


// Polling utility for reliable async waits
const pollWithTimeout = async (
  condition: () => Promise<boolean>,
  timeout: number = 5000,
  interval: number = 50
): Promise<void> => {
  const startTime = Date.now();
  while (Date.now() - startTime < timeout) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  throw new Error(`Condition not met within ${timeout}ms`);
};


// Integration tests that actually use tmux
describe("WorkerManager Integration Tests", () => {
  let workerManager: WorkerManager;
  let mockStateManager: StateManager;
  let testDir: string;
  let activeSessions: string[] = [];

  beforeEach(() => {
    // Create temp directory for test
    testDir = `/tmp/swarm-test-${Date.now()}`;
    fs.mkdirSync(testDir, { recursive: true });

    // Create .claude/orchestrator/workers directory
    const workerDir = path.join(testDir, ".claude/orchestrator/workers");
    fs.mkdirSync(workerDir, { recursive: true });

    mockStateManager = {
      load: () => ({
        taskDescription: "Test task for integration",
        features: [
          {
            id: "test-feature-1",
            description: "Print hello world and create done file",
            status: "pending",
            attempts: 0,
          },
        ],
        status: "in_progress",
        createdAt: new Date().toISOString(),
      }),
      save: () => {},
    } as any;

    workerManager = new WorkerManager(testDir, mockStateManager);
  });

  afterEach(async () => {
    // Kill all test sessions
    for (const session of activeSessions) {
      try {
        await execFileAsync("tmux", ["kill-session", "-t", session]);
      } catch {
        // Session might already be dead
      }
    }
    activeSessions = [];

    // Clean up test directory
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe("tmux integration", () => {
    it("should verify tmux is installed", async () => {
      const { stdout } = await execFileAsync("which", ["tmux"]);
      expect(stdout.trim()).toContain("tmux");
    });

    it("should start a real tmux session", async () => {
      const feature: Feature = {
        id: "test-feature-1",
        description: "Test feature",
        status: "pending",
        attempts: 0,
      };

      const result = await workerManager.startWorker(feature);

      expect(result.success).toBe(true);
      expect(result.sessionName).toMatch(/^cc-worker-test-feature-1-/);

      if (result.sessionName) {
        activeSessions.push(result.sessionName);

        // Verify session exists
        const { stdout } = await execFileAsync("tmux", ["list-sessions"]);
        expect(stdout).toContain(result.sessionName);
      }
    });

    it("should create worker files when starting", async () => {
      const feature: Feature = {
        id: "test-feature-2",
        description: "Test worker files",
        status: "pending",
        attempts: 0,
      };

      const result = await workerManager.startWorker(feature);
      expect(result.success).toBe(true);

      if (result.sessionName) {
        activeSessions.push(result.sessionName);
      }

      const workerDir = path.join(testDir, ".claude/orchestrator/workers");

      // Check prompt file exists
      const promptFile = path.join(workerDir, "test-feature-2.prompt");
      expect(fs.existsSync(promptFile)).toBe(true);

      const promptContent = fs.readFileSync(promptFile, "utf-8");
      expect(promptContent).toContain("You are a worker agent");
      expect(promptContent).toContain("Test worker files");

      // Check status file exists
      const statusFile = path.join(workerDir, "test-feature-2.status");
      expect(fs.existsSync(statusFile)).toBe(true);

      const statusContent = JSON.parse(fs.readFileSync(statusFile, "utf-8"));
      expect(statusContent.status).toBe("running");
      expect(statusContent.featureId).toBe("test-feature-2");

      // Check wrapper script exists
      const scriptFile = path.join(workerDir, "test-feature-2.sh");
      expect(fs.existsSync(scriptFile)).toBe(true);
    });

    it("should check worker status for running session", async () => {
      const feature: Feature = {
        id: "test-feature-3",
        description: "Test status check",
        status: "pending",
        attempts: 0,
      };

      const startResult = await workerManager.startWorker(feature);
      expect(startResult.success).toBe(true);

      if (startResult.sessionName) {
        activeSessions.push(startResult.sessionName);

        // Give worker a moment to initialize
        await pollWithTimeout(
          async () => (await workerManager.checkWorker(startResult.sessionName)).status === 'running',
          5000,
          100
        );

        const checkResult = await workerManager.checkWorker(
          startResult.sessionName
        );

        expect(checkResult.status).toBe("running");
        expect(checkResult.output).toBeDefined();
      }
    });

    it("should kill a running worker", async () => {
      const feature: Feature = {
        id: "test-feature-4",
        description: "Test kill worker",
        status: "pending",
        attempts: 0,
      };

      const startResult = await workerManager.startWorker(feature);
      expect(startResult.success).toBe(true);

      if (startResult.sessionName) {
        // Verify session exists
        const { stdout: before } = await execFileAsync("tmux", [
          "list-sessions",
        ]);
        expect(before).toContain(startResult.sessionName);

        // Kill it
        await workerManager.killWorker(startResult.sessionName);

        // Give tmux a moment to process
        await pollWithTimeout(
          async () => {
            try {
              await execFileAsync('tmux', ['list-sessions']);
              return true; // Session processed
            } catch {
              return false; // No sessions yet
            }
          },
          5000,
          50
        );

        // Verify session is gone
        try {
          const { stdout: after } = await execFileAsync("tmux", [
            "list-sessions",
          ]);
          expect(after).not.toContain(startResult.sessionName);
        } catch (error: any) {
          // If no sessions exist, tmux returns error - that's fine
          if (!error.message.includes("no server running")) {
            throw error;
          }
        }
      }
    });

    it("should detect completed worker via done file", async () => {
      const feature: Feature = {
        id: "test-feature-5",
        description: "Test completion detection",
        status: "pending",
        attempts: 0,
      };

      const startResult = await workerManager.startWorker(feature);
      expect(startResult.success).toBe(true);

      if (startResult.sessionName) {
        activeSessions.push(startResult.sessionName);

        // Simulate worker completion by creating done file
        const doneFile = path.join(
          testDir,
          ".claude/orchestrator/workers/test-feature-5.done"
        );
        fs.writeFileSync(
          doneFile,
          "Feature completed successfully\n\nFiles modified:\n- test.ts"
        );

        // Kill the session to simulate worker exit
        await workerManager.killWorker(startResult.sessionName);
        await pollWithTimeout(
          async () => {
            try {
              await execFileAsync('tmux', ['list-sessions']);
              return true;
            } catch {
              return false;
            }
          },
          5000,
          50
        );

        // Check status
        const checkResult = await workerManager.checkWorker(
          startResult.sessionName
        );

        expect(checkResult.status).toBe("completed");
        expect(checkResult.output).toContain("Feature completed successfully");
      }
    });

    it("should detect crashed worker without done file", async () => {
      const feature: Feature = {
        id: "test-feature-6",
        description: "Test crash detection",
        status: "pending",
        attempts: 0,
      };

      const startResult = await workerManager.startWorker(feature);
      expect(startResult.success).toBe(true);

      if (startResult.sessionName) {
        // Write some log content
        const logFile = path.join(
          testDir,
          ".claude/orchestrator/workers/test-feature-6.log"
        );
        fs.writeFileSync(logFile, "Worker started\nSome output\nError occurred");

        // Kill session without creating done file
        await workerManager.killWorker(startResult.sessionName);
        await pollWithTimeout(
          async () => {
            try {
              await execFileAsync('tmux', ['list-sessions']);
              return true;
            } catch {
              return false;
            }
          },
          5000,
          50
        );

        const checkResult = await workerManager.checkWorker(
          startResult.sessionName
        );

        expect(checkResult.status).toBe("crashed");
        expect(checkResult.output).toContain("Worker session ended unexpectedly");
      }
    });

    it("should get heartbeat info from running worker", async () => {
      const feature: Feature = {
        id: "test-feature-7",
        description: "Test heartbeat",
        status: "pending",
        attempts: 0,
      };

      const startResult = await workerManager.startWorker(feature);
      expect(startResult.success).toBe(true);

      if (startResult.sessionName) {
        activeSessions.push(startResult.sessionName);

        // Simulate some worker activity in log
        const logFile = path.join(
          testDir,
          ".claude/orchestrator/workers/test-feature-7.log"
        );
        fs.writeFileSync(
          logFile,
          "Using Read tool to examine src/app.ts\nEdit tool modified src/utils.ts"
        );

        const heartbeat = await workerManager.getHeartbeatInfo(
          startResult.sessionName,
          new Date().toISOString()
        );

        expect(heartbeat.status).toBe("running");
        expect(heartbeat.lastToolUsed).toBe("Edit");
        // File path regex extracts without src/ prefix
        expect(heartbeat.filesModified).toContain("/utils.ts");
        expect(heartbeat.runningFor).toBeDefined();
        expect(heartbeat.linesWritten).toBeGreaterThan(0);
      }
    });

    it("should support custom prompts", async () => {
      const feature: Feature = {
        id: "test-feature-8",
        description: "Test custom prompt",
        status: "pending",
        attempts: 0,
      };

      const customPrompt = "Additional context: Use TypeScript strict mode";

      const result = await workerManager.startWorker(feature, customPrompt);
      expect(result.success).toBe(true);

      if (result.sessionName) {
        activeSessions.push(result.sessionName);

        const promptFile = path.join(
          testDir,
          ".claude/orchestrator/workers/test-feature-8.prompt"
        );
        const promptContent = fs.readFileSync(promptFile, "utf-8");
        expect(promptContent).toContain(customPrompt);
      }
    });

    it("should support different models", async () => {
      const feature: Feature = {
        id: "test-feature-9",
        description: "Test model selection",
        status: "pending",
        attempts: 0,
      };

      const result = await workerManager.startWorker(
        feature,
        undefined,
        "haiku"
      );
      expect(result.success).toBe(true);

      if (result.sessionName) {
        activeSessions.push(result.sessionName);

        const scriptFile = path.join(
          testDir,
          ".claude/orchestrator/workers/test-feature-9.sh"
        );
        const scriptContent = fs.readFileSync(scriptFile, "utf-8");
        expect(scriptContent).toContain("--model claude-haiku-4-5");
      }
    });

    it("should validate feature IDs before starting", async () => {
      const invalidFeature: Feature = {
        id: "invalid feature id with spaces",
        description: "Should fail",
        status: "pending",
        attempts: 0,
      };

      const result = await workerManager.startWorker(invalidFeature);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Invalid feature ID");
    });

    it("should handle starting planner workers", async () => {
      const feature: Feature = {
        id: "test-feature-10",
        description: "Test planner mode",
        status: "pending",
        attempts: 0,
      };

      const result = await workerManager.startPlannerWorker(feature, "A");
      expect(result.success).toBe(true);
      expect(result.sessionName).toMatch(/^cc-planner-test-feature-10-a-/);

      if (result.sessionName) {
        activeSessions.push(result.sessionName);

        // Verify planner-specific files
        const promptFile = path.join(
          testDir,
          ".claude/orchestrator/workers/test-feature-10.planner-a.prompt"
        );
        expect(fs.existsSync(promptFile)).toBe(true);

        const promptContent = fs.readFileSync(promptFile, "utf-8");
        expect(promptContent).toContain("planning agent");
        expect(promptContent).toContain("DO NOT implement any code");
      }
    });
  });
});
