#!/bin/sh
# PostToolUse hook (Edit|Write): format + lint the touched *.ts file.
# Exit 2 blocks the tool result and feeds stderr back to the agent so it can fix the file.
set -u

[ -n "${CLAUDE_PROJECT_DIR:-}" ] && cd "$CLAUDE_PROJECT_DIR"

file=$(jq -r '.tool_input.file_path // empty')

case "$file" in
  *.ts) ;;
  *) exit 0 ;;
esac

[ -f "$file" ] || exit 0

if ! out=$(pnpm exec prettier --write "$file" 2>&1); then
  echo "$out" >&2
  exit 2
fi

if ! out=$(pnpm exec eslint --fix "$file" 2>&1); then
  echo "$out" >&2
  exit 2
fi

exit 0
