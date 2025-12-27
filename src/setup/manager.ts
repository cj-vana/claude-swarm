/**
 * Setup Manager - Orchestrates repository setup and configuration
 *
 * This module coordinates the repo setup process by:
 * - Detecting if a repo is "fresh" (needs initial setup)
 * - Analyzing the project to understand its structure and needs
 * - Generating setup features for the orchestrator
 * - Building worker prompts for setup tasks
 * - Tracking setup progress
 *
 * The SetupManager integrates with the existing orchestrator infrastructure
 * to run setup tasks as a swarm of workers.
 */

import * as fs from "fs";
import * as path from "path";
import { validateProjectDir } from "../utils/security.js";
import {
  detectFreshness,
  FreshnessResult,
  getSetupRecommendations,
} from "./detector.js";
import {
  SetupAnalyzer,
  SetupAnalysis,
  analyzeProjectForSetup,
} from "./analyzer.js";
import {
  generateClaudeMd,
  generateGitHubCI,
  generateDependabot,
  generateReleasePlease,
  generateReleasePleaseWorkflow,
  generateIssueTemplates,
  SupportedLanguage,
  ProjectAnalysis,
} from "./generator.js";
import { mergeMarkdown, mergeYaml, mergeJson, MergeResult } from "./merge-strategy.js";

// ============================================================================
// Types and Interfaces
// ============================================================================

/**
 * Configuration options for setup operations
 */
export interface SetupConfig {
  /** Skip specific config types (e.g., ['dependabot', 'release-please']) */
  skipConfigs?: string[];
  /** Force overwrite existing files without merging */
  force?: boolean;
  /** Dry run - analyze without making changes */
  dryRun?: boolean;
  /** Custom threshold for freshness detection (default: 50) */
  freshnessThreshold?: number;
}

/**
 * Setup feature definition for orchestrator integration
 */
export interface SetupFeature {
  /** Unique feature ID (e.g., 'setup-claude-md') */
  id: string;
  /** Human-readable description */
  description: string;
  /** Target file path relative to project root */
  targetPath: string;
  /** Type of config file for merge strategy */
  configType: "markdown" | "yaml" | "json" | "other";
  /** Dependencies on other setup features */
  dependsOn?: string[];
  /** Priority (lower = earlier, default: 100) */
  priority?: number;
  /** Whether this config already exists */
  existingFile?: boolean;
  /** Whether to skip based on config */
  skip?: boolean;
}

/**
 * Result of setup status check
 */
export interface SetupStatus {
  /** Whether setup is initialized */
  initialized: boolean;
  /** Freshness detection result */
  freshness?: FreshnessResult;
  /** Project analysis result */
  analysis?: SetupAnalysis;
  /** Generated setup features */
  features: SetupFeature[];
  /** Features that are completed */
  completedFeatures: string[];
  /** Features that are pending */
  pendingFeatures: string[];
  /** Features that failed */
  failedFeatures: string[];
  /** Overall progress percentage */
  progressPercent: number;
  /** Setup config used */
  config: SetupConfig;
}

/**
 * Worker prompt context for setup tasks
 */
interface WorkerPromptContext {
  featureId: string;
  analysis: SetupAnalysis;
  targetPath: string;
  generatedContent: string;
  existingContent?: string;
  mergeStrategy: "markdown" | "yaml" | "json" | "replace";
}

// ============================================================================
// SetupManager Class
// ============================================================================

/**
 * SetupManager - Orchestrates repository setup and configuration
 *
 * Usage:
 * ```typescript
 * const manager = new SetupManager(projectDir);
 *
 * // Check if repo needs setup
 * const freshness = await manager.detectFreshness();
 * if (freshness.isFresh) {
 *   // Analyze project and generate setup features
 *   const analysis = await manager.analyzeProject();
 *   const features = manager.generateSetupFeatures(analysis);
 *
 *   // Use with orchestrator
 *   for (const feature of features) {
 *     const prompt = manager.buildSetupPrompt(feature.id, analysis);
 *     // Start worker with prompt...
 *   }
 * }
 * ```
 */
export class SetupManager {
  private readonly projectDir: string;
  private readonly stateDir: string;
  private config: SetupConfig;
  private cachedAnalysis: SetupAnalysis | null = null;
  private cachedFreshness: FreshnessResult | null = null;

