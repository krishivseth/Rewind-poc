# Rewind

Rewind records a coding agent's session as a full trajectory. Scrub back to any step, inspect the
exact repository state and the exact messages the model saw, fork from that step with a different
model or an edited prompt, and watch the new branch run beside the original. Branches render as a
tree, any two can be diffed, and every fork of a branch can be lined up to find where they diverged.

TypeScript end to end: an Express API server that also hosts the agent workers and the SSE streams,
Drizzle on Postgres, and a React + Vite frontend with Monaco. Built to run on Replit as two
artifacts (API on `/api`, static web on `/`) on a Reserved VM, or anywhere else as one Node process.

## Run it

Replit: add the secrets `OPENROUTER_API_KEY` and `REWIND_ACCESS_KEY`, provision the Postgres module
(`DATABASE_URL` is set for you), then Run. Deploy as a **Reserved VM**: branches run for minutes
inside the API process, so Autoscale would kill them between requests.

Locally:

```bash
docker run -d --name rewind-pg -p 5432:5432 -e POSTGRES_PASSWORD=rewind postgres:16
docker exec rewind-pg psql -U postgres -c 'create database rewind'
export DATABASE_URL=postgresql://postgres:rewind@localhost:5432/rewind
export OPENROUTER_API_KEY=sk-or-... REWIND_ACCESS_KEY=devkey
pnpm install
pnpm --filter @workspace/db run push                 # create the tables
pnpm --filter @workspace/api-server run dev          # API + workers on :8080
pnpm --filter @workspace/rewind run dev              # UI on :5173, proxies /api to :8080
```

The API server needs `git` and a `python3` on PATH; on first boot it builds a small venv with pytest
and flask under `DATA_DIR` for the seed repos' tests (Replit's `python-base-3.12` module provides
python). Viewing is public. Creating a session, forking, cancelling, deleting and notes ask for the
access key once per browser tab.

Seed the three demo sessions (spends about a cent; uses the full hourly write quota of 10 branches):

```bash
pnpm --filter @workspace/api-server run build
REWIND_ACCESS_KEY=devkey pnpm --filter @workspace/api-server run seed
```

Tests (need `DATABASE_URL` or a local Postgres for the `rewind_ts_test` database):

```bash
pnpm --filter @workspace/db run push  # once, with DATABASE_URL pointing at rewind_ts_test
pnpm --filter @workspace/api-server test     # 21 tests: roundtrip, sandbox, HTTP API
pnpm --filter @workspace/rewind test         # 9 unit tests on the frontend's pure logic
```

## How it works

```
 browser ── React + Vite ─────────────────────────────────────────────────────┐
   │  GET /api/...  (TanStack Query)        EventSource /api/branches/{id}/events
   ▼                                                                          ▼
 ┌──────────────────────── one Node process (api-server) ───────────────────────┐
 │ Express routes ──► services ──► Postgres (repos, sessions, branches, steps)  │
 │      │                             ▲                                         │
 │      │ POST /sessions, /fork       │ every step is a row: the exact message  │
 │      ▼                             │                                         │
 │ scheduler (≤4 running, FIFO) ──► runBranch()  ──► pubsub ──► SSE            │
 │                                     │                                        │
 │                     while not done: │ chat.completions(messages, 4 tools)    │
 │                                     ▼                                        │
 │                     tools: read_file · write_file · edit_file · run("test")  │
 │                                     │ each mutation = git commit             │
 │                                     ▼                                        │
 │             /tmp/rewind/branches/{branch_id}   (scratch worktree)            │
 │                                     │ on finish: git bundle --all            │
 │                                     ▼                                        │
 │   DATA_DIR/storage/bundles/{id}.bundle, or Replit App Storage when           │
 │   PRIVATE_OBJECT_DIR is set                                                  │
 │                                     │ on view: restore, git show {commit}:p  │
 │                                     ▼                                        │
 │             /tmp/rewind/restores/{branch_id}   (10-minute cache)             │
 └──────────────────────────────────────────────────────────────────────────────┘
```

- **Recording.** The agent loop is a plain loop over an OpenAI-compatible chat completions API with
  four tools. We own the message array, so every message is stored exactly as sent or received. The
  context at step *k* is the system prompt plus the content of steps 0..*k*.
