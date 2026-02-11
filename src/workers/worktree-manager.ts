/**
 * Worktree Manager - Git worktree-based isolation for parallel workers
 *
 * Each worker gets its own git worktree, eliminating shared-directory conflicts.
 * Worktrees share .git/objects with the main repo (lightweight, instant creation)
 * but have their own working directory and index.
 *
 * Inspired by the "Building a C compiler with parallel Claudes" pattern where
 * each agent operates in its own Docker container with a separate git clone.
 * Git worktrees achieve the same isolation with zero overhead.
 */

import { execFile } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as path from "path";
import { validateFeatureId } from "../utils/security.js";

const execFileAsync = promisify(execFile);

export interface WorktreeInfo {
  worktreePath: string;
  branch: string;
}

export interface MergeResult {
  success: boolean;
  conflicts?: string[];
  mergeCommit?: string;
}

export class WorktreeManager {
  private projectDir: string;
  private worktreeBaseDir: string;

  constructor(projectDir: string) {
    this.projectDir = projectDir;
    this.worktreeBaseDir = path.join(projectDir, ".claude", "worktrees");
  }

  /**
   * Create a worktree for a feature.
   * Creates a branch from current HEAD and checks it out in a new worktree directory.
   */
  async createWorktree(featureId: string): Promise<WorktreeInfo> {
    validateFeatureId(featureId);

    const branch = `swarm/work/${featureId}`;
    const worktreePath = path.join(this.worktreeBaseDir, featureId);

    // Ensure base directory exists
    fs.mkdirSync(this.worktreeBaseDir, { recursive: true });

    // Clean up stale worktree if it exists
    await this.removeWorktree(featureId);

    // Delete branch if it exists from a previous run
    try {
      await execFileAsync("git", ["branch", "-D", branch], { cwd: this.projectDir });
    } catch {
      // Branch doesn't exist, that's fine
    }

    // Create worktree with a new branch from HEAD
    await execFileAsync("git", ["worktree", "add", "-b", branch, worktreePath, "HEAD"], {
      cwd: this.projectDir,
    });

    return { worktreePath, branch };
  }

  /**
   * Merge a worktree's branch back into the current branch.
   * Called after worker completion, before cleanup.
   */
  async mergeWorktree(featureId: string): Promise<MergeResult> {
    validateFeatureId(featureId);

    const branch = `swarm/work/${featureId}`;

    try {
      const { stdout } = await execFileAsync(
        "git",
        ["merge", "--no-ff", branch, "-m", `merge: swarm worker ${featureId}`],
        { cwd: this.projectDir }
      );

      // Extract merge commit hash
      let mergeCommit: string | undefined;
      try {
        const { stdout: hash } = await execFileAsync("git", ["rev-parse", "HEAD"], {
          cwd: this.projectDir,
        });
        mergeCommit = hash.trim();
      } catch {
        // Non-fatal
      }

      return { success: true, mergeCommit };
    } catch (error: any) {
      // Merge conflict - identify conflicting files
      let conflicts: string[] = [];
      try {
        const { stdout } = await execFileAsync(
          "git",
          ["diff", "--name-only", "--diff-filter=U"],
          { cwd: this.projectDir }
        );
        conflicts = stdout
          .trim()
          .split("\n")
          .filter((f) => f);
      } catch {
        // Can't determine conflicts
      }

      // Abort the failed merge
      try {
        await execFileAsync("git", ["merge", "--abort"], { cwd: this.projectDir });
      } catch {
        // Merge may not be in progress
      }

      return { success: false, conflicts };
    }
  }

  /**
   * Remove a worktree and optionally its branch.
   */
  async removeWorktree(featureId: string, removeBranch = true): Promise<void> {
    validateFeatureId(featureId);

    const worktreePath = path.join(this.worktreeBaseDir, featureId);
    const branch = `swarm/work/${featureId}`;

    // Remove the worktree
    try {
      await execFileAsync("git", ["worktree", "remove", "--force", worktreePath], {
        cwd: this.projectDir,
      });
    } catch {
      // Worktree doesn't exist or already removed
      // Try manual cleanup if directory still exists
      if (fs.existsSync(worktreePath)) {
        fs.rmSync(worktreePath, { recursive: true, force: true });
      }
    }

    // Prune worktree references
    try {
      await execFileAsync("git", ["worktree", "prune"], { cwd: this.projectDir });
    } catch {
      // Non-fatal
    }

    // Remove the branch
    if (removeBranch) {
      try {
        await execFileAsync("git", ["branch", "-D", branch], { cwd: this.projectDir });
      } catch {
        // Branch doesn't exist or already deleted
      }
    }
  }

  /**
   * List all active swarm worktrees.
   */
  async listWorktrees(): Promise<WorktreeInfo[]> {
    const results: WorktreeInfo[] = [];

    try {
      const { stdout } = await execFileAsync("git", ["worktree", "list", "--porcelain"], {
        cwd: this.projectDir,
      });

      // Parse porcelain output: each worktree is separated by blank lines
      const entries = stdout.split("\n\n").filter((e) => e.trim());
      for (const entry of entries) {
        const lines = entry.split("\n");
        const worktreeLine = lines.find((l) => l.startsWith("worktree "));
        const branchLine = lines.find((l) => l.startsWith("branch "));

        if (worktreeLine && branchLine) {
          const worktreePath = worktreeLine.replace("worktree ", "");
          const branch = branchLine.replace("branch refs/heads/", "");

          // Only include swarm worktrees
          if (branch.startsWith("swarm/work/")) {
            results.push({ worktreePath, branch });
          }
        }
      }
    } catch {
      // Not a git repo or git not available
    }

    return results;
  }

  /**
   * Clean up all swarm worktrees.
   * Returns the number of worktrees removed.
   */
  async cleanupAll(): Promise<number> {
    const worktrees = await this.listWorktrees();
    let count = 0;

    for (const wt of worktrees) {
      const featureId = wt.branch.replace("swarm/work/", "");
      try {
        await this.removeWorktree(featureId);
        count++;
      } catch {
        // Best-effort cleanup
      }
    }

    // Also remove the base directory if empty
    try {
      if (fs.existsSync(this.worktreeBaseDir)) {
        const remaining = fs.readdirSync(this.worktreeBaseDir);
        if (remaining.length === 0) {
          fs.rmdirSync(this.worktreeBaseDir);
        }
      }
    } catch {
      // Non-fatal
    }

    return count;
  }

  /**
   * Check if git worktrees are supported in this project.
   * Returns false for non-git directories.
   */
  async isAvailable(): Promise<boolean> {
    try {
      await execFileAsync("git", ["rev-parse", "--git-dir"], { cwd: this.projectDir });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get files modified in a worktree branch relative to where it branched from.
   */
  async getModifiedFiles(featureId: string): Promise<string[]> {
    validateFeatureId(featureId);

    const branch = `swarm/work/${featureId}`;

    try {
      // Find the merge-base (where the branch diverged)
      const { stdout: mergeBase } = await execFileAsync(
        "git",
        ["merge-base", "HEAD", branch],
        { cwd: this.projectDir }
      );

      const { stdout } = await execFileAsync(
        "git",
        ["diff", "--name-only", mergeBase.trim(), branch],
        { cwd: this.projectDir }
      );

      return stdout
        .trim()
        .split("\n")
        .filter((f) => f);
    } catch {
      return [];
    }
  }
}
