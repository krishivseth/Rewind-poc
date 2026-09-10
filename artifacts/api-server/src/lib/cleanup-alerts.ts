export const CLEANUP_QUEUE_AGE_ALERT_SECONDS = 24 * 60 * 60;

export interface CleanupHealth {
  pendingCount: number;
  retryBackoffCount: number;
  persistentFailureCount: number;
  persistentFailureThreshold: number;
  oldestQueuedAgeSeconds: number | null;
}

type AlertReason = "persistent_failures" | "queue_age";

export interface CleanupNotification extends CleanupHealth {
  event: "snapshot_cleanup_alert" | "snapshot_cleanup_recovered";
  reasons: AlertReason[];
  queueAgeThresholdSeconds: number;
}

export interface CleanupAlertSink {
  warn: (fields: object, message: string) => void;
  info: (fields: object, message: string) => void;
}

// One monitor per API process. A restart deliberately re-announces an ongoing
// incident; no object keys, raw errors, or other row data enter this channel.
export function createCleanupMonitor(
  readHealth: () => Promise<CleanupHealth>,
  sink: CleanupAlertSink,
) {
  let activeReasons = new Set<AlertReason>();
  let healthUnavailable = false;

  return async function checkCleanupHealth() {
    let health: CleanupHealth;
    try {
      health = await readHealth();
    } catch {
      if (!healthUnavailable) {
        sink.warn(
          { event: "snapshot_cleanup_health_unavailable" },
          "Snapshot cleanup health could not be checked",
        );
        healthUnavailable = true;
      }
      // An unreadable queue is not evidence of recovery.
      return;
    }

    if (healthUnavailable) {
      sink.info(
        { event: "snapshot_cleanup_health_restored" },
        "Snapshot cleanup health checks restored",
      );
      healthUnavailable = false;
    }

    const reasons = new Set<AlertReason>();
    if (health.persistentFailureCount > 0) reasons.add("persistent_failures");
    if (health.pendingCount > 0
      && health.oldestQueuedAgeSeconds !== null
      && health.oldestQueuedAgeSeconds >= CLEANUP_QUEUE_AGE_ALERT_SECONDS) {
      reasons.add("queue_age");
    }

    const newlyUnhealthy = [...reasons].some((reason) => !activeReasons.has(reason));
    const recovered = activeReasons.size > 0 && reasons.size === 0;
    if (newlyUnhealthy || recovered) {
      // Explicit allowlist: never spread health, even if its type later grows.
      const notification: CleanupNotification = {
        event: recovered ? "snapshot_cleanup_recovered" : "snapshot_cleanup_alert",
        reasons: [...reasons],
        pendingCount: health.pendingCount,
        retryBackoffCount: health.retryBackoffCount,
        persistentFailureCount: health.persistentFailureCount,
        persistentFailureThreshold: health.persistentFailureThreshold,
        oldestQueuedAgeSeconds: health.oldestQueuedAgeSeconds,
        queueAgeThresholdSeconds: CLEANUP_QUEUE_AGE_ALERT_SECONDS,
      };
      if (recovered) {
        sink.info(notification, "Snapshot cleanup queue returned to normal");
      } else {
        sink.warn(notification, "Snapshot cleanup requires operator attention");
      }
    }
    activeReasons = reasons;
  };
}