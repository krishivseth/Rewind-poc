---
name: ESM integration-test bundles
description: Constraints for bundling API integration-test support that imports database and logging runtime packages.
---

ESM test-support bundles must leave CommonJS-heavy runtime packages such as database drivers and loggers external. Under pnpm, an external package must also resolve from the generated output's directory; use an explicit external module path when it is not a direct dependency of that package.

**Why:** Bundling these packages can turn their dynamic built-in-module requires into unsupported ESM shims, while bare external imports can fail under pnpm's strict dependency isolation.

**How to apply:** When expanding bundled integration-test support to import server modules, externalize affected runtime packages and verify resolution from the generated bundle location before adding duplicate dependencies.