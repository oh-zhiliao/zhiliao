/**
 * Helpers for loading IIFE-pattern frontend modules into a jsdom environment.
 *
 * The files in agent/web/js/ use `var Module = (function(){...})()` — they're
 * not ES modules and assume globals like `document`, `localStorage`, `marked`,
 * `hljs`. jsdom (vitest environment) provides DOM/localStorage; we stub the
 * rest and eval the source to extract the exported IIFE object.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

// vitest jsdom realm makes import.meta.url non-file; use cwd-relative instead.
// vitest runs from agent/ so web/js is accessible directly.
const WEB_JS = join(process.cwd(), "web/js");

/**
 * Load an IIFE module by file name. Evaluates the source in the current
 * (jsdom) realm so it can access window/document/localStorage. Returns
 * whatever the IIFE assigned to the named global.
 */
export function loadIife(fileName: string, globalName: string): any {
  const src = readFileSync(join(WEB_JS, fileName), "utf8");
  // Assign to globalThis so tests can read it back
  const wrapped = `${src}\nglobalThis.${globalName} = ${globalName};`;
  new Function(wrapped)();
  return (globalThis as any)[globalName];
}

export function resetLocalStorage(): void {
  localStorage.clear();
}
