import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

const {
  cleanupMonitorState,
  createCleanupAlertStateStore,
  createCleanupMonitor,
  eq,
  pool,
} = await import("./.generated/test-support.mjs");

const monitorId = `snapshot_cleanup_test_${randomUUID()}`;
const store = createCleanupAlertStateStore(monitorId);

test.after(async () => {
  const client = await pool.connect();
  try {
    await client.query("delete from cleanup_monitor_state where id = $1", [monitorId]);
  } finally {
    client.release();
    await pool.end();
  }
});

function fixture() {
  let health = {
    pendingCount: 0,
    retryBackoffCount: 0,
    persistentFailureCount: 0,
    persistentFailureThreshold: 3,
    oldestQueuedAgeSeconds: null,
  };
  const events = [];
  const makeCheck = () => createCleanupMonitor(async () => health, {
    warn: (fields, message) => events.push({ level: "warn", ...fields, message }),
    info: (fields, message) => events.push({ level: "info", ...fields, message }),
  }, store);
  return {
    makeCheck,
    events,
    set: (patch) => { health = { ...health, ...patch }; },
  };
}

test("incident state persists across monitor restarts", async () => {
  const f = fixture();
  const first = f.makeCheck();
  f.set({ pendingCount: 1, persistentFailureCount: 1, oldestQueuedAgeSeconds: 600 });
  await first();
  assert.equal(f.events.length, 1);
  assert.equal(f.events[0].event, "snapshot_cleanup_alert");

  const persisted = await pool.query(
    "select active_reasons, health_unavailable from cleanup_monitor_state where id = $1",
    [monitorId],
  );
  assert.deepEqual(persisted.rows[0].active_reasons, ["persistent_failures"]);
  assert.equal(persisted.rows[0].health_unavailable, false);

  // A restarted monitor reloads persisted state and stays quiet.
  const restarted = f.makeCheck();
  await restarted();
  await restarted();
  assert.equal(f.events.length, 1);

  f.set({ pendingCount: 0, persistentFailureCount: 0, oldestQueuedAgeSeconds: null });
  await restarted();
  assert.equal(f.events.length, 2);
  assert.equal(f.events[1].event, "snapshot_cleanup_recovered");
  await first();
  assert.equal(f.events.length, 2);
});

test("concurrent instances claim an alert transition exactly once", async () => {
  const f = fixture();
  const monitors = [f.makeCheck(), f.makeCheck(), f.makeCheck()];
  f.set({ pendingCount: 3, persistentFailureCount: 2, oldestQueuedAgeSeconds: 100000 });
  await Promise.all(monitors.map((check) => check()));
  await Promise.all(monitors.map((check) => check()));
  assert.equal(f.events.length, 1);
  assert.equal(f.events[0].event, "snapshot_cleanup_alert");
  assert.deepEqual(f.events[0].reasons, ["persistent_failures", "queue_age"]);

  f.set({ pendingCount: 0, persistentFailureCount: 0, oldestQueuedAgeSeconds: null });
  await Promise.all(monitors.map((check) => check()));
  await Promise.all(monitors.map((check) => check()));
  assert.equal(f.events.length, 2);
  assert.equal(f.events[1].event, "snapshot_cleanup_recovered");
});

test("a crash between committing a transition and sending it does not lose the alert", async () => {
  // Zero grace: any persisted-but-undelivered entry is immediately
  // re-deliverable by the next health check.
  const crashStore = createCleanupAlertStateStore(monitorId, { gracePeriodMs: 0 });
  let health = {
    pendingCount: 1,
    retryBackoffCount: 0,
    persistentFailureCount: 1,
    persistentFailureThreshold: 3,
    oldestQueuedAgeSeconds: 600,
  };
  const events = [];
  let crashing = false;
  const makeCheck = () => createCleanupMonitor(async () => health, {
    warn: (fields, message) => {
      // The process dies after the state commit, before the log line lands.
      if (crashing) throw new Error("process died");
      events.push({ level: "warn", ...fields, message });
    },
    info: (fields, message) => events.push({ level: "info", ...fields, message }),
  }, crashStore);

  crashing = true;
  await assert.rejects(makeCheck()());
  assert.equal(events.length, 0);

  // The transition and the pending notification were committed atomically.
  const persisted = await pool.query(
    "select active_reasons, pending_notifications from cleanup_monitor_state where id = $1",
    [monitorId],
  );
  assert.deepEqual(persisted.rows[0].active_reasons, ["persistent_failures"]);
  assert.equal(persisted.rows[0].pending_notifications.length, 1);

  // A restarted process re-announces the committed-but-unsent alert exactly
  // once, then clears it from the outbox.
  crashing = false;
  const restarted = makeCheck();
  await restarted();
  assert.equal(events.length, 1);
  assert.equal(events[0].event, "snapshot_cleanup_alert");
  assert.equal(events[0].persistentFailureCount, 1);
  await restarted();
  await makeCheck()();
  assert.equal(events.length, 1);

  const cleared = await pool.query(
    "select pending_notifications from cleanup_monitor_state where id = $1",
    [monitorId],
  );
  assert.deepEqual(cleared.rows[0].pending_notifications, []);

  // Recovery after the crash is still announced exactly once.
  health = { ...health, pendingCount: 0, persistentFailureCount: 0, oldestQueuedAgeSeconds: null };
  await restarted();
  assert.equal(events.length, 2);
  assert.equal(events[1].event, "snapshot_cleanup_recovered");
});

test("a live committer's fresh pending notification is not duplicated", async () => {
  // Default grace period: a notification committed moments ago is assumed to
  // be mid-delivery by the instance that committed it, so another instance
  // must not re-emit it.
  const graceStore = createCleanupAlertStateStore(monitorId);
  const committed = await graceStore.transact((persisted) => ({
    next: { ...persisted, activeReasons: ["persistent_failures"] },
    out: {
      notifications: [{
        level: "warn",
        fields: { event: "snapshot_cleanup_alert" },
        message: "Snapshot cleanup requires operator attention",
      }],
    },
  }));
  assert.equal(committed.length, 1);
  // The committing process is still alive and about to emit; a concurrent
  // check sees the fresh outbox entry and stays quiet.
  const observer = await graceStore.transact((persisted) => ({ next: persisted, out: { notifications: [] } }));
  assert.equal(observer.length, 0);
  await graceStore.markDelivered(committed.map((notification) => notification.id));
  // Restore pristine shared state for subsequent tests.
  await graceStore.transact(() => ({
    next: { activeReasons: [], healthUnavailable: false },
    out: { notifications: [] },
  }));
});

test("health-unavailable state is shared across instances", async () => {
  const f = fixture();
  let failing = true;
  const events = [];
  const makeCheck = () => createCleanupMonitor(async () => {
    if (failing) throw new Error("database unreachable");
    return {
      pendingCount: 0,
      retryBackoffCount: 0,
      persistentFailureCount: 0,
      persistentFailureThreshold: 3,
      oldestQueuedAgeSeconds: null,
    };
  }, {
    warn: (fields, message) => events.push({ level: "warn", ...fields, message }),
    info: (fields, message) => events.push({ level: "info", ...fields, message }),
  }, store);
  const a = makeCheck();
  const b = makeCheck();
  await a();
  await b();
  assert.equal(events.length, 1);
  assert.equal(events[0].event, "snapshot_cleanup_health_unavailable");
  assert.ok(!JSON.stringify(events).includes("database unreachable"));

  failing = false;
  await b();
  await a();
  assert.equal(events.length, 2);
  assert.equal(events[1].event, "snapshot_cleanup_health_restored");
});
