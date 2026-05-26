import { createOpenAI } from "@ai-sdk/openai";
import { streamText, stepCountIs, type LanguageModel } from "ai";
import { createToolsFromDefs } from "../tool";
import {
  buildFaraSystemPrompt,
  faraToolDefs,
  parseToolCallFromText,
  runComputerUse,
  type FaraBackend,
} from "../fara";
import {
  errorText,
  formatGenericError,
  hasToolCall,
  looksLikeConnectionFailure,
  sawTerminate,
  streamIntoConversation,
} from "./streaming";
import { createLogger } from "../../logger";
import type { BackendContext, ChatBackend } from "./types";

const log = createLogger("fara");
const FARA_TEMPERATURE = 0;
const STEPS_PER_ROUND = 1;
const DEFAULT_MAX_ROUNDS = 15;

const maxRounds = (): number => {
  const parsed = Number(process.env.FARA_MAX_ROUNDS);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_MAX_ROUNDS;
};

const createModel = (backend: FaraBackend, modelId: string): LanguageModel =>
  createOpenAI({
    baseURL: backend.baseURL,
    apiKey: process.env.OPENAI_API_KEY ?? "local",
  }).chat(modelId);

export const createFaraVllmBackend = (backend: FaraBackend): ChatBackend => {
  const modelName = backend.defaultModel;
  const model = createModel(backend, modelName);

  const appendAssistantLine = (ctx: BackendContext, line: string): void => {
    const last = ctx.conversation.messages[ctx.conversation.messages.length - 1];
    if (last?.role === "assistant" && typeof last.content === "string") {
      ctx.conversation.setAt(ctx.conversation.messages.length - 1, {
        role: "assistant",
        content: `${last.content}\n${line}`,
      });
    } else {
      ctx.conversation.push({ role: "assistant", content: line });
    }
  };

  const executeParsedToolCall = async (
    text: string,
    ctx: BackendContext,
  ): Promise<boolean> => {
    const parsed = parseToolCallFromText(text);
    if (!parsed) return false;
    try {
      const result = await runComputerUse(parsed, { window: ctx.window });
      log.info({ action: parsed.action, result }, "Executed parsed Fara tool call");
      if (result.terminated) return true;
      appendAssistantLine(
        ctx,
        `Executed ${parsed.action}${result.url ? ` — now at ${result.url}` : ""}.`,
      );
      return true;
    } catch (error) {
      log.error({ err: error, parsed }, "Parsed tool call failed");
      return false;
    }
  };

  return {
    id: "fara-vllm",
    get languageModel() { return model; },
    isReady: () => true,
    async prepareUserMessage(text, ctx) {
      const screenshot = await ctx.captureScreenshot();
      return {
        role: "user",
        content: screenshot
          ? [
              { type: "image", image: screenshot },
              { type: "text", text },
            ]
          : text,
      };
    },
    async runTurn(_userText, ctx) {
      const rounds = maxRounds();
      const system = buildFaraSystemPrompt(ctx.window?.activeTab?.url ?? null);

      for (let round = 0; round < rounds; round++) {
        if (round > 0) {
          const screenshot = await ctx.captureScreenshot();
          if (screenshot) {
            ctx.conversation.push({
              role: "user",
              content: [
                { type: "image", image: screenshot },
                {
                  type: "text",
                  text: "Updated screenshot after your last action. Continue the task or call computer_use with action terminate when done.",
                },
              ],
            });
          }
        }

        const isLast = round === rounds - 1;
        const result = streamText({
          model,
          system,
          messages: ctx.conversation.messages,
          tools: createToolsFromDefs(faraToolDefs, { window: ctx.window }),
          stopWhen: stepCountIs(STEPS_PER_ROUND),
          temperature: FARA_TEMPERATURE,
          maxRetries: 1,
          maxOutputTokens: 1024,
        });
        await streamIntoConversation(result, ctx, { markComplete: isLast });

        const steps = await result.steps;
        const finalText = await result.text;
        let hadCall = hasToolCall(steps, "computer_use");
        if (!hadCall) hadCall = await executeParsedToolCall(finalText, ctx);

        if (sawTerminate(steps) || !hadCall) {
          ctx.emit({ content: "", isComplete: true });
          return;
        }
      }

      ctx.emit({ content: "\n\n(Reached maximum agent steps.)", isComplete: true });
    },
    async formatError(error) {
      const text = errorText(error);
      if (looksLikeConnectionFailure(text)) return backend.connectionHelp();
      if (text.includes("not found") && text.includes("model")) {
        return backend.modelNotFoundHelp(modelName, await backend.listModels());
      }
      return formatGenericError(error);
    },
    async logStartup() {
      await backend.logStartupHint(modelName);
    },
  };
};
