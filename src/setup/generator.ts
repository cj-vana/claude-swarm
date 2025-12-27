/**
 * Template Generators for Repository Setup
 *
 * This module provides generators for:
 * - CLAUDE.md configuration files
 * - GitHub Actions CI workflows (Node, Python, Rust, Go, Java)
 * - Release Please configuration
 * - Dependabot configuration
 * - GitHub Issue Templates (YAML forms)
 *
 * Each generator returns string content that can be written to files.
 */

// ============================================================================
// Types
// ============================================================================

/**
 * Supported programming languages for CI/CD generation
 */
export type SupportedLanguage = "node" | "python" | "rust" | "go" | "java";

/**
 * Project analysis result used by generators
 */
export interface ProjectAnalysis {
  name: string;
  description?: string;
  language: SupportedLanguage;
  packageManager?: "npm" | "yarn" | "pnpm" | "pip" | "poetry" | "cargo" | "go" | "maven" | "gradle";
  hasTests?: boolean;
  hasLinting?: boolean;
  hasBuild?: boolean;
  nodeVersion?: string;
  pythonVersion?: string;
  goVersion?: string;
  javaVersion?: string;
  rustEdition?: string;
  isMonorepo?: boolean;
  frameworks?: string[];
  directories?: {
    src?: string;
    tests?: string;
    docs?: string;
  };
  scripts?: Record<string, string>;
}

// ============================================================================
// CLAUDE.md Generator
// ============================================================================

/**
 * Generate a CLAUDE.md file based on project analysis
 */
export function generateClaudeMd(analysis: ProjectAnalysis): string {
  const sections: string[] = [];

  // Header
  sections.push(`# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.
`);

  // Build and Development Commands
  sections.push(`## Build and Development Commands

\`\`\`bash`);

  switch (analysis.language) {
    case "node":
      sections.push(generateNodeCommands(analysis));
      break;
    case "python":
      sections.push(generatePythonCommands(analysis));
      break;
    case "rust":
      sections.push(generateRustCommands(analysis));
      break;
    case "go":
      sections.push(generateGoCommands(analysis));
      break;
    case "java":
      sections.push(generateJavaCommands(analysis));
      break;
  }

  sections.push(`\`\`\`
`);

  // Architecture Overview
  if (analysis.description) {
    sections.push(`## Architecture Overview

${analysis.description}
`);
  }

  // Project Structure
  sections.push(`## Project Structure

${generateProjectStructure(analysis)}
`);

  // Testing
  if (analysis.hasTests) {
    sections.push(`## Testing

${generateTestingSection(analysis)}
`);
  }

  // Code Style
  if (analysis.hasLinting) {
    sections.push(`## Code Style

${generateCodeStyleSection(analysis)}
`);
  }

  return sections.join("\n");
}

function generateNodeCommands(analysis: ProjectAnalysis): string {
  const pm = analysis.packageManager || "npm";
  const run = pm === "npm" ? "npm run" : pm === "yarn" ? "yarn" : "pnpm";
  const install = pm === "npm" ? "npm install" : pm === "yarn" ? "yarn install" : "pnpm install";

  const commands: string[] = [];
  commands.push(`${install}         # Install dependencies`);

  if (analysis.scripts?.build || analysis.hasBuild) {
    commands.push(`${run} build       # Build the project`);
  }
  if (analysis.scripts?.dev) {
    commands.push(`${run} dev         # Run in development mode`);
  }
  if (analysis.scripts?.start) {
    commands.push(`${run} start       # Start the application`);
  }
  if (analysis.scripts?.test || analysis.hasTests) {
    commands.push(`${run} test        # Run tests`);
  }
  if (analysis.scripts?.lint || analysis.hasLinting) {
    commands.push(`${run} lint        # Run linter`);
  }

  return commands.join("\n");
}

function generatePythonCommands(analysis: ProjectAnalysis): string {
  const pm = analysis.packageManager || "pip";
  const commands: string[] = [];

  if (pm === "poetry") {
    commands.push(`poetry install    # Install dependencies`);
    commands.push(`poetry run python main.py  # Run the application`);
    if (analysis.hasTests) {
      commands.push(`poetry run pytest # Run tests`);
    }
    if (analysis.hasLinting) {
      commands.push(`poetry run ruff check .  # Run linter`);
    }
  } else {
    commands.push(`pip install -r requirements.txt  # Install dependencies`);
    commands.push(`python main.py    # Run the application`);
    if (analysis.hasTests) {
      commands.push(`pytest            # Run tests`);
    }
    if (analysis.hasLinting) {
      commands.push(`ruff check .      # Run linter`);
    }
  }

  return commands.join("\n");
}

