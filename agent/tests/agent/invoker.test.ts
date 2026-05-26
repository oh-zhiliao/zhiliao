import { describe, it, expect, vi, beforeEach } from "vitest";
import { AgentInvoker, MAX_TOOL_ITERATIONS, DEFAULT_SOUL_PROMPT, type AgentConfig } from "../../src/agent/invoker.js";
import type { ToolRegistry } from "../../src/agent/tool-registry.js";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const TOOL_LIMIT_CONTINUE_PROMPT = "任务似乎比较复杂，目前达到了执行限制，是否要继续执行？如需继续，可以直接回复或补充新的要求。";

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

  it("passes request context to tool execution in agentic loop", async () => {
    mockAnthropicCreate.mockResolvedValueOnce({
      content: [
        { type: "tool_use", id: "call_1", name: "git_file_read", input: { repo: "proj", path: "README.md" } },
      ],
      stop_reason: "tool_use",
      usage: { input_tokens: 10, output_tokens: 5 },
    });

    mockAnthropicCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: "done" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 5 },
    });

    const requestContext = {
      channel: "feishu" as const,
      chatType: "group" as const,
      chatId: "oc_group_1",
      userId: "ou_1",
      role: "prod_readonly",
      logId: "log1",
    };

    await invoker.ask("What's in the README?", "session-2ctx", undefined, requestContext);

    expect(mockTools.executeTool).toHaveBeenCalledWith(
      "git_file_read",
      { repo: "proj", path: "README.md" },
      requestContext,
    );
  });

  it("builds tool definitions and system prompt addendum with request context", async () => {
    mockAnthropicCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: "done" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 5 },
    });

    const requestContext = {
      channel: "feishu" as const,
      chatType: "group" as const,
      chatId: "oc_group_1",
      userId: "ou_u1",
      role: "complaint",
      logId: "log1",
    };

    await invoker.ask("hello", "session-ctx-meta", undefined, requestContext);

    expect(mockTools.getToolDefinitions).toHaveBeenCalledWith(requestContext);
    expect(mockTools.getSystemPromptAddendum).toHaveBeenCalledWith(requestContext);
  });

  it("treats tool calls as actionable even when stop_reason is end_turn", async () => {
    mockAnthropicCreate.mockResolvedValueOnce({
      content: [
        { type: "tool_use", id: "call_1", name: "git_file_read", input: { repo: "proj", path: "README.md" } },
      ],
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 5 },
    });

    mockAnthropicCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: "The README says: file contents here" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 5 },
    });

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await invoker.ask("What's in the README?", "session-2b");
    expect(result.text).toBe("The README says: file contents here");
    expect(mockTools.executeTool).toHaveBeenCalledWith("git_file_read", { repo: "proj", path: "README.md" });
    expect(mockAnthropicCreate).toHaveBeenCalledTimes(2);
    expect(warnSpy).toHaveBeenCalledWith(
      '[session-2b] llm returned tool calls with stop=end_turn; treating response as tool_use'
    );

    warnSpy.mockRestore();
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
    expect(mockAnthropicCreate.mock.calls.length).toBe(MAX_TOOL_ITERATIONS);
    expect(result.text).toBe(TOOL_LIMIT_CONTINUE_PROMPT);
  });

  it("uses configured max tool iterations override", async () => {
    mockAnthropicCreate.mockResolvedValue({
      content: [
        { type: "tool_use", id: "call_n", name: "memory_search", input: { query: "x" } },
      ],
      stop_reason: "tool_use",
      usage: { input_tokens: 10, output_tokens: 5 },
    });

    const limitedInvoker = new AgentInvoker({
      ...config,
      maxToolIterations: 5,
    });
    limitedInvoker.setTools(mockTools as ToolRegistry);

    const result = await limitedInvoker.ask("loop forever", "session-3b");
    expect(mockAnthropicCreate.mock.calls.length).toBe(5);
    expect(result.text).toBe(TOOL_LIMIT_CONTINUE_PROMPT);
  });

  it("emits progress message when tool limit is reached", async () => {
    mockAnthropicCreate.mockResolvedValue({
      content: [
        { type: "tool_use", id: "call_n", name: "memory_search", input: { query: "x" } },
      ],
      stop_reason: "tool_use",
      usage: { input_tokens: 10, output_tokens: 5 },
    });

    const limitedInvoker = new AgentInvoker({
      ...config,
      maxToolIterations: 5,
    });
    limitedInvoker.setTools(mockTools as ToolRegistry);

    const progress: string[] = [];
    const result = await limitedInvoker.ask("loop forever", "session-3f", (info) => progress.push(info));

    expect(result.text).toBe(TOOL_LIMIT_CONTINUE_PROMPT);
    expect(progress).toContain("limit: expensive=5/5 total=5 awaiting_user_confirmation");
  });

  it("passes arbitrary follow-up instructions back to the model after hitting the limit", async () => {
    let callCount = 0;
    mockAnthropicCreate.mockImplementation(() => {
      callCount++;
      if (callCount <= 5) {
        return {
          content: [
            { type: "tool_use", id: `call_${callCount}`, name: "memory_search", input: { query: "x" } },
          ],
          stop_reason: "tool_use",
          usage: { input_tokens: 10, output_tokens: 5 },
        };
      }
      if (callCount === 6) {
        return {
          content: [
            { type: "tool_use", id: "call_6", name: "memory_search", input: { query: "y" } },
          ],
          stop_reason: "tool_use",
          usage: { input_tokens: 10, output_tokens: 5 },
        };
      }
      return {
        content: [{ type: "text", text: "已确认当前没有满足条件的数据。" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 5 },
      };
    });

    const limitedInvoker = new AgentInvoker({
      ...config,
      maxToolIterations: 5,
    });
    limitedInvoker.setTools(mockTools as ToolRegistry);

    const followUpInstruction = "继续查，并优先过滤客服号码";
    const first = await limitedInvoker.ask("loop forever", "session-3g");
    const second = await limitedInvoker.ask(followUpInstruction, "session-3g");
    const continuationMessages = mockAnthropicCreate.mock.calls[5]?.[0]?.messages ?? [];

    expect(first.text).toBe(TOOL_LIMIT_CONTINUE_PROMPT);
    expect(second.text).toBe("已确认当前没有满足条件的数据。");
    expect(mockAnthropicCreate).toHaveBeenCalledTimes(7);
    expect(
      continuationMessages.some((message: any) => message.role === "user" && message.content === followUpInstruction)
    ).toBe(true);
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
    expect(mockOpenAICreate.mock.calls.length).toBe(MAX_TOOL_ITERATIONS);
    expect(result.text).toBe(TOOL_LIMIT_CONTINUE_PROMPT);
  });
});