  constructor(projectDir: string, config: SetupConfig = {}) {
    this.projectDir = validateProjectDir(projectDir);
    this.config = {
      skipConfigs: [],
      force: false,
      dryRun: false,
      freshnessThreshold: 50,
      ...config,
    };

    // State directory for tracking setup progress
    this.stateDir = path.join(projectDir, ".claude", "orchestrator", "setup");
  }

  // ==========================================================================
  // Public API
  // ==========================================================================

  /**
   * Detect if the repository is "fresh" and needs initial setup
   *
   * @returns FreshnessResult with score and check details
   */
  async detectFreshness(): Promise<FreshnessResult> {
    if (this.cachedFreshness) {
      return this.cachedFreshness;
    }

    this.cachedFreshness = await detectFreshness(
      this.projectDir,
      this.config.freshnessThreshold
    );

    return this.cachedFreshness;
  }

  /**
   * Analyze the project to understand its structure and setup needs
   *
   * @returns SetupAnalysis with CI needs, detected tools, entry points, and source structure
   */
  async analyzeProject(): Promise<SetupAnalysis> {
    if (this.cachedAnalysis) {
      return this.cachedAnalysis;
    }

    this.cachedAnalysis = await analyzeProjectForSetup(this.projectDir);

    return this.cachedAnalysis;
  }

  /**
   * Generate setup features based on project analysis
   *
   * Returns a list of features that can be used with the orchestrator.
   * Each feature represents a config file to create or update.
   *
   * @param analysis - Project analysis result
   * @returns Array of SetupFeature definitions
   */
  generateSetupFeatures(analysis: SetupAnalysis): SetupFeature[] {
    const features: SetupFeature[] = [];
    const skipConfigs = new Set(this.config.skipConfigs || []);

    // 1. CLAUDE.md - Primary project documentation for Claude Code
    if (!skipConfigs.has("claude-md")) {
      features.push({
        id: "setup-claude-md",
        description: "Create or update CLAUDE.md with project-specific instructions for Claude Code",
        targetPath: "CLAUDE.md",
        configType: "markdown",
        existingFile: this.fileExists("CLAUDE.md"),
        priority: 10,
      });
    }

    // 2. GitHub Actions CI Workflow
    if (!skipConfigs.has("ci") && !skipConfigs.has("github-actions")) {
      features.push({
        id: "setup-github-ci",
        description: "Set up GitHub Actions CI workflow for automated testing and building",
        targetPath: ".github/workflows/ci.yml",
        configType: "yaml",
        existingFile: this.fileExists(".github/workflows/ci.yml"),
        priority: 20,
      });
    }

    // 3. Dependabot Configuration
    if (!skipConfigs.has("dependabot")) {
      features.push({
        id: "setup-dependabot",
        description: "Configure Dependabot for automated dependency updates",
        targetPath: ".github/dependabot.yml",
        configType: "yaml",
        existingFile: this.fileExists(".github/dependabot.yml"),
        priority: 30,
      });
    }

    // 4. Release Please Configuration
    if (!skipConfigs.has("release-please") && !skipConfigs.has("release")) {
      features.push({
        id: "setup-release-please-config",
        description: "Configure Release Please for automated releases with semantic versioning",
        targetPath: "release-please-config.json",
        configType: "json",
        existingFile: this.fileExists("release-please-config.json"),
        priority: 40,
      });

      features.push({
        id: "setup-release-please-workflow",
        description: "Create Release Please GitHub Actions workflow",
        targetPath: ".github/workflows/release-please.yml",
        configType: "yaml",
        existingFile: this.fileExists(".github/workflows/release-please.yml"),
        dependsOn: ["setup-release-please-config"],
        priority: 41,
      });
    }

    // 5. Issue Templates
    if (!skipConfigs.has("issue-templates") && !skipConfigs.has("templates")) {
      const templateDir = ".github/ISSUE_TEMPLATE";
      const templateFiles = [
        { file: "bug.yml", desc: "bug report template" },
        { file: "feature.yml", desc: "feature request template" },
        { file: "docs.yml", desc: "documentation issue template" },
        { file: "support.yml", desc: "support request template" },
        { file: "security.yml", desc: "security concern template" },
        { file: "blank.yml", desc: "blank issue template" },
        { file: "config.yml", desc: "issue template chooser configuration" },
      ];

      features.push({
        id: "setup-issue-templates",
        description: "Set up GitHub issue templates for bug reports, feature requests, and more",
        targetPath: templateDir,
        configType: "yaml",
        existingFile: this.directoryExists(templateDir),
        priority: 50,
      });
    }

    // Mark features to skip based on config
    for (const feature of features) {
      feature.skip = skipConfigs.has(feature.id.replace("setup-", ""));
    }

    // Sort by priority
    features.sort((a, b) => (a.priority || 100) - (b.priority || 100));

    return features;
  }

