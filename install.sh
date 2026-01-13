#!/bin/bash
set -e

# Claude Swarm Installer
# Usage: curl -fsSL https://raw.githubusercontent.com/cj-vana/claude-swarm/main/install.sh | bash

REPO_URL="https://github.com/cj-vana/claude-swarm.git"
INSTALL_DIR="${CLAUDE_SWARM_DIR:-$HOME/.claude-swarm}"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

print_step() {
    echo -e "${BLUE}==>${NC} $1"
}

print_success() {
    echo -e "${GREEN}✓${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}!${NC} $1"
}

print_error() {
    echo -e "${RED}✗${NC} $1"
}

# Check for required dependencies
check_dependencies() {
    print_step "Checking dependencies..."

    local missing=()

    if ! command -v node &> /dev/null; then
        missing+=("node")
    else
        # Check Node.js version (need 18+)
        NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
        if [ "$NODE_VERSION" -lt 18 ]; then
            print_error "Node.js 18+ required (found v$NODE_VERSION)"
            exit 1
        fi
        print_success "Node.js $(node -v)"
    fi

    if ! command -v npm &> /dev/null; then
        missing+=("npm")
    else
        print_success "npm $(npm -v)"
    fi

    if ! command -v git &> /dev/null; then
        missing+=("git")
    else
        print_success "git $(git --version | cut -d' ' -f3)"
    fi

    if ! command -v tmux &> /dev/null; then
        missing+=("tmux")
    else
        print_success "tmux $(tmux -V | cut -d' ' -f2)"
    fi

    if ! command -v claude &> /dev/null; then
        missing+=("claude (Claude Code CLI)")
    else
        print_success "claude CLI found"
    fi

    if [ ${#missing[@]} -ne 0 ]; then
        print_error "Missing required dependencies: ${missing[*]}"
        echo ""
        echo "Please install the missing dependencies:"
        for dep in "${missing[@]}"; do
            case $dep in
                "node"|"npm")
                    echo "  - Node.js 18+: https://nodejs.org/"
                    ;;
                "git")
                    echo "  - git: https://git-scm.com/"
                    ;;
                "tmux")
                    echo "  - tmux: brew install tmux (macOS) or apt install tmux (Linux)"
                    ;;
                "claude (Claude Code CLI)")
                    echo "  - Claude Code: https://claude.ai/code"
                    ;;
            esac
        done
        exit 1
    fi

    echo ""
}

# Clone or update the repository
clone_repo() {
    print_step "Installing claude-swarm to $INSTALL_DIR..."

    if [ -d "$INSTALL_DIR" ]; then
        print_warning "Directory exists, updating..."
        cd "$INSTALL_DIR"
        git fetch origin
        git reset --hard origin/main
    else
        git clone "$REPO_URL" "$INSTALL_DIR"
        cd "$INSTALL_DIR"
    fi

    print_success "Repository ready"
    echo ""
}

# Install npm dependencies and build
build_project() {
    print_step "Installing dependencies..."
    npm install --silent
    print_success "Dependencies installed"

    print_step "Building project..."
    npm run build --silent
    print_success "Build complete"
    echo ""
}

# Register MCP server with Claude Code
register_mcp() {
    print_step "Registering MCP server with Claude Code..."

    # Remove existing registration if present
    claude mcp remove claude-swarm --scope user 2>/dev/null || true

    # Add fresh registration
    claude mcp add claude-swarm --scope user -- node "$INSTALL_DIR/dist/index.js"

    print_success "MCP server registered"
    echo ""
}

# Install the /swarm skill
install_skill() {
    print_step "Installing /swarm skill..."

    SKILL_DIR="$HOME/.claude/skills/swarm"
    mkdir -p "$SKILL_DIR"
    cp "$INSTALL_DIR/skill/SKILL.md" "$SKILL_DIR/"

    print_success "Skill installed to $SKILL_DIR"
    echo ""
}

# Main installation
main() {
    echo ""
    echo -e "${BLUE}╔════════════════════════════════════════╗${NC}"
    echo -e "${BLUE}║${NC}     Claude Swarm Installer v0.1.0      ${BLUE}║${NC}"
    echo -e "${BLUE}╚════════════════════════════════════════╝${NC}"
    echo ""

    check_dependencies
    clone_repo
    build_project
    register_mcp
    install_skill

    echo -e "${GREEN}╔════════════════════════════════════════╗${NC}"
    echo -e "${GREEN}║${NC}     Installation Complete!             ${GREEN}║${NC}"
    echo -e "${GREEN}╚════════════════════════════════════════╝${NC}"
    echo ""
    echo "Claude Swarm has been installed to: $INSTALL_DIR"
    echo ""
    echo "Usage:"
    echo "  1. Open Claude Code in any project"
    echo "  2. Type /swarm to start orchestrating"
    echo ""
    echo "Or use the MCP tools directly:"
    echo "  - orchestrator_init: Initialize a new swarm session"
    echo "  - start_worker: Start a worker on a feature"
    echo "  - check_all_workers: Monitor worker progress"
    echo ""
    echo "Dashboard available at: http://localhost:3456 (when MCP server is active)"
    echo ""
}

main "$@"
