---
name: Snapshot retention locking
description: Concurrency rules that prevent retention cleanup from deleting snapshots while forks or runs make them live.
---

Session retirement and cross-session fork creation must use the same session-row lock. Bundle objects must be queued transactionally with session data removal, then deleted only after a fresh global branch-and-step reference check. Active runs need durable, renewable leases so crashes do not preserve expired sessions forever.

**Why:** Without a shared lock, cleanup can observe no child fork and remove the parent while a concurrent fork establishes that dependency. Without durable leases, crashed runs remain active indefinitely and defeat retention.

**How to apply:** Any path that creates cross-session branch dependencies must lock and revalidate the source session. Any cleanup change must preserve retry records, rotate failures, and distinguish leased live runs from abandoned statuses.