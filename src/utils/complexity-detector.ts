/**
 * Complexity Detector - Analyzes feature descriptions to determine complexity
 *
 * Used to decide whether a feature should trigger competitive planning mode
 * where two workers create competing implementation plans.
 *
 * Scoring algorithm:
 * - Description length (0-20 pts)
 * - Keywords: refactor, migrate, redesign, integrate (0-30 pts)
 * - Scope indicators: multiple, all, entire, system-wide (0-20 pts)
 * - Dependency count (0-15 pts)
 * - Inferred file/component mentions (0-15 pts)
 *
 * Threshold: score >= 60 triggers competitive planning
 */

import { Feature } from "../state/manager.js";

export interface ComplexitySignals {
  descriptionLength: number;
  keywordMatches: string[];
  scopeIndicators: string[];
  architecturalTerms: string[];
  uncertaintyIndicators: string[];
  dependencyCount: number;
  estimatedTouchPoints: number;
}

export interface ComplexityResult {
  score: number;
  isComplex: boolean;
  signals: ComplexitySignals;
  recommendation: "simple" | "competitive_planning" | "manual_review";
  breakdown: {
    lengthScore: number;
    keywordScore: number;
    scopeScore: number;
    dependencyScore: number;
    touchPointScore: number;
  };
}

// Keywords that indicate complex refactoring or restructuring work
const COMPLEXITY_KEYWORDS = [
  { pattern: /\brefactor(ing|ed|s)?\b/i, weight: 10 },
  { pattern: /\bmigrat(e|ing|ion)\b/i, weight: 10 },
  { pattern: /\bredesign(ing|ed)?\b/i, weight: 10 },
  { pattern: /\bintegrat(e|ing|ion)\b/i, weight: 8 },
  { pattern: /\brestructur(e|ing)\b/i, weight: 10 },
  { pattern: /\boverhaul(ing|ed)?\b/i, weight: 10 },
  { pattern: /\brewrite\b/i, weight: 8 },
  { pattern: /\barchitect(ure|ural)?\b/i, weight: 6 },
  { pattern: /\binfrastructure\b/i, weight: 6 },
  { pattern: /\bframework\b/i, weight: 5 },
];

// Scope indicators that suggest broad changes
const SCOPE_INDICATORS = [
  { pattern: /\bmultiple\b/i, weight: 5 },
  { pattern: /\ball\s+(the\s+)?(files?|components?|modules?|services?)\b/i, weight: 7 },
  { pattern: /\bentire\b/i, weight: 6 },
  { pattern: /\bsystem[- ]wide\b/i, weight: 8 },
  { pattern: /\bacross\s+(the\s+)?(codebase|project|application)\b/i, weight: 7 },
  { pattern: /\beverywhere\b/i, weight: 5 },
  { pattern: /\bglobal(ly)?\b/i, weight: 5 },
  { pattern: /\bproject[- ]wide\b/i, weight: 7 },
];

// Architectural terms that indicate complexity
const ARCHITECTURAL_TERMS = [
  { pattern: /\bapi\s+(design|layer|gateway)\b/i, weight: 5 },
  { pattern: /\bdatabase\s+(schema|migration|design)\b/i, weight: 6 },
  { pattern: /\bauthentication\b/i, weight: 5 },
  { pattern: /\bauthorization\b/i, weight: 5 },
  { pattern: /\bmicroservices?\b/i, weight: 6 },
  { pattern: /\bstate\s+management\b/i, weight: 5 },
  { pattern: /\bcaching\s+(layer|strategy)\b/i, weight: 5 },
  { pattern: /\breal[- ]time\b/i, weight: 4 },
];

// Uncertainty indicators that suggest the task needs careful planning
const UNCERTAINTY_INDICATORS = [
  { pattern: /\bcomplex\b/i, weight: 4 },
  { pattern: /\bchallenging\b/i, weight: 4 },
  { pattern: /\btricky\b/i, weight: 4 },
  { pattern: /\bcareful(ly)?\b/i, weight: 3 },
  { pattern: /\bdifficult\b/i, weight: 4 },
  { pattern: /\bcritical\b/i, weight: 5 },
  { pattern: /\bsensitive\b/i, weight: 4 },
];

// File/component patterns to estimate touch points
const TOUCH_POINT_PATTERNS = [
  /\b[\w\-\/]+\.(ts|js|tsx|jsx|json|md|py|rs|go|css|scss|html|vue|svelte)\b/gi,
  /\b(component|module|service|controller|handler|model|route|hook|context|store|page|layout)s?\b/gi,
  /\b(src|lib|app|components|pages|routes|api|services|utils|hooks)\/[\w\-\/]+/gi,
];

/**
 * Analyze feature complexity and determine if competitive planning is recommended
 */
