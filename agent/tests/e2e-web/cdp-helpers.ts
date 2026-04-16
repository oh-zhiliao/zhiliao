/**
 * Pattern-2 wrappers: expose window.__zhiliao_cdp to Playwright tests.
 * All functions are null-safe — if cdp-debug.js wasn't injected (missing ?debug=1
 * or ?test_token=X), they return sentinels so failure messages point to the
 * injection issue rather than a generic TypeError.
 */
import type { Page } from "@playwright/test";

export async function getDebugState(page: Page): Promise<Record<string, unknown> | null> {
  return page.evaluate(() => {
    const cdp = (window as any).__zhiliao_cdp;
    return cdp ? cdp.state() : null;
  });
}

export async function getEventKinds(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const cdp = (window as any).__zhiliao_cdp;
    return cdp ? cdp.eventKinds() : [];
  });
}

export async function waitForWsMessage(
  page: Page,
  predicate: (msg: any) => boolean,
  timeoutMs = 5000,
): Promise<any> {
  return page.evaluate(
    async ({ predStr, timeout }) => {
      const cdp = (window as any).__zhiliao_cdp;
      if (!cdp) throw new Error("__zhiliao_cdp missing — ensure URL has ?test_token=X or ?debug=1");
      const pred = new Function("evt", `return (${predStr})(evt.payload);`);
      const evt = await cdp.waitForEvent(
        (e: any) => e.kind === "ws_message" && pred(e),
        timeout,
      );
      return evt.payload;
    },
    { predStr: predicate.toString(), timeout: timeoutMs },
  );
}

export async function loginWithTestToken(page: Page, token: string): Promise<void> {
  // Uses the test-token bypass endpoint exposed by server.ts when config.testToken is set.
  const response = await page.request.get(`/api/auth/test-token?token=${encodeURIComponent(token)}`);
  if (!response.ok()) {
    throw new Error(`test-token login failed: ${response.status()} ${await response.text()}`);
  }
  const { token: jwt } = await response.json();
  await page.goto(`/?test_token=${encodeURIComponent(token)}`);
  await page.evaluate((t) => localStorage.setItem("zhiliao_token", t), jwt);
  await page.reload();
}