function generateRustCommands(analysis: ProjectAnalysis): string {
  const commands: string[] = [];
  commands.push(`cargo build       # Build the project`);
  commands.push(`cargo build --release  # Build for release`);
  commands.push(`cargo run         # Run the application`);
  if (analysis.hasTests) {
    commands.push(`cargo test        # Run tests`);
  }
  if (analysis.hasLinting) {
    commands.push(`cargo clippy      # Run linter`);
  }
  commands.push(`cargo fmt         # Format code`);

  return commands.join("\n");
}

function generateGoCommands(analysis: ProjectAnalysis): string {
  const commands: string[] = [];
  commands.push(`go build          # Build the project`);
  commands.push(`go run .          # Run the application`);
  if (analysis.hasTests) {
    commands.push(`go test ./...     # Run tests`);
  }
  if (analysis.hasLinting) {
    commands.push(`golangci-lint run # Run linter`);
  }
  commands.push(`go fmt ./...      # Format code`);

  return commands.join("\n");
}

function generateJavaCommands(analysis: ProjectAnalysis): string {
  const pm = analysis.packageManager || "maven";
  const commands: string[] = [];

  if (pm === "gradle") {
    commands.push(`./gradlew build   # Build the project`);
    commands.push(`./gradlew run     # Run the application`);
    if (analysis.hasTests) {
      commands.push(`./gradlew test    # Run tests`);
    }
    commands.push(`./gradlew clean   # Clean build artifacts`);
  } else {
    commands.push(`mvn compile       # Compile the project`);
    commands.push(`mvn package       # Package the project`);
    commands.push(`mvn exec:java     # Run the application`);
    if (analysis.hasTests) {
      commands.push(`mvn test          # Run tests`);
    }
    commands.push(`mvn clean         # Clean build artifacts`);
  }

  return commands.join("\n");
}

function generateProjectStructure(analysis: ProjectAnalysis): string {
  const srcDir = analysis.directories?.src || "src";
  const testDir = analysis.directories?.tests || "tests";

  switch (analysis.language) {
    case "node":
      return `\`\`\`
${srcDir}/           # Source code
${testDir}/          # Test files
package.json    # Dependencies and scripts
tsconfig.json   # TypeScript configuration (if applicable)
\`\`\``;

    case "python":
      return `\`\`\`
${srcDir}/           # Source code
${testDir}/          # Test files
pyproject.toml  # Project configuration
requirements.txt # Dependencies (if not using poetry)
\`\`\``;

    case "rust":
      return `\`\`\`
src/            # Source code
  main.rs       # Entry point
  lib.rs        # Library code
Cargo.toml      # Dependencies and configuration
\`\`\``;

    case "go":
      return `\`\`\`
cmd/            # Application entry points
internal/       # Private application code
pkg/            # Public library code
go.mod          # Module definition
go.sum          # Dependency checksums
\`\`\``;

    case "java":
      return `\`\`\`
src/main/java/  # Source code
src/main/resources/  # Resources
src/test/java/  # Test files
pom.xml         # Maven configuration (or build.gradle)
\`\`\``;

    default:
      return "";
  }
}

function generateTestingSection(analysis: ProjectAnalysis): string {
  switch (analysis.language) {
    case "node":
      return `Run tests with \`npm test\` or \`npm run test:watch\` for watch mode.

Test files should be placed in the \`${analysis.directories?.tests || "tests"}\` directory or alongside source files with \`.test.ts\` extension.`;

    case "python":
      return `Run tests with \`pytest\` or \`pytest -v\` for verbose output.

Test files should be named \`test_*.py\` and placed in the \`${analysis.directories?.tests || "tests"}\` directory.`;

    case "rust":
      return `Run tests with \`cargo test\`.

Unit tests should be placed in a \`tests\` module within each source file.
Integration tests should be placed in the \`tests/\` directory.`;

    case "go":
      return `Run tests with \`go test ./...\` or \`go test -v ./...\` for verbose output.

Test files should be named \`*_test.go\` and placed alongside the source files they test.`;

    case "java":
      return `Run tests with \`mvn test\` or \`./gradlew test\`.

Test files should be placed in \`src/test/java/\` mirroring the source package structure.`;

    default:
      return "";
  }
}

