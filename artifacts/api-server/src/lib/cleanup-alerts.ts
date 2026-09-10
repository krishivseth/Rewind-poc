export const CLEANUP_QUEUE_AGE_ALERT_SECONDS = 24 * 60 * 60;

export interface CleanupHealth {
  pendingCount: number;
  retryBackoffCount: number;
  persistentFailureCount: number;
  persistentFailureThreshold: number;
  oldestQueuedAgeSeconds: number | null;
}

export type AlertReason = "persistent_failures" | "queue_age";

export interface CleanupNotification extends CleanupHealth {
  event: "snapshot_cleanup_alert" | "snapshot_cleanup_recovered";
  reasons: AlertReason[];
  queueAgeThresholdSeconds: number;
}

export interface CleanupAlertSink {
  warn: (fields: object, message: string) => void;
  info: (fields: object, message: string) => void;
}

// Incident state that must survive API restarts and be shared across
// instances, so an unchanged incident is announced exactly once no matter
// which replica observes it.
export interface CleanupAlertState {
  activeReasons: AlertReason[];
  healthUnavailable: boolean;
}

export const EMPTY_CLEANUP_ALERT_STATE: CleanupAlertState = {
  activeReasons: [],
  healthUnavailable: false,
};

export interface CleanupAlertTransition<T> {
  next: CleanupAlertState;
  out: T;
}

interface MonitorNotification {
  level: "warn" | "info";
  fields: object;
  message: string;
}

// A notification persisted alongside the incident state so a crash between
// committing the transition and emitting the log line cannot lose the alert.
// enqueuedAt uses the database clock in the database-backed store; id is
// unique per enqueued notification so deliveries can be acknowledged
// individually.
export interface PendingNotification extends MonitorNotification {
  id: string;
  enqueuedAt: string;
}

// A committed-but-undelivered notification younger than this is assumed to be
// mid-delivery by the process that committed it; older ones mean that process
// died and any live monitor must re-emit them. Kept well below the hourly
// monitor interval so a lost alert is re-announced on the next health check.
export const PENDING_NOTIFICATION_GRACE_MS = 5 * 60 * 1000;

export interface CleanupAlertStateStore {
  // Runs update with exclusive ownership of the persisted state (a row lock in
  // the database implementation), commits the returned state, and appends the
  // returned notifications to the persisted outbox — atomically, so a
  // notification can never be committed without being recoverable. Resolves
  // with every notification ready for delivery: the ones just committed plus
  // any persisted ones whose delivery grace period expired (their committing
  // process crashed between commit and send). Fresh persisted entries belong
  // to a live committer and are left alone, so concurrent instances still
  // announce an unchanged incident exactly once.
  transact: (
    update: (
      state: CleanupAlertState,
    ) => CleanupAlertTransition<{ notifications: MonitorNotification[] }>
      | Promise<CleanupAlertTransition<{ notifications: MonitorNotification[] }>>,
  ) => Promise<PendingNotification[]>;
  // Acknowledges emitted notifications, removing them from the persisted
  // outbox by id. If this fails (or the process crashes first), the entries
  // survive and a later check re-emits them: at-least-once, never lost.
  markDelivered: (ids: string[]) => Promise<void>;
}

// In-memory store: preserves pre-persistence behavior for tests and as a
// default. Production wiring passes the database-backed store instead.
// Transactions are serialized through a promise chain so concurrent monitors
// observe the same compare-then-commit semantics as the row-locked database
// store.
export function createMemoryCleanupAlertStateStore(
  initial: CleanupAlertState = EMPTY_CLEANUP_ALERT_STATE,
  options: { gracePeriodMs?: number; now?: () => number } = {},
): CleanupAlertStateStore {
  const gracePeriodMs = options.gracePeriodMs ?? PENDING_NOTIFICATION_GRACE_MS;
  const now = options.now ?? Date.now;
  let state = initial;
  let pending: PendingNotification[] = [];
  let nextId = 0;
  let queue: Promise<unknown> = Promise.resolve();
  const enqueue = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = queue.then(fn);
    queue = run.catch(() => {});
    return run;
  };
  return {
    transact: (update) => enqueue(async () => {
      const { next, out } = await update(state);
      state = next;
      const enqueuedAt = new Date(now()).toISOString();
      const fresh: PendingNotification[] = out.notifications.map((notification) => ({
        ...notification,
        id: `mem-${++nextId}`,
        enqueuedAt,
      }));
      const cutoff = now() - gracePeriodMs;
      const stale = pending.filter((entry) => Date.parse(entry.enqueuedAt) <= cutoff);
      pending = [...pending, ...fresh];
      return [...stale, ...fresh];
    }),
    markDelivered: (ids) => enqueue(async () => {
      pending = pending.filter((entry) => !ids.includes(entry.id));
    }),
  };
}