export function analyzeComplexity(
  feature: Feature,
  threshold: number = 60
): ComplexityResult {
  const description = feature.description;
  const signals: ComplexitySignals = {
    descriptionLength: description.length,
    keywordMatches: [],
    scopeIndicators: [],
    architecturalTerms: [],
    uncertaintyIndicators: [],
    dependencyCount: feature.dependsOn?.length || 0,
    estimatedTouchPoints: 0,
  };

  // 1. Score based on description length (0-20 pts)
  // Short descriptions (< 50 chars) = 0, Long descriptions (> 200 chars) = 20
  const lengthScore = Math.min(20, Math.floor(description.length / 10));

  // 2. Score based on complexity keywords (0-30 pts, capped)
  let keywordScore = 0;
  for (const { pattern, weight } of COMPLEXITY_KEYWORDS) {
    const match = description.match(pattern);
    if (match) {
      signals.keywordMatches.push(match[0]);
      keywordScore += weight;
    }
  }
  keywordScore = Math.min(30, keywordScore);

  // 3. Score based on scope indicators (0-20 pts, capped)
  let scopeScore = 0;
  for (const { pattern, weight } of SCOPE_INDICATORS) {
    const match = description.match(pattern);
    if (match) {
      signals.scopeIndicators.push(match[0]);
      scopeScore += weight;
    }
  }

  // Add architectural terms to scope
  for (const { pattern, weight } of ARCHITECTURAL_TERMS) {
    const match = description.match(pattern);
    if (match) {
      signals.architecturalTerms.push(match[0]);
      scopeScore += Math.floor(weight / 2); // Half weight for architectural terms
    }
  }
  scopeScore = Math.min(20, scopeScore);

  // Track uncertainty indicators (informational, doesn't add to score directly)
  for (const { pattern } of UNCERTAINTY_INDICATORS) {
    const match = description.match(pattern);
    if (match) {
      signals.uncertaintyIndicators.push(match[0]);
    }
  }

  // 4. Score based on dependency count (0-15 pts)
  // 3 points per dependency, capped at 15
  const dependencyScore = Math.min(15, signals.dependencyCount * 3);

  // 5. Score based on estimated touch points (0-15 pts)
  const touchPoints = new Set<string>();
  for (const pattern of TOUCH_POINT_PATTERNS) {
    const matches = description.match(pattern) || [];
    for (const match of matches) {
      touchPoints.add(match.toLowerCase());
    }
  }
  signals.estimatedTouchPoints = touchPoints.size;
  // 3 points per touch point, capped at 15
  const touchPointScore = Math.min(15, touchPoints.size * 3);

  // Calculate total score
  const score =
    lengthScore + keywordScore + scopeScore + dependencyScore + touchPointScore;

  // Determine recommendation
  let recommendation: ComplexityResult["recommendation"];
  if (score >= threshold) {
    recommendation = "competitive_planning";
  } else if (score >= threshold * 0.7) {
    // 70% of threshold suggests manual review might be beneficial
    recommendation = "manual_review";
  } else {
    recommendation = "simple";
  }

  return {
    score,
    isComplex: score >= threshold,
    signals,
    recommendation,
    breakdown: {
      lengthScore,
      keywordScore,
      scopeScore,
      dependencyScore,
      touchPointScore,
    },
  };
}

/**
 * Format complexity result for display
 */
export function formatComplexityResult(result: ComplexityResult): string {
  const lines: string[] = [];

  lines.push(`Complexity Score: ${result.score}/100`);
  lines.push(`Recommendation: ${result.recommendation.replace(/_/g, " ")}`);
  lines.push("");
  lines.push("Breakdown:");
  lines.push(`  Description length: ${result.breakdown.lengthScore}/20`);
  lines.push(`  Keywords: ${result.breakdown.keywordScore}/30`);
  lines.push(`  Scope: ${result.breakdown.scopeScore}/20`);
  lines.push(`  Dependencies: ${result.breakdown.dependencyScore}/15`);
  lines.push(`  Touch points: ${result.breakdown.touchPointScore}/15`);

  if (result.signals.keywordMatches.length > 0) {
    lines.push("");
    lines.push(`Keywords found: ${result.signals.keywordMatches.join(", ")}`);
  }

  if (result.signals.scopeIndicators.length > 0) {
    lines.push(`Scope indicators: ${result.signals.scopeIndicators.join(", ")}`);
  }

  if (result.signals.architecturalTerms.length > 0) {
    lines.push(
      `Architectural terms: ${result.signals.architecturalTerms.join(", ")}`
    );
  }

  if (result.signals.uncertaintyIndicators.length > 0) {
    lines.push(
      `Uncertainty indicators: ${result.signals.uncertaintyIndicators.join(", ")}`
    );
  }

  return lines.join("\n");
}
