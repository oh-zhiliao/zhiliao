import express from "express";
import { createServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { compareSync } from "bcryptjs";
import jwt from "jsonwebtoken";
import { randomBytes } from "crypto";
import { join } from "path";
import type { AgentInvoker } from "../../agent/invoker.js";
import type { ToolRegistry } from "../../agent/tool-registry.js";
import type { ChannelMessageContext } from "../channel.js";
import { ChannelRouter } from "../channel-router.js";
import { filterSecrets } from "../feishu/secret-filter.js";
import { WebChatChannel } from "./channel.js";

export interface FeishuAuthConfig {
  appId: string;
  appSecret: string;
  redirectUri: string;
  userIdField: "open_id" | "email" | "user_id";
  allowedUsers: string[];
}

export interface WebChatConfig {
  port: number;
  passwordHash: string;
  jwtSecret: string;
  feishuAuth?: FeishuAuthConfig;
  /** Test-only: if set, enables GET /api/auth/test-token?token=<this> to mint a JWT.
   *  MUST be left unset in production. */
  testToken?: string;
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
    const token = jwt.sign({ sub: "webchat_user" }, config.jwtSecret, {
      expiresIn: "1h",
      audience: "session",
    });
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

  // Test-only auth bypass. Only active when config.testToken is explicitly set.
  if (config.testToken) {
    app.get("/api/auth/test-token", (req, res) => {
      if (req.query.token !== config.testToken) {
        res.status(401).json({ error: "Invalid test token" });
        return;
      }
      const userId = typeof req.query.user === "string" ? req.query.user : "test_user";
      const token = jwt.sign({ sub: userId, auth_method: "test" }, config.jwtSecret, {
        expiresIn: "1h",
        audience: "session",
      });
      res.json({ token });
    });
  }

  // --- Feishu OAuth2 endpoints ---

  // Feature detection: is Feishu auth configured?
  app.get("/api/auth/feishu/config", (_req, res) => {
    res.json({ enabled: !!config.feishuAuth });
  });

  // Start OAuth flow: redirect to Feishu authorize page
  app.get("/api/auth/feishu/authorize", (_req, res) => {
    if (!config.feishuAuth) {
      res.status(404).json({ error: "Feishu auth not configured" });
      return;
    }
    // Self-contained state: signed JWT with nonce + timestamp (survives restarts).
    // audience "oauth_state" isolates this token from session JWTs — so a leaked
    // state JWT cannot be used as a session Bearer token.
    const state = jwt.sign(
      { nonce: randomBytes(16).toString("hex") },
      config.jwtSecret,
      { expiresIn: "5m", audience: "oauth_state" },
    );
    const authUrl = new URL("https://accounts.feishu.cn/open-apis/authen/v1/authorize");
    authUrl.searchParams.set("client_id", config.feishuAuth.appId);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("redirect_uri", config.feishuAuth.redirectUri);
    authUrl.searchParams.set("scope", "contact:user.base:readonly");
    authUrl.searchParams.set("state", state);
    res.redirect(authUrl.toString());
  });

  // OAuth callback: exchange code → get user info → issue JWT
  app.get("/api/auth/feishu/callback", async (req, res) => {
    const { code, state, error: feishuError } = req.query as Record<string, string>;

    if (feishuError) {
      res.status(400).send(oauthErrorHtml("Feishu auth error", String(feishuError)));
      return;
    }

    // Validate state (signed JWT — self-contained CSRF protection)
    if (!state) {
      res.status(400).send(oauthErrorHtml("Missing state", "No state parameter"));
      return;
    }
    try {
      jwt.verify(state, config.jwtSecret, { algorithms: ["HS256"], audience: "oauth_state" });
    } catch {
      res.status(400).send(oauthErrorHtml("Invalid state", "CSRF state expired or invalid"));
      return;
    }

    if (!code || !config.feishuAuth) {
      res.status(400).send(oauthErrorHtml("Missing code", "Authorization code missing"));
      return;
    }

    try {
      // Step 1: Exchange code for user_access_token
      console.log("[Feishu OAuth] Exchanging code for token...");
      const tokenResp = await fetch("https://open.feishu.cn/open-apis/authen/v2/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(10000),
        body: JSON.stringify({
          client_id: config.feishuAuth.appId,
          client_secret: config.feishuAuth.appSecret,
          grant_type: "authorization_code",
          code,
          redirect_uri: config.feishuAuth.redirectUri,
        }),
      });
      const tokenData = (await tokenResp.json()) as any;
      console.log("[Feishu OAuth] Token response code:", tokenData.code);
      if (tokenData.code !== 0) {
        console.error("[Feishu OAuth] Token exchange failed:", JSON.stringify(tokenData));
        res.status(502).send(oauthErrorHtml("Token exchange failed", tokenData.msg || "Unknown error"));
        return;
      }
      // v2 response: access_token at top level (not nested under data)
      const userAccessToken = tokenData.access_token || tokenData.data?.access_token;
      if (!userAccessToken) {
        console.error("[Feishu OAuth] No access_token in response. Keys:", Object.keys(tokenData));
        res.status(502).send(oauthErrorHtml("Token exchange failed", "No access_token in response"));
        return;
      }

      // Step 2: Get user info (CRITICAL: /authen/v1/user_info with underscore!)
      console.log("[Feishu OAuth] Fetching user info...");
      const userInfoResp = await fetch("https://open.feishu.cn/open-apis/authen/v1/user_info", {
        headers: { Authorization: `Bearer ${userAccessToken}` },
        signal: AbortSignal.timeout(10000),
      });
      const userInfo = (await userInfoResp.json()) as any;
      console.log("[Feishu OAuth] User info response:", JSON.stringify(userInfo));
      if (userInfo.code !== 0) {
        console.error("[Feishu OAuth] User info failed:", JSON.stringify(userInfo));
        res.status(502).send(oauthErrorHtml("User info failed", userInfo.msg || "Unknown error"));
        return;
      }

      const feishuUser = userInfo.data;
      // Step 3: Determine user ID
      const userIdField = config.feishuAuth.userIdField;
      const rawValue = feishuUser[userIdField];
      let fieldWarning = "";
      if (!rawValue && userIdField !== "open_id") {
        fieldWarning = `Configured user_id_field "${userIdField}" is empty — the Feishu app may lack the required scope (e.g. contact:user.email:readonly). Falling back to open_id.`;
        console.warn(`[Feishu OAuth] ${fieldWarning} Available fields: ${Object.keys(feishuUser).join(", ")}.`);
      }
      const userId = rawValue || feishuUser.open_id || "";
      console.log(`[Feishu OAuth] User: field=${userIdField}, value=${rawValue}, open_id=${feishuUser.open_id}, resolved=${userId}`);

      // Step 4: Check allowlist
      const allowed = config.feishuAuth.allowedUsers;
      if (allowed && allowed.length > 0 && !allowed.includes(userId)) {
        const detail = fieldWarning
          ? `${fieldWarning} Your resolved ID (${userId}) does not match the allowlist.`
          : `Your account (${userId}) is not in the allowlist.`;
        console.warn(`[Feishu OAuth] Access denied for ${userId} (allowlist: ${allowed.join(",")})`);
        res.status(403).send(oauthErrorHtml("Access denied", detail));
        return;
      }

      // Step 5: Issue JWT
      const name = feishuUser.name || userId;
      const avatarUrl = feishuUser.avatar_url || "";
      console.log(`[Feishu OAuth] Login success: userId=${userId}, name=${name}`);
      const token = jwt.sign(
        { sub: userId, name, avatar_url: avatarUrl, auth_method: "feishu" },
        config.jwtSecret,
        { expiresIn: "1h", audience: "session" },
      );

      // Step 6: Return HTML page with localStorage write (NOT Set-Cookie — Safari/ITP)
      res.setHeader("Cache-Control", "no-store");
      res.send(oauthSuccessHtml(token));
    } catch (err: any) {
      console.error("Feishu OAuth error:", err);
      res.status(500).send(oauthErrorHtml("Internal error", err.message || "Unknown error"));
    }
  });

  const server = createServer(app);
  const wss = new WebSocketServer({ server, path: "/ws" });

  const activeStreams = new Map<string, AbortController>();

  wss.on("connection", (ws, req) => {
    // Verify JWT from query param and extract user info
    const url = new URL(req.url ?? "", `http://${req.headers.host}`);
    const token = url.searchParams.get("token");
    const decoded = decodeToken(token, config.jwtSecret);
    if (!decoded) {
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
          userId: decoded.sub || "webchat_user",
          sessionKey: `webchat:${sessionId}`,
          extra: { sessionId },
        };

        try {
          const text = msg.content.trim();

          // Handle /debug prefix (not a command — it's a mode flag)
          let question = text;
          if (text.startsWith("/debug2 ") || text.startsWith("/debug ")) {
            question = text.replace(/^\/debug2?\s+/, "").trim();
            if (!question) {
              ws.send(JSON.stringify({ type: "message_complete", sessionId, content: "用法: /debug <你的问题>" }));
              activeStreams.delete(sessionId);
              channel.unregisterSocket(sessionId);
              return;
            }
            // Send session key info (webchat already shows tool calls via streaming)
            ws.send(JSON.stringify({ type: "message_complete", sessionId, content: `[debug] session=webchat:${sessionId}` }));
          }

          if (question.startsWith("/")) {
            // Commands go through non-streaming path
            await router.handleMessage(channel, ctx, question);
          } else {
            // Questions go through streaming path
            await agent.askStreaming(
              question,
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
    jwt.verify(authHeader.slice(7), secret, { algorithms: ["HS256"], audience: "session" });
    return true;
  } catch {
    return false;
  }
}

function decodeToken(token: string | null, secret: string): { sub: string; [k: string]: unknown } | null {
  if (!token) return null;
  try {
    return jwt.verify(token, secret, {
      algorithms: ["HS256"],
      audience: "session",
    }) as { sub: string; [k: string]: unknown };
  } catch {
    return null;
  }
}

function oauthSuccessHtml(token: string): string {
  // No escaping needed — JWT is base64url (no " < > chars)
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Login</title>
<style>body{font-family:system-ui;display:flex;justify-content:center;align-items:center;height:100vh;background:#f5f3ef}
p{color:#78736c;font-size:1rem}</style></head><body>
<p>Signing in\u2026</p>
<script>
try {
  localStorage.setItem("zhiliao_token", ${JSON.stringify(token)});
  window.location.replace("/");
} catch(e) {
  document.body.innerHTML = "<p style=color:red>Login failed: " + e.message + "</p>";
}
</script></body></html>`;
}

function oauthErrorHtml(title: string, detail: string): string {
  const safeTitle = title.replace(/</g, "&lt;");
  const safeDetail = detail.replace(/</g, "&lt;");
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Error</title>
<style>body{font-family:system-ui;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#f5f3ef}
.card{background:#fff;border-radius:10px;padding:32px 40px;box-shadow:0 4px 20px rgba(0,0,0,.1);text-align:center;max-width:400px}
h2{color:#dc2626;margin:0 0 12px}p{color:#78736c;margin:0 0 20px;font-size:.9rem}
a{color:#0d7377;text-decoration:none;font-weight:600}</style></head>
<body><div class="card"><h2>${safeTitle}</h2><p>${safeDetail}</p>
<a href="/">Return to login</a></div></body></html>`;
}
