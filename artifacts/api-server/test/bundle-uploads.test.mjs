import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import pg from "../../../lib/db/node_modules/pg/esm/index.mjs";

const schema = `bundle_upload_test_${crypto.randomUUID().replaceAll("-", "")}`;
const adminPool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
await adminPool.query(`create schema "${schema}"`);
for (const table of [
  "repos",
  "sessions",
  "branches",
  "steps",
  "bundle_cleanup_queue",
  "bundle_upload_intents",
]) {
  await adminPool.query(`create table "${schema}"."${table}" (like public."${table}" including all)`);
}

// The application pool is constructed by the dynamic import below. Pin its
// search path first so this suite cannot inspect or sweep development rows.
process.env.PGOPTIONS = `-c search_path=${schema}`;
const bundleDir = await mkdtemp(path.join(tmpdir(), "rewind-durable-uploads-"));
process.env.REWIND_LOCAL_BUNDLE_DIR = bundleDir;

const {
  adoptBundleUpload,
  branches,
  db,
  drainBundleCleanupQueue,
  eq,
  ensureRewindSeedData,
  pool,
  reconcileBundleUploads,
  runBundleCleanup,
  steps,
  uploadBundle,
  createAgentWorktree,
} = await import("./.generated/test-support.mjs");

test.after(async () => {
  await pool.end();
  await rm(bundleDir, { recursive: true, force: true });
  await adminPool.query(`drop schema "${schema}" cascade`);
  await adminPool.end();
});

function objectPath(bundleKey) {
  assert.match(bundleKey, /^\/objects\//);
  return path.join(bundleDir, bundleKey.slice("/objects/".length));
}

async function exists(filePath) {
  return stat(filePath).then(() => true, () => false);
}

async function intent(bundleKey) {
  return pool.query("select * from bundle_upload_intents where bundle_key = $1", [bundleKey]);
}

async function queue(bundleKey) {
  return pool.query("select * from bundle_cleanup_queue where bundle_key = $1", [bundleKey]);
}

async function sourceFile(content = "durable bundle bytes") {
  const file = path.join(bundleDir, `source-${crypto.randomUUID()}.bundle`);
  await writeFile(file, content);
  return file;
}

async function storedBundles() {
  return (await readdir(path.join(bundleDir, "rewind"), { recursive: true }).catch(() => []))
    .filter((name) => name.endsWith(".bundle"))
    .sort();
}

async function createGraph() {
  const slug = `upload-test-${crypto.randomUUID()}`;
  const { rows: [repo] } = await pool.query(
    "insert into repos (slug, name, description) values ($1, $1, '') returning id",
    [slug],
  );
  const { rows: [session] } = await pool.query(
    "insert into sessions (repo_id, title) values ($1, 'Durable upload test') returning id",
    [repo.id],
  );
  const { rows: [branch] } = await pool.query(
    `insert into branches (session_id, model_id, task_prompt, status)
     values ($1, 'test/model', 'test', 'done') returning id`,
    [session.id],
  );
  return { repoId: repo.id, sessionId: session.id, branchId: branch.id };
}

test("an already-aborted upload never registers or touches storage", async () => {
  const source = await sourceFile();
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    uploadBundle(source, crypto.randomUUID(), "a".repeat(40), controller.signal),
    { name: "AbortError" },
  );

  assert.equal((await pool.query("select 1 from bundle_upload_intents")).rowCount, 0);
  assert.deepEqual(await storedBundles(), []);
});

test("failed intent registration never reaches storage", async () => {
  const before = await storedBundles();
  await pool.query("alter table bundle_upload_intents rename to unavailable_bundle_upload_intents");
  try {
    await assert.rejects(
      uploadBundle(await sourceFile(), crypto.randomUUID(), "9".repeat(40)),
      /bundle_upload_intents/,
    );
  } finally {
    await pool.query("alter table unavailable_bundle_upload_intents rename to bundle_upload_intents");
  }
  assert.deepEqual(await storedBundles(), before);
});

test("storage failure after registration remains tracked and can be reconciled", async () => {
  const branchId = crypto.randomUUID();
  await assert.rejects(
    uploadBundle(path.join(bundleDir, "does-not-exist.bundle"), branchId, "8".repeat(40)),
    /ENOENT|no such file/i,
  );
  const { rows: [registered] } = await pool.query(
    "select bundle_key from bundle_upload_intents where bundle_key like $1",
    [`/objects/rewind/bundles/${branchId}/%`],
  );
  assert.ok(registered?.bundle_key);

  await pool.query(
    "update bundle_upload_intents set expires_at = clock_timestamp() - interval '1 second' where bundle_key = $1",
    [registered.bundle_key],
  );
  await reconcileBundleUploads();
  await drainBundleCleanupQueue(new Date());
  assert.equal((await intent(registered.bundle_key)).rowCount, 0);
  assert.equal((await queue(registered.bundle_key)).rowCount, 0);
  assert.equal(await exists(objectPath(registered.bundle_key)), false);
});

