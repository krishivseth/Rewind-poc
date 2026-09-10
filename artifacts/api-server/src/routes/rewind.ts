import { Router, type IRouter } from "express";
import { and, asc, desc, eq, lte } from "drizzle-orm";
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

const router: IRouter = Router();

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

router.get("/repos", async (_req, res) => {
  const rows = await db.select().from(repos).orderBy(asc(repos.name));
  res.json(rows.map(({ id, slug, name, description }) => ({ id, slug, name, description })));
});

router.get("/sessions", async (_req, res) => {
  const rows = await db.select().from(sessions).orderBy(desc(sessions.createdAt));
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
  const body = CreateSessionBody.parse(req.body);
  const [session] = await db
    .insert(sessions)
    .values({ repoId: body.repoId, title: body.title })
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
});

router.get("/sessions/:id", async (req, res) => {
  const { id } = GetSessionParams.parse(req.params);
  const [session] = await db.select().from(sessions).where(eq(sessions.id, id));
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
  const { id } = ListBranchStepsParams.parse(req.params);
  const rows = await db.select().from(steps).where(eq(steps.branchId, id)).orderBy(asc(steps.stepIndex));
  res.json(rows.map(stepView));
});

router.get("/branches/:id/steps/:index/files", async (req, res) => {
  const { id, index } = ListStepFilesParams.parse(req.params);
  const rows = await db
    .select()
    .from(steps)
    .where(and(eq(steps.branchId, id), lte(steps.stepIndex, index)))
    .orderBy(asc(steps.stepIndex));
  const files = [...new Set(rows.flatMap((row) => row.filesChanged ?? []))];
  res.json(files.map((path) => ({ path, changed: true, size: 0 })));
});

router.get("/step-file", async (req, res) => {
  const params = ReadFileAtStepQueryParams.parse(req.query);
  const rows = await db
    .select()
    .from(steps)
    .where(and(eq(steps.branchId, params.branchId), lte(steps.stepIndex, params.index)))
    .orderBy(desc(steps.stepIndex));
  const snapshot = rows.find((row) => {
    const value = row.content;
    return (
      row.filesChanged?.includes(params.path) &&
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
  const { id, index } = GetStepContextParams.parse(req.params);
  const [row] = await db
    .select()
    .from(steps)
    .where(and(eq(steps.branchId, id), eq(steps.stepIndex, index)));
  const content = row?.content;
  const messages = Array.isArray(content) ? content : content ? [content] : [];
  res.json({ messages, tokenCount: row?.inputTokens ?? 0 });
});

router.post("/branches/:id/fork", async (req, res) => {
  const { id } = req.params;
  const body = ForkBranchBody.parse(req.body);
  const [parent] = await db.select().from(branches).where(eq(branches.id, id));
  if (!parent) {
    res.status(404).json({ error: "Branch not found" });
    return;
  }
  const created = await db
    .insert(branches)
    .values(
      Array.from({ length: body.count ?? 1 }, () => ({
        sessionId: parent.sessionId,
        parentBranchId: parent.id,
        forkStepIndex: body.stepIndex,
        modelId: body.modelId,
        taskPrompt: body.editedTaskPrompt ?? parent.taskPrompt,
        systemPrompt: parent.systemPrompt,
        status: "queued" as const,
      })),
    )
    .returning();
  res.status(201).json(created.map(branchView));
});

router.get("/diff", async (req, res) => {
  GetDiffQueryParams.parse(req.query);
  res.json({ files: [], patch: "No committed file changes are available for this comparison yet." });
});

export { MODELS };
export default router;