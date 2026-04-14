import { describe, it, expect, vi, beforeEach } from "vitest";
import { compressHistory, type CompressorConfig } from "../../src/agent/session-compressor.js";

describe("compressHistory", () => {
  const config: CompressorConfig = {
    apiKey: "test-api-key",
    baseURL: "https://api.example.com/v1",
    model: "test-model",
  };

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("sends correct request and extracts summary from response", async () => {
    const mockResponse = {
      ok: true,
      json: vi.fn().mockResolvedValue({
        choices: [{ message: { content: "This is the compressed summary." } }],
      }),
    };
    vi.spyOn(globalThis, "fetch").mockResolvedValue(mockResponse as any);

    const messages = [
      { role: "user", content: "What does the auth module do?" },
      { role: "assistant", content: "The auth module handles JWT tokens." },
    ];

    const result = await compressHistory(config, messages);

    expect(result).toBe("This is the compressed summary.");
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);

    // Verify the URL
    const [url, options] = (globalThis.fetch as any).mock.calls[0];
    expect(url).toBe("https://api.example.com/v1/chat/completions");

    // Verify request headers
    expect(options.method).toBe("POST");
    expect(options.headers["Authorization"]).toBe("Bearer test-api-key");
    expect(options.headers["Content-Type"]).toBe("application/json");

    // Verify request body
    const body = JSON.parse(options.body);
    expect(body.model).toBe("test-model");
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].role).toBe("user");
    expect(body.messages[0].content).toContain("What does the auth module do?");
    expect(body.messages[0].content).toContain("JWT tokens");
  });

  it("handles messages with tool_use and tool_result content blocks", async () => {
    const mockResponse = {
      ok: true,
      json: vi.fn().mockResolvedValue({
        choices: [{ message: { content: "Summary of tool interactions." } }],
      }),
    };
    vi.spyOn(globalThis, "fetch").mockResolvedValue(mockResponse as any);

    const messages = [
      { role: "user", content: "Read the config file" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Let me read that file." },
          { type: "tool_use", name: "git_file_read", input: { repo: "proj", path: "config.ts" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "call_1", content: "export const config = {}" },
        ],
      },
    ];

    const result = await compressHistory(config, messages);
    expect(result).toBe("Summary of tool interactions.");

    // Verify the prompt includes all message types
    const [, options] = (globalThis.fetch as any).mock.calls[0];
    const body = JSON.parse(options.body);
    const prompt = body.messages[0].content;

    // Text from user string message
    expect(prompt).toContain("user: Read the config file");
    // Text block from assistant
    expect(prompt).toContain("assistant: Let me read that file.");
    // Tool use block
    expect(prompt).toContain("[tool:git_file_read(");
    // Tool result block
    expect(prompt).toContain("tool_result: export const config = {}");
  });

  it("throws error on non-200 response", async () => {
    const mockResponse = {
      ok: false,
      status: 429,
      text: vi.fn().mockResolvedValue("Rate limit exceeded"),
    };
    vi.spyOn(globalThis, "fetch").mockResolvedValue(mockResponse as any);

    const messages = [
      { role: "user", content: "Hello" },
    ];

    await expect(compressHistory(config, messages)).rejects.toThrow(
      "Compressor LLM error 429: Rate limit exceeded"
    );
  });

  it("returns fallback text when response has no content", async () => {
    const mockResponse = {
      ok: true,
      json: vi.fn().mockResolvedValue({
        choices: [{ message: {} }],
      }),
    };
    vi.spyOn(globalThis, "fetch").mockResolvedValue(mockResponse as any);

    const messages = [
      { role: "user", content: "Hello" },
    ];

    const result = await compressHistory(config, messages);
    expect(result).toBe("(摘要生成失败)");
  });
});
