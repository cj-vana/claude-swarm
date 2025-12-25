/**
 * Context Enricher - Auto-enriches features with relevant documentation and code context
 *
 * This module provides intelligent context extraction for features, gathering:
 * - Relevant documentation from project files (CLAUDE.md, README, etc.)
 * - Related code files based on feature descriptions
 * - Architectural patterns and conventions
 * - Dependency relationships between features
 *
 * Key design principles:
 * - Non-blocking file operations where possible
 * - Configurable context limits to prevent prompt bloat
 * - Caching for frequently accessed context
 * - Support for multiple project types (Node.js, Python, Rust, Go, etc.)
 */

import * as fs from "fs";
import * as path from "path";
import { Feature } from "../state/manager.js";
import { sanitizeOutput, validateProjectDir } from "../utils/security.js";

// ============================================================================
// Types and Interfaces
// ============================================================================

/**
 * Configuration options for context enrichment
 */
export interface EnricherConfig {
  /** Maximum characters per documentation file */
  maxDocLength: number;
  /** Maximum characters per code file */
  maxCodeLength: number;
  /** Maximum total context size */
  maxTotalContext: number;
  /** Maximum number of related files to include */
  maxRelatedFiles: number;
  /** Enable architectural pattern detection */
  detectPatterns: boolean;
  /** Cache TTL in milliseconds */
  cacheTtlMs: number;
}

/**
 * Default configuration for context enrichment
 */
export const DEFAULT_ENRICHER_CONFIG: EnricherConfig = {
  maxDocLength: 4000,
  maxCodeLength: 2000,
  maxTotalContext: 16000,
  maxRelatedFiles: 10,
  detectPatterns: true,
  cacheTtlMs: 60000, // 1 minute cache
};

/**
 * A documentation source file
 */
export interface DocumentationSource {
  /** File path relative to project root */
  path: string;
  /** File type (markdown, text, json, etc.) */
  type: "markdown" | "text" | "json" | "yaml" | "other";
  /** Priority for inclusion (higher = more important) */
  priority: number;
  /** Content of the file (truncated if necessary) */
  content: string;
  /** Whether content was truncated */
  truncated: boolean;
}

/**
 * A related code file with relevance information
 */
export interface RelatedCodeFile {
  /** File path relative to project root */
  path: string;
  /** Why this file is relevant */
  relevanceReason: string;
  /** Relevance score (0-100) */
  relevanceScore: number;
  /** Key excerpts from the file */
  excerpts: string[];
  /** File type (ts, js, py, etc.) */
  fileType: string;
}

/**
 * Architectural pattern detected in the codebase
 */
export interface ArchitecturalPattern {
  /** Pattern name */
  name: string;
  /** Description of the pattern */
  description: string;
  /** Files that exemplify this pattern */
  exampleFiles: string[];
  /** Conventions to follow */
  conventions: string[];
}

/**
 * Project type and related tooling information
 */
export interface ProjectInfo {
  /** Primary project type */
  type: "nodejs" | "python" | "rust" | "go" | "java" | "mixed" | "unknown";
  /** Package manager (npm, pnpm, yarn, pip, cargo, etc.) */
  packageManager?: string;
  /** Framework in use (react, express, fastapi, etc.) */
  framework?: string;
  /** Testing framework */
  testFramework?: string;
  /** Build tool */
  buildTool?: string;
  /** Source directories */
  srcDirs: string[];
  /** Test directories */
  testDirs: string[];
}

/**
 * Enriched context for a feature
 */
export interface EnrichedContext {
  /** The feature being enriched */
  featureId: string;
  /** Documentation sources */
  documentation: DocumentationSource[];
  /** Related code files */
  relatedFiles: RelatedCodeFile[];
  /** Detected architectural patterns */
  patterns: ArchitecturalPattern[];
  /** Project information */
  projectInfo: ProjectInfo;
  /** Related feature IDs */
  relatedFeatures: string[];
  /** Timestamp when context was generated */
  enrichedAt: string;
  /** Total context size in characters */
  totalSize: number;
}

/**
 * Cache entry for enriched context
 */
interface CacheEntry {
  context: EnrichedContext;
  expiresAt: number;
}

// ============================================================================
// Pattern Detection Constants
// ============================================================================

/**
 * Common documentation file patterns
 */
