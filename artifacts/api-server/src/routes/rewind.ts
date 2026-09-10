import { Router, type IRouter, type Response } from "express";
import { and, asc, desc, eq, isNull, lte, or } from "drizzle-orm";
import {
  CreateSessionBody,
  ForkBranchBody,
  GetDiffQueryParams,
  GetSessionParams,
  ListBranchStepsParams,
  ListStepFilesParams,
  ReadFileAtStepQueryParams,
  GetStepContextParams,
} from "@workspace/api-zod";
import { branches, db, repos, sessions, steps } from "@workspace/db";
import { runCodingAgent } from "../lib/openrouter";

const router: IRouter = Router();
const subscribers = new Map<string, Set<Response>>();

const MODELS = [
  { id: "anthropic/claude-sonnet-4", name: "Claude Sonnet", provider: "Anthropic", accent: "#d6a978" },
  { id: "openai/gpt-4o-mini", name: "GPT-4o mini", provider: "OpenAI", accent: "#75c89b" },
  { id: "google/gemini-2.5-flash", name: "Gemini Flash", provider: "Google", accent: "#7ba8f5" },
  { id: "moonshotai/kimi-k2", name: "Kimi K2", provider: "Moonshot", accent: "#c49af5" },
  { id: "deepseek/deepseek-chat-v3-0324", name: "DeepSeek V3", provider: "DeepSeek", accent: "#70c8d2" },
];

function branchView(branch: typeof branches.$inferSelect) {
  return {
    id: branch.id,
    sessionId: branch.sessionId,
    parentBranchId: branch.parentBranchId,
    forkStepIndex: branch.forkStepIndex,
    modelId: branch.modelId,
    systemPrompt: branch.systemPrompt,
    taskPrompt: branch.taskPrompt,
    status: branch.status,
    stepCount: branch.stepCount,
    totalInputTokens: branch.totalInputTokens,
    totalOutputTokens: branch.totalOutputTokens,
    queuePosition: branch.status === "queued" ? 1 : null,
    createdAt: branch.createdAt.toISOString(),
    finishedAt: branch.finishedAt?.toISOString() ?? null,
  };
}

function stepView(step: typeof steps.$inferSelect) {
  return {
    id: step.id,
    branchId: step.branchId,
    index: step.stepIndex,
    kind: step.kind,
    content: step.content,
    toolName: step.toolName,
    toolArgs: step.toolArgs,
    toolResult: step.toolResult,
    commitHash: step.commitHash,
    filesChanged: step.filesChanged,
    inputTokens: step.inputTokens,
    outputTokens: step.outputTokens,
    latencyMs: step.latencyMs,
    createdAt: step.createdAt.toISOString(),
  };
}

function publishBranchEvent(branchId: string, payload: Record<string, unknown>) {
  const message = `data: ${JSON.stringify(payload)}\n\n`;
  subscribers.get(branchId)?.forEach((response) => response.write(message));
}

async function visibleBranch(branchId: string, userId: string) {
  const [row] = await db
    .select({ branch: branches, sessionUserId: sessions.userId })
    .from(branches)
    .innerJoin(sessions, eq(branches.sessionId, sessions.id))
    .where(eq(branches.id, branchId));
  return row && (row.sessionUserId === null || row.sessionUserId === userId) ? row.branch : null;
}

