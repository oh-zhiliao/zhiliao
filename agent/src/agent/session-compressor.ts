/**
 * Session history compressor — summarizes old conversation messages
 * using the cheaper memo LLM.
 */

export interface CompressorConfig {
  apiKey: string;
  baseURL: string;
  model: string;
  provider?: string;
}

function joinURL(baseURL: string, path: string): string {
  return `${baseURL.replace(/\/+$/, "")}${path}`;
}

function extractAnthropicText(data: any): string {
  const text = data.content
    ?.filter((block: any) => block?.type === "text" && typeof block.text === "string")
    .map((block: any) => block.text)
    .join("")
    .trim();
  return text || "(摘要生成失败)";
}

export async function compressHistory(
  config: CompressorConfig,
  messages: Array<{ role: string; content: any }>
): Promise<string> {
  const textParts: string[] = [];
  for (const msg of messages) {
    if (msg.role === "tool") {
      const toolMsg = msg as { tool_call_id?: unknown };
      textParts.push(formatRedactedToolResult(toolMsg.tool_call_id));
    } else if (typeof msg.content === "string") {
      textParts.push(`${msg.role}: ${msg.content}`);
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === "text") {
          textParts.push(`${msg.role}: ${block.text}`);
        } else if (block.type === "tool_use") {
          textParts.push(formatRedactedToolUse(block.name, block.id));
        } else if (block.type === "tool_result") {
          textParts.push(formatRedactedToolResult(block.tool_use_id));
        }
      }
    }
  }

  const prompt = `请将以下对话历史压缩为一段简洁的摘要，保留关键信息（讨论的主题、查看的文件、重要结论）。用中文回答。\n\n${textParts.join("\n")}`;

  if (config.provider === "anthropic") {
    const resp = await fetch(joinURL(config.baseURL, "/v1/messages"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages: [{ role: "user", content: prompt }],
        max_tokens: 1024,
      }),
    });

    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`Compressor LLM error ${resp.status}: ${body.slice(0, 200)}`);
    }

    const data = await resp.json() as any;
    return extractAnthropicText(data);
  }

  const resp = await fetch(joinURL(config.baseURL, "/chat/completions"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      messages: [{ role: "user", content: prompt }],
      max_tokens: 1024,
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Compressor LLM error ${resp.status}: ${body.slice(0, 200)}`);
  }

  const data = await resp.json() as any;
  return data.choices?.[0]?.message?.content?.trim() ?? "(摘要生成失败)";
}

function formatRedactedToolResult(id: unknown): string {
  const suffix = typeof id === "string" && id ? ` id=${id}` : "";
  return `tool_result: [redacted${suffix}]`;
}

function formatRedactedToolUse(name: unknown, id: unknown): string {
  const toolName = typeof name === "string" && name ? name : "unknown";
  const suffix = typeof id === "string" && id ? ` id=${id}` : "";
  return `assistant: [tool:${toolName}${suffix} input redacted]`;
}
