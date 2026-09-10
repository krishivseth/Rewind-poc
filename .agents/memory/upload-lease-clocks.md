---
name: Upload lease clocks
description: Why orphan reconciliation must not use application wall time for upload ownership.
---

Use PostgreSQL time consistently to grant, consume, and expire upload ownership. Keep caller-supplied retention timestamps out of upload-lease decisions.

**Why:** A server clock jump can otherwise queue and delete a live upload before its object has finished appearing. A successful "not found" deletion would discard the only tracking record, allowing the later object to become permanently orphaned.

**How to apply:** When changing upload leases or cleanup scheduling, test with an API timestamp far ahead of database time. Force expiration in tests by changing the lease relative to PostgreSQL time instead of advancing the cleanup caller's clock.