function generateCodeStyleSection(analysis: ProjectAnalysis): string {
  switch (analysis.language) {
    case "node":
      return `This project uses ESLint for linting and Prettier for formatting.

- Run \`npm run lint\` to check for issues
- Run \`npm run lint:fix\` to auto-fix issues
- Run \`npm run format\` to format code`;

    case "python":
      return `This project uses Ruff for linting and formatting.

- Run \`ruff check .\` to check for issues
- Run \`ruff check --fix .\` to auto-fix issues
- Run \`ruff format .\` to format code`;

    case "rust":
      return `This project uses rustfmt for formatting and clippy for linting.

- Run \`cargo fmt\` to format code
- Run \`cargo clippy\` to run the linter
- Run \`cargo clippy --fix\` to auto-fix issues`;

    case "go":
      return `This project uses gofmt for formatting and golangci-lint for linting.

- Run \`go fmt ./...\` to format code
- Run \`golangci-lint run\` to run the linter`;

    case "java":
      return `This project follows standard Java conventions.

- Run the linter through your IDE or build tool
- Use Checkstyle or SpotBugs for code quality checks`;

    default:
      return "";
  }
}

// ============================================================================
// GitHub Actions CI Generator
// ============================================================================

/**
 * Generate a GitHub Actions CI workflow for the specified language
 */
export function generateGitHubCI(analysis: ProjectAnalysis, language?: SupportedLanguage): string {
  const lang = language || analysis.language;

  switch (lang) {
    case "node":
      return generateNodeCI(analysis);
    case "python":
      return generatePythonCI(analysis);
    case "rust":
      return generateRustCI(analysis);
    case "go":
      return generateGoCI(analysis);
    case "java":
      return generateJavaCI(analysis);
    default:
      throw new Error(`Unsupported language: ${lang}`);
  }
}

function generateNodeCI(analysis: ProjectAnalysis): string {
  const pm = analysis.packageManager || "npm";
  const nodeVersion = analysis.nodeVersion || "20";

  let installCmd: string;
  let cacheKey: string;

  switch (pm) {
    case "yarn":
      installCmd = "yarn install --frozen-lockfile";
      cacheKey = "yarn";
      break;
    case "pnpm":
      installCmd = "pnpm install --frozen-lockfile";
      cacheKey = "pnpm";
      break;
    default:
      installCmd = "npm ci";
      cacheKey = "npm";
  }

  const pnpmSetup = pm === "pnpm" ? `
      - name: Install pnpm
        uses: pnpm/action-setup@v2
        with:
          version: 8
` : "";

  return `name: CI

on:
  push:
    branches: [main, master]
  pull_request:
    branches: [main, master]

jobs:
  build:
    runs-on: ubuntu-latest

    strategy:
      matrix:
        node-version: [${nodeVersion}]

    steps:
      - name: Checkout repository
        uses: actions/checkout@v4
${pnpmSetup}
      - name: Setup Node.js \${{ matrix.node-version }}
        uses: actions/setup-node@v4
        with:
          node-version: \${{ matrix.node-version }}
          cache: '${cacheKey}'

      - name: Install dependencies
        run: ${installCmd}

      - name: Build
        run: ${pm === "npm" ? "npm run" : pm} build

      - name: Lint
        run: ${pm === "npm" ? "npm run" : pm} lint

      - name: Test
        run: ${pm === "npm" ? "npm" : pm} test
`;
}

function generatePythonCI(analysis: ProjectAnalysis): string {
  const pythonVersion = analysis.pythonVersion || "3.11";
  const usePoetry = analysis.packageManager === "poetry";

  const installStep = usePoetry
    ? `      - name: Install Poetry
        uses: snok/install-poetry@v1
        with:
          version: 1.7.0
          virtualenvs-create: true
          virtualenvs-in-project: true

      - name: Install dependencies
        run: poetry install`
    : `      - name: Install dependencies
        run: |
          python -m pip install --upgrade pip
          pip install -r requirements.txt
          pip install pytest ruff`;

  const runPrefix = usePoetry ? "poetry run " : "";

  return `name: CI

on:
  push:
    branches: [main, master]
  pull_request:
    branches: [main, master]

jobs:
  build:
    runs-on: ubuntu-latest

    strategy:
      matrix:
        python-version: ['${pythonVersion}']

    steps:
      - name: Checkout repository
        uses: actions/checkout@v4

      - name: Set up Python \${{ matrix.python-version }}
        uses: actions/setup-python@v5
        with:
          python-version: \${{ matrix.python-version }}

${installStep}

      - name: Lint with ruff
        run: ${runPrefix}ruff check .

      - name: Type check with mypy
        run: ${runPrefix}mypy .
        continue-on-error: true

      - name: Test with pytest
        run: ${runPrefix}pytest
`;
}

