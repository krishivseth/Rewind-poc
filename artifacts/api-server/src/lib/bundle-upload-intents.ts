import { and, asc, eq, sql } from "drizzle-orm";
import { bundleCleanupQueue, bundleUploadIntents, db } from "@workspace/db";

// Each checkpoint is published promptly. A bounded upload leaves ample time for
// storage to settle before an abandoned registration is eligible for deletion.
export const BUNDLE_UPLOAD_TIMEOUT_MS = 2 * 60 * 1000;
export const BUNDLE_UPLOAD_LEASE_MS = 15 * 60 * 1000;
type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function registerBundleUpload(bundleKey: string) {
  await db.insert(bundleUploadIntents).values({
    bundleKey,
    expiresAt: sql`clock_timestamp() + ${BUNDLE_UPLOAD_LEASE_MS} * interval '1 millisecond'`,
  });
}

/** Must share the transaction that creates the first durable bundle reference. */
export async function adoptBundleUpload(tx: Transaction, bundleKey: string) {
  const [intent] = await tx.delete(bundleUploadIntents)
    .where(and(
      eq(bundleUploadIntents.bundleKey, bundleKey),
      sql`${bundleUploadIntents.expiresAt} > clock_timestamp()`,
    ))
    .returning({ bundleKey: bundleUploadIntents.bundleKey });
  if (!intent) throw new Error("Snapshot upload expired before it could be saved. Please retry the run.");
}

export async function reconcileBundleUploads() {
  await db.transaction(async (tx) => {
    // Adoption and reconciliation serialize on the intent row. Once queued, a
    // late publisher cannot resurrect the object after the reference check.
    const expired = await tx.select().from(bundleUploadIntents)
      .where(sql`${bundleUploadIntents.expiresAt} <= clock_timestamp()`)
      .orderBy(asc(bundleUploadIntents.expiresAt))
      .limit(25)
      .for("update", { skipLocked: true });
    for (const intent of expired) {
      await tx.insert(bundleCleanupQueue).values({ bundleKey: intent.bundleKey }).onConflictDoNothing();
      await tx.delete(bundleUploadIntents).where(eq(bundleUploadIntents.bundleKey, intent.bundleKey));
    }
  });
}