async function runBranch(branchId: string) {
  const [branch] = await db.select().from(branches).where(eq(branches.id, branchId));
  if (!branch) return;

  const [session] = await db.select().from(sessions).where(eq(sessions.id, branch.sessionId));
  const [repo] = session
    ? await db.select().from(repos).where(eq(repos.id, session.repoId))
    : [];
  if (!repo) {
    await db
      .update(branches)
      .set({ status: "failed", finishedAt: new Date() })
      .where(eq(branches.id, branchId));
    return;
  }

  await db.update(branches).set({ status: "running" }).where(eq(branches.id, branchId));
  publishBranchEvent(branchId, { type: "status", status: "running" });
  const [lastStep] = await db
    .select({ stepIndex: steps.stepIndex })
    .from(steps)
    .where(eq(steps.branchId, branchId))
    .orderBy(desc(steps.stepIndex))
    .limit(1);
  let nextIndex = (lastStep?.stepIndex ?? -1) + 1;
  const appendStep = async (values: Omit<typeof steps.$inferInsert, "branchId" | "stepIndex">) => {
    const [step] = await db.insert(steps).values({ ...values, branchId, stepIndex: nextIndex }).returning();
    nextIndex += 1;
    publishBranchEvent(branchId, { type: "step", step: stepView(step) });
    return step;
  };

  await appendStep({ kind: "user", content: { role: "user", content: branch.taskPrompt }, filesChanged: [] });

  try {
    const result = await runCodingAgent({
      branchId,
      modelId: branch.modelId,
      systemPrompt: branch.systemPrompt,
      taskPrompt: branch.taskPrompt,
      repository: repo,
      onAssistant: async (content, usage) => {
        await appendStep({
          kind: "assistant",
          content: { role: "assistant", content },
          filesChanged: [],
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          latencyMs: usage.latencyMs,
        });
      },
      onToolCall: async (call) => {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(call.function.arguments || "{}") as Record<string, unknown>;
        } catch {
          args = {};
        }
        await appendStep({
          kind: "tool_call",
          content: { name: call.function.name, arguments: args },
          toolName: call.function.name,
          toolArgs: args,
          filesChanged: [],
        });
      },
      onToolResult: async (call, toolResult) => {
        await appendStep({
          kind: "tool_result",
          content: toolResult.snapshot ?? { output: toolResult.output },
          toolName: call.function.name,
          toolResult: toolResult.output,
          filesChanged: toolResult.filesChanged,
        });
      },
    });
    await appendStep({
      kind: "tool_result",
      content: { commitHash: result.commitHash, bundleKey: result.bundleKey },
      toolName: "git_commit",
      toolResult: result.changed.length ? `Committed ${result.changed.join(", ")}` : "No file changes to commit.",
      filesChanged: result.changed,
      commitHash: result.commitHash,
    });
    await db
      .update(branches)
      .set({
        status: "done",
        stepCount: nextIndex,
        totalInputTokens: result.totalInputTokens,
        totalOutputTokens: result.totalOutputTokens,
        bundleKey: result.bundleKey,
        finishedAt: new Date(),
      })
      .where(eq(branches.id, branchId));
    publishBranchEvent(branchId, { type: "status", status: "done" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "The agent run failed.";
    await appendStep({
      kind: "assistant",
      content: { role: "assistant", error: message },
      filesChanged: [],
    });
    await db
      .update(branches)
      .set({
        status: "failed",
        stepCount: nextIndex,
        finishedAt: new Date(),
      })
      .where(eq(branches.id, branchId));
    publishBranchEvent(branchId, { type: "status", status: "failed", error: message });
  }
}

router.get("/repos", async (_req, res) => {
  const rows = await db.select().from(repos).orderBy(asc(repos.name));
  res.json(rows.map(({ id, slug, name, description }) => ({ id, slug, name, description })));
});

router.get("/sessions", async (_req, res) => {
  const userId = res.locals.userId as string;
  const rows = await db
    .select()
    .from(sessions)
    .where(or(eq(sessions.userId, userId), isNull(sessions.userId)))
    .orderBy(desc(sessions.createdAt));
  const result = await Promise.all(
    rows.map(async (session) => {
      const sessionBranches = await db
        .select()
        .from(branches)
        .where(eq(branches.sessionId, session.id))
        .orderBy(asc(branches.createdAt));
      return {
        id: session.id,
        repoId: session.repoId,
        title: session.title,
        branches: sessionBranches.map(branchView),
        createdAt: session.createdAt.toISOString(),
      };
    }),
  );
  res.json(result);
});

router.post("/sessions", async (req, res) => {
  const userId = res.locals.userId as string;
  const body = CreateSessionBody.parse(req.body);
  if (!MODELS.some((model) => model.id === body.modelId)) {
    res.status(400).json({ error: "Unsupported model." });
    return;
  }
  const [session] = await db
    .insert(sessions)
    .values({ repoId: body.repoId, title: body.title, userId })
    .returning();
  const [branch] = await db
    .insert(branches)
    .values({
      sessionId: session.id,
      modelId: body.modelId,
      taskPrompt: body.taskPrompt,
      status: "queued",
    })
    .returning();
  res.status(201).json({
    id: session.id,
    repoId: session.repoId,
    title: session.title,
    branches: [branchView(branch)],
    createdAt: session.createdAt.toISOString(),
  });
  void runBranch(branch.id);
});

router.get("/sessions/:id", async (req, res) => {
  const userId = res.locals.userId as string;
  const { id } = GetSessionParams.parse(req.params);
  const [session] = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.id, id), or(eq(sessions.userId, userId), isNull(sessions.userId))));
  if (!session) {
    res.status(404).json({ error: "Session not found" });
    return;
  }
  const sessionBranches = await db
    .select()
    .from(branches)
    .where(eq(branches.sessionId, session.id))
    .orderBy(asc(branches.createdAt));
  res.json({
    id: session.id,
    repoId: session.repoId,
    title: session.title,
    branches: sessionBranches.map(branchView),
    createdAt: session.createdAt.toISOString(),
  });
});

router.get("/branches/:id/steps", async (req, res) => {
  const userId = res.locals.userId as string;
  const { id } = ListBranchStepsParams.parse(req.params);
  if (!(await visibleBranch(id, userId))) {
    res.status(404).json({ error: "Branch not found" });
    return;
  }
  const rows = await db.select().from(steps).where(eq(steps.branchId, id)).orderBy(asc(steps.stepIndex));
  res.json(rows.map(stepView));
});

