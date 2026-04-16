/**
 * Pattern-8: JSONL failure log. Each failure appends one structured line so
 * we can post-analyze without re-parsing Playwright HTML reports.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

const LOG_PATH = join(process.cwd(), "tests/e2e-web/failures.jsonl");

export interface FailureEntry {
  ts: string;
  test: string;
  error: string;
  state?: Record<string, unknown> | null;
  events?: string[];
}

export function logFailure(entry: FailureEntry): void {
  try {
    mkdirSync(dirname(LOG_PATH), { recursive: true });
    appendFileSync(LOG_PATH, JSON.stringify(entry) + "\n");
  } catch {
    // Swallow: log best-effort, must not mask the original test failure
  }
}