  /**
   * Build a worker prompt for a specific setup feature
   *
   * @param featureId - The feature ID to build a prompt for
   * @param analysis - Project analysis result
   * @returns Worker prompt string ready for Claude Code
   */
  buildSetupPrompt(featureId: string, analysis: SetupAnalysis): string {
    const projectAnalysis = this.convertToProjectAnalysis(analysis);

    switch (featureId) {
      case "setup-claude-md":
        return this.buildClaudeMdPrompt(analysis, projectAnalysis);

      case "setup-github-ci":
        return this.buildCIPrompt(analysis, projectAnalysis);

      case "setup-dependabot":
        return this.buildDependabotPrompt(analysis, projectAnalysis);

      case "setup-release-please-config":
        return this.buildReleasePleaseConfigPrompt(analysis, projectAnalysis);

      case "setup-release-please-workflow":
        return this.buildReleasePleaseWorkflowPrompt(analysis, projectAnalysis);

      case "setup-issue-templates":
        return this.buildIssueTemplatesPrompt(analysis);

      default:
        throw new Error(`Unknown setup feature: ${featureId}`);
    }
  }

  /**
   * Get the current setup status including progress tracking
   *
   * @returns SetupStatus with current progress information
   */
  async getSetupStatus(): Promise<SetupStatus> {
    // Load cached or fresh data
    const freshness = await this.detectFreshness();
    const analysis = await this.analyzeProject();
    const features = this.generateSetupFeatures(analysis);

    // Load progress state
    const progressState = this.loadProgressState();

    const completedFeatures: string[] = [];
    const pendingFeatures: string[] = [];
    const failedFeatures: string[] = [];

    for (const feature of features) {
      if (feature.skip) {
        continue;
      }

      const status = progressState.features[feature.id];

      if (status === "completed") {
        completedFeatures.push(feature.id);
      } else if (status === "failed") {
        failedFeatures.push(feature.id);
      } else {
        pendingFeatures.push(feature.id);
      }
    }

    const totalFeatures = completedFeatures.length + pendingFeatures.length + failedFeatures.length;
    const progressPercent = totalFeatures > 0
      ? Math.round((completedFeatures.length / totalFeatures) * 100)
      : 0;

    return {
      initialized: progressState.initialized,
      freshness,
      analysis,
      features,
      completedFeatures,
      pendingFeatures,
      failedFeatures,
      progressPercent,
      config: this.config,
    };
  }

  /**
   * Mark a setup feature as completed
   *
   * @param featureId - The feature ID to mark as completed
   */
  markFeatureCompleted(featureId: string): void {
    const state = this.loadProgressState();
    state.features[featureId] = "completed";
    state.lastUpdated = new Date().toISOString();
    this.saveProgressState(state);
  }

  /**
   * Mark a setup feature as failed
   *
   * @param featureId - The feature ID to mark as failed
   * @param error - Optional error message
   */
  markFeatureFailed(featureId: string, error?: string): void {
    const state = this.loadProgressState();
    state.features[featureId] = "failed";
    if (error) {
      state.errors = state.errors || {};
      state.errors[featureId] = error;
    }
    state.lastUpdated = new Date().toISOString();
    this.saveProgressState(state);
  }

  /**
   * Initialize the setup process
   *
   * Creates the state directory and initializes progress tracking.
   */
  initializeSetup(): void {
    if (!fs.existsSync(this.stateDir)) {
      fs.mkdirSync(this.stateDir, { recursive: true });
    }

    const state = this.loadProgressState();
    if (!state.initialized) {
      state.initialized = true;
      state.startedAt = new Date().toISOString();
      this.saveProgressState(state);
    }
  }

  /**
   * Reset setup progress (useful for re-running setup)
   */
  resetProgress(): void {
    const state = {
      initialized: false,
      features: {},
      lastUpdated: new Date().toISOString(),
    };
    this.saveProgressState(state);
    this.cachedAnalysis = null;
    this.cachedFreshness = null;
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<SetupConfig>): void {
    this.config = { ...this.config, ...config };
  }

