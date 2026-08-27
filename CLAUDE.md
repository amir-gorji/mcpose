@AGENTS.md

## Claude Code specifics

The `mcpose-audit-invariants` skill in `.claude/skills/` auto-applies when you touch `packages/audit` or `packages/testing`.
Let it load rather than working from memory.

A `PostToolUse` hook formats and lints every `.ts` file you edit and blocks the tool result on failure.
When it blocks, fix the reported file: do not retry the same write.
