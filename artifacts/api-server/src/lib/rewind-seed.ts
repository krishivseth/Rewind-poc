import { db, branches, repos, sessions, steps } from "@workspace/db";
import { and, eq, isNull } from "drizzle-orm";
import { createAgentWorktree } from "./worktree";
import { adoptBundleUpload } from "./bundle-upload-intents";

async function ensureDemoSnapshots() {
  const [demo] = await db
    .select({ branch: branches, repo: repos })
    .from(branches)
    .innerJoin(sessions, eq(branches.sessionId, sessions.id))
    .innerJoin(repos, eq(sessions.repoId, repos.id))
    .where(and(
      isNull(sessions.userId),
      eq(sessions.title, "Make all tests pass"),
      eq(repos.slug, "csv-stats"),
    ))
    .limit(1);
  if (!demo) return;
  const [initialStep] = await db
    .select({ content: steps.content })
    .from(steps)
    .where(and(eq(steps.branchId, demo.branch.id), eq(steps.stepIndex, 0)));
  if (
    typeof initialStep?.content === "object" &&
    initialStep.content !== null &&
    "bundleKey" in initialStep.content &&
    typeof initialStep.content.bundleKey === "string"
  ) return;

  const worktree = await createAgentWorktree(demo.repo.slug, demo.branch.id);
  try {
    const initial = await worktree.checkpoint("Seed demo initial state");
    await worktree.execute("edit_file", {
      path: "csv_stats.py",
      old_string: "return len(rows) - 1",
      new_string: "return len(rows)",
    });
    const edited = await worktree.checkpoint("Seed demo edited state");
    await db.transaction(async (tx) => {
      // Match retirement's session lock and recheck after concurrent startups.
      // A losing repair leaves its uploads registered for reconciliation rather
      // than replacing (and orphaning) the winning repair's durable snapshots.
      const [session] = await tx.select({ id: sessions.id }).from(sessions)
        .where(eq(sessions.id, demo.branch.sessionId)).for("update");
      if (!session) throw new Error("Demo checkpoint session no longer exists.");
      const [currentInitial] = await tx.select({ content: steps.content }).from(steps)
        .where(and(eq(steps.branchId, demo.branch.id), eq(steps.stepIndex, 0)));
      if (
        typeof currentInitial?.content === "object" && currentInitial.content !== null &&
        "bundleKey" in currentInitial.content && typeof currentInitial.content.bundleKey === "string"
      ) return;
      const [savedInitialStep] = await tx
        .update(steps)
        .set({
          commitHash: initial.commitHash,
          content: { role: "user", content: "Make all tests pass", bundleKey: initial.bundleKey },
        })
        .where(and(eq(steps.branchId, demo.branch.id), eq(steps.stepIndex, 0)))
        .returning({ id: steps.id });
      if (!savedInitialStep) throw new Error("Demo initial checkpoint step no longer exists.");
      await adoptBundleUpload(tx, initial.bundleKey);

      const [savedEditedStep] = await tx
        .update(steps)
        .set({
          commitHash: edited.commitHash,
          content: { path: "csv_stats.py", content: "def row_count(rows):\n    return len(rows)\n", bundleKey: edited.bundleKey },
        })
        .where(and(eq(steps.branchId, demo.branch.id), eq(steps.stepIndex, 6)))
        .returning({ id: steps.id });
      if (!savedEditedStep) throw new Error("Demo edited checkpoint step no longer exists.");
      await adoptBundleUpload(tx, edited.bundleKey);

      const [savedFinalStep] = await tx
        .update(steps)
        .set({
          commitHash: edited.commitHash,
          content: { name: "run", arguments: { command: "test" }, bundleKey: edited.bundleKey },
        })
        .where(and(eq(steps.branchId, demo.branch.id), eq(steps.stepIndex, 7)))
        .returning({ id: steps.id });
      if (!savedFinalStep) throw new Error("Demo final checkpoint step no longer exists.");

      const [savedBranch] = await tx
        .update(branches)
        .set({ bundleKey: edited.bundleKey })
        .where(eq(branches.id, demo.branch.id))
        .returning({ id: branches.id });
      if (!savedBranch) throw new Error("Demo checkpoint branch no longer exists.");
    });
  } finally {
    await worktree.cleanup();
  }
}

