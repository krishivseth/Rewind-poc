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

export interface CleanupAlertStateStore {
  // Runs update with exclusive ownership of the persisted state (a row lock in
  // the database implementation) and commits the returned state atomically.
  // Concurrent monitors serialize here, so only the instance that commits a
  // changed state sees a transition to announce.
  transact: <T>(
    update: (state: CleanupAlertState) => CleanupAlertTransition<T> | Promise<CleanupAlertTransition<T>>,
  ) => Promise<T>;
}

interface MonitorNotification {
  level: "warn" | "info";
  fields: object;
  message: string;
}

// In-memory store: preserves pre-persistence behavior for tests and as a
// default. Production wiring passes the database-backed store instead.
// Transactions are serialized through a promise chain so concurrent monitors
// observe the same compare-then-commit semantics as the row-locked database
// store.
export function createMemoryCleanupAlertStateStore(
  initial: CleanupAlertState = EMPTY_CLEANUP_ALERT_STATE,
): CleanupAlertStateStore {
  let state = initial;
  let queue: Promise<unknown> = Promise.resolve();
  return {
    transact: (update) => {
      const run = queue.then(async () => {
        const { next, out } = await update(state);
        state = next;
        return out;
      });
      queue = run.catch(() => {});
      return run;
    },
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

    let notifications: MonitorNotification[];
    try {
      ({ notifications } = await store.transact(
        (persisted) => computeTransition(persisted, health),
      ));
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

    for (const notification of notifications) {
      if (notification.level === "warn") {
        sink.warn(notification.fields, notification.message);
      } else {
        sink.info(notification.fields, notification.message);
      }
    }
  };
}
