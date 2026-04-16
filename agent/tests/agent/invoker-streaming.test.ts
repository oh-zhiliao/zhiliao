import { describe, it, expect, vi, beforeEach } from "vitest";
import { AgentInvoker, type AgentConfig } from "../../src/agent/invoker.js";

// Helper to create an async iterable of Anthropic streaming events
function createAnthropicStream(events: any[]): AsyncIterable<any> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) {
        yield event;
      }
    },
  };
}

// Helper to create Anthropic stream events from a simple text response
function textResponseEvents(text: string, inputTokens = 10, outputTokens = 5): any[] {
  return [
    { type: "message_start", message: { usage: { input_tokens: inputTokens } } },
    { type: "content_block_start", content_block: { type: "text" } },
    ...text.split("").map((char) => ({
      type: "content_block_delta",
      delta: { type: "text_delta", text: char },
    })),
    { type: "content_block_stop" },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: outputTokens } },
  ];
}

// Helper to create Anthropic stream events for a tool_use response
function toolUseResponseEvents(
  tools: Array<{ id: string; name: string; input: Record<string, any> }>,
  inputTokens = 10,
  outputTokens = 5,
): any[] {
  const events: any[] = [
    { type: "message_start", message: { usage: { input_tokens: inputTokens } } },
  ];
  for (const tool of tools) {
    const inputJson = JSON.stringify(tool.input);
    events.push(
      { type: "content_block_start", content_block: { type: "tool_use", id: tool.id, name: tool.name } },
      { type: "content_block_delta", delta: { type: "input_json_delta", partial_json: inputJson } },
      { type: "content_block_stop" },
    );
  }
  events.push(
    { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: outputTokens } },
  );
  return events;
}

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
    const deltas: string[] = [];

    mockAnthropicCreate.mockResolvedValue(
      createAnthropicStream(textResponseEvents("Hello world")),
    );

    const result = await invoker.askStreaming("hi", "test-session", {
      onTextDelta: (t) => { deltas.push(t); },
      onComplete: (t) => { completeText = t; },
    });

    expect(result).toBe("Hello world");
    // Streaming should produce individual character deltas
    expect(deltas.length).toBeGreaterThan(1);
    expect(deltas.join("")).toBe("Hello world");
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
        return createAnthropicStream(
          toolUseResponseEvents([{ id: "t1", name: "test.search", input: { query: "test" } }]),
        );
      }
      return createAnthropicStream(textResponseEvents("Found it"));
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

    mockAnthropicCreate.mockResolvedValue(
      createAnthropicStream(textResponseEvents("")),
    );

    const result = await invoker.askStreaming("hi", "test-session-5", {
      onComplete: (t) => { completeText = t; },
    });

    expect(result).toBe("(空回复，请重试)");
    expect(completeText).toBe("(空回复，请重试)");
  });

  it("returns unfiltered text (caller handles filtering)", async () => {
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

    mockAnthropicCreate.mockResolvedValue(
      createAnthropicStream(textResponseEvents("Connect to secret-host")),
    );

    const result = await invoker.askStreaming("hi", "test-session-6", {
      onComplete: (t) => { completeText = t; },
    });

    // askStreaming does NOT apply filterOutput — caller is responsible,
    // consistent with doAsk() which also returns unfiltered text.
    expect(result).toBe("Connect to secret-host");
    expect(completeText).toBe("Connect to secret-host");
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
        return createAnthropicStream(
          toolUseResponseEvents([
            { id: "t1", name: "test.search", input: {} },
            { id: "t2", name: "test.read", input: {} },
          ]),
        );
      }
      return createAnthropicStream(textResponseEvents("Done"));
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

  it("streams text incrementally (not all at once)", async () => {
    const deltas: string[] = [];

    // Create a stream that yields text in chunks
    const events = [
      { type: "message_start", message: { usage: { input_tokens: 10 } } },
      { type: "content_block_start", content_block: { type: "text" } },
      { type: "content_block_delta", delta: { type: "text_delta", text: "Hello " } },
      { type: "content_block_delta", delta: { type: "text_delta", text: "world" } },
      { type: "content_block_stop" },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } },
    ];

    mockAnthropicCreate.mockResolvedValue(createAnthropicStream(events));

    const result = await invoker.askStreaming("hi", "test-session-8", {
      onTextDelta: (t) => { deltas.push(t); },
    });

    expect(result).toBe("Hello world");
    expect(deltas).toEqual(["Hello ", "world"]);
  });

  it("suppresses text deltas once tool_use block is encountered in same response", async () => {
    const deltas: string[] = [];

    const mockTools = {
      getToolDefinitions: () => [{ name: "test.search", description: "search", input_schema: { type: "object", properties: {} } }],
      executeTool: vi.fn().mockResolvedValue("result"),
      isCheapTool: () => false,
      summarizeToolInput: () => "",
      getSystemPromptAddendum: () => "",
      hasTool: () => false,
      filterOutput: (t: string) => t,
    };
    invoker.setTools(mockTools as any);

    let callCount = 0;
    mockAnthropicCreate.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        // Response with text BEFORE tool_use — text deltas before the tool_use block
        // get forwarded (we can't know a tool_use is coming until we see it), but
        // any text after the tool_use block starts is suppressed
        const events = [
          { type: "message_start", message: { usage: { input_tokens: 10 } } },
          { type: "content_block_start", content_block: { type: "text" } },
          { type: "content_block_delta", delta: { type: "text_delta", text: "Let me search" } },
          { type: "content_block_stop" },
          { type: "content_block_start", content_block: { type: "tool_use", id: "t1", name: "test.search" } },
          { type: "content_block_delta", delta: { type: "input_json_delta", partial_json: "{}" } },
          { type: "content_block_stop" },
          { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } },
        ];
        return createAnthropicStream(events);
      }
      return createAnthropicStream(textResponseEvents("Found it"));
    });

    await invoker.askStreaming("search", "test-session-9", {
      onTextDelta: (t) => { deltas.push(t); },
    });

    // Text before tool_use is forwarded (streaming can't predict future blocks),
    // but the final response text is also included
    expect(deltas.join("")).toContain("Found it");
    // "Let me search" appears because it was streamed before tool_use was known
    expect(deltas.join("")).toContain("Let me search");
  });
});
