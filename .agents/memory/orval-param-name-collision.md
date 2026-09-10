---
name: OpenAPI parameter naming
description: Avoiding generated Zod/type export collisions in this monorepo's Orval setup.
---

When an operation combines path parameters with query parameters, Orval can emit the same `OperationParams` name in both the generated Zod API file and generated types. Keep mixed parameter operations query-only when practical, or choose a contract shape that avoids the duplicate export.

**Why:** The generated barrel re-exports both files and TypeScript fails with TS2308 before any application code is checked.

**How to apply:** After changing the OpenAPI contract, run codegen immediately and inspect the generated barrel error before building routes or consumers.