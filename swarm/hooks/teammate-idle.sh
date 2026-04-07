#!/usr/bin/env bash
# Hook for Claude Code Agent Teams TeammateIdle event.
# When a domain lead finishes all their tasks, this hook
# suggests they check for cross-domain overflow work.
#
# Exit codes:
#   0 = allow idle (no more work available)
#   2 = send feedback (suggest cross-domain tasks)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../../../.." && pwd)"
SWARM_DIR="$PROJECT_ROOT/.swarm"

# Check if plan.json exists with remaining tasks
if [ -f "$SWARM_DIR/plan.json" ]; then
  echo "Your domain is complete. Check the shared task list for unblocked tasks from other domains."
  echo "If you see available tasks you can help with, claim them."
  echo "If no tasks are available, you can shut down."
  exit 2
fi

echo "No swarm plan found. Teammate can go idle."
exit 0