function computeReasons(health: CleanupHealth): AlertReason[] {
  const reasons: AlertReason[] = [];
  if (health.persistentFailureCount > 0) reasons.push("persistent_failures");
  if (health.pendingCount > 0
    && health.oldestQueuedAgeSeconds !== null
    && health.oldestQueuedAgeSeconds >= CLEANUP_QUEUE_AGE_ALERT_SECONDS) {
    reasons.push("queue_age");
  }
  return reasons;
}

// Pure transition logic, evaluated inside the store's exclusive transaction.
// No object keys, raw errors, or other row data ever enter notifications.
function computeTransition(
  persisted: CleanupAlertState,
  health: CleanupHealth | null,
): CleanupAlertTransition<{ notifications: MonitorNotification[] }> {
  const notifications: MonitorNotification[] = [];

  if (health === null) {
    if (!persisted.healthUnavailable) {
      notifications.push({
        level: "warn",
        fields: { event: "snapshot_cleanup_health_unavailable" },
        message: "Snapshot cleanup health could not be checked",
      });
    }
    // An unreadable queue is not evidence of recovery: keep active reasons.
    return {
      next: { ...persisted, healthUnavailable: true },
      out: { notifications },
    };
  }

  const next: CleanupAlertState = {
    activeReasons: computeReasons(health),
    healthUnavailable: false,
  };

  if (persisted.healthUnavailable) {
    notifications.push({
      level: "info",
      fields: { event: "snapshot_cleanup_health_restored" },
      message: "Snapshot cleanup health checks restored",
    });
  }

  const newlyUnhealthy = next.activeReasons.some(
    (reason) => !persisted.activeReasons.includes(reason),
  );
  const recovered = persisted.activeReasons.length > 0 && next.activeReasons.length === 0;
  if (newlyUnhealthy || recovered) {
    // Explicit allowlist: never spread health, even if its type later grows.
    const notification: CleanupNotification = {
      event: recovered ? "snapshot_cleanup_recovered" : "snapshot_cleanup_alert",
      reasons: next.activeReasons,
      pendingCount: health.pendingCount,
      retryBackoffCount: health.retryBackoffCount,
      persistentFailureCount: health.persistentFailureCount,
      persistentFailureThreshold: health.persistentFailureThreshold,
      oldestQueuedAgeSeconds: health.oldestQueuedAgeSeconds,
      queueAgeThresholdSeconds: CLEANUP_QUEUE_AGE_ALERT_SECONDS,
    };
    notifications.push({
      level: recovered ? "info" : "warn",
      fields: notification,
      message: recovered
        ? "Snapshot cleanup queue returned to normal"
        : "Snapshot cleanup requires operator attention",
    });
  }

  return { next, out: { notifications } };
}

export function createCleanupMonitor(
  readHealth: () => Promise<CleanupHealth>,
  sink: CleanupAlertSink,
  store: CleanupAlertStateStore = createMemoryCleanupAlertStateStore(),
) {
  // The store shares its database with the health read, so a store failure
  // almost always means the database is down entirely. Warn once per process
  // rather than staying silent, but never re-announce the persisted incident.
  let storeUnreachable = false;

  return async function checkCleanupHealth() {
    let health: CleanupHealth | null = null;
    try {
      health = await readHealth();
    } catch {
      health = null;
    }

    let deliverable: PendingNotification[];
    try {
      deliverable = await store.transact(
        (persisted) => computeTransition(persisted, health),
      );
      storeUnreachable = false;
    } catch {
      if (!storeUnreachable) {
        sink.warn(
          { event: "snapshot_cleanup_monitor_state_unavailable" },
          "Snapshot cleanup alert state could not be persisted",
        );
        storeUnreachable = true;
      }
      return;
    }

    // Emit everything the store released for delivery: notifications committed
    // by this check plus any a crashed process never sent. A crash from here
    // until markDelivered is safe — the entries stay in the outbox and a later
    // check re-emits them (a duplicate log line, never a lost alert).
    for (const notification of deliverable) {
      if (notification.level === "warn") {
        sink.warn(notification.fields, notification.message);
      } else {
        sink.info(notification.fields, notification.message);
      }
    }
    if (deliverable.length > 0) {
      try {
        await store.markDelivered(deliverable.map((notification) => notification.id));
      } catch {
        // Left in the outbox; a later health check re-delivers them.
      }
    }
  };
}
