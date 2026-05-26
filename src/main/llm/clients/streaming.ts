import type {
  CoreMessage,
  StepResult,
  StreamTextResult,
  ToolSet,
} from "ai";
import type { BackendContext } from "./types";

/** Stream text chunks into the conversation and emit them to the renderer. */
export const streamIntoConversation = async (
  result: StreamTextResult<ToolSet, never>,
  ctx: BackendContext,
  options: { markComplete: boolean },
): Promise<void> => {
  const placeholderIndex = ctx.conversation.messages.length;
  ctx.conversation.push({ role: "assistant", content: "" });

  let accumulated = "";
  for await (const chunk of result.textStream) {
    accumulated += chunk;
    ctx.conversation.setAt(placeholderIndex, {
      role: "assistant",
      content: accumulated,
    });
    ctx.emit({ content: chunk, isComplete: false });
  }

  const steps = await result.steps;
  const turnMessages: CoreMessage[] = [];
  for (const step of steps) {
    for (const msg of step.response.messages) turnMessages.push(msg as CoreMessage);
  }
  if (turnMessages.length > 0) {
    ctx.conversation.splice(placeholderIndex, 1, ...turnMessages);
  }

  if (options.markComplete) {
    ctx.emit({ content: await result.text, isComplete: true });
  }
};

export const hasToolCall = (
  steps: Array<StepResult<ToolSet>>,
  name: string,
): boolean =>
  steps.some((s) => (s.toolCalls ?? []).some((tc) => tc.toolName === name));

export const sawTerminate = (steps: Array<StepResult<ToolSet>>): boolean => {
  for (const step of steps) {
    for (const tr of step.toolResults ?? []) {
      if (tr.toolName !== "computer_use") continue;
      if ((tr.output as { terminated?: boolean } | undefined)?.terminated) return true;
    }
  }
  return false;
};

const collectErrorText = (error: unknown): string => {
  const parts: string[] = [];
  const visit = (value: unknown, depth = 0): void => {
    if (depth > 4 || value == null) return;
    if (value instanceof Error) {
      parts.push(value.message);
      if ("errors" in value && Array.isArray(value.errors)) {
        for (const nested of value.errors) visit(nested, depth + 1);
      }
      if ("lastError" in value) visit((value as { lastError?: unknown }).lastError, depth + 1);
      if ("cause" in value) visit(value.cause, depth + 1);
      return;
    }
    if (typeof value === "string") parts.push(value);
  };
  visit(error);
  return parts.join(" ");
};

export const errorText = (error: unknown): string =>
  collectErrorText(error).toLowerCase();

export const formatGenericError = (error: unknown): string => {
  if (!(error instanceof Error)) return "An unexpected error occurred. Please try again.";
  const text = errorText(error);
  if (text.includes("401") || text.includes("unauthorized"))
    return "Authentication error: Please check your API key in the .env file.";
  if (text.includes("429") || text.includes("rate limit"))
    return "Rate limit exceeded. Please try again in a few moments.";
  if (text.includes("network") || text.includes("fetch") || text.includes("econnrefused"))
    return "Network error: Please check your internet connection.";
  if (text.includes("timeout"))
    return "Request timeout: The service took too long to respond. Please try again.";
  if (text.includes("no output generated"))
    return "The model returned no output. Please try again.";
  return "Sorry, I encountered an error while processing your request. Please try again.";
};

export const looksLikeConnectionFailure = (text: string): boolean =>
  text.includes("econnrefused") ||
  text.includes("cannot connect to api") ||
  text.includes("fetch failed") ||
  text.includes("maxretriesexceeded") ||
  text.includes("no output generated");
