import assert from "node:assert/strict";
import test from "node:test";
import {
  CLEANUP_QUEUE_AGE_ALERT_SECONDS as threshold,
  PENDING_NOTIFICATION_GRACE_MS,
  createCleanupMonitor,
  createMemoryCleanupAlertStateStore,
} from "./.generated/cleanup-alerts.mjs";

function fixture(store = createMemoryCleanupAlertStateStore()) {
  let health = {
    pendingCount: 0,
    retryBackoffCount: 0,
    persistentFailureCount: 0,
    persistentFailureThreshold: 3,
    oldestQueuedAgeSeconds: null,
  };
  const events = [];
  const makeCheck = () => createCleanupMonitor(async () => {
    if (health instanceof Error) throw health;
    return health;
  }, {
    warn: (fields, message) => events.push({ level: "warn", ...fields, message }),
    info: (fields, message) => events.push({ level: "info", ...fields, message }),
  }, store);
  return {
    check: makeCheck(),
    makeCheck,
    events,
    set: (patch) => { health = { ...health, ...patch }; },
    fail: () => { health = new Error("Private /objects/secret-key"); },
  };
}

test("normal startup and ordinary retries do not notify", async () => {
  const f = fixture();
  await f.check();
  f.set({ pendingCount: 2, retryBackoffCount: 2, oldestQueuedAgeSeconds: threshold - 1 });
  await f.check();
  assert.deepEqual(f.events, []);
});

test("persistent failures notify immediately, deduplicate hourly, recover and re-arm", async () => {
  const f = fixture();
  f.set({ pendingCount: 1, persistentFailureCount: 1, oldestQueuedAgeSeconds: 600 });
  await f.check();
  f.set({ pendingCount: 3, persistentFailureCount: 3, oldestQueuedAgeSeconds: 7200 });
  for (let i = 0; i < 12; i++) await f.check();
  assert.equal(f.events.length, 1);
  assert.equal(f.events[0].level, "warn");
  assert.deepEqual(f.events[0].reasons, ["persistent_failures"]);
  assert.equal(f.events[0].persistentFailureCount, 1);
  // Normal can include young queued items with transient retries.
  f.set({ persistentFailureCount: 0, retryBackoffCount: 3 });
  await f.check();
  await f.check();
  assert.equal(f.events.length, 2);
  assert.equal(f.events[1].event, "snapshot_cleanup_recovered");
  assert.equal(f.events[1].level, "info");
  f.set({ persistentFailureCount: 1 });
  await f.check();
  assert.equal(f.events.length, 3);
  assert.equal(f.events[2].event, "snapshot_cleanup_alert");
});

test("age threshold is inclusive; a new reason escalates without premature recovery", async () => {
  const f = fixture();
  f.set({ pendingCount: 1, oldestQueuedAgeSeconds: threshold - 1 });
  await f.check();
  assert.equal(f.events.length, 0);
  f.set({ oldestQueuedAgeSeconds: threshold });
  await f.check();
  assert.deepEqual(f.events[0].reasons, ["queue_age"]);
  f.set({ persistentFailureCount: 1 });
  await f.check();
  assert.deepEqual(f.events[1].reasons, ["persistent_failures", "queue_age"]);
  f.set({ persistentFailureCount: 0 });
  await f.check();
  await f.check();
  assert.equal(f.events.length, 2);
  f.set({ pendingCount: 0, oldestQueuedAgeSeconds: null });
  await f.check();
  assert.equal(f.events[2].event, "snapshot_cleanup_recovered");
  assert.equal(f.events[2].oldestQueuedAgeSeconds, null);
});

test("notifications allowlist aggregate fields, dropping private keys and raw errors", async () => {
  const f = fixture();
  f.set({
    pendingCount: 7,
    persistentFailureCount: 2,
    retryBackoffCount: 3,
    oldestQueuedAgeSeconds: 1234,
    bundleKey: "/objects/secret-key",
    lastError: "Failed to delete /objects/secret-key",
    rows: [{ bundleKey: "/objects/secret-key" }],
  });
  await f.check();
  assert.deepEqual(f.events[0], {
    level: "warn",
    message: "Snapshot cleanup requires operator attention",
    event: "snapshot_cleanup_alert",
    reasons: ["persistent_failures"],
    pendingCount: 7,
    persistentFailureCount: 2,
    retryBackoffCount: 3,
    persistentFailureThreshold: 3,
    oldestQueuedAgeSeconds: 1234,
    queueAgeThresholdSeconds: threshold,
  });
});

test("a restarted monitor does not re-announce an unchanged incident", async () => {
  const store = createMemoryCleanupAlertStateStore();
  const f = fixture(store);
  f.set({ pendingCount: 1, persistentFailureCount: 1, oldestQueuedAgeSeconds: 600 });
  await f.check();
  assert.equal(f.events.length, 1);
  assert.equal(f.events[0].event, "snapshot_cleanup_alert");

  // Simulate a restart (or a second instance): a fresh monitor sharing the
  // persisted state. The ongoing incident must not be announced again.
  const restarted = f.makeCheck();
  await restarted();
  await restarted();
  assert.equal(f.events.length, 1);

  // Recovery is still announced exactly once, by whichever instance sees it.
  f.set({ pendingCount: 0, persistentFailureCount: 0, oldestQueuedAgeSeconds: null });
  await restarted();
  assert.equal(f.events.length, 2);
  assert.equal(f.events[1].event, "snapshot_cleanup_recovered");
  await f.check();
  assert.equal(f.events.length, 2);

  // A new incident after the restart re-arms alerting.
  f.set({ pendingCount: 1, persistentFailureCount: 2 });
  await restarted();
  assert.equal(f.events.length, 3);
  assert.equal(f.events[2].event, "snapshot_cleanup_alert");
  assert.equal(f.events[2].persistentFailureCount, 2);
});