  // ==========================================================================
  // Private Methods - Prompt Building
  // ==========================================================================

  /**
   * Build prompt for CLAUDE.md setup
   */
  private buildClaudeMdPrompt(analysis: SetupAnalysis, projectAnalysis: ProjectAnalysis): string {
    const generatedContent = generateClaudeMd(projectAnalysis);
    const existingPath = path.join(this.projectDir, "CLAUDE.md");
    const existingContent = this.fileExists("CLAUDE.md")
      ? fs.readFileSync(existingPath, "utf-8")
      : null;

    let mergeInstruction = "";
    if (existingContent && !this.config.force) {
      const mergeResult = mergeMarkdown(existingContent, generatedContent);
      mergeInstruction = `
## Merge Instructions
An existing CLAUDE.md file was found. Use the smart merge strategy:
- Preserve existing sections that the user has customized
- Add new sections from the generated content
- Sections that will be preserved: ${mergeResult.preserved.join(", ") || "none"}
- Sections that will be added: ${mergeResult.added.join(", ") || "none"}

Here is the suggested merged content as a starting point:
\`\`\`markdown
${mergeResult.content}
\`\`\`
`;
    }

    return `You are setting up CLAUDE.md for this repository.

## Task
Create or update the CLAUDE.md file to provide project-specific instructions for Claude Code.

## Project Analysis
- Language: ${analysis.projectInfo.type}
- Package Manager: ${analysis.projectInfo.packageManager || "unknown"}
- Has Tests: ${analysis.ciNeeds.test}
- Has Build: ${analysis.ciNeeds.build}
- Has Linting: ${analysis.ciNeeds.lint}
- Linters: ${analysis.detectedTools.linters.join(", ") || "none detected"}
- Formatters: ${analysis.detectedTools.formatters.join(", ") || "none detected"}
- Type Checkers: ${analysis.detectedTools.typeCheckers.join(", ") || "none detected"}
- Source Directories: ${analysis.sourceStructure.srcDirs.join(", ") || "none"}
- Test Directories: ${analysis.sourceStructure.testDirs.join(", ") || "none"}
- Is Monorepo: ${analysis.sourceStructure.isMonorepo}

## Generated Template
Here is a generated CLAUDE.md template based on the project analysis:

\`\`\`markdown
${generatedContent}
\`\`\`
${mergeInstruction}
## Instructions
1. Review the generated template above
2. Explore the actual codebase to understand its architecture
3. Customize the CLAUDE.md with project-specific details:
   - Add architecture overview describing key components
   - Document important patterns and conventions used
   - Add any project-specific build or test instructions
   - Include debugging tips if relevant
4. Write the final CLAUDE.md file

## Important
- Keep the document concise and focused on what helps Claude Code understand the project
- Include actual command examples that work for this project
- Document any non-obvious patterns or conventions
`;
  }

  /**
   * Build prompt for GitHub Actions CI setup
   */
  private buildCIPrompt(analysis: SetupAnalysis, projectAnalysis: ProjectAnalysis): string {
    const generatedContent = generateGitHubCI(projectAnalysis);
    const existingPath = path.join(this.projectDir, ".github/workflows/ci.yml");
    const existingContent = this.fileExists(".github/workflows/ci.yml")
      ? fs.readFileSync(existingPath, "utf-8")
      : null;

    let mergeInstruction = "";
    if (existingContent && !this.config.force) {
      const mergeResult = mergeYaml(existingContent, generatedContent);
      mergeInstruction = `
## Merge Instructions
An existing ci.yml file was found. The existing configuration should be preserved where possible.
- Keys preserved: ${mergeResult.preserved.slice(0, 10).join(", ") || "none"}
- Keys to add: ${mergeResult.added.join(", ") || "none"}

Review the existing workflow and only add missing essential steps.
`;
    }

    return `You are setting up GitHub Actions CI for this repository.

## Task
Create or update the GitHub Actions CI workflow at .github/workflows/ci.yml.

## Project Analysis
- Language: ${analysis.projectInfo.type}
- Package Manager: ${analysis.projectInfo.packageManager || "unknown"}
- Needs Build: ${analysis.ciNeeds.build}
- Has Tests: ${analysis.ciNeeds.test}
- Has Linting: ${analysis.ciNeeds.lint}
- Has Type Checking: ${analysis.ciNeeds.typecheck}

## Generated Template
Here is a generated CI workflow template:

\`\`\`yaml
${generatedContent}
\`\`\`
${mergeInstruction}
## Instructions
1. Review the generated template
2. Verify the package manager and language versions match the project
3. Check that the build, test, and lint commands match the actual project scripts
4. Create the .github/workflows directory if it doesn't exist
5. Write the ci.yml file

## Important
- Use the correct package manager commands (npm/yarn/pnpm)
- Match the Node.js/Python/etc version to what the project uses
- Include all relevant CI steps based on the project's actual tooling
`;
  }