function generateRustCI(analysis: ProjectAnalysis): string {
  const rustEdition = analysis.rustEdition || "stable";

  return `name: CI

on:
  push:
    branches: [main, master]
  pull_request:
    branches: [main, master]

env:
  CARGO_TERM_COLOR: always

jobs:
  build:
    runs-on: ubuntu-latest

    steps:
      - name: Checkout repository
        uses: actions/checkout@v4

      - name: Install Rust toolchain
        uses: dtolnay/rust-action@stable
        with:
          toolchain: ${rustEdition}
          components: clippy, rustfmt

      - name: Cache cargo registry
        uses: actions/cache@v4
        with:
          path: |
            ~/.cargo/registry
            ~/.cargo/git
            target
          key: \${{ runner.os }}-cargo-\${{ hashFiles('**/Cargo.lock') }}

      - name: Check formatting
        run: cargo fmt --all -- --check

      - name: Clippy
        run: cargo clippy --all-targets --all-features -- -D warnings

      - name: Build
        run: cargo build --verbose

      - name: Run tests
        run: cargo test --verbose
`;
}

function generateGoCI(analysis: ProjectAnalysis): string {
  const goVersion = analysis.goVersion || "1.21";

  return `name: CI

on:
  push:
    branches: [main, master]
  pull_request:
    branches: [main, master]

jobs:
  build:
    runs-on: ubuntu-latest

    steps:
      - name: Checkout repository
        uses: actions/checkout@v4

      - name: Set up Go
        uses: actions/setup-go@v5
        with:
          go-version: '${goVersion}'

      - name: Cache Go modules
        uses: actions/cache@v4
        with:
          path: |
            ~/go/pkg/mod
            ~/.cache/go-build
          key: \${{ runner.os }}-go-\${{ hashFiles('**/go.sum') }}
          restore-keys: |
            \${{ runner.os }}-go-

      - name: Download dependencies
        run: go mod download

      - name: Verify dependencies
        run: go mod verify

      - name: Build
        run: go build -v ./...

      - name: Run golangci-lint
        uses: golangci/golangci-lint-action@v4
        with:
          version: latest

      - name: Test
        run: go test -v -race -coverprofile=coverage.txt -covermode=atomic ./...

      - name: Upload coverage
        uses: codecov/codecov-action@v4
        with:
          file: ./coverage.txt
          fail_ci_if_error: false
`;
}

function generateJavaCI(analysis: ProjectAnalysis): string {
  const javaVersion = analysis.javaVersion || "17";
  const useGradle = analysis.packageManager === "gradle";

  if (useGradle) {
    return `name: CI

on:
  push:
    branches: [main, master]
  pull_request:
    branches: [main, master]

jobs:
  build:
    runs-on: ubuntu-latest

    steps:
      - name: Checkout repository
        uses: actions/checkout@v4

      - name: Set up JDK ${javaVersion}
        uses: actions/setup-java@v4
        with:
          java-version: '${javaVersion}'
          distribution: 'temurin'
          cache: 'gradle'

      - name: Grant execute permission for gradlew
        run: chmod +x gradlew

      - name: Build with Gradle
        run: ./gradlew build

      - name: Run tests
        run: ./gradlew test

      - name: Upload test results
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: test-results
          path: build/reports/tests/
`;
  }

  return `name: CI

on:
  push:
    branches: [main, master]
  pull_request:
    branches: [main, master]

jobs:
  build:
    runs-on: ubuntu-latest

    steps:
      - name: Checkout repository
        uses: actions/checkout@v4

      - name: Set up JDK ${javaVersion}
        uses: actions/setup-java@v4
        with:
          java-version: '${javaVersion}'
          distribution: 'temurin'
          cache: 'maven'

      - name: Build with Maven
        run: mvn -B compile --file pom.xml

      - name: Run tests
        run: mvn -B test --file pom.xml

      - name: Package
        run: mvn -B package --file pom.xml -DskipTests

      - name: Upload artifact
        uses: actions/upload-artifact@v4
        with:
          name: package
          path: target/*.jar
`;
}

