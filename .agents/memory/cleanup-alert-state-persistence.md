---
name: Cleanup alert state persistence
description: Cleanup alert incident state lives in the database, claimed under a row lock; restarts and replicas must not re-announce unchanged incidents.
---

Cleanup alert deduplication is persisted in the `cleanup_monitor_state` table (one row per monitor), not in per-process memory. Monitors compare freshly computed health against the persisted state inside a `SELECT ... FOR UPDATE` transaction and only the instance that commits a changed state announces the transition.

**Why:** Per-process dedup meant every API restart or additional replica re-announced an unchanged incident. The row lock serializes concurrent monitors so a transition is announced exactly once.

**How to apply:** Any change to cleanup alerting must keep transitions inside the store's `transact` (never announce from in-memory comparisons) and keep notifications aggregate-only. Notifications are sent after the state commit, so a crash in between can drop one alert — do not "fix" this by notifying before commit, which would reintroduce duplicate announcements. The in-memory store (`createMemoryCleanupAlertStateStore`) is for tests/defaults only; production wiring must pass the database-backed store.
