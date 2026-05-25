export interface RequestContext {
  channel?: "feishu" | "webchat";
  chatType?: "group" | "p2p";
  chatId?: string;
  userId: string;
  role?: string;
  logId: string;
}
