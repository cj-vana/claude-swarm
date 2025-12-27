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
  generateGitLabCI,
  generateGiteaWorkflow,
  generateBitbucketPipelines,
  generateAzurePipelines,
  generateDependabot,
  generateReleasePlease,
  generateReleasePleaseWorkflow,
  generateIssueTemplates,
  SupportedLanguage,
  ProjectAnalysis,
} from "./generator.js";
import { mergeMarkdown, mergeYaml, mergeJson, MergeResult } from "./merge-strategy.js";
import {
  detectPlatform,
  getPlatformConfig,
  getPlatformIssueTemplates,
  Platform,
  PlatformConfig,
} from "./platforms.js";

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
  /** Override auto-detected Git platform */
  platform?: Platform;
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
  /** The Git platform this feature is for (e.g., 'github', 'gitlab') */
  platform?: Platform;
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
  /** Detected Git platform (github, gitlab, gitea, bitbucket, azure, unknown) */
  private platform: Platform = "unknown";
  /** Platform-specific configuration */
  private platformConfig: PlatformConfig | null = null;

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
   * Also detects the Git platform from the remote origin URL.
   *
   * @returns SetupAnalysis with CI needs, detected tools, entry points, and source structure
   */
  async analyzeProject(): Promise<SetupAnalysis> {
    if (this.cachedAnalysis) {
      return this.cachedAnalysis;
    }

    // Use config platform if provided, otherwise detect from remote origin
    if (this.config.platform) {
      this.platform = this.config.platform;
    } else {
      this.platform = await detectPlatform(this.projectDir);
    }
    this.platformConfig = getPlatformConfig(this.platform);

    this.cachedAnalysis = await analyzeProjectForSetup(this.projectDir);

    return this.cachedAnalysis;
  }

  /**
   * Get the detected Git platform
   *
   * @returns The detected platform (github, gitlab, gitea, bitbucket, azure, or unknown)
   */
  getPlatform(): Platform {
    return this.platform;
  }

  /**
   * Get the platform configuration
   *
   * @returns Platform-specific configuration or null if not detected yet
   */
  getPlatformConfig(): PlatformConfig | null {
    return this.platformConfig;
  }

  /**
   * Generate setup features based on project analysis
   *
   * Returns a list of features that can be used with the orchestrator.
   * Each feature represents a config file to create or update.
   * Uses the detected Git platform to generate platform-specific CI and template features.
   *
   * @param analysis - Project analysis result
   * @returns Array of SetupFeature definitions
   */
  generateSetupFeatures(analysis: SetupAnalysis): SetupFeature[] {
    const features: SetupFeature[] = [];
    const skipConfigs = new Set(this.config.skipConfigs || []);

    // Get platform-specific paths
    const platformConfig = this.platformConfig || getPlatformConfig(this.platform);
    const platformName = platformConfig.name;

    // 1. CLAUDE.md - Primary project documentation for Claude Code (platform-agnostic)
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

    // 2. CI/CD Workflow - Platform-specific
    if (!skipConfigs.has("ci") && !skipConfigs.has(`${this.platform}-ci`)) {
      const ciFeature = this.createPlatformCIFeature(platformConfig);
      if (ciFeature) {
        features.push(ciFeature);
      }
    }

    // 3. Dependabot Configuration (GitHub-specific)
    // Only add for GitHub or Gitea (which has some Dependabot-like features)
    if (!skipConfigs.has("dependabot") && (this.platform === "github" || this.platform === "gitea")) {
      features.push({
        id: "setup-dependabot",
        description: "Configure Dependabot for automated dependency updates",
        targetPath: ".github/dependabot.yml",
        configType: "yaml",
        existingFile: this.fileExists(".github/dependabot.yml"),
        priority: 30,
        platform: this.platform,
      });
    }

    // 4. Release Please Configuration (GitHub-specific)
    if (!skipConfigs.has("release-please") && !skipConfigs.has("release") && this.platform === "github") {
      features.push({
        id: "setup-release-please-config",
        description: "Configure Release Please for automated releases with semantic versioning",
        targetPath: "release-please-config.json",
        configType: "json",
        existingFile: this.fileExists("release-please-config.json"),
        priority: 40,
        platform: this.platform,
      });

      features.push({
        id: "setup-release-please-workflow",
        description: "Create Release Please GitHub Actions workflow",
        targetPath: ".github/workflows/release-please.yml",
        configType: "yaml",
        existingFile: this.fileExists(".github/workflows/release-please.yml"),
        dependsOn: ["setup-release-please-config"],
        priority: 41,
        platform: this.platform,
      });
    }

    // 5. Issue Templates - Platform-specific
    if (!skipConfigs.has("issue-templates") && !skipConfigs.has("templates")) {
      const templateFeature = this.createPlatformIssueTemplatesFeature(platformConfig);
      if (templateFeature) {
        features.push(templateFeature);
      }
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

      // Platform-specific CI features
      case "setup-github-ci":
      case "setup-gitlab-ci":
      case "setup-gitea-ci":
      case "setup-bitbucket-ci":
      case "setup-azure-ci":
        return this.buildCIPrompt(analysis, projectAnalysis);

      case "setup-dependabot":
        return this.buildDependabotPrompt(analysis, projectAnalysis);

      case "setup-release-please-config":
        return this.buildReleasePleaseConfigPrompt(analysis, projectAnalysis);

      case "setup-release-please-workflow":
        return this.buildReleasePleaseWorkflowPrompt(analysis, projectAnalysis);

      // Platform-specific issue template features
      case "setup-issue-templates":
      case "setup-github-templates":
      case "setup-gitlab-templates":
      case "setup-gitea-templates":
      case "setup-bitbucket-templates":
      case "setup-azure-templates":
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
  // Private Methods - Platform-Specific Feature Creation
  // ==========================================================================

  /**
   * Create a CI feature definition for the detected platform
   */
  private createPlatformCIFeature(platformConfig: PlatformConfig): SetupFeature | null {
    const platform = this.platform;
    const platformName = platformConfig.name;

    // Determine the CI config path and feature ID based on platform
    let targetPath: string;
    let featureId: string;
    let description: string;

    switch (platform) {
      case "github":
        targetPath = ".github/workflows/ci.yml";
        featureId = "setup-github-ci";
        description = `Set up GitHub Actions CI workflow for automated testing and building`;
        break;
      case "gitlab":
        targetPath = ".gitlab-ci.yml";
        featureId = "setup-gitlab-ci";
        description = `Set up GitLab CI/CD pipeline for automated testing and building`;
        break;
      case "gitea":
        targetPath = ".gitea/workflows/ci.yml";
        featureId = "setup-gitea-ci";
        description = `Set up Gitea Actions workflow for automated testing and building`;
        break;
      case "bitbucket":
        targetPath = "bitbucket-pipelines.yml";
        featureId = "setup-bitbucket-ci";
        description = `Set up Bitbucket Pipelines for automated testing and building`;
        break;
      case "azure":
        targetPath = "azure-pipelines.yml";
        featureId = "setup-azure-ci";
        description = `Set up Azure Pipelines for automated testing and building`;
        break;
      default:
        // For unknown platforms, default to GitHub Actions format
        targetPath = ".github/workflows/ci.yml";
        featureId = "setup-github-ci";
        description = `Set up CI workflow for automated testing and building`;
        break;
    }

    return {
      id: featureId,
      description,
      targetPath,
      configType: "yaml",
      existingFile: this.fileExists(targetPath),
      priority: 20,
      platform,
    };
  }

  /**
   * Create an issue templates feature definition for the detected platform
   */
  private createPlatformIssueTemplatesFeature(platformConfig: PlatformConfig): SetupFeature | null {
    const platform = this.platform;
    const platformName = platformConfig.name;

    // Determine the issue templates path and feature ID based on platform
    let targetPath: string;
    let featureId: string;
    let description: string;

    switch (platform) {
      case "github":
        targetPath = ".github/ISSUE_TEMPLATE";
        featureId = "setup-github-templates";
        description = `Set up GitHub issue templates for bug reports, feature requests, and more`;
        break;
      case "gitlab":
        targetPath = ".gitlab/issue_templates";
        featureId = "setup-gitlab-templates";
        description = `Set up GitLab issue templates for bug reports, feature requests, and more`;
        break;
      case "gitea":
        targetPath = ".gitea/issue_template";
        featureId = "setup-gitea-templates";
        description = `Set up Gitea issue templates for bug reports, feature requests, and more`;
        break;
      case "bitbucket":
        targetPath = ".bitbucket/issue_templates";
        featureId = "setup-bitbucket-templates";
        description = `Set up Bitbucket issue templates for bug reports, feature requests, and more`;
        break;
      case "azure":
        targetPath = ".azuredevops/work_item_templates";
        featureId = "setup-azure-templates";
        description = `Set up Azure DevOps work item templates for bugs, user stories, and more`;
        break;
      default:
        // For unknown platforms, default to GitHub format
        targetPath = ".github/ISSUE_TEMPLATE";
        featureId = "setup-github-templates";
        description = `Set up issue templates for bug reports, feature requests, and more`;
        break;
    }

    return {
      id: featureId,
      description,
      targetPath,
      configType: "yaml",
      existingFile: this.directoryExists(targetPath),
      priority: 50,
      platform,
    };
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
   * Build prompt for CI setup (platform-aware)
   */
  private buildCIPrompt(analysis: SetupAnalysis, projectAnalysis: ProjectAnalysis): string {
    const platform = this.platform;
    const platformConfig = this.platformConfig || getPlatformConfig(platform);
    const platformName = platformConfig.name;

    // Generate platform-specific CI content
    let generatedContent: string;
    let targetPath: string;
    let ciSystemName: string;

    // Map generator ProjectAnalysis to the format expected by generateCI
    const genProjectAnalysis = {
      language: projectAnalysis.language === "node" ? "node" as const :
                projectAnalysis.language === "python" ? "python" as const :
                projectAnalysis.language === "rust" ? "rust" as const :
                projectAnalysis.language === "go" ? "go" as const :
                projectAnalysis.language === "java" ? "java" as const :
                "unknown" as const,
      packageManager: projectAnalysis.packageManager,
      nodeVersion: undefined as string | undefined,
      pythonVersion: undefined as string | undefined,
      hasTests: projectAnalysis.hasTests,
      hasLinting: projectAnalysis.hasLinting,
      hasTypeCheck: false,
      buildCommand: projectAnalysis.scripts?.build ? `npm run build` : undefined,
      testCommand: projectAnalysis.scripts?.test ? `npm test` : undefined,
      lintCommand: projectAnalysis.scripts?.lint ? `npm run lint` : undefined,
    };

    switch (platform) {
      case "github":
        generatedContent = generateGitHubCI(projectAnalysis);
        targetPath = ".github/workflows/ci.yml";
        ciSystemName = "GitHub Actions";
        break;
      case "gitlab":
        generatedContent = generateGitLabCI(genProjectAnalysis, genProjectAnalysis.language);
        targetPath = ".gitlab-ci.yml";
        ciSystemName = "GitLab CI/CD";
        break;
      case "gitea":
        generatedContent = generateGiteaWorkflow(genProjectAnalysis, genProjectAnalysis.language);
        targetPath = ".gitea/workflows/ci.yml";
        ciSystemName = "Gitea Actions";
        break;
      case "bitbucket":
        generatedContent = generateBitbucketPipelines(genProjectAnalysis, genProjectAnalysis.language);
        targetPath = "bitbucket-pipelines.yml";
        ciSystemName = "Bitbucket Pipelines";
        break;
      case "azure":
        generatedContent = generateAzurePipelines(genProjectAnalysis, genProjectAnalysis.language);
        targetPath = "azure-pipelines.yml";
        ciSystemName = "Azure Pipelines";
        break;
      default:
        // Default to GitHub Actions for unknown platforms
        generatedContent = generateGitHubCI(projectAnalysis);
        targetPath = ".github/workflows/ci.yml";
        ciSystemName = "CI workflow";
        break;
    }

    const existingContent = this.fileExists(targetPath)
      ? fs.readFileSync(path.join(this.projectDir, targetPath), "utf-8")
      : null;

    let mergeInstruction = "";
    if (existingContent && !this.config.force) {
      const mergeResult = mergeYaml(existingContent, generatedContent);
      mergeInstruction = `
## Merge Instructions
An existing CI config file was found. The existing configuration should be preserved where possible.
- Keys preserved: ${mergeResult.preserved.slice(0, 10).join(", ") || "none"}
- Keys to add: ${mergeResult.added.join(", ") || "none"}

Review the existing workflow and only add missing essential steps.
`;
    }

    return `You are setting up ${ciSystemName} for this ${platformName} repository.

## Task
Create or update the ${ciSystemName} configuration at ${targetPath}.

## Project Analysis
- Language: ${analysis.projectInfo.type}
- Package Manager: ${analysis.projectInfo.packageManager || "unknown"}
- Needs Build: ${analysis.ciNeeds.build}
- Has Tests: ${analysis.ciNeeds.test}
- Has Linting: ${analysis.ciNeeds.lint}
- Has Type Checking: ${analysis.ciNeeds.typecheck}
- Git Platform: ${platformName}

## Generated Template
Here is a generated ${ciSystemName} template:

\`\`\`yaml
${generatedContent}
\`\`\`
${mergeInstruction}
## Instructions
1. Review the generated template
2. Verify the package manager and language versions match the project
3. Check that the build, test, and lint commands match the actual project scripts
4. Create any necessary directories if they don't exist
5. Write the CI configuration file

## Important
- Use the correct package manager commands (npm/yarn/pnpm)
- Match the Node.js/Python/etc version to what the project uses
- Include all relevant CI steps based on the project's actual tooling
- This is a ${platformName} repository, so use ${ciSystemName} format
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
   * Build prompt for Issue Templates setup (platform-aware)
   */
  private buildIssueTemplatesPrompt(analysis: SetupAnalysis): string {
    const platform = this.platform;
    const platformConfig = this.platformConfig || getPlatformConfig(platform);
    const platformName = platformConfig.name;

    // Get platform-specific templates
    const templates = getPlatformIssueTemplates(platform);

    // Determine the template directory based on platform
    let templateDir: string;
    let templateType: string;

    switch (platform) {
      case "github":
        templateDir = ".github/ISSUE_TEMPLATE";
        templateType = "issue templates";
        break;
      case "gitlab":
        templateDir = ".gitlab/issue_templates";
        templateType = "issue templates";
        break;
      case "gitea":
        templateDir = ".gitea/issue_template";
        templateType = "issue templates";
        break;
      case "bitbucket":
        templateDir = ".bitbucket/issue_templates";
        templateType = "issue templates";
        break;
      case "azure":
        templateDir = ".azuredevops/work_item_templates";
        templateType = "work item templates";
        break;
      default:
        templateDir = ".github/ISSUE_TEMPLATE";
        templateType = "issue templates";
        break;
    }

    let templatesContent = "";
    for (const [filename, content] of Object.entries(templates)) {
      // Extract just the filename from the full path
      const shortFilename = filename.split("/").pop() || filename;
      templatesContent += `### ${shortFilename}\n\`\`\`markdown\n${content}\`\`\`\n\n`;
    }

    return `You are setting up ${platformName} ${templateType} for this repository.

## Task
Create ${templateType} in the ${templateDir}/ directory.

## Platform
This is a ${platformName} repository, so use the ${platformName}-specific template format.

## Generated Templates
${templatesContent}

## Instructions
1. Create the ${templateDir} directory if it doesn't exist
2. Create each template file with the content shown above
3. Update any placeholders (like "OWNER/REPO") with actual values
4. Adjust template content to match your project's specific needs

## Important
- Each template is formatted for ${platformName}'s template system
- Templates should have appropriate labels for your project
${platform === "github" ? "- The config.yml controls the template chooser behavior" : ""}
${platform === "gitlab" ? "- GitLab templates use simple markdown with optional /label quick actions" : ""}
${platform === "azure" ? "- Azure DevOps templates can include work item field mappings" : ""}
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
