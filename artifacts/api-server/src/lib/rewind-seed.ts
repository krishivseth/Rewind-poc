import { db, branches, repos, sessions, steps } from "@workspace/db";

export async function ensureRewindSeedData() {
  const existing = await db.select({ id: repos.id }).from(repos).limit(1);
  if (existing.length > 0) return;

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
}