const DOCUMENTATION_FILES = [
  { pattern: "CLAUDE.md", priority: 100, type: "markdown" as const },
  { pattern: ".claude/CLAUDE.md", priority: 95, type: "markdown" as const },
  { pattern: "README.md", priority: 80, type: "markdown" as const },
  { pattern: "CONTRIBUTING.md", priority: 70, type: "markdown" as const },
  { pattern: "ARCHITECTURE.md", priority: 90, type: "markdown" as const },
  { pattern: "docs/README.md", priority: 60, type: "markdown" as const },
  { pattern: "docs/ARCHITECTURE.md", priority: 85, type: "markdown" as const },
  { pattern: ".clauderc", priority: 50, type: "json" as const },
  { pattern: ".claude/settings.json", priority: 45, type: "json" as const },
];

/**
 * Project type detection patterns
 */
const PROJECT_INDICATORS = {
  nodejs: ["package.json", "node_modules", "package-lock.json", "pnpm-lock.yaml", "yarn.lock"],
  python: ["requirements.txt", "setup.py", "pyproject.toml", "Pipfile"],
  rust: ["Cargo.toml", "Cargo.lock"],
  go: ["go.mod", "go.sum"],
  java: ["pom.xml", "build.gradle", "build.gradle.kts"],
};

/**
 * Common architectural pattern indicators
 */
const ARCHITECTURAL_PATTERNS = [
  {
    name: "MVC",
    indicators: ["controllers/", "models/", "views/"],
    description: "Model-View-Controller architecture",
  },
  {
    name: "Component-Based",
    indicators: ["components/", "hooks/", "contexts/"],
    description: "React/Vue component-based architecture",
  },
  {
    name: "Clean Architecture",
    indicators: ["domain/", "application/", "infrastructure/"],
    description: "Clean/Hexagonal architecture layers",
  },
  {
    name: "Service Layer",
    indicators: ["services/", "handlers/", "repositories/"],
    description: "Service-oriented architecture",
  },
  {
    name: "Feature Modules",
    indicators: ["features/", "modules/"],
    description: "Feature-based module organization",
  },
];

/**
 * Keywords to match for file relevance scoring
 */
const RELEVANCE_KEYWORDS = [
  { pattern: /\bapi\b/i, boost: 10 },
  { pattern: /\bauth(entication|orization)?\b/i, boost: 15 },
  { pattern: /\btest(s|ing)?\b/i, boost: 8 },
  { pattern: /\bconfig(uration)?\b/i, boost: 10 },
  { pattern: /\butils?\b/i, boost: 5 },
  { pattern: /\bhelper(s)?\b/i, boost: 5 },
  { pattern: /\bschema\b/i, boost: 12 },
  { pattern: /\btype(s)?\b/i, boost: 8 },
  { pattern: /\binterface(s)?\b/i, boost: 8 },
  { pattern: /\bmodel(s)?\b/i, boost: 10 },
  { pattern: /\bservice(s)?\b/i, boost: 10 },
  { pattern: /\bcontroller(s)?\b/i, boost: 10 },
  { pattern: /\bhandler(s)?\b/i, boost: 10 },
  { pattern: /\broute(r|s)?\b/i, boost: 10 },
  { pattern: /\bmiddleware\b/i, boost: 8 },
  { pattern: /\bvalidat(e|ion|or)\b/i, boost: 8 },
];

// ============================================================================
// ContextEnricher Class
// ============================================================================

/**
 * ContextEnricher - Automatically enriches features with relevant context
 *
 * Usage:
 * ```typescript
 * const enricher = new ContextEnricher(projectDir);
 * const context = await enricher.enrichFeature(feature);
 * // or
 * const contexts = await enricher.enrichFeatures(features);
 * ```
 */
export class ContextEnricher {
  private readonly projectDir: string;
  private readonly config: EnricherConfig;
  private cache: Map<string, CacheEntry> = new Map();
  private projectInfoCache: ProjectInfo | null = null;
  private docCache: DocumentationSource[] | null = null;
  private patternCache: ArchitecturalPattern[] | null = null;

  constructor(projectDir: string, config?: Partial<EnricherConfig>) {
    // Validate project directory to prevent path traversal
    this.projectDir = validateProjectDir(projectDir);
    this.config = { ...DEFAULT_ENRICHER_CONFIG, ...config };
  }

  // ==========================================================================
  // Public API
  // ==========================================================================

