const mdBoldItalicRe = /\*\*\*(.+?)\*\*\*/g;
const mdBoldRe = /\*\*(.+?)\*\*/g;
const mdItalicRe = /\*([^*\n]+?)\*/g;
const mdLinkRe = /\[([^\]]+)\]\(([^)]+)\)/g;
const mdHeaderRe = /^#{1,6}\s+(.+)$/gm;
const mdStrikeRe = /~~(.+?)~~/g;
const mdUnorderedListRe = /^(\s*)[-*]\s+/gm;
const mdOrderedListRe = /^(\s*)\d+\.\s+/gm;
const mdTableRowRe = /^\|(.+)\|$/m;
const mdTableSepRe = /^\|[\s:]*-{2,}[\s:]*(\|[\s:]*-{2,}[\s:]*)*\|$/m;
const inlineCodeUrlRe = /(https?:\/\/|www\.|(?:[a-z0-9-]+\.)+[a-z]{2,}(?:[:/]|$))/i;
const slackLinkLabelRe = /^<([^>|]+)\|([^>]+)>$/;
const slackLinkBareRe = /^<([^>]+)>$/;

const phBIOpen = "\x00BI\x01";
const phBIClose = "\x00BI\x02";
const phBOpen = "\x00B\x01";
const phBClose = "\x00B\x02";

interface MarkdownSegment {
  readonly text: string;
  readonly isCode: boolean;
}

interface ProtectedCodeSegment {
  readonly token: string;
  readonly replacement: string;
}

export function markdownToMrkdwn(text: string): string {
  const [protectedText, codeSegments] = protectCodeSegments(text);
  return restoreCodeSegments(transformMarkdownText(protectedText), codeSegments);
}

export function markdownishToMrkdwn(text: string): string {
  const [protectedText, codeSegments] = protectCodeSegments(text);
  return restoreCodeSegments(transformMarkdownishText(protectedText), codeSegments);
}

export function markdownToSlackFallbackText(text: string): string {
  const fallback = markdownToMrkdwn(text).trim();
  if (fallback === "") {
    return text;
  }
  return fallback;
}

function sanitizeSlackCodeSegment(text: string): string {
  if (text.startsWith("```")) {
    return text;
  }
  if (text.length < 2 || text[0] !== "`" || text[text.length - 1] !== "`") {
    return text;
  }

  let inner = text.slice(1, -1);
  inner = normalizeInlineCodeSlackLink(inner);
  if (!inlineCodeUrlRe.test(inner)) {
    return text;
  }

  inner = breakSlackAutolink(inner);
  return `\`${inner}\``;
}

function normalizeInlineCodeSlackLink(text: string): string {
  const trimmed = text.trim();
  const labeledMatch = slackLinkLabelRe.exec(trimmed);
  if (labeledMatch) {
    const [, target, label] = labeledMatch;
    if (target!.startsWith("mailto:")) {
      if (label!.trim() !== "") {
        return label!;
      }
      return target!.slice("mailto:".length);
    }
    if (label!.trim() !== "" && label === target) {
      return label!;
    }
    return target!;
  }

  const bareMatch = slackLinkBareRe.exec(trimmed);
  if (bareMatch) {
    return bareMatch[1]!.replace(/^mailto:/, "");
  }

  return text;
}

function breakSlackAutolink(text: string): string {
  const protocolIndex = text.indexOf("://");
  if (protocolIndex >= 0) {
    const prefix = text.slice(0, protocolIndex + 3);
    const rest = text.slice(protocolIndex + 3);
    const dotIndex = rest.indexOf(".");
    if (dotIndex >= 0) {
      return `${prefix}${rest.slice(0, dotIndex + 1)}\u200B${rest.slice(dotIndex + 1)}`;
    }
    const slashIndex = rest.indexOf("/");
    if (slashIndex >= 0) {
      return `${prefix}${rest.slice(0, slashIndex + 1)}\u200B${rest.slice(slashIndex + 1)}`;
    }
    if (rest !== "") {
      return `${prefix}\u200B${rest}`;
    }
    return text;
  }

  const atIndex = text.indexOf("@");
  if (atIndex >= 0) {
    return `${text.slice(0, atIndex + 1)}\u200B${text.slice(atIndex + 1)}`;
  }

  const dotIndex = text.indexOf(".");
  if (dotIndex >= 0) {
    return `${text.slice(0, dotIndex + 1)}\u200B${text.slice(dotIndex + 1)}`;
  }

  const slashIndex = text.indexOf("/");
  if (slashIndex >= 0) {
    return `${text.slice(0, slashIndex + 1)}\u200B${text.slice(slashIndex + 1)}`;
  }

  return text;
}

