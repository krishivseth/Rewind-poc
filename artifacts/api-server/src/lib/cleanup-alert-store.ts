import { eq, sql } from "drizzle-orm";
import { cleanupMonitorState, db } from "@workspace/db";
import type {
  AlertReason,
  CleanupAlertState,
  CleanupAlertStateStore,
} from "./cleanup-alerts";

export const CLEANUP_MONITOR_ID = "snapshot_cleanup";

// Database-backed alert state: a single row per monitor, read and written
// under SELECT ... FOR UPDATE inside one transaction. Restarting the API
// reloads the persisted incident instead of re-announcing it, and concurrent
// instances serialize on the row lock so an unchanged incident is announced
// exactly once.
export function createCleanupAlertStateStore(
  monitorId: string = CLEANUP_MONITOR_ID,
): CleanupAlertStateStore {
  return {
    transact: async (update) => db.transaction(async (tx) => {
      await tx.insert(cleanupMonitorState).values({ id: monitorId }).onConflictDoNothing();
      const [row] = await tx
        .select({
          activeReasons: cleanupMonitorState.activeReasons,
          healthUnavailable: cleanupMonitorState.healthUnavailable,
        })
        .from(cleanupMonitorState)
        .where(eq(cleanupMonitorState.id, monitorId))
        .for("update");
      const persisted: CleanupAlertState = {
        activeReasons: (row?.activeReasons ?? []) as AlertReason[],
        healthUnavailable: row?.healthUnavailable ?? false,
      };
      const { next, out } = await update(persisted);
      const changed = next.healthUnavailable !== persisted.healthUnavailable
        || next.activeReasons.length !== persisted.activeReasons.length
        || next.activeReasons.some((reason, index) => persisted.activeReasons[index] !== reason);
      if (changed) {
        // Single database clock: do not trust API server wall time.
        await tx.update(cleanupMonitorState)
          .set({
            activeReasons: next.activeReasons,
            healthUnavailable: next.healthUnavailable,
            updatedAt: sql`now()`,
          })
          .where(eq(cleanupMonitorState.id, monitorId));
      }
      return out;
    }),
  };
}
