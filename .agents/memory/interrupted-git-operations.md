---
name: Interrupted Git operations
description: Restart behavior relevant to retrying local Git bundle and worktree operations.
---

Treat the temporary filesystem as potentially containing leftovers from a previous process, including Git lock files.

**Why:** An interrupted bundle operation left a lock that prevented demo checkpoint initialization and stopped API startup after a workflow restart. Restarting a workflow does not guarantee a fresh temporary filesystem.

**How to apply:** Isolate retry attempts in uniquely allocated temporary directories and clean only paths owned by that attempt. Do not blindly remove another attempt's lock or restore repository; it may still be active.