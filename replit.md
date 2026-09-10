# Rewind

Rewind lets developers scrub through coding-agent trajectories, inspect exact context and file snapshots, and fork alternate branches from any recorded step.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `artifacts/rewind/src/App.tsx` — session archive and debugger workspace
- `artifacts/rewind/src/index.css` — Rewind dark workbench theme
- `artifacts/api-server/src/routes/rewind.ts` — session, branch, step, file, context, fork, and diff routes
- `artifacts/api-server/src/lib/rewind-seed.ts` — first-boot seeded repositories and trajectory
- `lib/db/src/schema/rewind.ts` — Postgres tables and enums
- `lib/api-spec/openapi.yaml` — source-of-truth API contract

## Architecture decisions

- The first vertical slice uses the workspace's existing TypeScript Express/React stack so the seeded debugger is runnable before the live agent loop is enabled.
- Session and trajectory records are durable in Postgres; the current seeded file snapshots are carried in step content.
- OpenRouter model ids are centralized in the API route and mirrored in the UI selectors.

## Product

Users can browse seeded coding-agent sessions, scrub individual steps, inspect context and file state, replay a trajectory, and create queued fork branches with a different model or edited prompt.

## User preferences

The product should remain dark, dense, monospace-forward, and focused on debugging rather than marketing.

## Gotchas

- Run API codegen after changing `lib/api-spec/openapi.yaml`.
- Restart the managed API and web workflows after backend or frontend changes.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
- See `DECISIONS.md` for the deliberate first-slice tradeoffs and follow-up phases.
