import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import express from "express";
import { pool, router } from "./.generated/route-test-support.mjs";

const bundleKeys = [
  "/objects/rewind/bundles/private-route-fixture/new.bundle",
  "/objects/rewind/bundles/private-route-fixture/retry.bundle",
  "/objects/rewind/bundles/private-route-fixture/failed.bundle",
];
const deletionErrors = [
  "PRIVATE_RETRY_ERROR: storage credentials rejected for internal-bucket",
  "PRIVATE_DELETION_ERROR: internal storage endpoint denied object deletion",
];
const aggregateFields = [
  "pendingCount",
  "oldestQueuedAt",
  "oldestQueuedAgeSeconds",
  "retryBackoffCount",
  "persistentFailureCount",
  "persistentFailureThreshold",
  "state",
].sort();

function assertRedacted(text) {
  for (const secret of [...bundleKeys, ...deletionErrors]) {
    assert.equal(text.includes(secret), false, "HTTP response must not expose stored private data");
  }
  assert.doesNotMatch(text, /bundle_?key|last_?error|PRIVATE_/i);
}

test("cleanup status HTTP authentication and redaction", async (t) => {
  const client = await pool.connect();
  let server;
  let queryMock;
  try {
    await client.query("begin");
    // Shadow only this connection's queue, leaving development rows and workers untouched.
    await client.query(`
      create temporary table bundle_cleanup_queue
      (like public.bundle_cleanup_queue including defaults) on commit drop
    `);
    const queuedAt = new Date(Date.now() - 20 * 60_000);
    for (const [index, attempts] of [0, 1, 3].entries()) {
      await client.query(
        `insert into bundle_cleanup_queue (bundle_key, attempts, last_error, created_at)
         values ($1, $2, $3, $4)`,
        [bundleKeys[index], attempts, index === 0 ? null : deletionErrors[index - 1], queuedAt],
      );
    }
    // Keep the real aggregate query, but execute it on the isolated fixture connection.
    queryMock = t.mock.method(pool, "query", (...args) => client.query(...args));
    const app = express();
    app.use((req, _res, next) => {
      // Simulate Clerk's verified request context, not the application's auth guard.
      // This header is interpreted only by this local test server.
      req.auth = () => ({
        userId: req.headers["x-test-user"] === "signed-in" ? "user_route_test" : null,
        tokenType: "session_token",
      });
      // Clerk brands its auth accessor to distinguish it from other auth libraries.
      req.auth[Symbol.for("@clerk/express.auth")] = true;
      next();
    });
    // Mount the production router so removing/reordering requireAuth breaks the test.
    app.use("/api", router);
    server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const url = `http://127.0.0.1:${server.address().port}/api/ops/bundle-cleanup`;

    await t.test("unauthenticated requests receive 401 without querying cleanup data", async () => {
      const callsBefore = queryMock.mock.callCount();
      const response = await fetch(url);
      const text = await response.text();
      assert.equal(response.status, 401);
      assert.deepEqual(JSON.parse(text), { error: "Authentication required." });
      assertRedacted(text);
      assert.equal(queryMock.mock.callCount(), callsBefore);
    });

    await t.test("authenticated requests receive only aggregate status fields", async () => {
      const response = await fetch(url, { headers: { "x-test-user": "signed-in" } });
      const text = await response.text();
      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-type"), /application\/json/);
      assertRedacted(text);
      const status = JSON.parse(text);
      // An explicit allowlist catches new response properties, not just known secret values.
      assert.deepEqual(Object.keys(status).sort(), aggregateFields);
      assert.equal(status.pendingCount, 3);
      assert.equal(status.retryBackoffCount, 1);
      assert.equal(status.persistentFailureCount, 1);
      assert.equal(status.persistentFailureThreshold, 3);
      assert.equal(status.state, "persistent_failures");
      assert.equal(status.oldestQueuedAt, queuedAt.toISOString());
      assert.ok(Number.isInteger(status.oldestQueuedAgeSeconds));
      assert.ok(status.oldestQueuedAgeSeconds >= 1200);
      assert.ok(status.oldestQueuedAgeSeconds <= Math.ceil((Date.now() - queuedAt.getTime()) / 1000));
    });
  } finally {
    if (server) {
      server.closeAllConnections();
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
    queryMock?.mock.restore();
    try {
      await client.query("rollback");
    } finally {
      client.release();
      await pool.end();
    }
  }
});