interface FeishuMessage {
  msg_type: string;
  content: string;
}

export function buildTextMessage(text: string): FeishuMessage {
  return {
    msg_type: "text",
    content: JSON.stringify({ text }),
  };
}

export interface CardOptions {
  title?: string;
  template?: "blue" | "orange" | "red" | "green" | "purple";
}

function parseTableRow(line: string): string[] {
  return line
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((c) => c.trim());
}

function isSeparatorRow(line: string): boolean {
  return /^[\s|:-]+$/.test(line);
}

/**
 * Convert a markdown table into Feishu card column_set elements.
 * Returns an array of card elements (header column_set with grey bg + data column_sets).
 */
export function tableToColumnSets(tableLines: string[]): Record<string, unknown>[] {
  const headers = parseTableRow(tableLines[0]);
  const dataRows = tableLines.slice(1).filter((l) => !isSeparatorRow(l));

  if (dataRows.length === 0) return [];

  const _colCount = headers.length;

  const makeColumnSet = (
    cells: string[],
    bgStyle: string,
    bold: boolean
  ): Record<string, unknown> => ({
    tag: "column_set",
    flex_mode: "bisect",
    background_style: bgStyle,
    columns: headers.map((_h, i) => ({
      tag: "column",
      width: "weighted",
      weight: 1,
      vertical_align: "top",
      elements: [
        {
          tag: "markdown",
          content: bold ? `**${cells[i] ?? ""}**` : (cells[i] ?? ""),
        },
      ],
    })),
  });

  const elements: Record<string, unknown>[] = [];

  // Header row with grey background
  elements.push(makeColumnSet(headers, "grey", true));

  // Data rows
  for (const row of dataRows) {
    const cells = parseTableRow(row);
    elements.push(makeColumnSet(cells, "default", false));
  }

  return elements;
}

/**
 * Sanitize markdown for Feishu card rendering.
 * Handles: inline code → bold, headings → bold, blockquotes → plain, horizontal rules → blank.
 * Tables are handled separately by tableToColumnSets in buildCardMessage.
 */
export function sanitizeMarkdown(md: string): string {
  const parts = md.split(/(```[\s\S]*?```)/);

  return parts
    .map((part) => {
      if (part.startsWith("```")) return part;

      return (
        part
          .replace(/^(#{1,6})\s+(.+)$/gm, "**$2**")
          .replace(/(?<!`)`([^`\n]+?)`(?!`)/g, "**$1**")
          .replace(/^[-*_]{3,}\s*$/gm, "")
          .replace(/^>\s?/gm, "")
      );
    })
    .join("");
}

interface Segment {
  type: "text" | "table";
  content: string[];
}

/**
 * Split markdown into text and table segments.
 * Code blocks are kept within text segments (not split).
 */
export function splitMarkdownSegments(md: string): Segment[] {
  // First, protect code blocks by replacing them with placeholders
  const codeBlocks: string[] = [];
  const protected_ = md.replace(/(```[\s\S]*?```)/g, (_match, block) => {
    codeBlocks.push(block);
    return `\x00CB${codeBlocks.length - 1}\x00`;
  });

  const lines = protected_.split("\n");
  const segments: Segment[] = [];
  let textBuffer: string[] = [];
  let tableBuffer: string[] = [];

  const flushText = () => {
    if (textBuffer.length > 0) {
      segments.push({ type: "text", content: [...textBuffer] });
      textBuffer = [];
    }
  };

  const flushTable = () => {
    if (tableBuffer.length >= 2) {
      // Restore code blocks in table lines (unlikely but safe)
      const restored = tableBuffer.map((l) =>
        // eslint-disable-next-line no-control-regex -- intentional sentinel for code block placeholders
        l.replace(/\x00CB(\d+)\x00/g, (_m, i) => codeBlocks[Number(i)])
      );
      segments.push({ type: "table", content: restored });
    } else if (tableBuffer.length > 0) {
      textBuffer.push(...tableBuffer);
    }
    tableBuffer = [];
  };

  for (const line of lines) {
    if (/^\|.+\|/.test(line.trim())) {
      if (tableBuffer.length === 0) flushText();
      tableBuffer.push(line);
    } else {
      flushTable();
      textBuffer.push(line);
    }
  }
  flushTable();
  flushText();

  // Restore code blocks in text segments
  for (const seg of segments) {
    if (seg.type === "text") {
      seg.content = seg.content.map((l) =>
        // eslint-disable-next-line no-control-regex -- intentional sentinel for code block placeholders
        l.replace(/\x00CB(\d+)\x00/g, (_m, i) => codeBlocks[Number(i)])
      );
    }
  }

  return segments;
}

export function buildCardMessage(
  markdown: string,
  options?: CardOptions
): FeishuMessage {
  const segments = splitMarkdownSegments(markdown);
  const elements: Record<string, unknown>[] = [];

  for (const seg of segments) {
    if (seg.type === "table") {
      elements.push(...tableToColumnSets(seg.content));
    } else {
      const text = sanitizeMarkdown(seg.content.join("\n")).trim();
      if (text) {
        elements.push({ tag: "markdown", content: text });
      }
    }
  }

  // Fallback: if no elements, add empty markdown
  if (elements.length === 0) {
    elements.push({ tag: "markdown", content: markdown });
  }

  const card: Record<string, unknown> = {
    config: { wide_screen_mode: true },
    elements,
  };

  if (options?.title) {
    card.header = {
      title: { tag: "plain_text", content: options.title },
      template: options.template ?? "blue",
    };
  }

  return {
    msg_type: "interactive",
    content: JSON.stringify(card),
  };
}
