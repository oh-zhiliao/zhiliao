import * as lark from "@larksuiteoapi/node-sdk";

export interface FeishuClientConfig {
  appId: string;
  appSecret: string;
}

export type MessageHandler = (data: FeishuEventData) => void;

export interface FeishuEventData {
  sender: {
    sender_id?: { user_id?: string; open_id?: string };
    sender_type: string;
  };
  message: {
    message_id: string;
    chat_id: string;
    chat_type: string;
    message_type: string;
    content: string;
    create_time?: string;
    thread_id?: string;
    mentions?: Array<{
      key: string;
      id: { user_id?: string; open_id?: string };
      name: string;
    }>;
  };
}

export class FeishuClient {
  private apiClient: lark.Client;
  private wsClient: lark.WSClient | null = null;
  private config: FeishuClientConfig;
  private messageHandler: MessageHandler | null = null;
  private connected = false;
  private botOpenId = "";

  constructor(config: FeishuClientConfig) {
    this.config = config;
    this.apiClient = new lark.Client({
      appId: config.appId,
      appSecret: config.appSecret,
    });
  }

  getBotOpenId(): string {
    return this.botOpenId;
  }

  onMessage(handler: MessageHandler): void {
    this.messageHandler = handler;
  }

  async connect(): Promise<void> {
    // Fetch bot identity for mention detection
    try {
      const resp = await this.apiClient.request({
        method: "GET",
        url: "https://open.feishu.cn/open-apis/bot/v3/info",
      }) as any;
      this.botOpenId = resp?.bot?.open_id ?? "";
      console.log(`Bot identity: open_id=${this.botOpenId} name=${resp?.bot?.bot_name ?? "unknown"}`);
    } catch (e: any) {
      console.warn("Failed to fetch bot info:", e.message);
    }

    const dispatcher = new lark.EventDispatcher({}).register({
      "im.message.receive_v1": async (data: any) => {
        if (this.messageHandler) {
          this.messageHandler(data as FeishuEventData);
        }
      },
    });

    this.wsClient = new lark.WSClient({
      appId: this.config.appId,
      appSecret: this.config.appSecret,
      loggerLevel: lark.LoggerLevel.info,
    });

    await this.wsClient.start({ eventDispatcher: dispatcher });
    this.connected = true;
  }

  async sendToChat(
    chatId: string,
    msgType: string,
    content: string
  ): Promise<void> {
    const resp = await this.apiClient.im.message.create({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: chatId,
        msg_type: msgType as any,
        content,
      },
    });
    if (resp.code !== 0) {
      const err: any = new Error(`Feishu API error: code=${resp.code} msg=${resp.msg}`);
      err.code = resp.code;
      err.logId = (resp as any).log_id;
      throw err;
    }
  }

  async replyMessage(
    messageId: string,
    msgType: string,
    content: string
  ): Promise<void> {
    const resp = await this.apiClient.im.message.reply({
      path: { message_id: messageId },
      data: {
        msg_type: msgType as any,
        content,
      },
    });
    if (resp.code !== 0) {
      const err: any = new Error(`Feishu API error: code=${resp.code} msg=${resp.msg}`);
      err.code = resp.code;
      err.logId = (resp as any).log_id;
      throw err;
    }
  }

  async addReaction(messageId: string, emojiType: string): Promise<void> {
    try {
      await this.apiClient.im.messageReaction.create({
        path: { message_id: messageId },
        data: { reaction_type: { emoji_type: emojiType } },
      });
    } catch (e: any) {
      console.warn(`Failed to add reaction ${emojiType} to ${messageId}: code=${e.code ?? "?"} ${e.message ?? ""}`);
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  async disconnect(): Promise<void> {
    if (this.wsClient && typeof (this.wsClient as any).stop === "function") {
      (this.wsClient as any).stop();
    }
    this.wsClient = null;
    this.connected = false;
  }
}