  /**
   * Enrich a single feature with context
   */
  async enrichFeature(feature: Feature, allFeatures?: Feature[]): Promise<EnrichedContext> {
    // Check cache first
    const cached = this.getCached(feature.id);
    if (cached) {
      return cached;
    }

    const enrichedAt = new Date().toISOString();

    // Gather all context components
    const projectInfo = this.detectProjectInfo();
    const documentation = this.gatherDocumentation();
    const relatedFiles = this.findRelatedFiles(feature, projectInfo);
    const patterns = this.detectPatterns(projectInfo);
    const relatedFeatures = this.findRelatedFeatures(feature, allFeatures || []);

    // Calculate total size
    let totalSize = 0;
    for (const doc of documentation) {
      totalSize += doc.content.length;
    }
    for (const file of relatedFiles) {
      for (const excerpt of file.excerpts) {
        totalSize += excerpt.length;
      }
    }

    const context: EnrichedContext = {
      featureId: feature.id,
      documentation,
      relatedFiles,
      patterns,
      projectInfo,
      relatedFeatures,
      enrichedAt,
      totalSize,
    };

    // Cache the result
    this.setCached(feature.id, context);

    return context;
  }

  /**
   * Enrich multiple features at once
   */
  async enrichFeatures(features: Feature[]): Promise<EnrichedContext[]> {
    const contexts: EnrichedContext[] = [];

    for (const feature of features) {
      const context = await this.enrichFeature(feature, features);
      contexts.push(context);
    }

    return contexts;
  }

  /**
   * Format enriched context as a string for inclusion in prompts
   */
  formatForPrompt(context: EnrichedContext): string {
    const sections: string[] = [];

    // Project info section
    if (context.projectInfo.type !== "unknown") {
      sections.push(this.formatProjectInfo(context.projectInfo));
    }

    // Documentation section
    if (context.documentation.length > 0) {
      sections.push(this.formatDocumentation(context.documentation));
    }

    // Related files section
    if (context.relatedFiles.length > 0) {
      sections.push(this.formatRelatedFiles(context.relatedFiles));
    }

    // Patterns section
    if (context.patterns.length > 0) {
      sections.push(this.formatPatterns(context.patterns));
    }

    // Related features section
    if (context.relatedFeatures.length > 0) {
      sections.push(this.formatRelatedFeatures(context.relatedFeatures));
    }

    return sections.join("\n\n");
  }

  /**
   * Clear all caches
   */
  clearCache(): void {
    this.cache.clear();
    this.projectInfoCache = null;
    this.docCache = null;
    this.patternCache = null;
  }

  // ==========================================================================
  // Project Detection
  // ==========================================================================

  /**
   * Detect project type and configuration
   */
  detectProjectInfo(): ProjectInfo {
    // Return cached if available
    if (this.projectInfoCache) {
      return this.projectInfoCache;
    }

    let detectedType: ProjectInfo["type"] = "unknown";
    let packageManager: string | undefined;
    let framework: string | undefined;
    let testFramework: string | undefined;
    let buildTool: string | undefined;
    const srcDirs: string[] = [];
    const testDirs: string[] = [];

    // Check for project type indicators
    for (const [type, indicators] of Object.entries(PROJECT_INDICATORS)) {
      for (const indicator of indicators) {
        if (fs.existsSync(path.join(this.projectDir, indicator))) {
          detectedType = type as ProjectInfo["type"];
          break;
        }
      }
      if (detectedType !== "unknown") break;
    }

    // Node.js specific detection
    if (detectedType === "nodejs") {
      const packageJsonPath = path.join(this.projectDir, "package.json");
      if (fs.existsSync(packageJsonPath)) {
        try {
          const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));

          // Detect package manager
          if (fs.existsSync(path.join(this.projectDir, "pnpm-lock.yaml"))) {
            packageManager = "pnpm";
          } else if (fs.existsSync(path.join(this.projectDir, "yarn.lock"))) {
            packageManager = "yarn";
          } else {
            packageManager = "npm";
          }

          // Detect framework from dependencies
          const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
          if (allDeps["react"]) framework = "react";
          else if (allDeps["vue"]) framework = "vue";
          else if (allDeps["express"]) framework = "express";
          else if (allDeps["fastify"]) framework = "fastify";
          else if (allDeps["next"]) framework = "nextjs";
          else if (allDeps["@nestjs/core"]) framework = "nestjs";

          // Detect test framework
          if (allDeps["vitest"]) testFramework = "vitest";
          else if (allDeps["jest"]) testFramework = "jest";
          else if (allDeps["mocha"]) testFramework = "mocha";
          else if (allDeps["ava"]) testFramework = "ava";

          // Detect build tool
          if (allDeps["vite"]) buildTool = "vite";
          else if (allDeps["webpack"]) buildTool = "webpack";
          else if (allDeps["esbuild"]) buildTool = "esbuild";
          else if (allDeps["tsc"]) buildTool = "tsc";
        } catch {
          // Ignore JSON parse errors
        }
      }

