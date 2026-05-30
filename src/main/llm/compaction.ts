import type { CoreMessage } from "ai";

const CLEARED_OUTPUTS: Record<string, { type: "text"; value: string }> = {
  // Most tool results just get a minimal placeholder.
  default: { type: "text" as const, value: "[cleared]" },
  // For tool results that might still be useful for context, slightly longer.
  "getPageText": { type: "text" as const, value: "[text cleared — re-run this tool if still needed]" },
  "searchPage": { type: "text" as const, value: "[search content cleared]" },
  "getPageState": { type: "text" as const, value: "[page_state cleared]" },
};

const isToolResultPart = (part: unknown): boolean => !!part && typeof part === "object" && (part as { type?: unknown }).type === "tool-result";

export const maskStaleToolResults = (
  messages: CoreMessage[],
  keepLast: number,
): CoreMessage[] => {
  if (keepLast < 0) return messages;

  const positions: Array<{ mi: number; pi: number }> = [];
  messages.forEach((m, mi) => {
    if (!Array.isArray(m.content)) return;
    m.content.forEach((part, pi) => {
      if (isToolResultPart(part)) positions.push({ mi, pi });
    });
  });

  if (positions.length <= keepLast) return messages;

  const maskCount = positions.length - keepLast;
  const masked = new Set(
    positions.slice(0, maskCount).map(({ mi, pi }) => `${mi}:${pi}`),
  );

  return messages.map((m, mi) => {
    if (!Array.isArray(m.content)) return m;
    let changed = false;
    const content = m.content.map((part, pi) => {
      if (masked.has(`${mi}:${pi}`) && isToolResultPart(part)) {
        changed = true;
        return { ...(part as object), output: CLEARED_OUTPUTS[part.name] ?? CLEARED_OUTPUTS.default };
      }
    return part;
    });
    return changed ? ({ ...m, content } as CoreMessage) : m;
  });
};
