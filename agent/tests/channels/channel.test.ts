import { describe, it, expect } from "vitest";
import type { Channel, ChannelMessageContext, StreamDelta } from "../../src/channels/channel.js";

describe("Channel types", () => {
  it("Channel interface can be implemented", () => {
    const mockChannel: Channel = {
      name: "test",
      getSessionKey(ctx: ChannelMessageContext) { return `test:${ctx.userId}`; },
      async sendReply(_ctx, content) { /* noop */ },
      supportsStreaming() { return false; },
    };
    expect(mockChannel.name).toBe("test");
    expect(mockChannel.getSessionKey({ channelName: "test", userId: "u1", sessionKey: "", extra: {} })).toBe("test:u1");
    expect(mockChannel.supportsStreaming()).toBe(false);
  });

  it("StreamDelta discriminated union covers all types", () => {
    const deltas: StreamDelta[] = [
      { type: "text_delta", content: "hello" },
      { type: "tool_start", toolName: "git-repos.search", summary: "query" },
      { type: "tool_end", toolName: "git-repos.search" },
      { type: "complete", content: "full response" },
      { type: "error", message: "something went wrong" },
    ];
    expect(deltas).toHaveLength(5);
    expect(deltas[0].type).toBe("text_delta");
    expect(deltas[4].type).toBe("error");
  });

  it("ChannelMessageContext supports unknown extra values", () => {
    const ctx: ChannelMessageContext = {
      channelName: "telegram",
      userId: "u1",
      sessionKey: "telegram:u1:123",
      extra: { chatType: "group", threadTs: 12345 },
    };
    expect(ctx.extra.chatType).toBe("group");
    expect(ctx.extra.threadTs).toBe(12345);
  });
});
