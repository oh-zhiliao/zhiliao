export interface ChannelMessageContext {
  channelName: string;
  userId: string;
  sessionKey: string;
  messageId?: string;
  extra: Record<string, unknown>;
}

export type StreamDelta =
  | { type: "text_delta"; content: string }
  | { type: "tool_start"; toolName: string; summary: string }
  | { type: "tool_end"; toolName: string }
  | { type: "complete"; content: string }
  | { type: "error"; message: string };

export interface Channel {
  name: string;
  getSessionKey(context: ChannelMessageContext): string;
  sendReply(context: ChannelMessageContext, content: string): Promise<void>;
  sendProgress?(context: ChannelMessageContext, info: string): Promise<void>;
  supportsStreaming(): boolean;
  sendStreamDelta?(context: ChannelMessageContext, delta: StreamDelta): Promise<void>;
}
