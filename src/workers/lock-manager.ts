/**
 * Task Lock Manager - File-based mutual exclusion for parallel workers
 *
 * Prevents two workers from modifying the same files simultaneously.
 * Uses atomic file creation (O_CREAT | O_EXCL) to prevent races.
 *
 * Inspired by the "current_tasks/" locking pattern from
 * "Building a C compiler with parallel Claudes" where agents claim
 * tasks by writing lock files.
 */

import * as fs from "fs";
import * as path from "path";
import { validateFeatureId } from "../utils/security.js";

export interface FileLock {
  featureId: string;
  path: string;
  lockedAt: string;
  workerSession: string;
}

export interface LockResult {
  claimed: string[];
  conflicts: Array<{ file: string; heldBy: string }>;
}

export class TaskLockManager {
  private lockDir: string;

  constructor(projectDir: string) {
    this.lockDir = path.join(projectDir, ".claude", "orchestrator", "locks");
    fs.mkdirSync(this.lockDir, { recursive: true });
  }

  /**
   * Claim files for a feature. Returns list of successfully claimed files and conflicts.
   * Uses atomic file creation (O_CREAT | O_EXCL) to prevent race conditions.
   */
  claimFiles(featureId: string, files: string[], session: string): LockResult {
    validateFeatureId(featureId);

    const claimed: string[] = [];
    const conflicts: Array<{ file: string; heldBy: string }> = [];

    for (const file of files) {
      const lockFile = path.join(this.lockDir, this.fileToLockName(file));
      try {
        // Atomic create - fails if file already exists
        const fd = fs.openSync(
          lockFile,
          fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY
        );
        const lock: FileLock = {
          featureId,
          path: file,
          lockedAt: new Date().toISOString(),
          workerSession: session,
        };
        fs.writeSync(fd, JSON.stringify(lock));
        fs.closeSync(fd);
        claimed.push(file);
      } catch {
        // Lock file already exists - read who owns it
        try {
          const existing: FileLock = JSON.parse(
            fs.readFileSync(lockFile, "utf-8")
          );
          conflicts.push({ file, heldBy: existing.featureId });
        } catch {
          conflicts.push({ file, heldBy: "unknown" });
        }
      }
    }

    return { claimed, conflicts };
  }

  /**
   * Release all locks held by a feature.
   * Returns the number of locks released.
   */
  releaseAll(featureId: string): number {
    validateFeatureId(featureId);

    let released = 0;

    if (!fs.existsSync(this.lockDir)) return 0;

    const lockFiles = fs.readdirSync(this.lockDir).filter((f) => f.endsWith(".lock"));

    for (const lockFile of lockFiles) {
      const lockPath = path.join(this.lockDir, lockFile);
      try {
        const lock: FileLock = JSON.parse(fs.readFileSync(lockPath, "utf-8"));
        if (lock.featureId === featureId) {
          fs.unlinkSync(lockPath);
          released++;
        }
      } catch {
        // Corrupted lock file - skip
      }
    }

    return released;
  }

  /**
   * List all active locks.
   */
  listLocks(): FileLock[] {
    const locks: FileLock[] = [];

    if (!fs.existsSync(this.lockDir)) return locks;

    const lockFiles = fs.readdirSync(this.lockDir).filter((f) => f.endsWith(".lock"));

    for (const lockFile of lockFiles) {
      try {
        const lock: FileLock = JSON.parse(
          fs.readFileSync(path.join(this.lockDir, lockFile), "utf-8")
        );
        locks.push(lock);
      } catch {
        // Skip corrupted lock files
      }
    }

    return locks;
  }

  /**
   * Clear all locks. Used during orchestrator_reset.
   */
  clearAll(): number {
    let cleared = 0;

    if (!fs.existsSync(this.lockDir)) return 0;

    const lockFiles = fs.readdirSync(this.lockDir).filter((f) => f.endsWith(".lock"));

    for (const lockFile of lockFiles) {
      try {
        fs.unlinkSync(path.join(this.lockDir, lockFile));
        cleared++;
      } catch {
        // Skip
      }
    }

    return cleared;
  }

  /**
   * Convert a file path to a safe lock filename.
   * Replaces path separators with double underscores.
   */
  private fileToLockName(filePath: string): string {
    return filePath.replace(/[/\\]/g, "__") + ".lock";
  }
}