test("concurrent monitors sharing persisted state announce a transition once", async () => {
  const store = createMemoryCleanupAlertStateStore();
  const f = fixture(store);
  const replica = f.makeCheck();
  f.set({ pendingCount: 2, persistentFailureCount: 1, oldestQueuedAgeSeconds: 900 });
  for (let i = 0; i < 5; i++) {
    await Promise.all([f.check(), replica()]);
  }
  assert.equal(f.events.length, 1);
  assert.equal(f.events[0].event, "snapshot_cleanup_alert");

  f.set({ pendingCount: 0, persistentFailureCount: 0, oldestQueuedAgeSeconds: null });
  await Promise.all([f.check(), replica()]);
  await Promise.all([f.check(), replica()]);
  assert.equal(f.events.length, 2);
  assert.equal(f.events[1].event, "snapshot_cleanup_recovered");
});

test("a crash between committing a transition and sending it does not lose the alert", async () => {
  let clock = 1_000_000_000;
  const store = createMemoryCleanupAlertStateStore(undefined, { now: () => clock });
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
  }, store);

  crashing = true;
  await assert.rejects(makeCheck()());
  assert.equal(events.length, 0);

  // A restart within the grace period stays quiet: the entry may still be
  // mid-delivery by a live committer, so it must not be duplicated.
  crashing = false;
  const restarted = makeCheck();
  await restarted();
  assert.equal(events.length, 0);

  // Once the grace period passes with no delivery, the committed-but-unsent
  // alert is re-announced exactly once.
  clock += PENDING_NOTIFICATION_GRACE_MS + 1;
  await restarted();
  assert.equal(events.length, 1);
  assert.equal(events[0].event, "snapshot_cleanup_alert");
  await restarted();
  assert.equal(events.length, 1);

  // Recovery after the crash is still announced exactly once.
  health = { ...health, pendingCount: 0, persistentFailureCount: 0, oldestQueuedAgeSeconds: null };
  await restarted();
  assert.equal(events.length, 2);
  assert.equal(events[1].event, "snapshot_cleanup_recovered");
});

test("a failed delivery acknowledgement re-emits the alert instead of losing it", async () => {
  // Zero grace: an unacknowledged entry is re-deliverable on the next check.
  const inner = createMemoryCleanupAlertStateStore(undefined, { gracePeriodMs: 0 });
  let ackFails = true;
  const store = {
    transact: (update) => inner.transact(update),
    markDelivered: async (ids) => {
      if (ackFails) throw new Error("connection reset");
      return inner.markDelivered(ids);
    },
  };
  const f = fixture(store);
  f.set({ pendingCount: 1, persistentFailureCount: 1, oldestQueuedAgeSeconds: 600 });
  await f.check();
  assert.equal(f.events.length, 1);

  // The acknowledgement was lost, so the alert is re-emitted (a duplicate log
  // line) rather than never delivered.
  ackFails = false;
  await f.makeCheck()();
  assert.equal(f.events.length, 2);
  assert.equal(f.events[1].event, "snapshot_cleanup_alert");
  await f.check();
  assert.equal(f.events.length, 2);
});

test("an unreachable state store warns once per process and never leaks errors", async () => {
  const privateKey = "/objects/secret-key";
  const failingStore = {
    transact: async () => { throw new Error(`connection reset by ${privateKey}`); },
  };
  const f = fixture(failingStore);
  await f.check();
  await f.check();
  assert.equal(f.events.length, 1);
  assert.equal(f.events[0].event, "snapshot_cleanup_monitor_state_unavailable");
  assert.ok(!JSON.stringify(f.events).includes("secret-key"));
});

test("unreadable health deduplicates, preserves incident state, and never leaks errors", async () => {
  const f = fixture();
  f.set({ pendingCount: 1, persistentFailureCount: 1 });
  await f.check();
  f.fail();
  await f.check();
  await f.check();
  assert.equal(f.events.length, 2);
  assert.equal(f.events[1].event, "snapshot_cleanup_health_unavailable");
  assert.ok(!JSON.stringify(f.events).includes("secret-key"));
  f.set({
    pendingCount: 1, persistentFailureCount: 1, retryBackoffCount: 0,
    persistentFailureThreshold: 3, oldestQueuedAgeSeconds: 100,
  });
  await f.check();
  assert.equal(f.events.length, 3);
  assert.equal(f.events[2].event, "snapshot_cleanup_health_restored");
  f.set({ pendingCount: 0, persistentFailureCount: 0, oldestQueuedAgeSeconds: null });
  await f.check();
  assert.equal(f.events[3].event, "snapshot_cleanup_recovered");
});