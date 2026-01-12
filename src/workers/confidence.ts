/**
 * Confidence Scoring System - Multi-signal worker confidence monitoring
 *
 * Combines three signals to produce a confidence score (0-100):
 * 1. Tool Activity Patterns (35%): Read→Edit→Test cycles, stuck loops, idle periods
 * 2. Self-Reported Confidence (35%): Worker writes to .confidence file
 * 3. Output Analysis (30%): Error patterns, success indicators, frustration signals
 *
 * Alerts the orchestrator when confidence drops below threshold.
 */

import * as fs from "fs";
import * as path from "path";

export interface ToolActivityScore {
  score: number;
  patterns: {
    healthyCycles: number;
    stuckLoops: number;
    idlePeriods: number;
    errorRecoveries: number;
  };
  lastActivityAge: number; // seconds since last activity
}

export interface OutputAnalysisScore {
  score: number;
  indicators: {
    errorCount: number;
    retryCount: number;
    successIndicators: number;
    frustrationIndicators: number;
    completionIndicators: number;
  };
}

export interface ConfidenceSignals {
  toolActivity: ToolActivityScore;
  selfReported: number | null;
  outputAnalysis: OutputAnalysisScore;
}

export interface ConfidenceAlert {
  type:
    | "idle"
    | "stuck_loop"
    | "high_errors"
    | "self_reported_low"
    | "declining_trend";
  message: string;
  severity: "warning" | "critical";
  timestamp: string;
}

export interface AggregatedConfidence {
  score: number;
  level: "high" | "medium" | "low" | "critical";
  signals: ConfidenceSignals;
  trend: "improving" | "stable" | "declining";
  alerts: ConfidenceAlert[];
}

// Pattern matching for healthy tool cycles
const HEALTHY_PATTERNS = [
  /Read.*Edit.*(?:test|build|npm|pytest|cargo)/i, // Read-Edit-Test
  /Glob.*Read.*Edit/i, // Search-Read-Edit
  /Edit.*Bash.*(?:test|npm run|pytest)/i, // Edit-Verify
  /Write.*Bash.*(?:test|build)/i, // Write-Test
];