// ============================================================================
// Release Please Generator
// ============================================================================

/**
 * Generate Release Please configuration
 */
export function generateReleasePlease(language: SupportedLanguage): string {
  const releaseType = getReleasePleaseType(language);

  return `{
  "$schema": "https://raw.githubusercontent.com/googleapis/release-please/main/schemas/config.json",
  "release-type": "${releaseType}",
  "packages": {
    ".": {
      "changelog-path": "CHANGELOG.md",
      "release-type": "${releaseType}"
    }
  },
  "bump-minor-pre-major": true,
  "bump-patch-for-minor-pre-major": true,
  "include-component-in-tag": false,
  "include-v-in-tag": true
}
`;
}

function getReleasePleaseType(language: SupportedLanguage): string {
  switch (language) {
    case "node":
      return "node";
    case "python":
      return "python";
    case "rust":
      return "rust";
    case "go":
      return "go";
    case "java":
      return "maven";
    default:
      return "simple";
  }
}

/**
 * Generate Release Please GitHub Action workflow
 */
export function generateReleasePleaseWorkflow(): string {
  return `name: Release Please

on:
  push:
    branches:
      - main
      - master

permissions:
  contents: write
  pull-requests: write

jobs:
  release-please:
    runs-on: ubuntu-latest
    steps:
      - name: Release Please
        uses: googleapis/release-please-action@v4
        with:
          token: \${{ secrets.GITHUB_TOKEN }}
          config-file: release-please-config.json
          manifest-file: .release-please-manifest.json
`;
}

// ============================================================================
// Dependabot Generator
// ============================================================================

/**
 * Generate Dependabot configuration
 */
export function generateDependabot(language: SupportedLanguage): string {
  const ecosystem = getDependabotEcosystem(language);
  const directory = language === "java" ? "/" : "/";

  return `version: 2
updates:
  # ${capitalizeFirst(language)} dependencies
  - package-ecosystem: "${ecosystem}"
    directory: "${directory}"
    schedule:
      interval: "weekly"
      day: "monday"
      time: "09:00"
      timezone: "America/New_York"
    open-pull-requests-limit: 10
    commit-message:
      prefix: "chore(deps)"
    labels:
      - "dependencies"
      - "automerge"
    reviewers:
      - "your-team"
    groups:
      minor-and-patch:
        patterns:
          - "*"
        update-types:
          - "minor"
          - "patch"

  # GitHub Actions
  - package-ecosystem: "github-actions"
    directory: "/"
    schedule:
      interval: "weekly"
      day: "monday"
    commit-message:
      prefix: "chore(ci)"
    labels:
      - "ci"
      - "dependencies"
`;
}

function getDependabotEcosystem(language: SupportedLanguage): string {
  switch (language) {
    case "node":
      return "npm";
    case "python":
      return "pip";
    case "rust":
      return "cargo";
    case "go":
      return "gomod";
    case "java":
      return "maven";
    default:
      return "npm";
  }
}

