import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";
import {
  isDegenerateModelOutput,
  requestOllamaFaraDecision,
  runComputerUse,
  summarizeInvalidDecision,
  type FaraBackend,
} from "../fara";
import {
  errorText,
  formatGenericError,
  looksLikeConnectionFailure,
} from "./streaming";
import type { BackendContext, ChatBackend } from "./types";

const DEFAULT_MAX_ROUNDS = 15;

const maxRounds = (): number => {
  const parsed = Number(process.env.FARA_MAX_ROUNDS);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_MAX_ROUNDS;
};

const setOrAppendAssistant = (ctx: BackendContext, text: string): void => {
  const idx = ctx.conversation.messages.length - 1;
  const last = ctx.conversation.messages[idx];
  if (last?.role === "assistant") {
    ctx.conversation.setAt(idx, { role: "assistant", content: text });
  } else {
    ctx.conversation.push({ role: "assistant", content: text });
  }
};

const appendAssistantLine = (ctx: BackendContext, line: string): void => {
  const idx = ctx.conversation.messages.length - 1;
  const last = ctx.conversation.messages[idx];
  if (last?.role === "assistant" && typeof last.content === "string") {
    ctx.conversation.setAt(idx, {
      role: "assistant",
      content: `${last.content}\n${line}`,
    });
  } else {
    ctx.conversation.push({ role: "assistant", content: line });
  }
};

export const createFaraOllamaBackend = (backend: FaraBackend): ChatBackend => {
  let modelName = backend.defaultModel;
  let resolved = false;
  const model: LanguageModel = createOpenAI({
    baseURL: backend.baseURL,
    apiKey: process.env.OPENAI_API_KEY ?? "local",
  }).chat(modelName);

  const ensureResolved = async (): Promise<void> => {
    if (resolved) return;
    modelName = await backend.resolveModel(modelName);
    resolved = true;
  };

  return {
    id: "fara-ollama",
    languageModel: model,
    isReady: () => true,
    async prepareUserMessage(text) {
      return { role: "user", content: text };
    },
    async runTurn(userTask, ctx) {
      await ensureResolved();
      const rounds = maxRounds();
      let lastSummary = "";

      for (let round = 0; round < rounds; round++) {
        const pageUrl = ctx.window?.activeTab?.url ?? null;
        const { decision, rawText } = await requestOllamaFaraDecision({
          model: modelName,
          baseURL: backend.baseURL,
          task: userTask,
          pageUrl,
          pageTitle: ctx.window?.activeTab?.title ?? null,
          lastStepSummary: lastSummary,
        });

        if (isDegenerateModelOutput(rawText)) {
          const msg =
            "The local Fara model returned garbled text (common with Q4 on Ollama). " +
            "Clear chat, reduce context, or use vLLM with more VRAM for the full Fara model.";
          setOrAppendAssistant(ctx, msg);
          ctx.emit({ content: msg, isComplete: true });
          return;
        }

        if (!decision) {
          const msg = summarizeInvalidDecision(rawText);
          setOrAppendAssistant(ctx, msg);
          ctx.emit({ content: msg, isComplete: true });
          return;
        }

        if (decision.kind === "answer") {
          setOrAppendAssistant(ctx, decision.text);
          ctx.emit({ content: decision.text, isComplete: true });
          return;
        }

        const result = await runComputerUse(decision, { window: ctx.window });
        lastSummary = JSON.stringify(result);

        if (decision.action === "terminate" || result.terminated) {
          const done = `Done (${decision.status ?? result.status ?? "success"}).`;
          appendAssistantLine(ctx, done);
          ctx.emit({ content: `\n${done}`, isComplete: true });
          return;
        }

        const note = `Executed ${decision.action}${result.url ? ` -> ${result.url}` : ""}.`;
        appendAssistantLine(ctx, note);

        if (decision.action === "visit_url" || decision.action === "web_search") {
          ctx.emit({ content: `\n${note}`, isComplete: true });
          return;
        }
        ctx.emit({ content: `\n${note}`, isComplete: false });
      }

      ctx.emit({
        content: "\n\n(Reached maximum agent steps.)",
        isComplete: true,
      });
    },
    async formatError(error) {
      const text = errorText(error);
      if (text.includes("not found") && text.includes("model")) {
        return backend.modelNotFoundHelp(modelName, await backend.listModels());
      }
      if (looksLikeConnectionFailure(text)) return backend.connectionHelp();
      if (text.includes("garbled") || text.includes("degenerate")) {
        return "Local Fara model failed. Clear chat, reduce context, or switch to vLLM with more VRAM.";
      }
      return formatGenericError(error);
    },
    async logStartup() {
      await ensureResolved();
      await backend.logStartupHint(modelName);
    },
  };
};
