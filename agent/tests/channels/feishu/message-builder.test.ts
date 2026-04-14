import { describe, it, expect } from "vitest";
import {
  buildCardMessage,
  buildTextMessage,
  sanitizeMarkdown,
  tableToColumnSets,
  splitMarkdownSegments,
} from "../../../src/channels/feishu/message-builder.js";

describe("buildTextMessage", () => {
  it("wraps plain text in Feishu text format", () => {
    const result = buildTextMessage("hello world");
    expect(result).toEqual({
      msg_type: "text",
      content: JSON.stringify({ text: "hello world" }),
    });
  });
});

describe("buildCardMessage", () => {
  it("builds a card with title and default template", () => {
    const result = buildCardMessage("Hello **world**", { title: "My Title" });
    expect(result.msg_type).toBe("interactive");
    const parsed = JSON.parse(result.content);
    expect(parsed.config).toEqual({ wide_screen_mode: true });
    expect(parsed.header).toEqual({
      title: { tag: "plain_text", content: "My Title" },
      template: "blue",
    });
  });

  it("builds a card without header when no title", () => {
    const result = buildCardMessage("Just text");
    const parsed = JSON.parse(result.content);
    expect(parsed.header).toBeUndefined();
    expect(parsed.elements[0]).toEqual({
      tag: "markdown",
      content: "Just text",
    });
  });

  it("splits markdown with tables into multiple elements", () => {
    const md = "Before\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\nAfter";
    const result = buildCardMessage(md);
    const parsed = JSON.parse(result.content);
    // Should have: markdown("Before"), column_set(header), column_set(row), markdown("After")
    expect(parsed.elements.length).toBe(4);
    expect(parsed.elements[0].tag).toBe("markdown");
    expect(parsed.elements[0].content).toBe("Before");
    expect(parsed.elements[1].tag).toBe("column_set");
    expect(parsed.elements[1].background_style).toBe("grey");
    expect(parsed.elements[2].tag).toBe("column_set");
    expect(parsed.elements[2].background_style).toBe("default");
    expect(parsed.elements[3].tag).toBe("markdown");
    expect(parsed.elements[3].content).toBe("After");
  });

  it("sanitizes text segments but not table segments", () => {
    const md = "## Title\n\n| H |\n|---|\n| v |";
    const result = buildCardMessage(md);
    const parsed = JSON.parse(result.content);
    expect(parsed.elements[0].content).toBe("**Title**");
    expect(parsed.elements[1].tag).toBe("column_set");
  });
});

describe("sanitizeMarkdown", () => {
  it("converts headings to bold", () => {
    expect(sanitizeMarkdown("## Section Title")).toBe("**Section Title**");
    expect(sanitizeMarkdown("### Sub")).toBe("**Sub**");
  });

  it("converts inline code to bold", () => {
    expect(sanitizeMarkdown("use `fileName.ts` here")).toBe(
      "use **fileName.ts** here"
    );
  });

  it("does not touch code blocks", () => {
    const md = "```js\nconst x = `template`;\n```";
    expect(sanitizeMarkdown(md)).toBe(md);
  });

  it("removes horizontal rules", () => {
    expect(sanitizeMarkdown("above\n---\nbelow")).toBe("above\n\nbelow");
  });

  it("strips blockquote markers", () => {
    expect(sanitizeMarkdown("> quoted text")).toBe("quoted text");
  });
});

describe("tableToColumnSets", () => {
  it("creates column_set elements from table lines", () => {
    const lines = [
      "| Name | Value |",
      "|------|-------|",
      "| key  | 123   |",
    ];
    const elements = tableToColumnSets(lines);
    expect(elements).toHaveLength(2); // header + 1 data row
    // Header row: grey bg, bold
    expect(elements[0].tag).toBe("column_set");
    expect(elements[0].background_style).toBe("grey");
    const headerCols = (elements[0] as any).columns;
    expect(headerCols[0].elements[0].content).toBe("**Name**");
    expect(headerCols[1].elements[0].content).toBe("**Value**");
    // Data row: default bg, plain
    expect(elements[1].background_style).toBe("default");
    const dataCols = (elements[1] as any).columns;
    expect(dataCols[0].elements[0].content).toBe("key");
    expect(dataCols[1].elements[0].content).toBe("123");
  });

  it("handles multiple data rows", () => {
    const lines = [
      "| A | B |",
      "|---|---|",
      "| 1 | 2 |",
      "| 3 | 4 |",
    ];
    const elements = tableToColumnSets(lines);
    expect(elements).toHaveLength(3); // header + 2 data rows
  });
});

describe("splitMarkdownSegments", () => {
  it("splits text and table segments", () => {
    const md = "hello\n\n| A |\n|---|\n| 1 |\n\nworld";
    const segs = splitMarkdownSegments(md);
    expect(segs).toHaveLength(3);
    expect(segs[0].type).toBe("text");
    expect(segs[1].type).toBe("table");
    expect(segs[2].type).toBe("text");
  });

  it("preserves code blocks in text segments", () => {
    const md = "```\n| A |\n|---|\n| 1 |\n```";
    const segs = splitMarkdownSegments(md);
    expect(segs).toHaveLength(1);
    expect(segs[0].type).toBe("text");
    expect(segs[0].content.join("\n")).toContain("```");
  });

  it("handles markdown with no tables", () => {
    const md = "just text\nmore text";
    const segs = splitMarkdownSegments(md);
    expect(segs).toHaveLength(1);
    expect(segs[0].type).toBe("text");
  });
});
