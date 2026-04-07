#!/usr/bin/env bash
# Quality gate hook for Claude Code Agent Teams.
# Delegates to TypeScript enforcement gate when available.
# Falls back to configured verification commands only when the TypeScript hook
# cannot be launched.
#
# Exit codes:
#   0 = allow (all checks passed)
#   2 = reject (one or more checks failed)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../../../.." && pwd)"
WORKTREE_ROOT="${WYVERN_WORKTREE:-$PROJECT_ROOT}"
TS_HOOK="$PROJECT_ROOT/cmdctrl/wyvern/src/swarm/hooks/task-completed.ts"

# Delegate to TypeScript version if available
if [ -f "$TS_HOOK" ] && command -v npx &>/dev/null; then
  exec npx tsx "$TS_HOOK"
fi

# Fallback: run configured verify commands from wyvern.config.json
cd "$WORKTREE_ROOT"

echo "=== Quality Gate: Task Completed ==="
echo "Running fallback verification..."

CONFIG_FILE="$PROJECT_ROOT/wyvern.config.json"
if [ -f "$CONFIG_FILE" ] && command -v node &>/dev/null; then
  VERIFY_CMDS=$(node -e "
    const c = require('$CONFIG_FILE');
    const cmds = c.verify || [];
    cmds.forEach(cmd => console.log(cmd));
  " 2>/dev/null)

  if [ -n "$VERIFY_CMDS" ]; then
    while IFS= read -r cmd; do
      echo "Running: $cmd"
      if ! eval "$cmd" 2>&1; then
        echo ""
        echo "VERIFICATION FAILED — task cannot be marked complete."
        echo "Command failed: $cmd"
        exit 2
      fi
    done <<< "$VERIFY_CMDS"
  else
    echo "WARNING: No verify commands configured. Skipping verification."
  fi
else
  echo "WARNING: No wyvern.config.json found. Skipping verification."
fi

echo ""
echo "=== Quality Gate PASSED ==="
exit 0