      // Check for common source directories
      const commonSrcDirs = ["src", "lib", "app", "pages", "components"];
      for (const dir of commonSrcDirs) {
        const dirPath = path.join(this.projectDir, dir);
        if (fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory()) {
          srcDirs.push(dir);
        }
      }

      // Check for test directories
      const commonTestDirs = ["test", "tests", "__tests__", "spec"];
      for (const dir of commonTestDirs) {
        const dirPath = path.join(this.projectDir, dir);
        if (fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory()) {
          testDirs.push(dir);
        }
      }
    }

    // Python specific detection
    if (detectedType === "python") {
      packageManager = "pip";
      if (fs.existsSync(path.join(this.projectDir, "pyproject.toml"))) {
        packageManager = "poetry";
      }
      if (fs.existsSync(path.join(this.projectDir, "Pipfile"))) {
        packageManager = "pipenv";
      }
    }

    // Rust specific detection
    if (detectedType === "rust") {
      packageManager = "cargo";
      testFramework = "cargo test";
    }

    // Go specific detection
    if (detectedType === "go") {
      packageManager = "go mod";
      testFramework = "go test";
    }

    this.projectInfoCache = {
      type: detectedType,
      packageManager,
      framework,
      testFramework,
      buildTool,
      srcDirs,
      testDirs,
    };

    return this.projectInfoCache;
  }

  // ==========================================================================
  // Documentation Gathering
  // ==========================================================================

  /**
   * Gather documentation from project files
   */
  gatherDocumentation(): DocumentationSource[] {
    // Return cached if available
    if (this.docCache) {
      return this.docCache;
    }

    const docs: DocumentationSource[] = [];
    let totalSize = 0;
    const maxDocSize = this.config.maxTotalContext * 0.4; // 40% of total for docs

    // Check each documentation file pattern
    for (const { pattern, priority, type } of DOCUMENTATION_FILES) {
      if (totalSize >= maxDocSize) break;

      const filePath = path.join(this.projectDir, pattern);
      if (fs.existsSync(filePath)) {
        try {
          let content = fs.readFileSync(filePath, "utf-8");
          const truncated = content.length > this.config.maxDocLength;

          if (truncated) {
            content = content.substring(0, this.config.maxDocLength) + "\n... (truncated)";
          }

          docs.push({
            path: pattern,
            type,
            priority,
            content: sanitizeOutput(content),
            truncated,
          });

          totalSize += content.length;
        } catch {
          // Skip unreadable files
        }
      }
    }

    // Sort by priority (highest first)
    docs.sort((a, b) => b.priority - a.priority);

    this.docCache = docs;
    return docs;
  }

  // ==========================================================================
  // Related File Discovery
  // ==========================================================================

  /**
   * Find code files related to a feature based on its description
   */
  findRelatedFiles(feature: Feature, projectInfo: ProjectInfo): RelatedCodeFile[] {
    const relatedFiles: RelatedCodeFile[] = [];
    const description = feature.description.toLowerCase();

    // Extract keywords from the feature description
    const keywords = this.extractKeywords(description);

    // Get all source files
    const sourceFiles = this.getSourceFiles(projectInfo);

    // Score each file for relevance
    const scoredFiles: Array<{ file: string; score: number; reasons: string[] }> = [];

    for (const file of sourceFiles) {
      const fileName = path.basename(file).toLowerCase();
      const filePath = file.toLowerCase();
      let score = 0;
      const reasons: string[] = [];

      // Check for keyword matches in filename
      for (const keyword of keywords) {
        if (fileName.includes(keyword)) {
          score += 20;
          reasons.push(`Filename contains "${keyword}"`);
        }
        if (filePath.includes(keyword)) {
          score += 10;
          reasons.push(`Path contains "${keyword}"`);
        }
      }

      // Apply relevance keyword boosts
      for (const { pattern, boost } of RELEVANCE_KEYWORDS) {
        if (pattern.test(description) && pattern.test(filePath)) {
          score += boost;
          const match = description.match(pattern);
          if (match) {
            reasons.push(`Matches keyword "${match[0]}"`);
          }
        }
      }

      // Boost for type files (likely interfaces/schemas)
      if (fileName.includes("type") || fileName.includes("interface") || fileName.includes("schema")) {
        score += 5;
        reasons.push("Type/schema file");
      }

      // Boost for index files (entry points)
      if (fileName === "index.ts" || fileName === "index.js") {
        score += 3;
        reasons.push("Entry point");
      }

      if (score > 0) {
        scoredFiles.push({ file, score, reasons });
      }
    }

    // Sort by score and take top N
    scoredFiles.sort((a, b) => b.score - a.score);
    const topFiles = scoredFiles.slice(0, this.config.maxRelatedFiles);

    // Read excerpts from top files
    for (const { file, score, reasons } of topFiles) {
      const excerpts = this.extractExcerpts(file, keywords);
      const fileType = path.extname(file).slice(1) || "unknown";

      relatedFiles.push({
        path: file,
        relevanceReason: reasons.slice(0, 3).join("; "),
        relevanceScore: Math.min(100, score),
        excerpts,
        fileType,
      });
    }

    return relatedFiles;
  }

  /**
   * Extract keywords from a feature description
   */
  private extractKeywords(description: string): string[] {
    const keywords = new Set<string>();

    // Extract potential identifiers (camelCase, snake_case, kebab-case)
    const identifiers = description.match(/\b[a-zA-Z][a-zA-Z0-9_-]{2,}\b/g) || [];

    for (const id of identifiers) {
      const lower = id.toLowerCase();
      // Skip common stop words
      if (!["the", "and", "for", "with", "that", "this", "from", "into", "will", "should", "must", "can"].includes(lower)) {
        keywords.add(lower);

        // Also add camelCase parts
        const parts = id.split(/(?=[A-Z])/);
        for (const part of parts) {
          if (part.length > 2) {
            keywords.add(part.toLowerCase());
          }
        }
      }
    }

    return Array.from(keywords);
  }

  /**
   * Get all source files in the project
   */
  private getSourceFiles(projectInfo: ProjectInfo): string[] {
    const files: string[] = [];
    const extensions = this.getSourceExtensions(projectInfo.type);
    const srcDirs = projectInfo.srcDirs.length > 0 ? projectInfo.srcDirs : ["."];

    for (const srcDir of srcDirs) {
      const dirPath = path.join(this.projectDir, srcDir);
      if (fs.existsSync(dirPath)) {
        this.walkDirectory(dirPath, files, extensions);
      }
    }

    // Convert to relative paths
    return files.map(f => path.relative(this.projectDir, f));
  }

  /**
   * Get source file extensions for a project type
   */
  private getSourceExtensions(type: ProjectInfo["type"]): string[] {
    switch (type) {
      case "nodejs":
        return [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];
      case "python":
        return [".py"];
      case "rust":
        return [".rs"];
      case "go":
        return [".go"];
      case "java":
        return [".java", ".kt", ".scala"];
      default:
        return [".ts", ".tsx", ".js", ".jsx", ".py", ".rs", ".go", ".java"];
    }
  }

  /**
   * Recursively walk a directory and collect files
   */
  private walkDirectory(dir: string, files: string[], extensions: string[], depth: number = 0): void {
    // Limit recursion depth
    if (depth > 10) return;

    // Skip common non-source directories
    const skipDirs = ["node_modules", ".git", "dist", "build", ".next", "venv", "__pycache__", "target"];

    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
          if (!skipDirs.includes(entry.name)) {
            this.walkDirectory(fullPath, files, extensions, depth + 1);
          }
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name);
          if (extensions.includes(ext)) {
            files.push(fullPath);
          }
        }
      }
    } catch {
      // Skip unreadable directories
    }
  }

  /**
   * Extract relevant excerpts from a file
   */
  private extractExcerpts(filePath: string, keywords: string[]): string[] {
    const excerpts: string[] = [];
    const fullPath = path.join(this.projectDir, filePath);

    // Validate the file path stays within project directory
    try {
      const realPath = fs.realpathSync(fullPath);
      const realProjectDir = fs.realpathSync(this.projectDir);
      if (!realPath.startsWith(realProjectDir)) {
        // Skip files outside project directory (possible symlink escape)
        return [];
      }
    } catch {
      // File doesn't exist or can't be resolved
      return [];
    }

    try {
      const content = fs.readFileSync(fullPath, "utf-8");
      const lines = content.split("\n");

      // Find lines containing keywords and include context
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].toLowerCase();

        for (const keyword of keywords) {
          if (line.includes(keyword)) {
            // Get surrounding context (3 lines before and after)
            const start = Math.max(0, i - 3);
            const end = Math.min(lines.length, i + 4);
            const excerpt = lines.slice(start, end).join("\n");

            // Truncate if too long
            const truncated = excerpt.length > this.config.maxCodeLength
              ? excerpt.substring(0, this.config.maxCodeLength) + "..."
              : excerpt;

            if (!excerpts.includes(truncated)) {
              excerpts.push(sanitizeOutput(truncated));
            }
            break;
          }
        }

        // Limit excerpts per file
        if (excerpts.length >= 3) break;
      }
    } catch {
      // Skip unreadable files
    }

    return excerpts;
  }

  // ==========================================================================
  // Pattern Detection
  // ==========================================================================

  /**
   * Detect architectural patterns in the codebase
   */
  detectPatterns(projectInfo: ProjectInfo): ArchitecturalPattern[] {
    if (!this.config.detectPatterns) {
      return [];
    }

    // Return cached if available
    if (this.patternCache) {
      return this.patternCache;
    }

    const detected: ArchitecturalPattern[] = [];

    for (const pattern of ARCHITECTURAL_PATTERNS) {
      const foundIndicators: string[] = [];
      const exampleFiles: string[] = [];

      for (const indicator of pattern.indicators) {
        const checkPath = path.join(this.projectDir, indicator);
        if (fs.existsSync(checkPath)) {
          foundIndicators.push(indicator);

          // Find example files in this directory
          try {
            if (fs.statSync(checkPath).isDirectory()) {
              const files = fs.readdirSync(checkPath).slice(0, 3);
              exampleFiles.push(...files.map(f => path.join(indicator, f)));
            }
          } catch {
            // Skip
          }
        }
      }

      // If at least 2 indicators found, consider pattern detected
      if (foundIndicators.length >= 2) {
        detected.push({
          name: pattern.name,
          description: pattern.description,
          exampleFiles: exampleFiles.slice(0, 5),
          conventions: this.inferConventions(pattern.name, projectInfo),
        });
      }
    }

    this.patternCache = detected;
    return detected;
  }

  /**
   * Infer coding conventions based on pattern and project type
   */
  private inferConventions(patternName: string, projectInfo: ProjectInfo): string[] {
    const conventions: string[] = [];

    // Add general conventions
    if (projectInfo.type === "nodejs") {
      conventions.push("Use TypeScript for type safety");
      conventions.push("Export types and interfaces separately");
    }

    // Add pattern-specific conventions
    switch (patternName) {
      case "Component-Based":
        conventions.push("One component per file");
        conventions.push("Use hooks for shared logic");
        conventions.push("Keep components focused and composable");
        break;
      case "Service Layer":
        conventions.push("Services handle business logic");
        conventions.push("Handlers/controllers handle HTTP specifics");
        conventions.push("Use dependency injection where appropriate");
        break;
      case "Clean Architecture":
        conventions.push("Domain layer has no external dependencies");
        conventions.push("Infrastructure implements interfaces from domain");
        conventions.push("Application layer coordinates domain objects");
        break;
    }

    return conventions;
  }

  // ==========================================================================
  // Related Features
  // ==========================================================================

  /**
   * Find features that are related to the given feature
   */
  findRelatedFeatures(feature: Feature, allFeatures: Feature[]): string[] {
    const related: string[] = [];
    const keywords = this.extractKeywords(feature.description);

    // Check dependencies
    if (feature.dependsOn) {
      related.push(...feature.dependsOn);
    }

    // Find features with keyword overlap
    for (const other of allFeatures) {
      if (other.id === feature.id) continue;
      if (related.includes(other.id)) continue;

      const otherKeywords = this.extractKeywords(other.description);
      const overlap = keywords.filter(k => otherKeywords.includes(k));

      if (overlap.length >= 2) {
        related.push(other.id);
      }
    }

    // Check if any feature depends on this one
    for (const other of allFeatures) {
      if (other.id === feature.id) continue;
      if (related.includes(other.id)) continue;

      if (other.dependsOn?.includes(feature.id)) {
        related.push(other.id);
      }
    }

    return related.slice(0, 10); // Limit related features
  }

  // ==========================================================================
  // Formatting Helpers
  // ==========================================================================

  private formatProjectInfo(info: ProjectInfo): string {
    const lines = ["## Project Information"];
    lines.push(`Type: ${info.type}`);
    if (info.framework) lines.push(`Framework: ${info.framework}`);
    if (info.packageManager) lines.push(`Package Manager: ${info.packageManager}`);
    if (info.testFramework) lines.push(`Test Framework: ${info.testFramework}`);
    if (info.buildTool) lines.push(`Build Tool: ${info.buildTool}`);
    if (info.srcDirs.length > 0) lines.push(`Source Dirs: ${info.srcDirs.join(", ")}`);
    return lines.join("\n");
  }

  private formatDocumentation(docs: DocumentationSource[]): string {
    const lines = ["## Relevant Documentation"];
    for (const doc of docs.slice(0, 3)) { // Limit to top 3 docs
      lines.push(`\n### ${doc.path}`);
      lines.push(doc.content);
    }
    return lines.join("\n");
  }

  private formatRelatedFiles(files: RelatedCodeFile[]): string {
    const lines = ["## Related Code Files"];
    for (const file of files.slice(0, 5)) { // Limit to top 5 files
      lines.push(`\n### ${file.path} (score: ${file.relevanceScore})`);
      lines.push(`Relevance: ${file.relevanceReason}`);
      if (file.excerpts.length > 0) {
        lines.push("```" + file.fileType);
        lines.push(file.excerpts[0]); // Just first excerpt
        lines.push("```");
      }
    }
    return lines.join("\n");
  }

  private formatPatterns(patterns: ArchitecturalPattern[]): string {
    const lines = ["## Detected Architectural Patterns"];
    for (const pattern of patterns) {
      lines.push(`\n### ${pattern.name}`);
      lines.push(pattern.description);
      if (pattern.conventions.length > 0) {
        lines.push("Conventions:");
        for (const conv of pattern.conventions) {
          lines.push(`- ${conv}`);
        }
      }
    }
    return lines.join("\n");
  }

  private formatRelatedFeatures(features: string[]): string {
    const lines = ["## Related Features"];
    lines.push("Consider these related features when implementing:");
    for (const f of features) {
      lines.push(`- ${f}`);
    }
    return lines.join("\n");
  }

  // ==========================================================================
  // Caching
  // ==========================================================================

  private getCached(featureId: string): EnrichedContext | null {
    const entry = this.cache.get(featureId);
    if (entry && entry.expiresAt > Date.now()) {
      return entry.context;
    }
    // Remove expired entry
    if (entry) {
      this.cache.delete(featureId);
    }
    return null;
  }

  private setCached(featureId: string, context: EnrichedContext): void {
    this.cache.set(featureId, {
      context,
      expiresAt: Date.now() + this.config.cacheTtlMs,
    });
  }
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Create a context enricher with default configuration
 */
export function createEnricher(projectDir: string, config?: Partial<EnricherConfig>): ContextEnricher {
  return new ContextEnricher(projectDir, config);
}

/**
 * Quick enrichment for a single feature
 */
export async function enrichFeature(
  projectDir: string,
  feature: Feature,
  config?: Partial<EnricherConfig>
): Promise<EnrichedContext> {
  const enricher = new ContextEnricher(projectDir, config);
  return enricher.enrichFeature(feature);
}

/**
 * Format enriched context for inclusion in a prompt
 */
export function formatContextForPrompt(context: EnrichedContext, maxLength: number = 8000): string {
  const enricher = new ContextEnricher(""); // Dummy instance for formatting
  let formatted = enricher.formatForPrompt(context);

  // Truncate if too long
  if (formatted.length > maxLength) {
    formatted = formatted.substring(0, maxLength) + "\n\n... (context truncated)";
  }

  return formatted;
}
