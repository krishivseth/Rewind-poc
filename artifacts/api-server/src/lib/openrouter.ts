import { createAgentWorktree, type AgentToolName, type AgentToolResult, type WorktreeBase, type WorktreeCheckpoint } from "./worktree";

type ToolCall = {
  id: string;
  type: "function";
  function: { name: AgentToolName; arguments: string };
};

type ModelMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
};

type OpenRouterResponse = {
  choices?: Array<{ message?: { content?: string | null; tool_calls?: ToolCall[] } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string };
};

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const tools = [
  { type: "function", function: { name: "list_files", description: "List tracked files in the repository.", parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "read_file", description: "Read a UTF-8 file.", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } },
  { type: "function", function: { name: "write_file", description: "Create or replace a UTF-8 file.", parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } } },
  { type: "function", function: { name: "edit_file", description: "Replace one exact string in a file.", parameters: { type: "object", properties: { path: { type: "string" }, old_string: { type: "string" }, new_string: { type: "string" } }, required: ["path", "old_string", "new_string"] } } },
  { type: "function", function: { name: "run_tests", description: "Run the repository's allowlisted test command.", parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "git_diff", description: "Inspect the current uncommitted git diff.", parameters: { type: "object", properties: {} } } },
] as const;

async function complete(modelId: string, messages: ModelMessage[], signal?: AbortSignal) {
  const apiKey = process.env["OPENROUTER_API_KEY"];
  if (!apiKey) throw new Error("OpenRouter is not configured. Add OPENROUTER_API_KEY in Secrets.");
  const startedAt = Date.now();
  const response = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": process.env["REPLIT_DEV_DOMAIN"] ?? "https://replit.com",
      "X-Title": "Rewind coding-agent debugger",
    },
    body: JSON.stringify({ model: modelId, temperature: 0.2, max_tokens: 1400, messages, tools, tool_choice: "auto" }),
    signal,
  });
  const payload = (await response.json()) as OpenRouterResponse;
  if (!response.ok) throw new Error(payload.error?.message ? `OpenRouter request failed: ${payload.error.message}` : `OpenRouter request failed with status ${response.status}.`);
  const message = payload.choices?.[0]?.message;
  if (!message) throw new Error("OpenRouter returned an empty response.");
  return {
    message,
    inputTokens: payload.usage?.prompt_tokens ?? 0,
    outputTokens: payload.usage?.completion_tokens ?? 0,
    latencyMs: Date.now() - startedAt,
  };
}

export async function runCodingAgent(input: {
  branchId: string;
  modelId: string;
  systemPrompt: string;
  taskPrompt: string;
  repository: { name: string; slug: string; description: string };
  signal?: AbortSignal;
  base?: WorktreeBase | null;
  onWorktreeReady: (checkpoint: WorktreeCheckpoint) => Promise<void>;
  onAssistant: (content: string, usage: { inputTokens: number; outputTokens: number; latencyMs: number }) => Promise<void>;
  onToolCall: (call: ToolCall) => Promise<void>;
  onToolResult: (call: ToolCall, result: AgentToolResult) => Promise<void>;
}) {
  const worktree = await createAgentWorktree(input.repository.slug, input.branchId, {
    signal: input.signal,
    base: input.base,
  });
  const messages: ModelMessage[] = [
    {
      role: "system",
      content: input.systemPrompt || "You are a coding agent in an isolated Git worktree. Inspect files before editing. Use the available tools to implement the task, run tests, inspect the diff, and then summarize what changed. Never claim a tool succeeded unless its result confirms it.",
    },
    {
      role: "user",
      content: `Repository: ${input.repository.name}\nDescription: ${input.repository.description}\n\nTask:\n${input.taskPrompt}`,
    },
  ];
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalLatencyMs = 0;
  let finalContent = "";
  const changedFiles = new Set<string>();

  try {
    await input.onWorktreeReady(await worktree.checkpoint(`Initialize Rewind run ${input.branchId.slice(0, 8)}`));
    for (let turn = 0; turn < 10; turn += 1) {
      input.signal?.throwIfAborted();
      const result = await complete(input.modelId, messages, input.signal);
      totalInputTokens += result.inputTokens;
      totalOutputTokens += result.outputTokens;
      totalLatencyMs += result.latencyMs;
      const content = result.message.content ?? "";
      const toolCalls = result.message.tool_calls ?? [];
      messages.push({ role: "assistant", content, tool_calls: toolCalls });
      if (content) {
        finalContent = content;
        await input.onAssistant(content, result);
      }
      if (!toolCalls.length) break;

      for (const call of toolCalls) {
        await input.onToolCall(call);
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(call.function.arguments || "{}") as Record<string, unknown>;
        } catch (error) {
          const failed: AgentToolResult = { output: error instanceof Error ? error.message : "Tool failed.", filesChanged: [] };
          await input.onToolResult(call, failed);
          messages.push({ role: "tool", tool_call_id: call.id, content: failed.output });
          continue;
        }
        let toolResult: AgentToolResult;
        try {
          toolResult = await worktree.execute(call.function.name, args);
        } catch (error) {
          if (input.signal?.aborted) throw error;
          const failed: AgentToolResult = { output: error instanceof Error ? error.message : "Tool failed.", filesChanged: [] };
          await input.onToolResult(call, failed);
          messages.push({ role: "tool", tool_call_id: call.id, content: failed.output });
          continue;
        }
        toolResult.filesChanged.forEach((file) => changedFiles.add(file));
        if (toolResult.filesChanged.length) {
          toolResult.checkpoint = await worktree.checkpoint(`Rewind ${call.function.name} ${toolResult.filesChanged.join(", ")}`);
        }
        await input.onToolResult(call, toolResult);
        messages.push({ role: "tool", tool_call_id: call.id, content: toolResult.output });
      }
    }
    if (!finalContent) throw new Error("The agent stopped without a final response.");
    const finalized = await worktree.finalize();
    return {
      ...finalized,
      changed: [...changedFiles],
      content: finalContent,
      totalInputTokens,
      totalOutputTokens,
      totalLatencyMs,
    };
  } finally {
    await worktree.cleanup();
  }
}