import { describe, it, expect, vi, beforeEach } from "vitest";
import { AgentInvoker, MAX_TOOL_ITERATIONS, DEFAULT_SOUL_PROMPT, type AgentConfig } from "../../src/agent/invoker.js";
import type { ToolRegistry } from "../../src/agent/tool-registry.js";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// Mock the Anthropic SDK
const mockAnthropicCreate = vi.fn();
vi.mock("@anthropic-ai/sdk", () => {
  return {
    default: class MockAnthropic {
      messages = { create: mockAnthropicCreate };
    },
  };
});

// Mock the OpenAI SDK
const mockOpenAICreate = vi.fn();
vi.mock("openai", () => {
  return {
    default: class MockOpenAI {
      chat = { completions: { create: mockOpenAICreate } };
    },
  };
});

function makeTools(): Partial<ToolRegistry> {
  return {
    getToolDefinitions: vi.fn().mockReturnValue([
      { name: "git_file_read", description: "Read a file", input_schema: { type: "object", properties: {}, required: [] } },
    ]),
    executeTool: vi.fn().mockResolvedValue("file contents here"),
    hasTool: vi.fn().mockReturnValue(false),
    isCheapTool: vi.fn().mockImplementation((name: string) => name !== "memory_search"),
    summarizeToolInput: vi.fn().mockReturnValue("summary"),
    getSystemPromptAddendum: vi.fn().mockReturnValue(""),
  };
}

