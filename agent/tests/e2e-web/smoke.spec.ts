import { expect, test } from "@playwright/test";
import { getDebugState, getEventKinds, loginWithTestToken, waitForWsMessage } from "./cdp-helpers.js";
import { logFailure } from "./failure-log.js";

const TEST_TOKEN = process.env.E2E_TEST_TOKEN ?? "e2e-fixed-token";

test.afterEach(async ({ page }, testInfo) => {
  if (testInfo.status === testInfo.expectedStatus) return;
  const state = await getDebugState(page).catch(() => null);
  const events = await getEventKinds(page).catch(() => [] as string[]);
  logFailure({
    ts: new Date().toISOString(),
    test: testInfo.title,
    error: testInfo.error?.message ?? "unknown",
    state,
    events,
  });
});

test("health endpoint returns ok", async ({ request }) => {
  const resp = await request.get("/api/health");
  expect(resp.ok()).toBe(true);
  expect(await resp.json()).toEqual({ status: "ok" });
});

test("test-token bypass rejects wrong token", async ({ request }) => {
  const resp = await request.get("/api/auth/test-token?token=wrong");
  expect(resp.status()).toBe(401);
});

test("test-token bypass issues valid JWT", async ({ request }) => {
  const resp = await request.get(`/api/auth/test-token?token=${TEST_TOKEN}`);
  expect(resp.ok()).toBe(true);
  const body = await resp.json();
  expect(typeof body.token).toBe("string");
  expect(body.token.split(".").length).toBe(3); // header.payload.signature
});

test("login → send /help → receives command response via WS", async ({ page }) => {
  await loginWithTestToken(page, TEST_TOKEN);

  // Chat screen should be visible after login
  await expect(page.locator("#chat-screen")).toBeVisible({ timeout: 5000 });

  // CDP debug must be injected (URL has test_token)
  const state = await getDebugState(page);
  expect(state).not.toBeNull();
  expect(state!.hasToken).toBe(true);

  // Wait for WS to connect
  await page.waitForFunction(
    () => (window as any).__zhiliao_cdp?.events?.some((e: any) => e.kind === "ws_open"),
    null,
    { timeout: 5000 },
  );

  // Send /help
  const input = page.locator("#message-input");
  await input.fill("/help");
  await page.locator("#send-btn").click();

  // Wait for message_complete event on WS
  const msg = await waitForWsMessage(page, (p: any) => p.type === "message_complete", 8000);
  expect(msg).toBeTruthy();
  expect(String(msg.content)).toContain("命令列表");
});

test("send echo question → streaming deltas arrive then complete", async ({ page }) => {
  await loginWithTestToken(page, TEST_TOKEN);
  await expect(page.locator("#chat-screen")).toBeVisible();

  // Wait for WS to be open
  await page.waitForFunction(
    () => (window as any).__zhiliao_cdp?.events?.some((e: any) => e.kind === "ws_open"),
    null,
    { timeout: 5000 },
  );

  await page.locator("#message-input").fill("hello world");
  await page.locator("#send-btn").click();

  const delta = await waitForWsMessage(page, (p: any) => p.type === "text_delta", 8000);
  expect(String(delta.content)).toMatch(/Echo|hello/);

  const complete = await waitForWsMessage(page, (p: any) => p.type === "message_complete", 8000);
  expect(String(complete.content)).toBe("Echo: hello world");
});
