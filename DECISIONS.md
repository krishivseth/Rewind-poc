# Decisions

Choices the spec left open, and what this codebase does about them.

## Architecture

1. **TypeScript, Express, Drizzle.** The spec asked for Python and FastAPI; this repo is the Replit
   submission and keeps the Replit monorepo layout (`artifacts/api-server`, `artifacts/rewind`,
   `lib/db`). The one-process rule is honoured where it matters: the API server hosts the routes, the
   SSE streams and the agent workers. On Replit the frontend is a separate static artifact routed on
   `/`; off Replit the API server serves the built frontend itself.
2. **Reserved VM, not Autoscale.** Autoscale is request-scoped and scales to zero, which would kill
   running branches. `.replit` pins `deploymentTarget = "vm"`.
3. **Access key instead of Clerk.** Viewing is public; writes need `X-Rewind-Key`. Clerk and its
   proxy middleware were removed. `sessions.user_id` stays in the schema, unused, so the migration is
   additive.
4. **Additive schema only.** `drizzle-kit push` prompts on drops and renames, and Replit's post-merge
   hook runs it non-interactively. New columns (`branches.error`, `created_by`, `steps.note`,
   `sessions.root_branch_id`) were added; nothing was dropped. The earlier upload-intent and
   alert-state tables are gone from the schema but harmless if they linger in an old database.
5. **Storage abstraction.** `storage.ts` keys blobs by relative path. Local disk under `DATA_DIR` by
   default; with `PRIVATE_OBJECT_DIR` (Replit App Storage) the same keys go to the bucket. Replit
   deployments have an ephemeral filesystem, so the bucket is what makes bundles durable there.
6. **Sandbox python is a venv under DATA_DIR** with pytest and flask, built on first boot from
   whatever `python3` is on PATH (Replit's `python-base-3.12` module). Its bin is prepended to the
   sandbox `PATH`; the host's python is never assumed to have anything installed.

## Trajectory model

7. **System prompt is not a step.** It lives on the branch; step 0 is the user task. Context at step
   k is `[system] + content of steps 0..k`.
8. **`tool_call` rows are not messages.** The assistant row carries the full message including
   `tool_calls`; each call also gets its own row for the scrubber. Rebuilding the message array skips
   `tool_call` rows. `/context` on a `tool_call` row returns the owning assistant step's context and
   says so with `requested_index` vs `step_index`.
9. **Forks copy the parent's steps** up to the boundary, so context and scrubber work the same on
   root and fork branches. `fork_step_index` is the effective boundary; the fork endpoint returns
   `requested_step_index`, `fork_step_index` and `snapped`, and the tree hangs forks off the effective
   step. Inherited steps carry zero token counts and keep their notes.
10. **Boundary snapping.** A fork at a `tool_call` row, or a `tool_result` whose turn still has
    unanswered calls, moves back to the end of the previous complete round.
11. **`MAX_MODEL_CALLS` counts model calls**, not rows. Inherited rows never count against a fork.
12. **Every mutating tool call commits**, even a no-op (`--allow-empty`); `run` commits only if it
    dirtied the tree. Seed repos ignore caches and run pytest with `-p no:cacheprovider`.
13. **Token count in `/context`** is the prompt size reported by the next model call when there is
    one, else a chars/4 estimate, and the response says which.

## Sandbox

14. **Whitelist, then `ulimit`, then exec.** Commands come from `.rewind.json`, are split without a
    shell, and run under `/bin/sh -c 'ulimit -f/-u/-v ...; exec "$0" "$@"'` with only `PATH`,
    `HOME`=worktree and `PYTHONDONTWRITEBYTECODE` in the environment. Timeouts kill the process
    group. `ulimit -v` is Linux only.
15. **Paths** are rejected on `..`, on resolving outside the worktree, on any symlink component
    including the leaf, and under `.git/`. Absolute paths are allowed only if inside the worktree.
16. **`read_file` on a directory lists it.** Without this a model that guesses a wrong filename has
    no way to recover and tends to loop. Still four tools.
17. **`unshare -n` / `-rn`** is tried on Linux and re-probed every ten minutes; most containers
    refuse it and the sandbox keeps the host network. The boot log says which mode you got.
18. **Loop detection.** The same tool with the same arguments three times in a row appends a warning
    to the result; a fourth time fails the branch. Output is not part of the signature (test timings
    vary). An edit between two test runs resets the streak.

## Operations

19. **Run leases.** A running branch renews `lease_expires_at` every few minutes; boot fails every
    non-terminal branch (workers died with the process) and a five-minute sweep fails any whose lease
    lapsed. Surviving worktrees are bundled first so steps stay viewable.
20. **Deletion queues bundles** in `bundle_cleanup_queue` and drains it with retries, so a storage
    hiccup never leaks a bundle. There is no branch-level delete: removing a mid-tree node would
    orphan its forks.
21. **Rate limits and the queue are in memory.** One process by design; a restart resets them.
22. **Daily token cap** sums tokens of branches created since UTC midnight and is checked before
    every create or fork. Running branches finish.
23. **Retries** are the OpenAI SDK's own: 408/409/429/5xx and connection errors with backoff, four
    attempts; 402 and other 4xx fail the branch immediately.
24. **Model ids** were verified against OpenRouter's public model list on 2026-09-09.

## Frontend

25. **Bundled Monaco**, no CDN. IBM Plex Sans and Mono from Google Fonts with system fallbacks.
26. **Scrubber semantics.** Tick height encodes kind, a dot marks a commit, an accent bar marks a
    note, inherited steps on a fork are dimmed and the fork point is a dashed line. Selecting the last
    step while live means "follow along".
27. **One SSE subscription per live branch** in the session so the whole tree moves. Terminal status
    closes the stream and refetches once.
28. **Compare view** lines up every fork of one parent and marks the first step whose signature
    (kind, tool, arguments; for results, committed and errored) differs. Output and timing are never
    part of the signature.
29. **Home cards** show a branch-length graph: one bar per branch, from its fork step, as long as its
    step count, coloured by status.
30. **Model text is rendered** with a 40-line inline renderer: paragraphs, lists, code, bold, fences.
31. **Frontend tests** cover the pure logic only (divergence, step clamping, cache merging, fork
    labels); components are exercised by hand in the browser.
32. **Visual theme is the Replit design's**: near-black navy, teal primary, amber accent, Space
    Grotesk for prose, IBM Plex Mono for data, square corners, small uppercase tracked labels, dotted
    ground. Kind colours: task sky, model violet, call amber, result teal. Only the skin changed; the
    components and behaviour are the port's.
33. **A remembered pane width is ignored** when it would leave the centre pane under 800px of room;
    the default split applies instead. Narrow windows never lose the scrubber.
