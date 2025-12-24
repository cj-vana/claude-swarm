# Contributing to Claude Swarm

Thank you for your interest in contributing! This document provides guidelines and instructions for contributing.

## Getting Started

1. Fork the repository
2. Clone your fork:
   ```bash
   git clone https://github.com/YOUR_USERNAME/claude-swarm.git
   cd claude-swarm
   ```
3. Install dependencies:
   ```bash
   npm install
   ```
4. Build the project:
   ```bash
   npm run build
   ```

## Development Workflow

### Running in Development Mode

```bash
npm run dev
```

This starts TypeScript in watch mode for automatic recompilation.

### Testing with MCP Inspector

```bash
npm run inspector
```

This launches the MCP Inspector for testing tool calls interactively.

### Code Style

- Use TypeScript for all source files
- Follow existing code patterns and naming conventions
- Use meaningful variable and function names
- Add comments for complex logic

## Making Changes

### Branch Naming

- `feature/description` - New features
- `fix/description` - Bug fixes
- `docs/description` - Documentation updates
- `refactor/description` - Code refactoring

### Commit Messages

Follow conventional commits:

```
type(scope): description

[optional body]
```

Types:
- `feat` - New feature
- `fix` - Bug fix
- `docs` - Documentation
- `refactor` - Code refactoring
- `test` - Adding tests
- `chore` - Maintenance

Examples:
```
feat(dashboard): add dark mode toggle
fix(worker): handle tmux session cleanup
docs(readme): update installation instructions
```

## Pull Request Process

1. Create a feature branch from `main`
2. Make your changes
3. Ensure the build passes: `npm run build`
4. Update documentation if needed
5. Submit a pull request

### PR Checklist

- [ ] Code compiles without errors (`npm run build`)
- [ ] Changes are documented in README if applicable
- [ ] Commit messages follow conventions
- [ ] PR description explains the changes

## Reporting Issues

### Bug Reports

Please include:
- Description of the bug
- Steps to reproduce
- Expected behavior
- Actual behavior
- Environment (OS, Node version, Claude Code version)
- Relevant logs or screenshots

### Feature Requests

Please include:
- Description of the feature
- Use case / motivation
- Proposed implementation (optional)

## Code of Conduct

- Be respectful and inclusive
- Focus on constructive feedback
- Help others learn and grow

## Questions?

Open an issue with the "question" label or start a discussion.

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
