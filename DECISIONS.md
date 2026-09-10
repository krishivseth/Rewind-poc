# Rewind decisions

## Current implementation

- The workspace template provides a TypeScript Express API and React/Vite artifacts, so the first vertical slice uses those existing services rather than introducing a second runtime.
- Postgres is the source of truth for seed repositories, sessions, branches, and trajectory steps. File snapshot bytes are represented in step content for the seeded flow until git bundle storage is wired in.
- The debugger UI is intentionally dark, dense, monospace-forward, and single-accent. It is built around inspecting recorded state, not a marketing landing page.
- The initial model list uses OpenRouter-style ids and keeps the list in one backend constant so a later agent-loop implementation can replace ids without changing the UI contract.
- Live model calls use the user-provided `OPENROUTER_API_KEY` Replit Secret directly from the API server; the managed integration is not required.

## Follow-up phases

The production agent loop still needs tool execution, a git worktree/bundle layer, auth guards, SSE replay, and reserved-VM deployment configuration. Those are intentionally isolated from the seeded inspection surface so the app has a working debugger before live runs are enabled.