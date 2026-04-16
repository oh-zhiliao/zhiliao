import { describe, it, expect } from "vitest";
import {
  buildSessionKey,
  parseSessionKey,
  type FeishuMessageContext,
} from "../../../src/channels/feishu/thread-mapper.js";

describe("buildSessionKey", () => {
  it("builds key for group thread message", () => {
    const ctx: FeishuMessageContext = {
      chatId: "oc_abc123",
      chatType: "group",
      threadId: "omt_thread456",
      senderId: "ou_user1",
      senderName: "Alice",
      messageId: "om_msg789",
      logId: "test",
      debugLevel: 0,
    };
    expect(buildSessionKey(ctx)).toBe("feishu:oc_abc123:omt_thread456");
  });

  it("builds key for group main thread (no threadId)", () => {
    const ctx: FeishuMessageContext = {
      chatId: "oc_abc123",
      chatType: "group",
      threadId: undefined,
      senderId: "ou_user1",
      senderName: "Alice",
      messageId: "om_msg789",
      logId: "test",
      debugLevel: 0,
    };
    expect(buildSessionKey(ctx)).toBe("feishu:oc_abc123:main");
  });

  it("builds key for DM (p2p)", () => {
    const ctx: FeishuMessageContext = {
      chatId: "oc_dm456",
      chatType: "p2p",
      threadId: undefined,
      senderId: "ou_user1",
      senderName: "Alice",
      messageId: "om_msg789",
      logId: "test",
      debugLevel: 0,
    };
    expect(buildSessionKey(ctx)).toBe("feishu:p2p:ou_user1");
  });
});

describe("parseSessionKey", () => {
  it("parses group thread key", () => {
    const parsed = parseSessionKey("feishu:oc_abc:omt_thread1");
    expect(parsed).toEqual({
      channel: "feishu",
      chatId: "oc_abc",
      threadOrUserId: "omt_thread1",
      isDM: false,
    });
  });

  it("parses DM key", () => {
    const parsed = parseSessionKey("feishu:p2p:ou_user1");
    expect(parsed).toEqual({
      channel: "feishu",
      chatId: "p2p",
      threadOrUserId: "ou_user1",
      isDM: true,
    });
  });
});
