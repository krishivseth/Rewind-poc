---
name: Exact fork reconstruction
description: The fail-closed rule for reconstructing repository state when forking a Rewind trajectory.
---

Rewind must only start a fork when the selected step can be reconstructed from a durable Git bundle and verified commit. Historical trajectories without such a checkpoint must be rejected rather than rebuilt from the current seed plus partial snapshots.

**Why:** Partial snapshots do not represent untouched files or deletions, and seed repositories can change over time. Overlaying them can silently create a repository state that never existed.

**How to apply:** Any new import, migration, retention, or fork path must preserve a complete recoverable checkpoint at each supported fork boundary. If exact reconstruction cannot be proven, fail clearly before creating the child branch.