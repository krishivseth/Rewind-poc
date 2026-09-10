import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const bundleDir = await mkdtemp(path.join(tmpdir(), "rewind-test-bundles-"));
process.env.REWIND_LOCAL_BUNDLE_DIR = bundleDir;
const { checkpointAtStep, createAgentWorktree, pool } = await import("./.generated/test-support.mjs");
const uploadedBundleKeys = new Set();

test.after(async () => {
  if (uploadedBundleKeys.size) {
    await pool.query(
      "delete from bundle_upload_intents where bundle_key = any($1::text[])",
      [[...uploadedBundleKeys]],
    );
  }
  await pool.end();
  await rm(bundleDir, { recursive: true, force: true });
});

async function tree(root) {
  const { stdout } = await execFileAsync("git", ["ls-files", "-z"], { cwd: root });
  const files = stdout.split("\0").filter(Boolean).sort();
  return Object.fromEntries(await Promise.all(files.map(async (file) => [
    file,
    await readFile(path.join(root, file), "utf8"),
  ])));
}

async function trajectory(slug, id) {
  const source = await createAgentWorktree(slug, `${id}-source`);
  const initial = await source.checkpoint("initial");
  uploadedBundleKeys.add(initial.bundleKey);
  const initialTree = await tree(source.root);
  await source.execute("write_file", { path: "nested/new.txt", content: "checkpoint two\n" });
  await source.execute("edit_file", {
    path: "README.md",
    old_string: "Small",
    new_string: "Exact-step",
  });
  const changed = await source.checkpoint("file-changing");
  uploadedBundleKeys.add(changed.bundleKey);
  const changedTree = await tree(source.root);
  return { source, initial, initialTree, changed, changedTree };
}

test("forks initial, assistant, tool-call, file-changing, test, and final steps exactly", async () => {
  const run = await trajectory("csv-stats", "all-kinds");
  const steps = [
    { stepIndex: 0, commitHash: run.initial.commitHash, content: { bundleKey: run.initial.bundleKey } },
    { stepIndex: 1, commitHash: null, content: { role: "assistant" } },
    { stepIndex: 2, commitHash: null, content: { name: "read_file" } },
    { stepIndex: 3, commitHash: run.changed.commitHash, content: { bundleKey: run.changed.bundleKey } },
    { stepIndex: 4, commitHash: run.changed.commitHash, content: { bundleKey: run.changed.bundleKey, test: true } },
    { stepIndex: 5, commitHash: run.changed.commitHash, content: { bundleKey: run.changed.bundleKey, final: true } },
  ];
  try {
    for (const [index, expected] of [
      [0, run.initialTree], [1, run.initialTree], [2, run.initialTree],
      [3, run.changedTree], [4, run.changedTree], [5, run.changedTree],
    ]) {
      const base = checkpointAtStep(steps, index);
      assert.ok(base);
      const fork = await createAgentWorktree("csv-stats", `fork-kind-${index}`, { base });
      try {
        assert.deepEqual(await tree(fork.root), expected, `step ${index}`);
      } finally {
        await fork.cleanup();
      }
    }
  } finally {
    await run.source.cleanup();
  }
});

test("rejects invalid indexes and steps without a durable checkpoint", () => {
  const steps = [{ stepIndex: 0, commitHash: null, content: { role: "user" } }];
  assert.throws(() => checkpointAtStep(steps, 9), /does not exist/);
  assert.equal(checkpointAtStep(steps, 0), null);
});

test("fails explicitly for missing and corrupt bundles", async () => {
  await assert.rejects(
    createAgentWorktree("tiny-todo", "missing-bundle", {
      base: { commitHash: "a".repeat(40), bundleKey: "/objects/rewind/bundles/missing/no.bundle" },
    }),
    /ENOENT|no such file/i,
  );
  const corruptPath = path.join(bundleDir, "rewind/bundles/corrupt/bad.bundle");
  await writeFile(corruptPath, "not a git bundle", { encoding: "utf8", flag: "w" }).catch(async () => {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(path.dirname(corruptPath), { recursive: true });
    await writeFile(corruptPath, "not a git bundle");
  });
  await assert.rejects(
    createAgentWorktree("tiny-todo", "corrupt-bundle", {
      base: { commitHash: "b".repeat(40), bundleKey: "/objects/rewind/bundles/corrupt/bad.bundle" },
    }),
    /bundle|repository|clone/i,
  );
});

test("public seeded trajectory checkpoints remain forkable", async () => {
  const run = await trajectory("csv-stats", "public-seed");
  try {
    for (const [name, checkpoint, expected] of [
      ["initial", run.initial, run.initialTree],
      ["edited", run.changed, run.changedTree],
    ]) {
      const fork = await createAgentWorktree("csv-stats", `public-seed-${name}`, { base: checkpoint });
      try {
        assert.deepEqual(await tree(fork.root), expected);
      } finally {
        await fork.cleanup();
      }
    }
  } finally {
    await run.source.cleanup();
  }
});