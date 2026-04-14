/**
 * Session history compressor — summarizes old conversation messages
 * using the cheaper memo LLM (OpenAI-compatible endpoint).
 */

export interface CompressorConfig {
  apiKey: string;
  baseURL: string;
  model: string;
}

export async function compressHistory(
  config: CompressorConfig,
  messages: Array<{ role: string; content: any }>
): Promise<string> {
  const textParts: string[] = [];
  for (const msg of messages) {
    if (typeof msg.content === "string") {
      textParts.push(`${msg.role}: ${msg.content}`);
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === "text") {
          textParts.push(`${msg.role}: ${block.text}`);
        } else if (block.type === "tool_use") {
          textParts.push(`${msg.role}: [tool:${block.name}(${JSON.stringify(block.input).slice(0, 100)})]`);
        } else if (block.type === "tool_result") {
          const content = typeof block.content === "string" ? block.content : JSON.stringify(block.content);
          textParts.push(`tool_result: ${content.slice(0, 300)}`);
        }
      }
    }
  }

  const prompt = `请将以下对话历史压缩为一段简洁的摘要，保留关键信息（讨论的主题、查看的文件、重要结论）。用中文回答。\n\n${textParts.join("\n")}`;

  const resp = await fetch(`${config.baseURL}/chat/completions`, {
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
