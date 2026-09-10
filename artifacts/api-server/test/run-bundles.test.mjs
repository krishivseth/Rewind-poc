import assert from "node:assert/strict";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const bundleDir = await mkdtemp(path.join(tmpdir(), "rewind-retention-"));
process.env.REWIND_LOCAL_BUNDLE_DIR = bundleDir;
const {
  drainBundleCleanupQueue,
  getBundleCleanupStatus,
  pool,
  reconcileAbandonedRuns,
  retireEligibleSessions,
} = await import("./.generated/test-support.mjs");

const fixtureIds = {
  repos: new Set(),
  sessions: new Set(),
  bundles: new Set(),
};

test.after(async () => {
  const client = await pool.connect();
  try {
    const sessionIds = [...fixtureIds.sessions];
    if (sessionIds.length) {
      await client.query(
        "delete from steps where branch_id in (select id from branches where session_id = any($1::uuid[]))",
        [sessionIds],
      );
      await client.query(
        "delete from branches where session_id = any($1::uuid[])",
        [sessionIds],
      );
      await client.query("delete from sessions where id = any($1::uuid[])", [sessionIds]);
    }
    const repoIds = [...fixtureIds.repos];
    if (repoIds.length) {
      await client.query("delete from repos where id = any($1::uuid[])", [repoIds]);
    }
    const bundleKeys = [...fixtureIds.bundles];
    if (bundleKeys.length) {
      await client.query("delete from bundle_cleanup_queue where bundle_key = any($1::text[])", [bundleKeys]);
    }
  } finally {
    client.release();
    await pool.end();
    await rm(bundleDir, { recursive: true, force: true });
  }
});

function expired(minutes = 10) {
  return new Date(Date.now() - minutes * 60_000);
}

function future(minutes = 10) {
  return new Date(Date.now() + minutes * 60_000);
}

async function createRepo() {
  const slug = `retention-test-${crypto.randomUUID()}`;
  const { rows: [repo] } = await pool.query(
    "insert into repos (slug, name, description) values ($1, $2, '') returning id",
    [slug, slug],
  );
  fixtureIds.repos.add(repo.id);
  return repo.id;
}

async function createSession(repoId, expiresAt = expired()) {
  const { rows: [session] } = await pool.query(
    "insert into sessions (repo_id, title, expires_at) values ($1, 'Retention test', $2) returning id",
    [repoId, expiresAt],
  );
  fixtureIds.sessions.add(session.id);
  return session.id;
}

async function createBranch(sessionId, values = {}) {
  const {
    status = "done",
    bundleKey = null,
    leaseExpiresAt = null,
    parentBranchId = null,
    forkStepIndex = null,
  } = values;
  const { rows: [branch] } = await pool.query(
    `insert into branches
       (session_id, model_id, task_prompt, status, bundle_key, lease_expires_at, parent_branch_id, fork_step_index)
     values ($1, 'test/model', 'test', $2, $3, $4, $5, $6)
     returning id`,
    [sessionId, status, bundleKey, leaseExpiresAt, parentBranchId, forkStepIndex],
  );
  return branch.id;
}

async function putBundle(bundleKey, content = "bundle") {
  fixtureIds.bundles.add(bundleKey);
  const filePath = path.join(bundleDir, bundleKey.slice("/objects/".length));
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content);
  return filePath;
}

async function exists(filePath) {
  return stat(filePath).then(() => true, () => false);
}

test("a cross-session fork racing retirement keeps the parent checkpoint recoverable", async () => {
  const repoId = await createRepo();
  const parentSessionId = await createSession(repoId);
  const parentBundle = `/objects/rewind/bundles/${crypto.randomUUID()}/parent.bundle`;
  const parentPath = await putBundle(parentBundle);
  const parentBranchId = await createBranch(parentSessionId, { bundleKey: parentBundle });
  await pool.query(
    `insert into steps (branch_id, index, kind, content, files_changed)
     values ($1, 0, 'tool_result', $2::jsonb, '[]'::jsonb)`,
    [parentBranchId, JSON.stringify({ bundleKey: parentBundle })],
  );

  const forkClient = await pool.connect();
  await forkClient.query("begin");
  await forkClient.query("select id from sessions where id = $1 for update", [parentSessionId]);

  const retirement = retireEligibleSessions(new Date());
  await new Promise((resolve) => setTimeout(resolve, 50));

  const childSessionId = await createSession(repoId, future());
  await forkClient.query(
    `insert into branches
       (session_id, parent_branch_id, fork_step_index, model_id, task_prompt, status)
     values ($1, $2, 0, 'test/model', 'fork', 'done')`,
    [childSessionId, parentBranchId],
  );
  await forkClient.query("commit");
  forkClient.release();
  await retirement;

  const { rowCount } = await pool.query("select 1 from sessions where id = $1", [parentSessionId]);
  assert.equal(rowCount, 1);
  assert.equal(await exists(parentPath), true);
});