export async function ensureRewindSeedData() {
  const existing = await db.select({ id: repos.id }).from(repos).limit(1);
  if (existing.length > 0) {
    await ensureDemoSnapshots();
    return;
  }

  const seedRepos = await db
    .insert(repos)
    .values([
      {
        slug: "tiny-todo",
        name: "tiny-todo",
        description: "A small Flask todo app with a focused test suite.",
      },
      {
        slug: "csv-stats",
        name: "csv-stats",
        description: "A CLI for column statistics with two failing edge cases.",
      },
      {
        slug: "rate-limiter",
        name: "rate-limiter",
        description: "A token bucket implementation with a concurrency bug.",
      },
    ])
    .returning();

  const csv = seedRepos.find((repo) => repo.slug === "csv-stats") ?? seedRepos[1];
  const [session] = await db
    .insert(sessions)
    .values({ repoId: csv.id, title: "Make all tests pass" })
    .returning();
  const [branch] = await db
    .insert(branches)
    .values({
      sessionId: session.id,
      modelId: "anthropic/claude-sonnet-4",
      taskPrompt: "Make all tests pass",
      status: "done",
      stepCount: 8,
      totalInputTokens: 12480,
      totalOutputTokens: 3920,
    })
    .returning();

  await db.insert(steps).values([
    {
      branchId: branch.id,
      stepIndex: 0,
      kind: "user",
      content: { role: "user", content: "Make all tests pass" },
      filesChanged: [],
      inputTokens: 42,
      outputTokens: 0,
      latencyMs: 0,
    },
    {
      branchId: branch.id,
      stepIndex: 1,
      kind: "assistant",
      content: { role: "assistant", content: "I’ll inspect the failing tests and the CSV parser first." },
      filesChanged: [],
      inputTokens: 860,
      outputTokens: 32,
      latencyMs: 824,
    },
    {
      branchId: branch.id,
      stepIndex: 2,
      kind: "tool_call",
      content: { name: "read_file", arguments: { path: "csv_stats.py" } },
      toolName: "read_file",
      toolArgs: { path: "csv_stats.py" },
      filesChanged: [],
      inputTokens: 980,
      outputTokens: 24,
      latencyMs: 210,
    },
    {
      branchId: branch.id,
      stepIndex: 3,
      kind: "tool_result",
      content: { path: "csv_stats.py", content: "def row_count(rows):\n    return len(rows) - 1\n" },
      toolName: "read_file",
      toolResult: "def row_count(rows):\n    return len(rows) - 1",
      filesChanged: ["csv_stats.py"],
      commitHash: "a81e2c4",
      inputTokens: 1060,
      outputTokens: 188,
      latencyMs: 164,
    },
    {
      branchId: branch.id,
      stepIndex: 4,
      kind: "assistant",
      content: { role: "assistant", content: "The row counter is subtracting the header even when the caller already removed it." },
      filesChanged: [],
      inputTokens: 1280,
      outputTokens: 26,
      latencyMs: 628,
    },
    {
      branchId: branch.id,
      stepIndex: 5,
      kind: "tool_call",
      content: { name: "edit_file", arguments: { path: "csv_stats.py", old_string: "return len(rows) - 1", new_string: "return len(rows)" } },
      toolName: "edit_file",
      toolArgs: { path: "csv_stats.py" },
      filesChanged: [],
      inputTokens: 1360,
      outputTokens: 35,
      latencyMs: 390,
    },
    {
      branchId: branch.id,
      stepIndex: 6,
      kind: "tool_result",
      content: { path: "csv_stats.py", content: "def row_count(rows):\n    return len(rows)\n" },
      toolName: "edit_file",
      toolResult: "Updated csv_stats.py",
      filesChanged: ["csv_stats.py"],
      commitHash: "c62d95a",
      inputTokens: 1470,
      outputTokens: 30,
      latencyMs: 444,
    },
    {
      branchId: branch.id,
      stepIndex: 7,
      kind: "tool_result",
      content: { name: "run", arguments: { command: "test" } },
      toolName: "run",
      toolArgs: { command: "test" },
      toolResult: "12 passed in 0.18s",
      filesChanged: [],
      inputTokens: 1510,
      outputTokens: 24,
      latencyMs: 642,
    },
  ]);
  await ensureDemoSnapshots();
}