function splitCodeSegments(text: string): MarkdownSegment[] {
  const segments: MarkdownSegment[] = [];
  let index = 0;

  while (index < text.length) {
    if (index + 2 < text.length && text.slice(index, index + 3) === "```") {
      const end = text.indexOf("```", index + 3);
      if (end >= 0) {
        segments.push({ text: text.slice(index, end + 3), isCode: true });
        index = end + 3;
        continue;
      }
      segments.push({ text: text.slice(index), isCode: true });
      return segments;
    }

    if (text[index] === "`") {
      const end = text.indexOf("`", index + 1);
      if (end >= 0) {
        segments.push({ text: text.slice(index, end + 1), isCode: true });
        index = end + 1;
        continue;
      }
    }

    let next = text.length;
    for (let cursor = index + 1; cursor < text.length; cursor += 1) {
      if (text[cursor] === "`") {
        next = cursor;
        break;
      }
    }
    segments.push({ text: text.slice(index, next), isCode: false });
    index = next;
  }

  return segments;
}

function protectCodeSegments(text: string): readonly [string, ProtectedCodeSegment[]] {
  const segments = splitCodeSegments(text);
  if (segments.length === 0) {
    return [text, []];
  }

  let protectedText = "";
  const protectedSegments: ProtectedCodeSegment[] = [];

  for (const [index, segment] of segments.entries()) {
    if (!segment.isCode) {
      protectedText += segment.text;
      continue;
    }

    const token = `\x00CODE${index}\x00`;
    protectedText += token;
    protectedSegments.push({
      token,
      replacement: sanitizeSlackCodeSegment(segment.text)
    });
  }

  return [protectedText, protectedSegments];
}

function restoreCodeSegments(text: string, segments: readonly ProtectedCodeSegment[]): string {
  let restored = text;
  for (const segment of segments) {
    restored = restored.replaceAll(segment.token, segment.replacement);
  }
  return restored;
}

function transformMarkdownText(text: string): string {
  return convertCommonMarkdown(convertEmphasis(text));
}

function transformMarkdownishText(text: string): string {
  return convertCommonMarkdown(convertStrongEmphasis(text));
}

function convertCommonMarkdown(text: string): string {
  let converted = convertMarkdownTable(text);
  converted = converted.replaceAll(mdLinkRe, (_match, label: string, target: string) => {
    return `<${normalizeMarkdownLinkTarget(target)}|${label}>`;
  });
  converted = converted.replaceAll(mdHeaderRe, "*$1*");
  converted = converted.replaceAll(mdStrikeRe, "~$1~");
  converted = converted.replaceAll(mdUnorderedListRe, "$1• ");
  converted = converted.replaceAll(mdOrderedListRe, normalizeOrderedListPrefix);
  converted = converted.replaceAll("\n---\n", "\n———\n");
  converted = converted.replaceAll("\n***\n", "\n———\n");
  converted = converted.replaceAll("\n___\n", "\n———\n");
  return converted;
}

function normalizeMarkdownLinkTarget(target: string): string {
  const trimmed = target.trim();
  const bareMatch = slackLinkBareRe.exec(trimmed);
  if (bareMatch) {
    return bareMatch[1]!;
  }
  return trimmed;
}

function normalizeOrderedListPrefix(match: string): string {
  const trimmed = match.replace(/^[ \t]*/, "");
  const indent = match.slice(0, match.length - trimmed.length);
  if (trimmed === "") {
    return match;
  }
  const marker = trimmed.trim();
  if (!marker.endsWith(".")) {
    return match;
  }
  return `${indent}${marker} `;
}

function convertEmphasis(text: string): string {
  let converted = text.replaceAll(mdBoldItalicRe, `${phBIOpen}$1${phBIClose}`);
  converted = converted.replaceAll(mdBoldRe, `${phBOpen}$1${phBClose}`);
  converted = converted.replaceAll(mdItalicRe, "_$1_");

  converted = converted.replaceAll(phBIOpen, "*_");
  converted = converted.replaceAll(phBIClose, "_*");
  converted = converted.replaceAll(phBOpen, "*");
  converted = converted.replaceAll(phBClose, "*");
  return converted;
}

function convertStrongEmphasis(text: string): string {
  let converted = text.replaceAll(mdBoldItalicRe, "*_$1_*");
  converted = converted.replaceAll(mdBoldRe, "*$1*");
  return converted;
}

function convertMarkdownTable(text: string): string {
  const lines = text.split("\n");
  const result: string[] = [];

  for (let index = 0; index < lines.length;) {
    if (
      index + 1 < lines.length &&
      mdTableRowRe.test(lines[index]!) &&
      mdTableSepRe.test(lines[index + 1]!)
    ) {
      const headers = parseTableRow(lines[index]!);
      index += 2;

      while (index < lines.length && mdTableRowRe.test(lines[index]!)) {
        const columns = parseTableRow(lines[index]!);
        const parts: string[] = [];

        for (const [columnIndex, column] of columns.entries()) {
          const trimmedColumn = column.trim();
          if (trimmedColumn === "") {
            continue;
          }

          if (columnIndex < headers.length) {
            const header = headers[columnIndex]!.trim();
            if (header !== "") {
              parts.push(`*${header}*: ${trimmedColumn}`);
              continue;
            }
          }

          parts.push(trimmedColumn);
        }

        if (parts.length > 0) {
          result.push(`• ${parts.join("  ·  ")}`);
        }
        index += 1;
      }
      continue;
    }

    result.push(lines[index]!);
    index += 1;
  }

  return result.join("\n");
}

function parseTableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((part) => part.trim());
}
