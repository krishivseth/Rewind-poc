---
name: Cleanup alert state persistence
description: Cleanup alert incident state lives in the database, claimed under a row lock; restarts and replicas must not re-announce unchanged incidents.
---

Cleanup alert deduplication is persisted in the `cleanup_monitor_state` table (one row per monitor), not in per-process memory. Monitors compare freshly computed health against the persisted state inside a `SELECT ... FOR UPDATE` transaction and only the instance that commits a changed state announces the transition.

**Why:** Per-process dedup meant every API restart or additional replica re-announced an unchanged incident. The row lock serializes concurrent monitors so a transition is announced exactly once.

**How to apply:** Any change to cleanup alerting must keep transitions inside the store's `transact` (never announce from in-memory comparisons) and keep notifications aggregate-only. Notifications are persisted to an outbox column (`pending_notifications`) in the same transaction that commits the state change, and acknowledged via `markDelivered` only after emission — so a crash between commit and send is re-announced by any live instance once the entry outlives its grace period (`PENDING_NOTIFICATION_GRACE_MS`, compared against the database clock). Fresh outbox entries belong to a live committer and must not be re-emitted, or concurrent instances would duplicate alerts. Never notify before the state commit. The in-memory store (`createMemoryCleanupAlertStateStore`) is for tests/defaults only; production wiring must pass the database-backed store.