test("a successful upload remains registered if its caller aborts before persistence", async () => {
  const source = await sourceFile("uploaded before cancellation");
  const controller = new AbortController();
  const key = await uploadBundle(source, crypto.randomUUID(), "b".repeat(40), controller.signal);
  controller.abort();

  assert.equal(await exists(objectPath(key)), true);
  assert.equal((await intent(key)).rowCount, 1);
  assert.equal((await pool.query(
    "select 1 from branches where bundle_key = $1 union all select 1 from steps where content ->> 'bundleKey' = $1",
    [key],
  )).rowCount, 0);
});

test("a failed persistence transaction rolls back both reference and adoption", async () => {
  const source = await sourceFile();
  const key = await uploadBundle(source, crypto.randomUUID(), "c".repeat(40));
  const { branchId } = await createGraph();

  await assert.rejects(
    db.transaction(async (tx) => {
      await tx.insert(steps).values({
        branchId,
        stepIndex: 0,
        kind: "tool_result",
        content: { bundleKey: key },
        filesChanged: [],
      });
      await adoptBundleUpload(tx, key);
      throw new Error("simulated persistence failure");
    }),
    /simulated persistence failure/,
  );

  assert.equal((await pool.query("select 1 from steps where branch_id = $1", [branchId])).rowCount, 0);
  assert.equal((await intent(key)).rowCount, 1);
  assert.equal(await exists(objectPath(key)), true);
});

test("restart reconciliation queues and deletes an expired unadopted upload", async () => {
  const key = await uploadBundle(await sourceFile(), crypto.randomUUID(), "d".repeat(40));
  await pool.query(
    "update bundle_upload_intents set expires_at = clock_timestamp() - interval '1 second' where bundle_key = $1",
    [key],
  );

  await reconcileBundleUploads();
  assert.equal((await intent(key)).rowCount, 0);
  assert.equal((await queue(key)).rowCount, 1);

  await drainBundleCleanupQueue(new Date());
  assert.equal((await queue(key)).rowCount, 0);
  assert.equal(await exists(objectPath(key)), false);
});

test("repeat checkpoints of one commit use distinct keys and preserve the adopted snapshot", async () => {
  const graph = await createGraph();
  const worktree = await createAgentWorktree("csv-stats", graph.branchId);
  try {
    const first = await worktree.checkpoint("same commit, first attempt");
    const second = await worktree.checkpoint("same commit, repeated attempt");
    assert.equal(first.commitHash, second.commitHash);
    assert.notEqual(first.bundleKey, second.bundleKey);

    await db.transaction(async (tx) => {
      await tx.update(branches).set({ bundleKey: first.bundleKey }).where(eq(branches.id, graph.branchId));
      await adoptBundleUpload(tx, first.bundleKey);
    });
    await pool.query(
      "update bundle_upload_intents set expires_at = clock_timestamp() - interval '1 second' where bundle_key = $1",
      [second.bundleKey],
    );
    await reconcileBundleUploads();
    await drainBundleCleanupQueue(new Date());

    assert.equal(await exists(objectPath(first.bundleKey)), true);
    assert.equal(await exists(objectPath(second.bundleKey)), false);
    assert.equal((await intent(first.bundleKey)).rowCount, 0);
  } finally {
    await worktree.cleanup();
  }
});

test("cleanup recognizes both global branch and step references", async () => {
  const branchKey = await uploadBundle(await sourceFile("branch"), crypto.randomUUID(), "e".repeat(40));
  const stepKey = await uploadBundle(await sourceFile("step"), crypto.randomUUID(), "f".repeat(40));
  const { branchId } = await createGraph();
  await db.transaction(async (tx) => {
    await tx.update(branches).set({ bundleKey: branchKey }).where(eq(branches.id, branchId));
    await adoptBundleUpload(tx, branchKey);
    await tx.insert(steps).values({
      branchId,
      stepIndex: 0,
      kind: "tool_result",
      content: { output: "saved", bundleKey: stepKey },
      filesChanged: [],
    });
    await adoptBundleUpload(tx, stepKey);
  });
  await pool.query(
    "insert into bundle_cleanup_queue (bundle_key) values ($1), ($2)",
    [branchKey, stepKey],
  );

  await drainBundleCleanupQueue(new Date());

  assert.equal(await exists(objectPath(branchKey)), true);
  assert.equal(await exists(objectPath(stepKey)), true);
  assert.equal((await queue(branchKey)).rowCount, 0);
  assert.equal((await queue(stepKey)).rowCount, 0);
});

