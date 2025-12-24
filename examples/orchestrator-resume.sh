#!/bin/bash
# Hook: SessionStart - Check for active orchestration and remind Claude to resume
#
# Install: Copy to ~/.claude/hooks/orchestrator-resume.sh
# Make executable: chmod +x ~/.claude/hooks/orchestrator-resume.sh

# Check if we're in a project with an active orchestration
STATE_FILE=".claude/orchestrator/state.json"

if [ -f "$STATE_FILE" ]; then
    STATUS=$(cat "$STATE_FILE" | grep -o '"status":\s*"[^"]*"' | cut -d'"' -f4)

    if [ "$STATUS" = "in_progress" ]; then
        # Get some stats
        TOTAL=$(cat "$STATE_FILE" | grep -o '"status":' | wc -l)
        COMPLETED=$(cat "$STATE_FILE" | grep -o '"status":\s*"completed"' | wc -l)

        echo ""
        echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
        echo "🔄 ACTIVE ORCHESTRATION SESSION DETECTED"
        echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
        echo "Progress: $COMPLETED/$TOTAL features completed"
        echo ""
        echo "Use 'orchestrator_status' to see current state and resume work."
        echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
        echo ""
    fi
fi

exit 0