- **Commits.** Every file-mutating tool call is a git commit in the branch's worktree. Viewers never
  read the working tree; files come from `git show` at the step's commit.
- **Forking.** Copy the parent's steps up to the requested step (snapped back to the last point where
  the model's context was complete), restore the parent's history at that commit, and start the loop
  with a different model or an edited task. Five identical forks show how much the model diverges;
  the compare view marks the first step where they differ.
- **Durability.** Worktrees are scratch. Postgres holds the trajectory; bundles hold the git history.
  Each running branch renews a lease; if the process dies, the next boot or sweep fails the branch
  and keeps its steps viewable.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `DATABASE_URL` | required | Postgres |
| `OPENROUTER_API_KEY` | | Required to run branches |
| `REWIND_ACCESS_KEY` | | Required in `X-Rewind-Key` for writes |
| `DATA_DIR` | `./data` | Bundles, the sandbox venv |
| `PRIVATE_OBJECT_DIR` | | Set by Replit App Storage; bundles go to the bucket instead of disk |
| `PORT` | `8080` | API server port |

### Limits

| Variable | Default | What happens when hit |
| --- | --- | --- |
| `MAX_MODEL_CALLS` | 30 | Branch fails with "max steps hit"; disk state is committed and bundled |
| `MAX_OUTPUT_TOKENS_PER_CALL` | 4000 | Passed as `max_tokens` |
| `MAX_TOTAL_TOKENS_PER_BRANCH` | 150000 | Branch fails with "token limit hit" |
| `WALL_CLOCK_SECONDS_PER_BRANCH` | 600 | Branch fails with "wall clock limit hit" |
| `REWIND_DAILY_TOKEN_CAP` | 2000000 | New sessions and forks return 429 until UTC midnight |
| `MAX_CONCURRENT_BRANCHES` | 4 | Others queue; queue position is shown on the branch |
| `RATE_LIMIT_BRANCHES_PER_HOUR` | 10 | Per access key and per IP, in memory |
| `LOOP_WARN_AFTER` / `LOOP_FAIL_AFTER` | 3 / 4 | Identical call+args N times in a row: warn the model, then fail |
| `RUN_TIMEOUT_SECONDS` | 60 | `run` kills the process group |
| `TOOL_OUTPUT_LIMIT` | 20000 | Tool output truncation, in characters |
| `SANDBOX_MAX_FILE_MB` / `SANDBOX_MAX_PROCS` / `SANDBOX_MAX_MEMORY_MB` | 64 / 256 / 2048 | `ulimit` on the sandbox shell (memory limit Linux only) |
| `RUN_LEASE_SECONDS` | 900 | A branch whose lease lapses is failed by the sweep |

Models live in `artifacts/api-server/src/lib/config.ts`. Five OpenRouter models; DeepSeek V4 Flash is
the cheap one and is used by the seed script.

## Seed repositories

- **tiny-todo**: a Flask todo API with tests. Task: add a DELETE route with a test.
- **csv-stats**: a CSV statistics CLI with two deliberate bugs and two failing tests.
- **rate-limiter**: a token bucket with a check-then-act race and a failing concurrency test.
- **blank**: an empty Python project with pytest, for tasks that build something from scratch.

Each has a `.rewind.json` naming the only commands the agent may run.

## Keyboard

`←` `→` step · `Home` `End` jump · `F` fork · `D` diff mode · `C` context · `Esc` close

## Known limitations

- **The agent can execute arbitrary code.** `run("test")` restricts the command string; pytest then
  imports whatever the agent wrote, as the server user. The sandbox scrubs the environment (only
  `PATH`, `HOME`=worktree, `PYTHONDONTWRITEBYTECODE`; no secrets), applies `ulimit` on file size,
  process count and memory, kills the process group after 60s, and tries `unshare -n` on Linux. It
  does not hide the filesystem or, without `unshare`, the network. Anyone holding
  `REWIND_ACCESS_KEY` can run code on the host.
- Everything is publicly viewable; the access key gates only writes.
- Rate limits and the run queue are in-process and reset on restart. Run one instance.

See `DECISIONS.md` for every choice the spec left open.
