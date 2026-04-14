export interface FeishuMessageContext {
  chatId: string;
  chatType: "group" | "p2p";
  threadId?: string;
  senderId: string;
  senderName: string;
  messageId: string;
  logId: string;
  debugMode: boolean;
}

export interface ParsedSessionKey {
  channel: string;
  chatId: string;
  threadOrUserId: string;
  isDM: boolean;
}

export function buildSessionKey(ctx: FeishuMessageContext): string {
  if (ctx.chatType === "p2p") {
    return `feishu:p2p:${ctx.senderId}`;
  }
  const threadPart = ctx.threadId ?? "main";
  return `feishu:${ctx.chatId}:${threadPart}`;
}

export function parseSessionKey(key: string): ParsedSessionKey {
  const [channel, chatId, threadOrUserId] = key.split(":");
  return {
    channel,
    chatId,
    threadOrUserId,
    isDM: chatId === "p2p",
  };
}
