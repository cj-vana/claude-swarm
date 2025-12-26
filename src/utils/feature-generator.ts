/**
 * Feature Generator - Generates a feature list from a task description
 *
 * This is a simple placeholder that creates a basic feature structure.
 * In practice, Claude will typically provide the feature list explicitly
 * or the orchestrator_init tool can be called with existingFeatures.
 *
 * For more sophisticated decomposition, consider:
 * - Using Claude to analyze and decompose the task
 * - Implementing the MAKER paper's decomposition approach
 * - Adding domain-specific decomposition rules
 */

import { Feature } from "../state/manager.js";

/**
 * Generate a basic feature list from a task description
 *
 * This is intentionally simple - the real decomposition should be done by Claude
 * before calling orchestrator_init with the existingFeatures parameter.
 */
export function generateFeatureList(taskDescription: string): Feature[] {
  // This is a placeholder - in real usage, Claude should decompose the task
  // and pass the features explicitly via existingFeatures parameter

  const lines = taskDescription.split("\n").filter(line => {
    const trimmed = line.trim();
    // Look for numbered items, bullet points, or feature-like descriptions
    return (
      trimmed.match(/^\d+[\.\)]\s*/) ||  // 1. or 1) - space optional
      trimmed.match(/^[-*]\s*/) ||        // - or * - space optional
      trimmed.match(/^(?:feature|implement|add|create|build|fix|update):/i)
    );
  });

  if (lines.length > 0) {
    return lines.map((line, i) => ({
      id: `feature-${i + 1}`,
      description: line
        .replace(/^[\d\.\)\-\*\s]+/, "")  // Remove numbers, bullets
        .replace(/^(?:feature|implement|add|create|build|fix|update):\s*/i, "")  // Remove keyword prefixes
        .trim(),
      status: "pending" as const,
      attempts: 0,
    }));
  }

  // If no structured features found, create a single feature for the whole task
  return [{
    id: "feature-1",
    description: taskDescription.slice(0, 200) + (taskDescription.length > 200 ? "..." : ""),
    status: "pending" as const,
    attempts: 0,
  }];
}

/**
 * Suggested prompt for Claude to decompose a task into features
 * Can be used in the skill to guide Claude's decomposition
 */
export const DECOMPOSITION_PROMPT = `
Analyze the following task and break it down into discrete, implementable features.
Each feature should be:
1. Small enough to complete in a single focused session (15-60 minutes of work)
2. Independently testable
3. Clearly defined with specific acceptance criteria

Return the features as a numbered list, with each feature on its own line.
Focus on the "what" not the "how" - implementation details will be determined by the worker.

Example format:
1. Create user authentication endpoint with JWT token generation
2. Add password hashing using bcrypt
3. Implement login form with email/password fields
4. Add session persistence using cookies
5. Create logout endpoint and clear session

Task to decompose:
`;