// Pattern matching for concerning behaviors
const CONCERNING_PATTERNS = {
  stuckLoop: [
    /Read.*Read.*Read.*Read/i, // Multiple reads without action
    /Glob.*Glob.*Glob/i, // Multiple searches without progress
  ],
  // Error patterns - pre-compiled with 'gi' flags for global counting
  errors: [
    /\berror[:\s]/gi,
    /\bfailed\b/gi,
    /\bexception\b/gi,
    /\bcannot\b/gi,
    /\bunable to\b/gi,
    /exit code: [1-9]/gi,
    /ENOENT/gi,
    /undefined.*not.*defined/gi,
  ],
  // Retry patterns - pre-compiled with 'gi' flags for global counting
  retries: [/trying again/gi, /retrying/gi, /attempt \d+/gi, /let me try/gi],
  frustration: [
    /I('m| am) stuck/i,
    /not working/i,
    /I('m| am) confused/i,
    /I don't understand/i,
    /this is (?:difficult|challenging|hard)/i,
    /I can't figure/i,
    /doesn't seem to work/i,
  ],
};

// Pattern matching for positive signals
const POSITIVE_PATTERNS = {
  success: [
    /successfully/i,
    /completed/i,
    /tests? pass/i,
    /no errors/i,
    /build succeeded/i,
    /\u2713|\u2705|done/i, // Checkmarks
  ],
  completion: [
    /feature (?:is )?complete/i,
    /implementation done/i,
    /all tests pass/i,
    /ready for review/i,
    /finished implementing/i,
    /task complete/i,
  ],
};

/**
 * Analyze tool activity patterns from log content
 */
export function analyzeToolActivity(
  logContent: string,
  logMtimeMs: number
): ToolActivityScore {
  const lines = logContent.split("\n").slice(-100); // Last 100 lines
  const recentContent = lines.join("\n");

  let healthyCycles = 0;
  let stuckLoops = 0;
  let errorRecoveries = 0;

  // Count healthy cycles
  for (const pattern of HEALTHY_PATTERNS) {
    const matches = recentContent.match(pattern);
    if (matches) {
      healthyCycles++;
    }
  }

  // Count stuck loops
  for (const pattern of CONCERNING_PATTERNS.stuckLoop) {
    const matches = recentContent.match(pattern);
    if (matches) {
      stuckLoops++;
    }
  }

  // Detect error recoveries (error followed by success)
  const errorMatches = CONCERNING_PATTERNS.errors.some((p) =>
    p.test(recentContent)
  );
  const successMatches = POSITIVE_PATTERNS.success.some((p) =>
    p.test(recentContent)
  );
  if (errorMatches && successMatches) {
    errorRecoveries++;
  }

  // Calculate idle time
  const now = Date.now();
  const lastActivityAge = Math.floor((now - logMtimeMs) / 1000);

  // Count idle periods (based on line timestamps if available)
  let idlePeriods = 0;
  if (lastActivityAge > 180) {
    // More than 3 minutes
    idlePeriods = 1;
  }

  // Calculate score starting from base of 70
  let score = 70;
  score += healthyCycles * 5; // +5 per healthy cycle
  score -= stuckLoops * 10; // -10 per stuck loop
  score += errorRecoveries * 3; // +3 for recovering from errors

  // Penalize for idle time
  if (lastActivityAge > 60) {
    score -= Math.min(20, Math.floor(lastActivityAge / 60) * 5);
  }

  score = Math.max(0, Math.min(100, score));

  return {
    score,
    patterns: {
      healthyCycles,
      stuckLoops,
      idlePeriods,
      errorRecoveries,
    },
    lastActivityAge,
  };
}

/**
 * Analyze output for success/error patterns
 */
export function analyzeOutput(logContent: string): OutputAnalysisScore {
  const lines = logContent.split("\n").slice(-100);
  const recentContent = lines.join("\n");

  let errorCount = 0;
  let retryCount = 0;
  let successIndicators = 0;
  let frustrationIndicators = 0;
  let completionIndicators = 0;

  // Count errors using pre-compiled global patterns
  for (const pattern of CONCERNING_PATTERNS.errors) {
    // Reset lastIndex for global regex before matching
    pattern.lastIndex = 0;
    const matches = recentContent.match(pattern);
    if (matches) {
      errorCount += matches.length;
    }
  }

  // Count retries using pre-compiled global patterns
  for (const pattern of CONCERNING_PATTERNS.retries) {
    // Reset lastIndex for global regex before matching
    pattern.lastIndex = 0;
    const matches = recentContent.match(pattern);
    if (matches) {
      retryCount += matches.length;
    }
  }

  // Count frustration indicators
  for (const pattern of CONCERNING_PATTERNS.frustration) {
    if (pattern.test(recentContent)) {
      frustrationIndicators++;
    }
  }

  // Count success indicators
  for (const pattern of POSITIVE_PATTERNS.success) {
    if (pattern.test(recentContent)) {
      successIndicators++;
    }
  }

  // Count completion indicators
  for (const pattern of POSITIVE_PATTERNS.completion) {
    if (pattern.test(recentContent)) {
      completionIndicators++;
    }
  }

  // Calculate score starting from base of 70
  let score = 70;
  score += successIndicators * 5;
  score += completionIndicators * 20;
  score -= Math.min(30, errorCount * 5);
  score -= retryCount * 3;
  score -= frustrationIndicators * 15;

  score = Math.max(0, Math.min(100, score));

  return {
    score,
    indicators: {
      errorCount: Math.min(10, errorCount), // Cap for display
      retryCount: Math.min(10, retryCount),
      successIndicators,
      frustrationIndicators,
      completionIndicators,
    },
  };
}

/**
 * Read self-reported confidence from worker's .confidence file
 */
export function readSelfReportedConfidence(
  workerDir: string,
  featureId: string
): number | null {
  const confidenceFile = path.join(workerDir, `${featureId}.confidence`);

  try {
    if (!fs.existsSync(confidenceFile)) {
      return null;
    }

    const content = fs.readFileSync(confidenceFile, "utf-8").trim();
    const value = parseInt(content, 10);

    if (isNaN(value) || value < 0 || value > 100) {
      return null;
    }

    return value;
  } catch {
    return null;
  }
}

/**
 * Calculate aggregated confidence from all signals
 */
export function calculateAggregatedConfidence(
  signals: ConfidenceSignals,
  previousScore?: number
): AggregatedConfidence {
  // Define weights
  let toolWeight = 0.35;
  let selfWeight = 0.35;
  let outputWeight = 0.3;

  // If no self-reported confidence, redistribute weights
  if (signals.selfReported === null) {
    toolWeight = 0.5;
    selfWeight = 0;
    outputWeight = 0.5;
  }

  // Calculate weighted score
  let score =
    signals.toolActivity.score * toolWeight +
    (signals.selfReported ?? 0) * selfWeight +
    signals.outputAnalysis.score * outputWeight;

  // Apply trend adjustment
  let trend: AggregatedConfidence["trend"] = "stable";
  if (previousScore !== undefined) {
    const diff = score - previousScore;
    if (diff > 5) {
      trend = "improving";
      score += 5; // Small boost for improving trend
    } else if (diff < -5) {
      trend = "declining";
      score -= 5; // Small penalty for declining trend
    }
  }

  score = Math.max(0, Math.min(100, Math.round(score)));

  // Determine level
  let level: AggregatedConfidence["level"];
  if (score >= 80) {
    level = "high";
  } else if (score >= 50) {
    level = "medium";
  } else if (score >= 25) {
    level = "low";
  } else {
    level = "critical";
  }

  // Generate alerts
  const alerts: ConfidenceAlert[] = [];
  const now = new Date().toISOString();

  // Alert for idle
  if (signals.toolActivity.lastActivityAge > 180) {
    alerts.push({
      type: "idle",
      message: `Worker idle for ${Math.floor(signals.toolActivity.lastActivityAge / 60)} minutes`,
      severity: signals.toolActivity.lastActivityAge > 300 ? "critical" : "warning",
      timestamp: now,
    });
  }

  // Alert for stuck loops
  if (signals.toolActivity.patterns.stuckLoops > 0) {
    alerts.push({
      type: "stuck_loop",
      message: `Detected ${signals.toolActivity.patterns.stuckLoops} stuck loop pattern(s)`,
      severity: signals.toolActivity.patterns.stuckLoops > 2 ? "critical" : "warning",
      timestamp: now,
    });
  }

  // Alert for high errors
  if (signals.outputAnalysis.indicators.errorCount > 3) {
    alerts.push({
      type: "high_errors",
      message: `High error count: ${signals.outputAnalysis.indicators.errorCount} errors detected`,
      severity:
        signals.outputAnalysis.indicators.errorCount > 5 ? "critical" : "warning",
      timestamp: now,
    });
  }

  // Alert for low self-reported confidence
  if (signals.selfReported !== null && signals.selfReported < 30) {
    alerts.push({
      type: "self_reported_low",
      message: `Worker self-reported low confidence: ${signals.selfReported}%`,
      severity: signals.selfReported < 15 ? "critical" : "warning",
      timestamp: now,
    });
  }

  // Alert for declining trend
  if (trend === "declining" && previousScore !== undefined) {
    alerts.push({
      type: "declining_trend",
      message: `Confidence declining: ${previousScore} → ${score}`,
      severity: score < 40 ? "critical" : "warning",
      timestamp: now,
    });
  }

  return {
    score,
    level,
    signals,
    trend,
    alerts,
  };
}

/**
 * Get complete confidence analysis for a worker
 */
export function getWorkerConfidence(
  workerDir: string,
  featureId: string,
  previousScore?: number
): AggregatedConfidence | null {
  const logFile = path.join(workerDir, `${featureId}.log`);

  // Check if log file exists
  if (!fs.existsSync(logFile)) {
    return null;
  }

  try {
    const logContent = fs.readFileSync(logFile, "utf-8");
    const logStat = fs.statSync(logFile);

    // Gather all signals
    const toolActivity = analyzeToolActivity(logContent, logStat.mtimeMs);
    const selfReported = readSelfReportedConfidence(workerDir, featureId);
    const outputAnalysis = analyzeOutput(logContent);

    const signals: ConfidenceSignals = {
      toolActivity,
      selfReported,
      outputAnalysis,
    };

    return calculateAggregatedConfidence(signals, previousScore);
  } catch {
    return null;
  }
}

/**
 * Format confidence result for display
 */
export function formatConfidenceResult(confidence: AggregatedConfidence): string {
  const lines: string[] = [];

  // Level emoji
  const levelEmoji = {
    high: "🟢",
    medium: "🟡",
    low: "🟠",
    critical: "🔴",
  };

  lines.push(
    `${levelEmoji[confidence.level]} Confidence: ${confidence.score}/100 (${confidence.level})`
  );
  lines.push(`Trend: ${confidence.trend}`);
  lines.push("");

  lines.push("Signals:");
  lines.push(`  Tool Activity: ${confidence.signals.toolActivity.score}/100`);
  lines.push(
    `    Healthy cycles: ${confidence.signals.toolActivity.patterns.healthyCycles}`
  );
  lines.push(
    `    Stuck loops: ${confidence.signals.toolActivity.patterns.stuckLoops}`
  );
  lines.push(
    `    Last activity: ${formatDuration(confidence.signals.toolActivity.lastActivityAge)} ago`
  );

  if (confidence.signals.selfReported !== null) {
    lines.push(`  Self-Reported: ${confidence.signals.selfReported}/100`);
  } else {
    lines.push(`  Self-Reported: not available`);
  }

  lines.push(`  Output Analysis: ${confidence.signals.outputAnalysis.score}/100`);
  lines.push(
    `    Errors: ${confidence.signals.outputAnalysis.indicators.errorCount}`
  );
  lines.push(
    `    Success indicators: ${confidence.signals.outputAnalysis.indicators.successIndicators}`
  );

  if (confidence.alerts.length > 0) {
    lines.push("");
    lines.push("Alerts:");
    for (const alert of confidence.alerts) {
      const icon = alert.severity === "critical" ? "🚨" : "⚠️";
      lines.push(`  ${icon} ${alert.message}`);
    }
  }

  return lines.join("\n");
}

/**
 * Format duration in seconds to human readable
 */
function formatDuration(seconds: number): string {
  if (seconds < 60) {
    return `${seconds}s`;
  } else if (seconds < 3600) {
    return `${Math.floor(seconds / 60)}m`;
  } else {
    return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  }
}
