/**
 * Ralph Loop - Fresh context per iteration for long-running autonomy
 *
 * Implements the Ralph Loop pattern where each iteration of work gets a fresh
 * Claude session with state loaded from the filesystem (progress files, git diff).
 * This eliminates context rot that occurs in long-running single sessions.
 *
 * Inspired by:
 * - Ralph Loop pattern (https://www.alibabacloud.com/blog/from-react-to-ralph-loop-a-continuous-iteration-paradigm-for-ai-agents_602799)
 * - Anthropic's "Effective harnesses for long-running agents"
 *
 * Key differences from startContinuousWorker:
 * - Each iteration is a FRESH Claude session (no context rot)
 * - State persists via filesystem: progress.md, git history, .done files
 * - Prompt re-reads current state each iteration (self-reloading context)
 * - Configurable stopping conditions (marker, time, iterations)
 * - Git diff injected into prompt so worker sees what changed
 */

import * as path from "path";
import { shellQuote } from "../utils/security.js";

/**
 * RalphLoopOptions - Configuration for a Ralph Loop execution
 */
export interface RalphLoopOptions {
  maxIterations: number;        // default: 50
  maxDurationMinutes: number;   // default: 480 (8 hours)
  stopOnComplete: boolean;      // default: true
  verifyBeforeStop: boolean;    // default: true
  progressFile: string;         // default: .claude/orchestrator/workers/{id}.progress.md
}

/**
 * Default Ralph Loop options
 */
export const DEFAULT_RALPH_OPTIONS: RalphLoopOptions = {
  maxIterations: 50,
  maxDurationMinutes: 480,
  stopOnComplete: true,
  verifyBeforeStop: true,
  progressFile: "", // Set dynamically per feature
};

/**
 * Build the Ralph Loop wrapper script that runs an external bash loop,
 * launching a fresh Claude session per iteration with filesystem-based state.
 */
