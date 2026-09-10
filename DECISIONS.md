# Rewind decisions

## Current implementation

- The workspace template provides a TypeScript Express API and React/Vite artifacts, so the first vertical slice uses those existing services rather than introducing a second runtime.
- Postgres is the source of truth for seed repositories, sessions, branches, and trajectory steps. File snapshot bytes are represented in step content for the seeded flow until git bundle storage is wired in.
- The debugger UI is intentionally dark, dense, monospace-forward, and single-accent. It is built around inspecting recorded state, not a marketing landing page.
- The initial model list uses OpenRouter-style ids and keeps the list in one backend constant so a later agent-loop implementation can replace ids without changing the UI contract.
- Managed OpenRouter setup is currently blocked by the workspace plan, so the seeded trajectory remains usable without live model calls.

## Follow-up phases

The production agent loop still needs the git worktree/bundle layer, live model calls, auth guards, SSE replay, and reserved-VM deployment configuration. Those are intentionally isolated from the seeded inspection surface so the app has a working debugger before live runs are enabled.