  /**
   * Build prompt for Dependabot setup
   */
  private buildDependabotPrompt(analysis: SetupAnalysis, projectAnalysis: ProjectAnalysis): string {
    const generatedContent = generateDependabot(projectAnalysis.language);

    return `You are setting up Dependabot for this repository.

## Task
Create the Dependabot configuration at .github/dependabot.yml.

## Project Analysis
- Language: ${analysis.projectInfo.type}
- Package Manager: ${analysis.projectInfo.packageManager || "unknown"}

## Generated Template
Here is a generated Dependabot configuration:

\`\`\`yaml
${generatedContent}
\`\`\`

## Instructions
1. Review the generated template
2. Update the package ecosystem if needed
3. Adjust the schedule if the default doesn't suit the project
4. Create the .github directory if it doesn't exist
5. Write the dependabot.yml file

## Important
- Use the correct package ecosystem (npm, pip, cargo, gomod, etc.)
- Consider the project's release cadence when setting the schedule
- The "reviewers" field should be updated with actual team members
`;
  }

  /**
   * Build prompt for Release Please config setup
   */
  private buildReleasePleaseConfigPrompt(analysis: SetupAnalysis, projectAnalysis: ProjectAnalysis): string {
    const generatedContent = generateReleasePlease(projectAnalysis.language);

    return `You are setting up Release Please for this repository.

## Task
Create the Release Please configuration at release-please-config.json.

## Project Analysis
- Language: ${analysis.projectInfo.type}
- Package Manager: ${analysis.projectInfo.packageManager || "unknown"}

## Generated Template
Here is a generated Release Please configuration:

\`\`\`json
${generatedContent}
\`\`\`

## Instructions
1. Review the generated template
2. Verify the release-type matches the project's package type
3. Adjust changelog-path if the project uses a different location
4. Write the release-please-config.json file
5. Also create an empty .release-please-manifest.json file with just {}

## Important
- The release-type should match the project's ecosystem
- For Node.js projects, use "node"
- For Python, use "python"
- For Rust, use "rust"
`;
  }

  /**
   * Build prompt for Release Please workflow setup
   */
  private buildReleasePleaseWorkflowPrompt(analysis: SetupAnalysis, projectAnalysis: ProjectAnalysis): string {
    const generatedContent = generateReleasePleaseWorkflow();

    return `You are setting up the Release Please GitHub Actions workflow.

## Task
Create the Release Please workflow at .github/workflows/release-please.yml.

## Generated Template
Here is the Release Please workflow:

\`\`\`yaml
${generatedContent}
\`\`\`

## Instructions
1. Create the .github/workflows directory if it doesn't exist
2. Write the release-please.yml file exactly as shown above
3. The workflow will automatically create release PRs when commits land on main

## Important
- This workflow requires the release-please-config.json to exist
- It uses the GITHUB_TOKEN which is automatically provided
`;
  }

  /**
   * Build prompt for Issue Templates setup
   */
  private buildIssueTemplatesPrompt(analysis: SetupAnalysis): string {
    const templates = generateIssueTemplates();

    let templatesContent = "";
    for (const [filename, content] of Object.entries(templates)) {
      templatesContent += `### ${filename}\n\`\`\`yaml\n${content}\`\`\`\n\n`;
    }

    return `You are setting up GitHub Issue Templates for this repository.

## Task
Create GitHub issue templates in .github/ISSUE_TEMPLATE/ directory.

## Generated Templates
${templatesContent}

## Instructions
1. Create the .github/ISSUE_TEMPLATE directory if it doesn't exist
2. Create each template file with the content shown above
3. Update the config.yml with the actual repository owner and name
4. Replace "OWNER/REPO" placeholders with the actual values

## Important
- Issue templates use YAML form syntax
- Each template should have appropriate labels
- The config.yml controls the template chooser behavior
`;
  }

  // ==========================================================================
  // Private Methods - Utility
  // ==========================================================================

