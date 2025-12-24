#!/bin/bash
# Hook: Stop - Prevent stopping if orchestration has incomplete features
#
# Install: Copy to ~/.claude/hooks/orchestrator-check-incomplete.sh
# Make executable: chmod +x ~/.claude/hooks/orchestrator-check-incomplete.sh
#
# This hook exits with code 2 to BLOCK Claude from stopping
# if there are still pending or in-progress features.

STATE_FILE=".claude/orchestrator/state.json"

if [ ! -f "$STATE_FILE" ]; then
    # No orchestration session, allow stop
    exit 0
fi

STATUS=$(cat "$STATE_FILE" | grep -o '"status":\s*"[^"]*"' | head -1 | cut -d'"' -f4)

if [ "$STATUS" != "in_progress" ]; then
    # Orchestration is complete, allow stop
    exit 0
fi

# Count features by status
PENDING=$(grep -o '"status":\s*"pending"' "$STATE_FILE" | wc -l)
IN_PROGRESS=$(grep -o '"status":\s*"in_progress"' "$STATE_FILE" | wc -l)

if [ "$PENDING" -gt 0 ] || [ "$IN_PROGRESS" -gt 0 ]; then
    echo "" >&2
    echo "⚠️  ORCHESTRATION IN PROGRESS - Cannot stop yet!" >&2
    echo "" >&2
    echo "   Pending features: $PENDING" >&2
    echo "   In-progress features: $IN_PROGRESS" >&2
    echo "" >&2
    echo "   Continue working with 'orchestrator_status' or use" >&2
    echo "   'orchestrator_reset' if you want to abort." >&2
    echo "" >&2

    # Exit code 2 blocks Claude from stopping
    exit 2
fi

# All features done, allow stop
exit 0