function capitalizeFirst(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

// ============================================================================
// Issue Templates Generator
// ============================================================================

/**
 * Generate all GitHub Issue Templates
 */
export function generateIssueTemplates(): Record<string, string> {
  return {
    "bug.yml": generateBugTemplate(),
    "feature.yml": generateFeatureTemplate(),
    "docs.yml": generateDocsTemplate(),
    "support.yml": generateSupportTemplate(),
    "security.yml": generateSecurityTemplate(),
    "blank.yml": generateBlankTemplate(),
    "config.yml": generateIssueConfig(),
  };
}

function generateBugTemplate(): string {
  return `name: Bug Report
description: Report a bug or unexpected behavior
title: "[Bug]: "
labels: ["bug", "triage"]
assignees: []

body:
  - type: markdown
    attributes:
      value: |
        Thanks for taking the time to fill out this bug report!

  - type: textarea
    id: description
    attributes:
      label: Describe the bug
      description: A clear and concise description of what the bug is.
      placeholder: Tell us what you see!
    validations:
      required: true

  - type: textarea
    id: steps
    attributes:
      label: Steps to reproduce
      description: Steps to reproduce the behavior.
      placeholder: |
        1. Go to '...'
        2. Click on '...'
        3. Scroll down to '...'
        4. See error
    validations:
      required: true

  - type: textarea
    id: expected
    attributes:
      label: Expected behavior
      description: A clear and concise description of what you expected to happen.
    validations:
      required: true

  - type: textarea
    id: screenshots
    attributes:
      label: Screenshots
      description: If applicable, add screenshots to help explain your problem.

  - type: dropdown
    id: os
    attributes:
      label: Operating System
      options:
        - macOS
        - Windows
        - Linux
        - Other
    validations:
      required: true

  - type: input
    id: version
    attributes:
      label: Version
      description: What version are you running?
      placeholder: "v1.0.0"
    validations:
      required: true

  - type: textarea
    id: logs
    attributes:
      label: Relevant log output
      description: Please copy and paste any relevant log output.
      render: shell

  - type: checkboxes
    id: terms
    attributes:
      label: Checklist
      options:
        - label: I have searched existing issues to ensure this bug hasn't been reported
          required: true
        - label: I have provided all the information needed to reproduce this bug
          required: true
`;
}

function generateFeatureTemplate(): string {
  return `name: Feature Request
description: Suggest an idea for this project
title: "[Feature]: "
labels: ["enhancement", "triage"]
assignees: []

body:
  - type: markdown
    attributes:
      value: |
        Thank you for suggesting a feature! Please fill out the form below.

  - type: textarea
    id: problem
    attributes:
      label: Is your feature request related to a problem?
      description: A clear and concise description of what the problem is.
      placeholder: I'm always frustrated when...
    validations:
      required: false

  - type: textarea
    id: solution
    attributes:
      label: Describe the solution you'd like
      description: A clear and concise description of what you want to happen.
    validations:
      required: true

  - type: textarea
    id: alternatives
    attributes:
      label: Describe alternatives you've considered
      description: A clear and concise description of any alternative solutions or features you've considered.

  - type: dropdown
    id: priority
    attributes:
      label: Priority
      description: How important is this feature to you?
      options:
        - Nice to have
        - Important
        - Critical
    validations:
      required: true

  - type: textarea
    id: context
    attributes:
      label: Additional context
      description: Add any other context or screenshots about the feature request here.

  - type: checkboxes
    id: contribution
    attributes:
      label: Contribution
      options:
        - label: I would be willing to help implement this feature
          required: false
`;
}

function generateDocsTemplate(): string {
  return `name: Documentation
description: Report missing, incorrect, or unclear documentation
title: "[Docs]: "
labels: ["documentation"]
assignees: []

body:
  - type: markdown
    attributes:
      value: |
        Help us improve our documentation!

  - type: dropdown
    id: type
    attributes:
      label: Documentation issue type
      options:
        - Missing documentation
        - Incorrect documentation
        - Unclear documentation
        - Outdated documentation
        - Typo or grammatical error
    validations:
      required: true

  - type: input
    id: location
    attributes:
      label: Location
      description: Where is the documentation issue? (URL, file path, or section name)
      placeholder: https://example.com/docs/getting-started
    validations:
      required: true

  - type: textarea
    id: description
    attributes:
      label: Describe the issue
      description: What's wrong or missing? Be as specific as possible.
    validations:
      required: true

  - type: textarea
    id: suggestion
    attributes:
      label: Suggested improvement
      description: If you have a suggestion for how to fix or improve the documentation, please share it.

  - type: checkboxes
    id: contribution
    attributes:
      label: Contribution
      options:
        - label: I would be willing to submit a PR to fix this documentation issue
          required: false
`;
}

function generateSupportTemplate(): string {
  return `name: Support Request
description: Get help with using this project
title: "[Support]: "
labels: ["question", "support"]
assignees: []

body:
  - type: markdown
    attributes:
      value: |
        Need help? We're here to assist!

        Before submitting, please check:
        - [ ] The documentation
        - [ ] Existing issues and discussions
        - [ ] FAQ (if available)

  - type: textarea
    id: question
    attributes:
      label: What do you need help with?
      description: Describe what you're trying to accomplish and where you're stuck.
    validations:
      required: true

  - type: textarea
    id: tried
    attributes:
      label: What have you tried?
      description: What steps have you already taken to solve this?

  - type: textarea
    id: context
    attributes:
      label: Additional context
      description: |
        Add any other context about your situation.
        - What version are you using?
        - What environment are you running in?
        - Any relevant configuration?

  - type: dropdown
    id: urgency
    attributes:
      label: Urgency
      options:
        - Low - Just curious
        - Medium - Blocking non-critical work
        - High - Blocking critical work
    validations:
      required: true
`;
}

function generateSecurityTemplate(): string {
  return `name: Security Concern
description: Report a security-related issue (non-vulnerability)
title: "[Security]: "
labels: ["security"]
assignees: []

body:
  - type: markdown
    attributes:
      value: |
        **IMPORTANT**: If you are reporting a security vulnerability, please DO NOT use this form.
        Instead, please report it privately via our security policy (SECURITY.md) or email.

        This form is for general security-related discussions, questions, or non-critical concerns.

  - type: dropdown
    id: type
    attributes:
      label: Type of security concern
      options:
        - Security best practice question
        - Security hardening suggestion
        - Dependency security concern
        - Security documentation request
        - Other security discussion
    validations:
      required: true

  - type: textarea
    id: description
    attributes:
      label: Description
      description: Describe your security concern or question.
    validations:
      required: true

  - type: textarea
    id: context
    attributes:
      label: Additional context
      description: Add any other context about your concern.

  - type: checkboxes
    id: confirm
    attributes:
      label: Confirmation
      options:
        - label: I confirm this is NOT a security vulnerability that could be exploited
          required: true
        - label: I understand that vulnerabilities should be reported privately
          required: true
`;
}

function generateBlankTemplate(): string {
  return `name: Blank Issue
description: Create a blank issue for anything else
title: ""
labels: []
assignees: []

body:
  - type: markdown
    attributes:
      value: |
        Use this template for any issue that doesn't fit the other categories.

  - type: textarea
    id: content
    attributes:
      label: Description
      description: Describe your issue, question, or discussion topic.
    validations:
      required: true

  - type: textarea
    id: context
    attributes:
      label: Additional context
      description: Add any other context, screenshots, or information.
`;
}

function generateIssueConfig(): string {
  return `blank_issues_enabled: false
contact_links:
  - name: Discussions
    url: https://github.com/OWNER/REPO/discussions
    about: Ask questions and discuss ideas
  - name: Documentation
    url: https://github.com/OWNER/REPO#readme
    about: Read the documentation
`;
}

// ============================================================================
// Convenience Exports
// ============================================================================

/**
 * Generate all setup files for a project
 */
export interface GeneratedFiles {
  "CLAUDE.md": string;
  ".github/workflows/ci.yml": string;
  ".github/dependabot.yml": string;
  "release-please-config.json": string;
  ".github/workflows/release-please.yml": string;
  ".github/ISSUE_TEMPLATE/bug.yml": string;
  ".github/ISSUE_TEMPLATE/feature.yml": string;
  ".github/ISSUE_TEMPLATE/docs.yml": string;
  ".github/ISSUE_TEMPLATE/support.yml": string;
  ".github/ISSUE_TEMPLATE/security.yml": string;
  ".github/ISSUE_TEMPLATE/blank.yml": string;
  ".github/ISSUE_TEMPLATE/config.yml": string;
}

export function generateAllFiles(analysis: ProjectAnalysis): GeneratedFiles {
  const issueTemplates = generateIssueTemplates();

  return {
    "CLAUDE.md": generateClaudeMd(analysis),
    ".github/workflows/ci.yml": generateGitHubCI(analysis),
    ".github/dependabot.yml": generateDependabot(analysis.language),
    "release-please-config.json": generateReleasePlease(analysis.language),
    ".github/workflows/release-please.yml": generateReleasePleaseWorkflow(),
    ".github/ISSUE_TEMPLATE/bug.yml": issueTemplates["bug.yml"],
    ".github/ISSUE_TEMPLATE/feature.yml": issueTemplates["feature.yml"],
    ".github/ISSUE_TEMPLATE/docs.yml": issueTemplates["docs.yml"],
    ".github/ISSUE_TEMPLATE/support.yml": issueTemplates["support.yml"],
    ".github/ISSUE_TEMPLATE/security.yml": issueTemplates["security.yml"],
    ".github/ISSUE_TEMPLATE/blank.yml": issueTemplates["blank.yml"],
    ".github/ISSUE_TEMPLATE/config.yml": issueTemplates["config.yml"],
  };
}
