---
name: Clerk route-test identities
description: Keeping HTTP authorization regression tests independent of live Clerk credentials without bypassing the application's guard.
---

Simulate only Clerk's verified identity boundary in route regression tests, not the application's authorization middleware. Check the installed SDK's request-context expectations when upgrading Clerk.

**Why:** Newer Clerk Express versions brand their auth accessor; assigning a plain function to the request can produce a middleware-missing 500 rather than exercise signed-in or signed-out behavior. This is a test-context incompatibility, not a reason to weaken production authentication.

**How to apply:** Keep the real production router and auth guard in request tests. Treat synthetic identities as test-only inputs, and do not interpret their passing tests as coverage of Clerk token verification or live sign-in.