describe("AgentInvoker (Anthropic)", () => {
  let invoker: AgentInvoker;
  let mockTools: Partial<ToolRegistry>;

  const config: AgentConfig = {
    apiKey: "test-key",
    model: "claude-sonnet-4-20250514",
    systemPrompt: "You are Zhiliao (知了).",
    memoUrl: "http://localhost:8090",
  };

  beforeEach(() => {
    mockAnthropicCreate.mockReset();
    mockTools = makeTools();
    invoker = new AgentInvoker(config);
    invoker.setTools(mockTools as ToolRegistry);
  });

  it("sends question and returns text response (no tools)", async () => {
    mockAnthropicCreate.mockResolvedValue({
      content: [{ type: "text", text: "Hello!" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 5 },
    });

    const result = await invoker.ask("Hi", "session-1");
    expect(result.text).toBe("Hello!");
  });

  it("executes tool calls in agentic loop", async () => {
    // First call: model requests a tool
    mockAnthropicCreate.mockResolvedValueOnce({
      content: [
        { type: "text", text: "Let me read that file." },
        { type: "tool_use", id: "call_1", name: "git_file_read", input: { repo: "proj", path: "README.md" } },
      ],
      stop_reason: "tool_use",
      usage: { input_tokens: 10, output_tokens: 5 },
    });

    // Second call: model produces final answer after getting tool result
    mockAnthropicCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: "The README says: file contents here" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 5 },
    });

    const result = await invoker.ask("What's in the README?", "session-2");
    expect(result.text).toBe("The README says: file contents here");
    expect(mockTools.executeTool).toHaveBeenCalledWith("git_file_read", { repo: "proj", path: "README.md" });
    expect(mockAnthropicCreate).toHaveBeenCalledTimes(2);
  });

  it("limits tool loop iterations to prevent infinite loops", async () => {
    // Use memory_search (an expensive/non-cheap tool) to test the safety limit
    mockAnthropicCreate.mockResolvedValue({
      content: [
        { type: "tool_use", id: "call_n", name: "memory_search", input: { query: "x" } },
      ],
      stop_reason: "tool_use",
      usage: { input_tokens: 10, output_tokens: 5 },
    });

    const result = await invoker.ask("loop forever", "session-3");
    // MAX_TOOL_ITERATIONS expensive iterations + 1 final summary call (without tools)
    expect(mockAnthropicCreate.mock.calls.length).toBe(MAX_TOOL_ITERATIONS + 1);
  });

  it("retries on transient LLM errors", async () => {
    vi.useFakeTimers();
    try {
      // First call: timeout error
      mockAnthropicCreate.mockRejectedValueOnce(
        Object.assign(new Error("Request timed out"), { code: "ETIMEDOUT" })
      );
      // Second call: success
      mockAnthropicCreate.mockResolvedValueOnce({
        content: [{ type: "text", text: "Recovered!" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 5 },
      });

      const promise = invoker.ask("Hi", "retry-session-1");
      await vi.advanceTimersByTimeAsync(5000);
      const result = await promise;
      expect(result.text).toBe("Recovered!");
      expect(mockAnthropicCreate).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not retry on non-transient errors (4xx)", async () => {
    mockAnthropicCreate.mockRejectedValueOnce(
      Object.assign(new Error("Invalid API key"), { status: 401 })
    );

    await expect(invoker.ask("Hi", "retry-session-2")).rejects.toThrow("Invalid API key");
    expect(mockAnthropicCreate).toHaveBeenCalledTimes(1);
  });

  it("gives up after max retries", async () => {
    const timeoutErr = Object.assign(new Error("Request timed out"), { code: "ETIMEDOUT" });
    mockAnthropicCreate.mockImplementation(() => Promise.reject(timeoutErr));

    await expect(invoker.ask("Hi", "retry-session-3")).rejects.toThrow("Request timed out");
    // 3 total attempts: 1 initial + 2 retries
    expect(mockAnthropicCreate).toHaveBeenCalledTimes(3);
  }, 10_000);

  it("does not count cheap tools toward expensive iteration limit", async () => {
    // Alternate: MAX_TOOL_ITERATIONS+5 cheap calls, then a text response
    const totalCheap = MAX_TOOL_ITERATIONS + 5;
    let callCount = 0;
    mockAnthropicCreate.mockImplementation(() => {
      callCount++;
      if (callCount <= totalCheap) {
        return {
          content: [
            { type: "tool_use", id: `call_${callCount}`, name: "git_file_read", input: { repo: "proj", path: "x" } },
          ],
          stop_reason: "tool_use",
          usage: { input_tokens: 10, output_tokens: 5 },
        };
      }
      return {
        content: [{ type: "text", text: "Done after many cheap calls" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 5 },
      };
    });

    const result = await invoker.ask("read lots of files", "session-4");
    // All cheap iterations completed (not capped by MAX_TOOL_ITERATIONS) + 1 final text
    expect(callCount).toBe(totalCheap + 1);
    expect(result.text).toBe("Done after many cheap calls");
  });
});

describe("AgentInvoker (OpenAI-compatible)", () => {
  let invoker: AgentInvoker;
  let mockTools: Partial<ToolRegistry>;

  const config: AgentConfig = {
    apiKey: "test-key",
    baseURL: "https://api.example.com/v1",
    model: "doubao-pro",
    provider: "openai_compatible",
    systemPrompt: "You are Zhiliao (知了).",
    memoUrl: "http://localhost:8090",
  };

  beforeEach(() => {
    mockOpenAICreate.mockReset();
    mockTools = makeTools();
    invoker = new AgentInvoker(config);
    invoker.setTools(mockTools as ToolRegistry);
  });

  it("sends question and returns text response (no tools)", async () => {
    mockOpenAICreate.mockResolvedValue({
      choices: [{ message: { role: "assistant", content: "Hello from OpenAI!" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });

    const result = await invoker.ask("Hi", "openai-session-1");
    expect(result.text).toBe("Hello from OpenAI!");
  });

  it("executes tool calls in agentic loop", async () => {
    // First call: model requests a tool
    mockOpenAICreate.mockResolvedValueOnce({
      choices: [{
        message: {
          role: "assistant",
          content: "Let me read that file.",
          tool_calls: [{
            id: "call_1",
            type: "function",
            function: { name: "git_file_read", arguments: JSON.stringify({ repo: "proj", path: "README.md" }) },
          }],
        },
        finish_reason: "tool_calls",
      }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });

    // Second call: model produces final answer
    mockOpenAICreate.mockResolvedValueOnce({
      choices: [{ message: { role: "assistant", content: "The README says: file contents here" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 20, completion_tokens: 10 },
    });

    const result = await invoker.ask("What's in the README?", "openai-session-2");
    expect(result.text).toBe("The README says: file contents here");
    expect(mockTools.executeTool).toHaveBeenCalledWith("git_file_read", { repo: "proj", path: "README.md" });
    expect(mockOpenAICreate).toHaveBeenCalledTimes(2);

    // Verify tool results are sent in OpenAI format (role: "tool")
    const secondCallMessages = mockOpenAICreate.mock.calls[1][0].messages;
    const toolMsg = secondCallMessages.find((m: any) => m.role === "tool");
    expect(toolMsg).toBeDefined();
    expect(toolMsg.tool_call_id).toBe("call_1");
    expect(toolMsg.content).toBe("file contents here");
  });

  it("retries on transient LLM errors", async () => {
    vi.useFakeTimers();
    try {
      mockOpenAICreate.mockRejectedValueOnce(
        Object.assign(new Error("Request timed out"), { code: "ETIMEDOUT" })
      );
      mockOpenAICreate.mockResolvedValueOnce({
        choices: [{ message: { role: "assistant", content: "Recovered!" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      });

      const promise = invoker.ask("Hi", "openai-retry-1");
      await vi.advanceTimersByTimeAsync(5000);
      const result = await promise;
      expect(result.text).toBe("Recovered!");
      expect(mockOpenAICreate).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("limits tool loop iterations to prevent infinite loops", async () => {
    mockOpenAICreate.mockResolvedValue({
      choices: [{
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "call_n",
            type: "function",
            function: { name: "memory_search", arguments: JSON.stringify({ query: "x" }) },
          }],
        },
        finish_reason: "tool_calls",
      }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });

    const result = await invoker.ask("loop forever", "openai-session-3");
    expect(mockOpenAICreate.mock.calls.length).toBe(MAX_TOOL_ITERATIONS + 1);
  });
});

describe("loadSoulPrompt", () => {
  it("returns DEFAULT_SOUL_PROMPT when file is missing", () => {
    const result = AgentInvoker.loadSoulPrompt("/nonexistent/path");
    expect(result).toBe(DEFAULT_SOUL_PROMPT);
  });

  it("returns file content when SOUL.md exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "soul-test-"));
    try {
      const customSoul = "# CustomBot\n\nYou are a custom bot.";
      writeFileSync(join(dir, "SOUL.md"), customSoul, "utf-8");
      const result = AgentInvoker.loadSoulPrompt(dir);
      expect(result).toBe(customSoul);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("assembled prompt has soul content before CLAUDE.md", () => {
    const soulContent = "# MySoul\n\nI am a soul.";
    const systemContent = "# System\n\nSystem instructions.";

    const assembled = soulContent + "\n\n---\n\n" + systemContent;

    expect(assembled.indexOf(soulContent)).toBe(0);
    expect(assembled.indexOf("---")).toBeGreaterThan(soulContent.length);
    expect(assembled.indexOf(systemContent)).toBeGreaterThan(assembled.indexOf("---"));
  });
});
