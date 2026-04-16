import { describe, it, expect, vi, beforeEach } from "vitest";
import { AgentInvoker, type AgentConfig } from "../../src/agent/invoker.js";

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
vi.mock("openai", () => {
  return {
    default: class MockOpenAI {
      chat = { completions: { create: vi.fn() } };
    },
  };
});

const config: AgentConfig = {
  apiKey: "test-key",
  model: "test-model",
  systemPrompt: "You are a test bot.",
  memoUrl: "http://localhost:8090",
};

describe("AgentInvoker.askStreaming", () => {
  let invoker: AgentInvoker;

  beforeEach(() => {
    vi.clearAllMocks();
    invoker = new AgentInvoker(config);
  });

  it("streams text and fires onComplete", async () => {
    let completeText = "";
    let deltaText = "";

    mockAnthropicCreate.mockResolvedValue({
      content: [{ type: "text", text: "Hello world" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 5 },
    });

    const result = await invoker.askStreaming("hi", "test-session", {
      onTextDelta: (t) => { deltaText = t; },
      onComplete: (t) => { completeText = t; },
    });

    expect(result).toBe("Hello world");
    expect(deltaText).toBe("Hello world");
    expect(completeText).toBe("Hello world");
  });

  it("fires onToolStart and onToolEnd during tool use loop", async () => {
    const events: string[] = [];

    const mockTools = {
      getToolDefinitions: () => [{ name: "test.search", description: "search", input_schema: { type: "object", properties: {} } }],
      executeTool: vi.fn().mockResolvedValue("search result"),
      isCheapTool: () => false,
      summarizeToolInput: () => "query",
      getSystemPromptAddendum: () => "",
      hasTool: () => false,
      filterOutput: (t: string) => t,
    };
    invoker.setTools(mockTools as any);

    let callCount = 0;
    mockAnthropicCreate.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return {
          content: [{ type: "tool_use", id: "t1", name: "test.search", input: { query: "test" } }],
          stop_reason: "tool_use",
          usage: { input_tokens: 10, output_tokens: 5 },
        };
      }
      return {
        content: [{ type: "text", text: "Found it" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 20, output_tokens: 10 },
      };
    });

    await invoker.askStreaming("search for test", "test-session-2", {
      onToolStart: (name, summary) => events.push(`start:${name}`),
      onToolEnd: (name) => events.push(`end:${name}`),
      onComplete: (t) => events.push(`complete:${t}`),
    });

    expect(events).toEqual(["start:test.search", "end:test.search", "complete:Found it"]);
  });

  it("respects AbortSignal for cancellation", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      invoker.askStreaming("hi", "test-session-3", {}, controller.signal)
    ).rejects.toThrow();
  });

  it("fires onError when LLM call fails", async () => {
    let errorMsg = "";

    mockAnthropicCreate.mockRejectedValue(new Error("LLM unavailable"));

    await expect(
      invoker.askStreaming("hi", "test-session-4", {
        onError: (e) => { errorMsg = e; },
      })
    ).rejects.toThrow("LLM unavailable");

    expect(errorMsg).toBe("LLM unavailable");
  });

  it("returns empty-reply protection text when LLM returns no text", async () => {
    let completeText = "";

    mockAnthropicCreate.mockResolvedValue({
      content: [{ type: "text", text: "" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 0 },
    });

    const result = await invoker.askStreaming("hi", "test-session-5", {
      onComplete: (t) => { completeText = t; },
    });

    expect(result).toBe("(空回复，请重试)");
    expect(completeText).toBe("(空回复，请重试)");
  });

  it("applies filterOutput from tools", async () => {
    const mockTools = {
      getToolDefinitions: () => [],
      executeTool: vi.fn(),
      isCheapTool: () => false,
      summarizeToolInput: () => "",
      getSystemPromptAddendum: () => "",
      hasTool: () => false,
      filterOutput: (t: string) => t.replace("secret-host", "alias"),
    };
    invoker.setTools(mockTools as any);

    let completeText = "";

    mockAnthropicCreate.mockResolvedValue({
      content: [{ type: "text", text: "Connect to secret-host" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 5 },
    });

    const result = await invoker.askStreaming("hi", "test-session-6", {
      onComplete: (t) => { completeText = t; },
    });

    expect(result).toBe("Connect to alias");
    expect(completeText).toBe("Connect to alias");
  });

  it("fires onToolStart/onToolEnd for multiple tools in one response", async () => {
    const events: string[] = [];

    const mockTools = {
      getToolDefinitions: () => [
        { name: "test.search", description: "search", input_schema: { type: "object", properties: {} } },
        { name: "test.read", description: "read", input_schema: { type: "object", properties: {} } },
      ],
      executeTool: vi.fn().mockResolvedValue("result"),
      isCheapTool: () => false,
      summarizeToolInput: (name: string) => name,
      getSystemPromptAddendum: () => "",
      hasTool: () => false,
      filterOutput: (t: string) => t,
    };
    invoker.setTools(mockTools as any);

    let callCount = 0;
    mockAnthropicCreate.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return {
          content: [
            { type: "tool_use", id: "t1", name: "test.search", input: {} },
            { type: "tool_use", id: "t2", name: "test.read", input: {} },
          ],
          stop_reason: "tool_use",
          usage: { input_tokens: 10, output_tokens: 5 },
        };
      }
      return {
        content: [{ type: "text", text: "Done" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 20, output_tokens: 10 },
      };
    });

    await invoker.askStreaming("do stuff", "test-session-7", {
      onToolStart: (name) => events.push(`start:${name}`),
      onToolEnd: (name) => events.push(`end:${name}`),
    });

    expect(events).toEqual([
      "start:test.search", "end:test.search",
      "start:test.read", "end:test.read",
    ]);
  });
});
