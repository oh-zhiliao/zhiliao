import { beforeEach, describe, expect, it } from "vitest";
import { loadIife } from "./helpers.js";

describe("Markdown", () => {
  let Markdown: any;

  beforeEach(() => {
    // Stub marked and hljs globally before loading the IIFE
    (globalThis as any).marked = {
      setOptions: (_opts: unknown) => {},
      parse: (text: string) => `<p>${text}</p>`,
    };
    (globalThis as any).hljs = {
      getLanguage: (_lang: string) => null,
      highlight: (code: string, _opts: unknown) => ({ value: code }),
      highlightAuto: (code: string) => ({ value: code }),
      highlightElement: (_el: unknown) => {},
    };
    Markdown = loadIife("markdown.js", "Markdown");
  });

  it("render returns empty string for empty input", () => {
    expect(Markdown.render("")).toBe("");
    expect(Markdown.render(null)).toBe("");
    expect(Markdown.render(undefined)).toBe("");
  });

  it("render delegates to marked.parse", () => {
    expect(Markdown.render("hello")).toBe("<p>hello</p>");
  });

  it("render falls back to escaped HTML on marked error", () => {
    (globalThis as any).marked.parse = () => {
      throw new Error("boom");
    };
    Markdown = loadIife("markdown.js", "Markdown");
    const result = Markdown.render("<script>x</script>");
    expect(result).toContain("&lt;script&gt;");
    expect(result).not.toContain("<script>");
  });

  it("renderInto writes HTML into given element", () => {
    const el = document.createElement("div");
    Markdown.renderInto(el, "text");
    expect(el.innerHTML).toBe("<p>text</p>");
  });
});
