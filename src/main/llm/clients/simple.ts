import { streamText, stepCountIs, type LanguageModel } from "ai";
import { openai } from "@ai-sdk/openai";
import { anthropic } from "@ai-sdk/anthropic";
import { createTools } from "../tool";
import "../browserTools";
import { formatGenericError, streamIntoConversation } from "./streaming";
import type { BackendContext, ChatBackend } from "./types";

const MAX_TOOL_STEPS = 10;
const TEMPERATURE = 0.7;

export type SimpleProvider = "openai" | "anthropic";

const apiKeyFor = (provider: SimpleProvider): string | undefined =>
  process.env[provider === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY"];

const buildSystemPrompt = (url: string | null): string => {
  const parts = [
    "You are a helpful AI assistant integrated into a web browser.",
    "You can analyze and discuss web pages with the user.",
    "You have tools to read page text/HTML, get the current URL, and navigate the active tab.",
    "Use tools when you need up-to-date page content instead of guessing.",
  ];
  if (url) parts.push(`\nCurrent page URL: ${url}`);
  parts.push(
    "\nProvide helpful, accurate, and contextual responses about the current webpage.",
    "If the user asks about specific content, use your tools to inspect the page when needed.",
  );
  return parts.join("\n");
};

export const createSimpleBackend = (
  provider: SimpleProvider,
  modelName: string,
): ChatBackend => {
  const model: LanguageModel | null = apiKeyFor(provider)
    ? provider === "anthropic"
      ? anthropic(modelName)
      : openai(modelName)
    : null;

  return {
    id: provider,
    languageModel: model,
    isReady: () => model !== null,
    async prepareUserMessage(text) {
      return { role: "user", content: text };
    },
    async runTurn(_userText, ctx) {
      if (!model) {
        ctx.emit({
          content:
            "LLM service is not configured. Please add your API key to the .env file.",
          isComplete: true,
        });
        return;
      }
      const result = streamText({
        model,
        system: buildSystemPrompt(ctx.window?.activeTab?.url ?? null),
        messages: ctx.conversation.messages,
        tools: createTools({ window: ctx.window }),
        stopWhen: stepCountIs(MAX_TOOL_STEPS),
        temperature: TEMPERATURE,
        maxRetries: 3,
      });
      await streamIntoConversation(result, ctx, { markComplete: true });
    },
    async formatError(error) {
      return formatGenericError(error);
    },
  };
};