test("a live lease protects an expired session while an abandoned lease is retired", async () => {
  const repoId = await createRepo();
  const liveSessionId = await createSession(repoId);
  const abandonedSessionId = await createSession(repoId);
  await createBranch(liveSessionId, { status: "running", leaseExpiresAt: future() });
  await createBranch(abandonedSessionId, { status: "running", leaseExpiresAt: expired() });

  const now = new Date();
  await reconcileAbandonedRuns(now);
  await retireEligibleSessions(now);

  const live = await pool.query(
    `select b.status from sessions s
     join branches b on b.session_id = s.id where s.id = $1`,
    [liveSessionId],
  );
  assert.equal(live.rows[0]?.status, "running");
  const abandoned = await pool.query("select 1 from sessions where id = $1", [abandonedSessionId]);
  assert.equal(abandoned.rowCount, 0);
});

test("queued bundles that gain a live reference are never deleted", async () => {
  const repoId = await createRepo();
  const sessionId = await createSession(repoId, future());
  const bundleKey = `/objects/rewind/bundles/${crypto.randomUUID()}/referenced.bundle`;
  const bundlePath = await putBundle(bundleKey);
  await createBranch(sessionId, { bundleKey });
  await pool.query(
    "insert into bundle_cleanup_queue (bundle_key) values ($1)",
    [bundleKey],
  );

  await drainBundleCleanupQueue(new Date());

  assert.equal(await exists(bundlePath), true);
  const queued = await pool.query(
    "select 1 from bundle_cleanup_queue where bundle_key = $1",
    [bundleKey],
  );
  assert.equal(queued.rowCount, 0);
});

test("failed bundle deletions stay queued and a later retry succeeds", async () => {
  const bundleKey = `/objects/rewind/bundles/${crypto.randomUUID()}/retry.bundle`;
  fixtureIds.bundles.add(bundleKey);
  const bundlePath = path.join(bundleDir, bundleKey.slice("/objects/".length));
  await mkdir(bundlePath, { recursive: true });
  await pool.query(
    "insert into bundle_cleanup_queue (bundle_key) values ($1)",
    [bundleKey],
  );

  const firstAttempt = new Date();
  await drainBundleCleanupQueue(firstAttempt);
  const failed = await pool.query(
    `select attempts, last_attempt_at, last_error
     from bundle_cleanup_queue where bundle_key = $1`,
    [bundleKey],
  );
  assert.equal(failed.rows[0]?.attempts, 1);
  assert.ok(failed.rows[0]?.last_attempt_at);
  assert.ok(failed.rows[0]?.last_error);

  await rm(bundlePath, { recursive: true });
  await writeFile(bundlePath, "bundle");
  await drainBundleCleanupQueue(new Date(firstAttempt.getTime() + 6 * 60_000));

  assert.equal(await exists(bundlePath), false);
  const retried = await pool.query(
    "select 1 from bundle_cleanup_queue where bundle_key = $1",
    [bundleKey],
  );
  assert.equal(retried.rowCount, 0);
});

test("cleanup status separates retry backoff from persistent failures without exposing keys", async () => {
  const now = new Date();
  const queuedAt = new Date(now.getTime() - 20 * 60_000);
  const queueItems = [
    { key: `/objects/rewind/bundles/${crypto.randomUUID()}/new.bundle`, attempts: 0 },
    { key: `/objects/rewind/bundles/${crypto.randomUUID()}/retry.bundle`, attempts: 1 },
    { key: `/objects/rewind/bundles/${crypto.randomUUID()}/persistent.bundle`, attempts: 3 },
  ];
  queueItems.forEach(({ key }) => fixtureIds.bundles.add(key));
  for (const item of queueItems) {
    await pool.query(
      `insert into bundle_cleanup_queue (bundle_key, attempts, created_at)
       values ($1, $2, $3)`,
      [item.key, item.attempts, queuedAt],
    );
  }

  const status = await getBundleCleanupStatus(now);

  assert.ok(status.pendingCount >= 3);
  assert.ok(status.retryBackoffCount >= 1);
  assert.ok(status.persistentFailureCount >= 1);
  assert.equal(status.persistentFailureThreshold, 3);
  assert.equal(status.state, "persistent_failures");
  assert.ok(status.oldestQueuedAgeSeconds >= 20 * 60);
  const serialized = JSON.stringify(status);
  queueItems.forEach(({ key }) => assert.equal(serialized.includes(key), false));
});
