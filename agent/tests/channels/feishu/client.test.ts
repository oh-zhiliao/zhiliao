import { describe, it, expect, vi, beforeEach } from "vitest";
import { FeishuClient, type FeishuClientConfig } from "../../../src/channels/feishu/client.js";
import * as lark from "@larksuiteoapi/node-sdk";

const mockCreate = vi.fn().mockResolvedValue({ code: 0 });
const mockReply = vi.fn().mockResolvedValue({ code: 0 });

// Mock the Feishu SDK
vi.mock("@larksuiteoapi/node-sdk", () => {
  return {
    Client: class MockClient {
      im = {
        message: {
          create: mockCreate,
          reply: mockReply,
        },
      };
    },
    WSClient: class MockWSClient {
      start = vi.fn();
    },
    EventDispatcher: class MockEventDispatcher {
      register = vi.fn().mockReturnThis();
    },
    LoggerLevel: { info: 1 },
  };
});

describe("FeishuClient", () => {
  let client: FeishuClient;
  const config: FeishuClientConfig = {
    appId: "cli_test",
    appSecret: "secret_test",
  };

  beforeEach(() => {
    mockCreate.mockClear();
    mockReply.mockClear();
    client = new FeishuClient(config);
  });

  it("creates client with config", () => {
    expect(client).toBeDefined();
    expect(client.isConnected()).toBe(false);
  });

  it("sends text message to chat with correct args", async () => {
    await client.sendToChat("oc_chat1", "text", '{"text":"hello"}');
    expect(mockCreate).toHaveBeenCalledWith({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: "oc_chat1",
        msg_type: "text",
        content: '{"text":"hello"}',
      },
    });
  });

  it("replies to message with correct args", async () => {
    await client.replyMessage("om_msg1", "post", '{"zh_cn":{}}');
    expect(mockReply).toHaveBeenCalledWith({
      path: { message_id: "om_msg1" },
      data: {
        msg_type: "post",
        content: '{"zh_cn":{}}',
      },
    });
  });
});
