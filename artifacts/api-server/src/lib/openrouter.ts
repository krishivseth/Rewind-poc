type OpenRouterResponse = {
  choices?: Array<{
    message?: {
      content?: string | Array<{ type?: string; text?: string }>;
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  };
  error?: {
    message?: string;
  };
};

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

function normalizeContent(content: string | Array<{ type?: string; text?: string }> | undefined): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => part.text ?? "")
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

export async function generateAgentResponse(input: {
  modelId: string;
  systemPrompt: string;
  taskPrompt: string;
  repository: { name: string; slug: string; description: string };
}) {
  const apiKey = process.env["OPENROUTER_API_KEY"];
  if (!apiKey) {
    throw new Error("OpenRouter is not configured. Add OPENROUTER_API_KEY in Secrets.");
  }

  const startedAt = Date.now();
  const response = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": process.env["REPLIT_DEV_DOMAIN"] ?? "https://replit.com",
      "X-Title": "Rewind coding-agent debugger",
    },
    body: JSON.stringify({
      model: input.modelId,
      temperature: 0.2,
      max_tokens: 1200,
      messages: [
        {
          role: "system",
          content:
            input.systemPrompt ||
            "You are a careful coding agent. Explain the implementation plan and the exact files you would change. Do not claim to have edited files unless a tool confirms it.",
        },
        {
          role: "user",
          content: [
            `Repository: ${input.repository.name} (${input.repository.slug})`,
            `Repository description: ${input.repository.description}`,
            "",
            "Task:",
            input.taskPrompt,
          ].join("\n"),
        },
      ],
    }),
  });

  const payload = (await response.json()) as OpenRouterResponse;
  if (!response.ok) {
    throw new Error(
      payload.error?.message
        ? `OpenRouter request failed: ${payload.error.message}`
        : `OpenRouter request failed with status ${response.status}.`,
    );
  }

  const content = normalizeContent(payload.choices?.[0]?.message?.content);
  if (!content) {
    throw new Error("OpenRouter returned an empty response.");
  }

  return {
    content,
    inputTokens: payload.usage?.prompt_tokens ?? 0,
    outputTokens: payload.usage?.completion_tokens ?? 0,
    latencyMs: Date.now() - startedAt,
  };
}