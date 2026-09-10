import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { cleanupMonitorState, db } from "@workspace/db";
import {
  PENDING_NOTIFICATION_GRACE_MS,
  type AlertReason,
  type CleanupAlertState,
  type CleanupAlertStateStore,
  type PendingNotification,
} from "./cleanup-alerts";

export const CLEANUP_MONITOR_ID = "snapshot_cleanup";

// Database-backed alert state: a single row per monitor, read and written
// under SELECT ... FOR UPDATE inside one transaction. Restarting the API
// reloads the persisted incident instead of re-announcing it, and concurrent
// instances serialize on the row lock so an unchanged incident is announced
// exactly once. Notifications are appended to a persisted outbox in the same
// transaction that commits the state change; delivery is acknowledged
// afterwards, so a crash between commit and send leaves the notification
// recoverable for any live instance instead of lost.
export function createCleanupAlertStateStore(
  monitorId: string = CLEANUP_MONITOR_ID,
  options: { gracePeriodMs?: number } = {},
): CleanupAlertStateStore {
  const gracePeriodMs = options.gracePeriodMs ?? PENDING_NOTIFICATION_GRACE_MS;
  return {
    transact: async (update) => db.transaction(async (tx) => {
      await tx.insert(cleanupMonitorState).values({ id: monitorId }).onConflictDoNothing();
      const [row] = await tx
        .select({
          activeReasons: cleanupMonitorState.activeReasons,
          healthUnavailable: cleanupMonitorState.healthUnavailable,
          pendingNotifications: cleanupMonitorState.pendingNotifications,
          // Single database clock: do not trust API server wall time.
          nowMs: sql<string>`extract(epoch from now()) * 1000`,
        })
        .from(cleanupMonitorState)
        .where(eq(cleanupMonitorState.id, monitorId))
        .for("update");
      const persisted: CleanupAlertState = {
        activeReasons: (row?.activeReasons ?? []) as AlertReason[],
        healthUnavailable: row?.healthUnavailable ?? false,
      };
      const pending = (row?.pendingNotifications ?? []) as PendingNotification[];
      const dbNow = Number(row?.nowMs ?? Date.now());
      const { next, out } = await update(persisted);

      const enqueuedAt = new Date(dbNow).toISOString();
      const fresh: PendingNotification[] = out.notifications.map((notification) => ({
        ...notification,
        id: randomUUID(),
        enqueuedAt,
      }));
      // Entries past the grace period belong to a process that crashed between
      // commit and delivery; hand them to this check to re-emit. Fresher ones
      // are mid-delivery by their live committer and must not be duplicated.
      const cutoff = dbNow - gracePeriodMs;
      const stale = pending.filter((entry) => Date.parse(entry.enqueuedAt) <= cutoff);

      const changed = next.healthUnavailable !== persisted.healthUnavailable
        || next.activeReasons.length !== persisted.activeReasons.length
        || next.activeReasons.some((reason, index) => persisted.activeReasons[index] !== reason);
      if (changed || fresh.length > 0) {
        await tx.update(cleanupMonitorState)
          .set({
            activeReasons: next.activeReasons,
            healthUnavailable: next.healthUnavailable,
            pendingNotifications: [...pending, ...fresh],
            updatedAt: sql`now()`,
          })
          .where(eq(cleanupMonitorState.id, monitorId));
      }
      return [...stale, ...fresh];
    }),
    markDelivered: async (ids) => {
      if (ids.length === 0) return;
      await db.transaction(async (tx) => {
        const [row] = await tx
          .select({ pendingNotifications: cleanupMonitorState.pendingNotifications })
          .from(cleanupMonitorState)
          .where(eq(cleanupMonitorState.id, monitorId))
          .for("update");
        const pending = (row?.pendingNotifications ?? []) as PendingNotification[];
        const remaining = pending.filter((entry) => !ids.includes(entry.id));
        if (remaining.length !== pending.length) {
          await tx.update(cleanupMonitorState)
            .set({ pendingNotifications: remaining, updatedAt: sql`now()` })
            .where(eq(cleanupMonitorState.id, monitorId));
        }
      });
    },
  };
}