  /**
   * Convert SetupAnalysis to ProjectAnalysis format for generators
   */
  private convertToProjectAnalysis(analysis: SetupAnalysis): ProjectAnalysis {
    // Detect scripts from package.json if available
    let scripts: Record<string, string> = {};
    const packageJsonPath = path.join(this.projectDir, "package.json");
    if (fs.existsSync(packageJsonPath)) {
      try {
        const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));
        scripts = packageJson.scripts || {};
      } catch {
        // Ignore parse errors
      }
    }

    // Map project type to supported language
    const languageMap: Record<string, SupportedLanguage> = {
      nodejs: "node",
      python: "python",
      rust: "rust",
      go: "go",
      java: "java",
    };

    const language = languageMap[analysis.projectInfo.type] || "node";

    // Map package manager
    type PackageManager = "npm" | "yarn" | "pnpm" | "pip" | "poetry" | "cargo" | "go" | "maven" | "gradle";
    let packageManager: PackageManager | undefined;
    const pm = analysis.projectInfo.packageManager;
    if (pm === "npm" || pm === "yarn" || pm === "pnpm" || pm === "pip" ||
        pm === "poetry" || pm === "cargo" || pm === "go" || pm === "maven" || pm === "gradle") {
      packageManager = pm;
    }

    return {
      name: path.basename(this.projectDir),
      language,
      packageManager,
      hasTests: analysis.ciNeeds.test,
      hasLinting: analysis.ciNeeds.lint,
      hasBuild: analysis.ciNeeds.build,
      isMonorepo: analysis.sourceStructure.isMonorepo,
      scripts,
      directories: {
        src: analysis.sourceStructure.srcDirs[0],
        tests: analysis.sourceStructure.testDirs[0],
        docs: analysis.sourceStructure.docDirs[0],
      },
    };
  }

  /**
   * Check if a file exists in the project
   */
  private fileExists(relativePath: string): boolean {
    try {
      const fullPath = path.join(this.projectDir, relativePath);
      return fs.existsSync(fullPath) && fs.statSync(fullPath).isFile();
    } catch {
      return false;
    }
  }

  /**
   * Check if a directory exists in the project
   */
  private directoryExists(relativePath: string): boolean {
    try {
      const fullPath = path.join(this.projectDir, relativePath);
      return fs.existsSync(fullPath) && fs.statSync(fullPath).isDirectory();
    } catch {
      return false;
    }
  }

  /**
   * Load progress state from disk
   */
  private loadProgressState(): {
    initialized: boolean;
    startedAt?: string;
    features: Record<string, "pending" | "completed" | "failed">;
    errors?: Record<string, string>;
    lastUpdated?: string;
  } {
    const stateFile = path.join(this.stateDir, "progress.json");

    if (!fs.existsSync(stateFile)) {
      return {
        initialized: false,
        features: {},
      };
    }

    try {
      return JSON.parse(fs.readFileSync(stateFile, "utf-8"));
    } catch {
      return {
        initialized: false,
        features: {},
      };
    }
  }

  /**
   * Save progress state to disk
   */
  private saveProgressState(state: {
    initialized: boolean;
    startedAt?: string;
    features: Record<string, "pending" | "completed" | "failed">;
    errors?: Record<string, string>;
    lastUpdated?: string;
  }): void {
    // Ensure state directory exists
    if (!fs.existsSync(this.stateDir)) {
      fs.mkdirSync(this.stateDir, { recursive: true });
    }

    const stateFile = path.join(this.stateDir, "progress.json");

    // Atomic write using temp file + rename
    const tempFile = `${stateFile}.tmp`;
    fs.writeFileSync(tempFile, JSON.stringify(state, null, 2));
    fs.renameSync(tempFile, stateFile);
  }
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Create a SetupManager instance with default configuration
 *
 * @param projectDir - Path to the project directory
 * @param config - Optional configuration
 * @returns SetupManager instance
 */
export function createSetupManager(
  projectDir: string,
  config?: SetupConfig
): SetupManager {
  return new SetupManager(projectDir, config);
}

/**
 * Quick check if a project needs setup
 *
 * @param projectDir - Path to the project directory
 * @returns True if the project is "fresh" and needs setup
 */
export async function projectNeedsSetup(projectDir: string): Promise<boolean> {
  const manager = new SetupManager(projectDir);
  const freshness = await manager.detectFreshness();
  return freshness.isFresh;
}
