# Rewind

Rewind is a time-travel debugger for coding-agent sessions. It records a trajectory as inspectable steps so a developer can move through the exact context and repository state, then fork a branch from any point and compare results.

## Run

```bash
pnpm install
pnpm --filter @workspace/db run push
pnpm --filter @workspace/api-server run dev
pnpm --filter @workspace/rewind run dev
```

The API is served at `/api`; the Rewind web app is served at `/`.

## Current surface

- Seeded `tiny-todo`, `csv-stats`, and `rate-limiter` repositories
- Session archive with real Postgres-backed seed data
- Three-pane debugger workspace with branch tree, timeline scrubber, step details, context inspection, file browsing, and diff entry point
- Fork form that persists queued child branches
- Live OpenRouter execution for new sessions and forks using the server-side `OPENROUTER_API_KEY` secret
- Typed OpenAPI-generated client and Zod contracts

## Architecture

```text
React/Vite Rewind UI
        |
        | generated React Query client
        v
Express API (/api)
        |
        +--> Drizzle ORM --> PostgreSQL
        |
        +--> future agent loop --> git worktrees --> object storage bundles
```

The current model loop records the user prompt and the model response as durable trajectory steps. Tool execution, git worktrees, durable git bundles, streaming updates, and authentication are the next phase.