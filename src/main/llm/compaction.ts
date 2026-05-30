import type { CoreMessage } from "ai";

/**
 * Context compaction via tool-result masking ("observation masking").
 *
 * Tool outputs are by far the bulkiest content in an agent transcript (a single
 * page_state or page-text result is 1–5 KB), and every step of every turn
 * re-sends the entire growing transcript — so unbounded tool results make input
 * tokens grow roughly O(n²) in the number of steps.
 *
 * We keep only the most recent `keepLast` tool results verbatim and replace the
 * output of older ones with a short stub, while preserving the tool *call*
 * record (role/toolCallId/toolName). The agent still sees that a call was made
 * and can re-run it if it needs the data again. This is a free, no-LLM
 * transformation applied only to the messages sent to the model — the caller's
 * own history is left untouched.
 */

const CLEARED_OUTPUT = {
  type: "text" as const,
  value:
    "[cleared to save context — re-run this tool if you still need its result]",
};

type MaybePart = { type?: unknown };

const isToolResultPart = (part: unknown): boolean =>
  !!part &&
  typeof part === "object" &&
  (part as MaybePart).type === "tool-result";

/**
 * Return a copy of `messages` with all but the last `keepLast` tool results
 * masked. Messages without tool results are passed through by reference.
 */
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
        return { ...(part as object), output: CLEARED_OUTPUT };
      }
      return part;
    });
    return changed ? ({ ...m, content } as CoreMessage) : m;
  });
};
