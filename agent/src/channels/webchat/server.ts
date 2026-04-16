import express from "express";
import { createServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { compareSync } from "bcryptjs";
import jwt from "jsonwebtoken";
import { join } from "path";
import type { AgentInvoker } from "../../agent/invoker.js";
import type { ToolRegistry } from "../../agent/tool-registry.js";
import type { ChannelMessageContext } from "../channel.js";
import { ChannelRouter } from "../channel-router.js";
import { filterSecrets } from "../feishu/secret-filter.js";
import { WebChatChannel } from "./channel.js";

export interface WebChatConfig {
  port: number;
  passwordHash: string;
  jwtSecret: string;
}

export function createWebChatServer(
  config: WebChatConfig,
  router: ChannelRouter,
  agent: AgentInvoker,
  toolRegistry: ToolRegistry,
  secretPatterns: RegExp[],
): { start: () => void; stop: () => void } {
  const app = express();
  app.use(express.json());

  const channel = new WebChatChannel();

  // Serve static frontend files
  const webDir = join(import.meta.dirname, "../../../web");
  app.use(express.static(webDir));

  // Auth endpoint
  app.post("/api/auth/login", (req, res) => {
    const { password } = req.body;
    if (!password || !compareSync(password, config.passwordHash)) {
      res.status(401).json({ error: "Invalid password" });
      return;
    }
    const token = jwt.sign({ sub: "webchat_user" }, config.jwtSecret, { expiresIn: "1h" });
    res.json({ token });
  });

  // Session cleanup endpoint
  app.delete("/api/sessions/:id", (req, res) => {
    const authHeader = req.headers.authorization;
    if (!verifyToken(authHeader, config.jwtSecret)) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    agent.clearSession(`webchat:${req.params.id}`);
    res.json({ ok: true });
  });

  // Health
  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  const server = createServer(app);
  const wss = new WebSocketServer({ server, path: "/ws" });

  const activeStreams = new Map<string, AbortController>();

  wss.on("connection", (ws, req) => {
    // Verify JWT from query param
    const url = new URL(req.url ?? "", `http://${req.headers.host}`);
    const token = url.searchParams.get("token");
    if (!token || !verifyToken(`Bearer ${token}`, config.jwtSecret)) {
      ws.close(4001, "Unauthorized");
      return;
    }

    ws.on("message", async (raw) => {
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        ws.send(JSON.stringify({ type: "error", message: "Invalid JSON" }));
        return;
      }

      if (msg.type === "stop" && msg.sessionId) {
        const ctrl = activeStreams.get(msg.sessionId);
        ctrl?.abort();
        return;
      }

      if (msg.type === "message" && msg.sessionId && msg.content) {
        const sessionId = msg.sessionId;

        if (activeStreams.has(sessionId)) {
          ws.send(JSON.stringify({ type: "error", sessionId, message: "Already processing" }));
          return;
        }

        const controller = new AbortController();
        activeStreams.set(sessionId, controller);
        channel.registerSocket(sessionId, ws);

        const ctx: ChannelMessageContext = {
          channelName: "webchat",
          userId: "webchat_user",
          sessionKey: `webchat:${sessionId}`,
          extra: { sessionId },
        };

        try {
          const text = msg.content.trim();
          if (text.startsWith("/")) {
            // Commands go through non-streaming path
            await router.handleMessage(channel, ctx, text);
          } else {
            // Questions go through streaming path
            await agent.askStreaming(
              text,
              `webchat:${sessionId}`,
              {
                onTextDelta: (delta) => {
                  if (ws.readyState === WebSocket.OPEN) {
                    // Filter secrets from streaming deltas to prevent leaks
                    const filtered = filterSecrets(delta, secretPatterns);
                    ws.send(JSON.stringify({ type: "text_delta", sessionId, content: filtered }));
                  }
                },
                onToolStart: (toolName, summary) => {
                  if (ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ type: "tool_start", sessionId, toolName, summary }));
                  }
                },
                onToolEnd: (toolName) => {
                  if (ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ type: "tool_end", sessionId, toolName }));
                  }
                },
                onComplete: (fullText) => {
                  const secretFiltered = filterSecrets(fullText, secretPatterns);
                  const filtered = toolRegistry.filterOutput(secretFiltered);
                  if (ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ type: "message_complete", sessionId, content: filtered }));
                  }
                },
                onError: (error) => {
                  if (ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ type: "error", sessionId, message: error }));
                  }
                },
              },
              controller.signal,
            );
          }
        } catch (e: any) {
          if (e.name !== "AbortError" && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "error", sessionId, message: `处理失败: ${e.message}` }));
          }
        } finally {
          activeStreams.delete(sessionId);
          channel.unregisterSocket(sessionId);
        }
        return;
      }

      if (msg.type === "history" && msg.sessionId) {
        // localStorage is the display source of truth; return empty for now
        ws.send(JSON.stringify({ type: "history", sessionId: msg.sessionId, messages: [] }));
        return;
      }
    });

    ws.on("close", () => {
      for (const [sessionId, ctrl] of activeStreams) {
        const registered = channel.getSocket(sessionId);
        if (registered === ws) {
          ctrl.abort();
          activeStreams.delete(sessionId);
          channel.unregisterSocket(sessionId);
        }
      }
    });
  });

  return {
    start: () => {
      server.listen(config.port, () => {
        console.log(`WebChat server listening on port ${config.port}`);
      });
    },
    stop: () => {
      wss.close();
      server.close();
    },
  };
}

function verifyToken(authHeader: string | undefined, secret: string): boolean {
  if (!authHeader?.startsWith("Bearer ")) return false;
  try {
    jwt.verify(authHeader.slice(7), secret);
    return true;
  } catch {
    return false;
  }
}
