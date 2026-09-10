import { and, asc, eq, inArray, isNotNull, isNull, lte, notInArray, or, sql } from "drizzle-orm";
import { branches, bundleCleanupQueue, db, sessions, steps } from "@workspace/db";
import { deleteBundle } from "./bundle-storage";
import { logger } from "./logger";

export const SESSION_RETENTION_DAYS = 30;
const CLEANUP_BATCH_SIZE = 25;
const RETRY_DELAY_MS = 5 * 60 * 1000;

export function sessionExpiry(from = new Date()) {
  return new Date(from.getTime() + SESSION_RETENTION_DAYS * 24 * 60 * 60 * 1000);
}

async function referencedBundleKeys(keys: string[]) {
  if (!keys.length) return new Set<string>();
  const branchRows = await db
    .select({ bundleKey: branches.bundleKey })
    .from(branches)
    .where(and(isNotNull(branches.bundleKey), inArray(branches.bundleKey, keys)));
  const stepRows = await db
    .select({ bundleKey: sql<string>`${steps.content} ->> 'bundleKey'` })
    .from(steps)
    .where(inArray(sql<string>`${steps.content} ->> 'bundleKey'`, keys));
  return new Set([...branchRows, ...stepRows].map((row) => row.bundleKey).filter(Boolean));
}

async function retireEligibleSessions(now: Date) {
  const candidates = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(and(
      or(isNotNull(sessions.deletedAt), lte(sessions.expiresAt, now)),
      sql`not exists (
        select 1 from ${branches} active_branch
        where active_branch.session_id = ${sessions.id}
          and active_branch.status in ('queued', 'running')
      )`,
      sql`not exists (
        select 1
        from ${branches} child_branch
        inner join ${branches} parent_branch on parent_branch.id = child_branch.parent_branch_id
        where parent_branch.session_id = ${sessions.id}
          and child_branch.session_id <> ${sessions.id}
      )`,
    ))
    .orderBy(asc(sessions.deletedAt), asc(sessions.expiresAt))
    .limit(CLEANUP_BATCH_SIZE);

  for (const candidate of candidates) {
    try {
      await db.transaction(async (tx) => {
        const [session] = await tx
          .select({ id: sessions.id })
          .from(sessions)
          .where(and(eq(sessions.id, candidate.id), or(isNotNull(sessions.deletedAt), lte(sessions.expiresAt, now))))
          .for("update");
        if (!session) return;

        const sessionBranches = await tx
          .select({ id: branches.id, status: branches.status, bundleKey: branches.bundleKey })
          .from(branches)
          .where(eq(branches.sessionId, session.id));
        if (sessionBranches.some((branch) => branch.status === "queued" || branch.status === "running")) return;

        const branchIds = sessionBranches.map((branch) => branch.id);
        if (branchIds.length) {
          const [externalChild] = await tx
            .select({ id: branches.id })
            .from(branches)
            .where(and(inArray(branches.parentBranchId, branchIds), notInArray(branches.sessionId, [session.id])))
            .limit(1);
          if (externalChild) return;
        }

        const stepBundleRows = branchIds.length
          ? await tx
              .select({ bundleKey: sql<string>`${steps.content} ->> 'bundleKey'` })
              .from(steps)
              .where(and(inArray(steps.branchId, branchIds), isNotNull(sql`${steps.content} ->> 'bundleKey'`)))
          : [];
        const keys = [...new Set([
          ...sessionBranches.map((branch) => branch.bundleKey),
          ...stepBundleRows.map((row) => row.bundleKey),
        ].filter((key): key is string => Boolean(key)))];

        if (keys.length) {
          await tx.insert(bundleCleanupQueue).values(keys.map((bundleKey) => ({ bundleKey }))).onConflictDoNothing();
        }
        if (branchIds.length) await tx.delete(steps).where(inArray(steps.branchId, branchIds));
        await tx.delete(branches).where(eq(branches.sessionId, session.id));
        await tx.delete(sessions).where(eq(sessions.id, session.id));
      });
    } catch (error) {
      logger.error({ err: error, sessionId: candidate.id }, "Session retention cleanup failed");
    }
  }
}

async function reconcileAbandonedRuns(now: Date) {
  await db
    .update(branches)
    .set({ status: "failed", finishedAt: now, leaseExpiresAt: null })
    .where(and(
      inArray(branches.status, ["queued", "running"]),
      or(isNull(branches.leaseExpiresAt), lte(branches.leaseExpiresAt, now)),
    ));
}

async function drainBundleCleanupQueue(now: Date) {
  const retryBefore = new Date(now.getTime() - RETRY_DELAY_MS);
  const queued = await db
    .select()
    .from(bundleCleanupQueue)
    .where(or(isNull(bundleCleanupQueue.lastAttemptAt), lte(bundleCleanupQueue.lastAttemptAt, retryBefore)))
    .orderBy(sql`${bundleCleanupQueue.lastAttemptAt} asc nulls first`, asc(bundleCleanupQueue.createdAt))
    .limit(CLEANUP_BATCH_SIZE);
  const referenced = await referencedBundleKeys(queued.map((row) => row.bundleKey));

  for (const item of queued) {
    if (referenced.has(item.bundleKey)) {
      await db.delete(bundleCleanupQueue).where(eq(bundleCleanupQueue.bundleKey, item.bundleKey));
      continue;
    }
    try {
      await deleteBundle(item.bundleKey);
      await db.delete(bundleCleanupQueue).where(eq(bundleCleanupQueue.bundleKey, item.bundleKey));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown App Storage deletion failure";
      await db
        .update(bundleCleanupQueue)
        .set({ attempts: item.attempts + 1, lastAttemptAt: now, lastError: message })
        .where(eq(bundleCleanupQueue.bundleKey, item.bundleKey));
      logger.error({ err: error, bundleKey: item.bundleKey, attempts: item.attempts + 1 }, "Bundle cleanup failed");
    }
  }
}

let cleanupPromise: Promise<void> | null = null;

export function runBundleCleanup(now = new Date()) {
  if (cleanupPromise) return cleanupPromise;
  cleanupPromise = (async () => {
    await reconcileAbandonedRuns(now);
    const results = await Promise.allSettled([
      retireEligibleSessions(now),
      drainBundleCleanupQueue(now),
    ]);
    results.forEach((result, index) => {
      if (result.status === "rejected") {
        logger.error(
          { err: result.reason },
          index === 0 ? "Session retention sweep failed" : "Bundle cleanup queue drain failed",
        );
      }
    });
  })()
    .catch((error) => logger.error({ err: error }, "Run bundle cleanup failed"))
    .finally(() => {
      cleanupPromise = null;
    });
  return cleanupPromise;
}

export function startRunBundleCleanup() {
  void runBundleCleanup();
  const timer = setInterval(() => void runBundleCleanup(), 60 * 60 * 1000);
  timer.unref();
}