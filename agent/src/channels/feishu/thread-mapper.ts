export interface FeishuMessageContext {
  chatId: string;
  chatType: "group" | "p2p";
  threadId?: string;
  senderId: string;
  senderName: string;
  messageId: string;
  logId: string;
  debugLevel: 0 | 1 | 2;  // 0=off, 1=/debug (basic), 2=/debug2 (verbose, admin only)
}

export interface ParsedSessionKey {
  channel: string;
  chatId: string;
  threadOrUserId: string;
  isDM: boolean;
  role?: string;
}

export function buildSessionKey(ctx: FeishuMessageContext, role?: string): string {
  const rolePart = role ? `:role:${encodeURIComponent(role)}` : "";
  if (ctx.chatType === "p2p") {
    return `feishu:p2p:${ctx.senderId}${rolePart}`;
  }
  const threadPart = ctx.threadId ?? "main";
  return `feishu:${ctx.chatId}:${threadPart}${rolePart}`;
}

export function parseSessionKey(key: string): ParsedSessionKey {
  const [channel, chatId, threadOrUserId, marker, encodedRole] = key.split(":");
  return {
    channel,
    chatId,
    threadOrUserId,
    isDM: chatId === "p2p",
    ...(marker === "role" && encodedRole ? { role: decodeURIComponent(encodedRole) } : {}),
  };
}