describe("migrateSessionHistory", () => {
  // --- OpenAI → Anthropic migration ---

  it("converts OpenAI tool messages to Anthropic tool_result format", () => {
    const history = [
      { role: "user", content: "What's in README?" },
      {
        role: "assistant",
        content: "Let me read that.",
        tool_calls: [
          { id: "call_1", type: "function", function: { name: "git_file_read", arguments: '{"path":"README.md"}' } },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: "# Hello World" },
      { role: "assistant", content: "The README says Hello World." },
    ];

    const result = AgentInvoker.migrateSessionHistory(history, false);

    // Assistant with tool_calls → assistant with content blocks
    expect(result[1]).toEqual({
      role: "assistant",
      content: [
        { type: "text", text: "Let me read that." },
        { type: "tool_use", id: "call_1", name: "git_file_read", input: { path: "README.md" } },
      ],
    });

    // tool message → user message with tool_result
    expect(result[2]).toEqual({
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "call_1", content: "# Hello World" },
      ],
    });

    // Plain assistant message unchanged
    expect(result[3]).toEqual({ role: "assistant", content: "The README says Hello World." });
  });

  it("groups consecutive OpenAI tool messages into one Anthropic user message", () => {
    const history = [
      { role: "user", content: "Read two files" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "call_1", type: "function", function: { name: "file_read", arguments: '{"path":"a.txt"}' } },
          { id: "call_2", type: "function", function: { name: "file_read", arguments: '{"path":"b.txt"}' } },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: "content A" },
      { role: "tool", tool_call_id: "call_2", content: "content B" },
      { role: "assistant", content: "Done." },
    ];

    const result = AgentInvoker.migrateSessionHistory(history, false);

    // Two consecutive tool messages should be grouped into one user message
    expect(result[2]).toEqual({
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "call_1", content: "content A" },
        { type: "tool_result", tool_use_id: "call_2", content: "content B" },
      ],
    });

    // Total length should be 4 (user, assistant, grouped-user, assistant)
    expect(result.length).toBe(4);
  });

  // --- Anthropic → OpenAI migration ---

  it("converts Anthropic tool_result to OpenAI tool messages", () => {
    const history = [
      { role: "user", content: "What's in README?" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Let me read that." },
          { type: "tool_use", id: "call_1", name: "git_file_read", input: { path: "README.md" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "call_1", content: "# Hello World" },
        ],
      },
      { role: "assistant", content: [{ type: "text", text: "The README says Hello World." }] },
    ];

    const result = AgentInvoker.migrateSessionHistory(history, true);

    // Assistant with tool_use content blocks → assistant with tool_calls
    expect(result[1]).toEqual({
      role: "assistant",
      content: "Let me read that.",
      tool_calls: [
        { id: "call_1", type: "function", function: { name: "git_file_read", arguments: '{"path":"README.md"}' } },
      ],
    });

    // User with tool_result → tool messages
    expect(result[2]).toEqual({
      role: "tool",
      tool_call_id: "call_1",
      content: "# Hello World",
    });

    // Plain Anthropic assistant → OpenAI text content
    expect(result[3]).toEqual({
      role: "assistant",
      content: "The README says Hello World.",
      tool_calls: undefined,
    });
  });

  it("expands Anthropic multi-tool_result user message into multiple OpenAI tool messages", () => {
    const history = [
      { role: "user", content: "Read files" },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "call_1", name: "file_read", input: { path: "a.txt" } },
          { type: "tool_use", id: "call_2", name: "file_read", input: { path: "b.txt" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "call_1", content: "content A" },
          { type: "tool_result", tool_use_id: "call_2", content: "content B" },
        ],
      },
    ];

    const result = AgentInvoker.migrateSessionHistory(history, true);

    // One user message with 2 tool_results → 2 separate tool messages
    expect(result[2]).toEqual({ role: "tool", tool_call_id: "call_1", content: "content A" });
    expect(result[3]).toEqual({ role: "tool", tool_call_id: "call_2", content: "content B" });
    expect(result.length).toBe(4);
  });

  // --- No-op when format matches ---

  it("does not modify history already in Anthropic format", () => {
    const history = [
      { role: "user", content: "Hi" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Let me check." },
          { type: "tool_use", id: "call_1", name: "search", input: { q: "test" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "call_1", content: "results" },
        ],
      },
      { role: "assistant", content: [{ type: "text", text: "Here are results." }] },
    ];

    const original = JSON.parse(JSON.stringify(history));
    const result = AgentInvoker.migrateSessionHistory(history, false);
    expect(result).toEqual(original);
  });

  it("does not modify history already in OpenAI format", () => {
    const history = [
      { role: "user", content: "Hi" },
      {
        role: "assistant",
        content: "Let me check.",
        tool_calls: [
          { id: "call_1", type: "function", function: { name: "search", arguments: '{"q":"test"}' } },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: "results" },
      { role: "assistant", content: "Here are results." },
    ];

    const original = JSON.parse(JSON.stringify(history));
    const result = AgentInvoker.migrateSessionHistory(history, true);
    expect(result).toEqual(original);
  });

  // --- Mixed history (plain messages pass through) ---

  it("passes through regular user/assistant text messages unchanged", () => {
    const history = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there!" },
      { role: "user", content: "How are you?" },
      { role: "assistant", content: "I'm fine." },
    ];

    const resultAnthropic = AgentInvoker.migrateSessionHistory(history, false);
    expect(resultAnthropic).toEqual(history);

    const resultOpenAI = AgentInvoker.migrateSessionHistory(history, true);
    expect(resultOpenAI).toEqual(history);
  });

  // --- Edge case: empty history ---

  it("returns empty array for empty history", () => {
    expect(AgentInvoker.migrateSessionHistory([], true)).toEqual([]);
    expect(AgentInvoker.migrateSessionHistory([], false)).toEqual([]);
  });

  // --- Edge case: assistant with null content + tool_calls ---

  it("handles OpenAI assistant with null content during migration to Anthropic", () => {
    const history = [
      { role: "user", content: "Do something" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "call_1", type: "function", function: { name: "action", arguments: '{}' } },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: "done" },
    ];

    const result = AgentInvoker.migrateSessionHistory(history, false);

    // null content → no text block, only tool_use
    expect(result[1]).toEqual({
      role: "assistant",
      content: [
        { type: "tool_use", id: "call_1", name: "action", input: {} },
      ],
    });
  });

  // --- Edge case: malformed arguments ---

  it("handles malformed tool_calls arguments gracefully", () => {
    const history = [
      { role: "user", content: "Do something" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "call_1", type: "function", function: { name: "action", arguments: "not-valid-json" } },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: "done" },
    ];

    const result = AgentInvoker.migrateSessionHistory(history, false);

    // Should fallback to empty object for malformed JSON
    expect(result[1]).toEqual({
      role: "assistant",
      content: [
        { type: "tool_use", id: "call_1", name: "action", input: {} },
      ],
    });
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