router.get("/branches/:id/events", async (req, res) => {
  const userId = res.locals.userId as string;
  const { id } = req.params;
  if (!(await visibleBranch(id, userId))) {
    res.status(404).json({ error: "Branch not found" });
    return;
  }
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();
  res.write(`data: ${JSON.stringify({ type: "ready" })}\n\n`);
  const listeners = subscribers.get(id) ?? new Set<Response>();
  listeners.add(res);
  subscribers.set(id, listeners);
  const keepAlive = setInterval(() => res.write(": keep-alive\n\n"), 15_000);
  req.on("close", () => {
    clearInterval(keepAlive);
    listeners.delete(res);
    if (!listeners.size) subscribers.delete(id);
  });
});

router.get("/branches/:id/steps/:index/files", async (req, res) => {
  const userId = res.locals.userId as string;
  const { id, index } = ListStepFilesParams.parse(req.params);
  if (!(await visibleBranch(id, userId))) {
    res.status(404).json({ error: "Branch not found" });
    return;
  }
  const rows = await db
    .select()
    .from(steps)
    .where(and(eq(steps.branchId, id), lte(steps.stepIndex, index)))
    .orderBy(asc(steps.stepIndex));
  const files = [...new Set(rows.flatMap((row) => {
    const content = row.content;
    const snapshotPath = typeof content === "object" && content !== null && "path" in content && typeof content.path === "string"
      ? [content.path]
      : [];
    return [...(row.filesChanged ?? []), ...snapshotPath];
  }))];
  res.json(files.map((path) => ({ path, changed: true, size: 0 })));
});

router.get("/step-file", async (req, res) => {
  const userId = res.locals.userId as string;
  const params = ReadFileAtStepQueryParams.parse(req.query);
  if (!(await visibleBranch(params.branchId, userId))) {
    res.status(404).json({ error: "Branch not found" });
    return;
  }
  const rows = await db
    .select()
    .from(steps)
    .where(and(eq(steps.branchId, params.branchId), lte(steps.stepIndex, params.index)))
    .orderBy(desc(steps.stepIndex));
  const snapshot = rows.find((row) => {
    const value = row.content;
    return (
      typeof value === "object" &&
      value !== null &&
      "path" in value &&
      value.path === params.path &&
      "content" in value
    );
  });
  const value = snapshot?.content;
  const content =
    typeof value === "object" && value !== null && "content" in value && typeof value.content === "string"
      ? value.content
      : "// File snapshot is not available for this step yet.";
  res.json({ path: params.path, content, language: params.path.endsWith(".py") ? "python" : "text" });
});

router.get("/branches/:id/steps/:index/context", async (req, res) => {
  const userId = res.locals.userId as string;
  const { id, index } = GetStepContextParams.parse(req.params);
  if (!(await visibleBranch(id, userId))) {
    res.status(404).json({ error: "Branch not found" });
    return;
  }
  const [row] = await db
    .select()
    .from(steps)
    .where(and(eq(steps.branchId, id), eq(steps.stepIndex, index)));
  const content = row?.content;
  const messages = Array.isArray(content) ? content : content ? [content] : [];
  res.json({ messages, tokenCount: row?.inputTokens ?? 0 });
});

router.post("/branches/:id/fork", async (req, res) => {
  const userId = res.locals.userId as string;
  const { id } = req.params;
  const body = ForkBranchBody.parse(req.body);
  const parent = await visibleBranch(id, userId);
  if (!parent) {
    res.status(404).json({ error: "Branch not found" });
    return;
  }
  if (!MODELS.some((model) => model.id === body.modelId)) {
    res.status(400).json({ error: "Unsupported model." });
    return;
  }
  const [parentSession] = await db.select().from(sessions).where(eq(sessions.id, parent.sessionId));
  if (!parentSession) {
    res.status(404).json({ error: "Session not found" });
    return;
  }
  let targetSessionId = parent.sessionId;
  let parentBranchId: string | null = parent.id;
  if (parentSession.userId === null) {
    const [privateSession] = await db
      .insert(sessions)
      .values({ userId, repoId: parentSession.repoId, title: `${parentSession.title} / fork` })
      .returning();
    targetSessionId = privateSession.id;
    parentBranchId = null;
  }
  const created = await db
    .insert(branches)
    .values(
      Array.from({ length: body.count ?? 1 }, () => ({
        sessionId: targetSessionId,
        parentBranchId,
        forkStepIndex: body.stepIndex,
        modelId: body.modelId,
        taskPrompt: body.editedTaskPrompt ?? parent.taskPrompt,
        systemPrompt: parent.systemPrompt,
        status: "queued" as const,
      })),
    )
    .returning();
  res.status(201).json(created.map(branchView));
  created.forEach((branch) => void runBranch(branch.id));
});

router.get("/diff", async (req, res) => {
  GetDiffQueryParams.parse(req.query);
  res.json({ files: [], patch: "No committed file changes are available for this comparison yet." });
});

export { MODELS };
export default router;