test("an active intent blocks queued cleanup and expiration rejects late adoption", async () => {
  const key = await uploadBundle(await sourceFile(), crypto.randomUUID(), "1".repeat(40));
  await pool.query("insert into bundle_cleanup_queue (bundle_key) values ($1)", [key]);

  await drainBundleCleanupQueue(new Date());
  assert.equal((await queue(key)).rowCount, 1);
  assert.equal(await exists(objectPath(key)), true);

  await pool.query(
    "update bundle_upload_intents set expires_at = clock_timestamp() - interval '1 second' where bundle_key = $1",
    [key],
  );
  await reconcileBundleUploads();
  await assert.rejects(
    db.transaction((tx) => adoptBundleUpload(tx, key)),
    /expired before it could be saved/,
  );

  await drainBundleCleanupQueue(new Date());
  assert.equal(await exists(objectPath(key)), false);
  assert.equal((await queue(key)).rowCount, 0);
});

test("a caller's far-future cleanup clock cannot expire a fresh intent", async () => {
  const key = await uploadBundle(await sourceFile(), crypto.randomUUID(), "2".repeat(40));

  await runBundleCleanup(new Date("9999-12-31T23:59:59.000Z"));

  assert.equal((await intent(key)).rowCount, 1);
  assert.equal((await queue(key)).rowCount, 0);
  assert.equal(await exists(objectPath(key)), true);
});

test("demo snapshot repair rolls back adoption and retries without republishing on startup", async () => {
  const { rows: [repo] } = await pool.query(
    "insert into repos (slug, name, description) values ('csv-stats', 'csv-stats', '') returning id",
  );
  const { rows: [session] } = await pool.query(
    `insert into sessions (repo_id, title)
     values ($1, 'Make all tests pass') returning id`,
    [repo.id],
  );
  const { rows: [branch] } = await pool.query(
    `insert into branches (session_id, model_id, task_prompt, status, step_count)
     values ($1, 'test/model', 'Make all tests pass', 'done', 8) returning id`,
    [session.id],
  );
  await pool.query(
    `insert into steps (branch_id, index, kind, content, files_changed)
     values
       ($1, 0, 'user', $2::jsonb, '[]'::jsonb),
       ($1, 6, 'tool_result', $3::jsonb, '["csv_stats.py"]'::jsonb)`,
    [
      branch.id,
      JSON.stringify({ role: "user", content: "Make all tests pass" }),
      JSON.stringify({ path: "csv_stats.py", content: "stale" }),
    ],
  );

  const beforeFailure = new Set((await pool.query("select bundle_key from bundle_upload_intents")).rows.map((row) => row.bundle_key));
  await assert.rejects(ensureRewindSeedData(), /final checkpoint step no longer exists/);
  const failedKeys = (await pool.query("select bundle_key from bundle_upload_intents")).rows
    .map((row) => row.bundle_key)
    .filter((key) => !beforeFailure.has(key));
  assert.equal(failedKeys.length, 2);
  for (const key of failedKeys) {
    assert.equal(await exists(objectPath(key)), true);
  }
  assert.equal((await pool.query(
    "select 1 from steps where branch_id = $1 and content ? 'bundleKey'",
    [branch.id],
  )).rowCount, 0);

  await pool.query(
    "insert into bundle_cleanup_queue (bundle_key) select unnest($1::text[]) on conflict do nothing",
    [failedKeys],
  );
  await drainBundleCleanupQueue(new Date());
  for (const key of failedKeys) {
    assert.equal((await intent(key)).rowCount, 1);
    assert.equal((await queue(key)).rowCount, 1);
    assert.equal(await exists(objectPath(key)), true);
  }

  await pool.query(
    `insert into steps (branch_id, index, kind, content, files_changed)
     values ($1, 7, 'tool_result', $2::jsonb, '[]'::jsonb)`,
    [branch.id, JSON.stringify({ name: "run", arguments: { command: "test" } })],
  );
  await ensureRewindSeedData();

  const { rows: repairedSteps } = await pool.query(
    `select index, content ->> 'bundleKey' as bundle_key
     from steps where branch_id = $1 and index in (0, 6, 7) order by index`,
    [branch.id],
  );
  assert.ok(repairedSteps[0].bundle_key);
  assert.ok(repairedSteps[1].bundle_key);
  assert.equal(repairedSteps[2].bundle_key, repairedSteps[1].bundle_key);
  const { rows: [repairedBranch] } = await pool.query(
    "select bundle_key from branches where id = $1",
    [branch.id],
  );
  assert.equal(repairedBranch.bundle_key, repairedSteps[1].bundle_key);
  assert.equal((await pool.query(
    "select 1 from bundle_upload_intents where bundle_key = any($1::text[])",
    [repairedSteps.map((step) => step.bundle_key)],
  )).rowCount, 0);

  const intentCountBeforeRestart = Number((await pool.query("select count(*) from bundle_upload_intents")).rows[0].count);
  const bundlesBeforeRestart = await storedBundles();
  await ensureRewindSeedData();
  assert.equal(Number((await pool.query("select count(*) from bundle_upload_intents")).rows[0].count), intentCountBeforeRestart);
  assert.deepEqual(await storedBundles(), bundlesBeforeRestart);
});