import type { Channel, ChannelMessageContext, StreamDelta } from "../channel.js";
import type { WebSocket } from "ws";

export class WebChatChannel implements Channel {
  name = "webchat";
  private activeSockets = new Map<string, WebSocket>();

  getSessionKey(context: ChannelMessageContext): string {
    return `webchat:${context.extra.sessionId}`;
  }

  supportsStreaming(): boolean {
    return true;
  }

  registerSocket(sessionId: string, ws: WebSocket): void {
    this.activeSockets.set(sessionId, ws);
  }

  unregisterSocket(sessionId: string): void {
    this.activeSockets.delete(sessionId);
  }

  getSocket(sessionId: string): WebSocket | undefined {
    return this.activeSockets.get(sessionId);
  }

  async sendReply(context: ChannelMessageContext, content: string): Promise<void> {
    const sessionId = context.extra.sessionId as string;
    const ws = this.activeSockets.get(sessionId);
    if (ws?.readyState === 1) {
      ws.send(JSON.stringify({ type: "message_complete", sessionId, content }));
    }
  }

  async sendProgress(_context: ChannelMessageContext, _info: string): Promise<void> {
    // WebChat uses streaming deltas instead of progress messages
  }

  async sendStreamDelta(context: ChannelMessageContext, delta: StreamDelta): Promise<void> {
    const sessionId = context.extra.sessionId as string;
    const ws = this.activeSockets.get(sessionId);
    if (ws?.readyState === 1) {
      ws.send(JSON.stringify({ ...delta, sessionId }));
    }
  }
}