export function buildRalphLoopScript(options: {
  featureId: string;
  promptFile: string;
  progressFile: string;
  doneFile: string;
  logFile: string;
  workingDir: string;
  workerFlags: string;
  maxIterations: number;
  maxDurationSeconds: number;
}): string {
  const {
    featureId,
    promptFile,
    progressFile,
    doneFile,
    logFile,
    workingDir,
    workerFlags,
    maxIterations,
    maxDurationSeconds,
  } = options;

  return `#!/bin/bash
# Ralph Loop wrapper for feature: ${featureId}
# Each iteration launches a fresh Claude session with filesystem-based state
set -euo pipefail

ITERATION=0
MAX_ITERATIONS=${maxIterations}
START_TIME=$(date +%s)
MAX_DURATION=${maxDurationSeconds}
FEATURE_ID=${shellQuote(featureId)}
PROGRESS_FILE=${shellQuote(progressFile)}
PROMPT_FILE=${shellQuote(promptFile)}
DONE_FILE=${shellQuote(doneFile)}
WORKING_DIR=${shellQuote(workingDir)}
LOG_FILE=${shellQuote(logFile)}

cd "$WORKING_DIR"

# Initialize progress file if it doesn't exist
if [ ! -f "$PROGRESS_FILE" ]; then
  cat > "$PROGRESS_FILE" << 'PROGRESS_EOF'
# Progress: ${featureId}

## Completed Steps
(none yet)

## Current Focus
- Starting implementation

## Issues Encountered
(none yet)

## Files Modified
(none yet)
PROGRESS_EOF
fi

echo "[$(date -Iseconds)] Ralph Loop started for $FEATURE_ID (max iterations: $MAX_ITERATIONS, max duration: ${maxDurationSeconds}s)" >> "$LOG_FILE"

while [ $ITERATION -lt $MAX_ITERATIONS ]; do
  ITERATION=$((ITERATION + 1))
  ELAPSED=$(( $(date +%s) - START_TIME ))

  # Time limit check
  if [ $ELAPSED -ge $MAX_DURATION ]; then
    echo "[$(date -Iseconds)] TIME_LIMIT_REACHED after $ITERATION iterations ($ELAPSED seconds)" >> "$LOG_FILE"
    echo "" >> "$PROGRESS_FILE"
    echo "## Session End" >> "$PROGRESS_FILE"
    echo "Time limit reached after $ITERATION iterations" >> "$PROGRESS_FILE"
    break
  fi

  echo "[$(date -Iseconds)] Starting iteration $ITERATION/$MAX_ITERATIONS" >> "$LOG_FILE"

  # Build iteration-aware prompt (reads current state from filesystem)
  ITER_PROMPT=$(cat "$PROMPT_FILE")

  # Append current state context
  ITER_PROMPT="$ITER_PROMPT

## Current State (Iteration $ITERATION of $MAX_ITERATIONS)

### Progress So Far
$(cat "$PROGRESS_FILE" 2>/dev/null || echo 'First iteration - no prior progress.')

### Git Status
\`\`\`
$(cd "$WORKING_DIR" && git diff --stat HEAD 2>/dev/null || echo 'No changes yet.')
\`\`\`

### Recent Git Log
\`\`\`
$(cd "$WORKING_DIR" && git log --oneline -5 2>/dev/null || echo 'No commits yet.')
\`\`\`

## Iteration Instructions
- This is iteration $ITERATION. You have a FRESH context - all prior state is in the progress file above.
- UPDATE the progress file at $PROGRESS_FILE after completing work:
  - Mark completed steps with [x]
  - Add new steps as needed
  - Document any issues encountered
  - List files you modified
- When the feature is FULLY COMPLETE:
  1. Create a .done file at: $DONE_FILE with a summary of what was implemented
  2. Commit all changes
- If NOT complete, just update the progress file - another iteration will continue your work.
"

  # Write iteration prompt to temp file
  ITER_PROMPT_FILE="${promptFile}.iter$ITERATION"
  echo "$ITER_PROMPT" > "$ITER_PROMPT_FILE"
  chmod 600 "$ITER_PROMPT_FILE"

  # Run Claude with fresh context
  ITER_LOG="${logFile}.iter$ITERATION"
  if command -v claude-code &> /dev/null; then
    claude-code ${workerFlags} -p "$(cat "$ITER_PROMPT_FILE")" 2>&1 | tee "$ITER_LOG" >> "$LOG_FILE" || true
  else
    claude ${workerFlags} -p "$(cat "$ITER_PROMPT_FILE")" 2>&1 | tee "$ITER_LOG" >> "$LOG_FILE" || true
  fi

  # Clean up iteration prompt file
  rm -f "$ITER_PROMPT_FILE"

  echo "[$(date -Iseconds)] Iteration $ITERATION completed" >> "$LOG_FILE"

  # Check for completion marker (.done file)
  if [ -f "$DONE_FILE" ]; then
    echo "[$(date -Iseconds)] FEATURE_COMPLETE at iteration $ITERATION" >> "$LOG_FILE"
    echo "" >> "$PROGRESS_FILE"
    echo "## Completion" >> "$PROGRESS_FILE"
    echo "Feature completed at iteration $ITERATION" >> "$PROGRESS_FILE"
    break
  fi

  # Brief pause between iterations to avoid hammering
  sleep 2
done

echo "[$(date -Iseconds)] RALPH_LOOP_EXITED iterations=$ITERATION" >> "$LOG_FILE"
`;
}

/**
 * Parse a Ralph Loop progress file to extract structured information
 */
export function parseProgressFile(content: string): {
  completedSteps: string[];
  currentFocus: string[];
  issues: string[];
  filesModified: string[];
} {
  const result = {
    completedSteps: [] as string[],
    currentFocus: [] as string[],
    issues: [] as string[],
    filesModified: [] as string[],
  };

  let currentSection = "";

  for (const line of content.split("\n")) {
    const trimmed = line.trim();

    if (trimmed.startsWith("## Completed Steps")) {
      currentSection = "completed";
    } else if (trimmed.startsWith("## Current Focus")) {
      currentSection = "focus";
    } else if (trimmed.startsWith("## Issues Encountered")) {
      currentSection = "issues";
    } else if (trimmed.startsWith("## Files Modified")) {
      currentSection = "files";
    } else if (trimmed.startsWith("## ")) {
      currentSection = "";
    } else if (trimmed.startsWith("- [x]") || trimmed.startsWith("- [X]")) {
      if (currentSection === "completed") {
        result.completedSteps.push(trimmed.substring(5).trim());
      }
    } else if (trimmed.startsWith("- [ ]")) {
      if (currentSection === "focus") {
        result.currentFocus.push(trimmed.substring(5).trim());
      }
    } else if (trimmed.startsWith("- ")) {
      const text = trimmed.substring(2).trim();
      if (text && text !== "(none yet)") {
        switch (currentSection) {
          case "completed":
            result.completedSteps.push(text);
            break;
          case "focus":
            result.currentFocus.push(text);
            break;
          case "issues":
            result.issues.push(text);
            break;
          case "files":
            result.filesModified.push(text);
            break;
        }
      }
    }
  }

  return result;
}
