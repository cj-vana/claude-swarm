#!/bin/bash
cd /opt/claude-swarm

# Kill any stuck processes
pkill -9 -f "gh repo fork" 2>/dev/null
sleep 1

# Add fork remote if not exists
if ! git remote get-url fork &>/dev/null; then
    git remote add fork https://github.com/jeffersonwarrior/claude-swarm.git
fi

# Show remotes
echo "=== Remotes ==="
git remote -v

# Push current branch to fork
echo ""
echo "=== Pushing feature/test-coverage to fork ==="
git push -u fork feature/test-coverage
