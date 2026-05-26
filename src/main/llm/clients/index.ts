import { getFaraBackend } from "../fara";
import { createSimpleBackend, type SimpleProvider } from "./simple";
import { createFaraVllmBackend } from "./faraVllm";
import { createFaraOllamaBackend } from "./faraOllama";
import type { ChatBackend } from "./types";

export type { ChatBackend, BackendContext, ConversationView, StreamChunk } from "./types";

const ALLOWED = ["openai", "anthropic", "fara"] as const;
type Provider = (typeof ALLOWED)[number];

const DEFAULT_MODELS: Record<SimpleProvider, string> = {
  openai: "gpt-5-nano",
  anthropic: "claude-3-5-sonnet-20241022",
};

const resolveProvider = (): Provider => {
  const p = process.env.LLM_PROVIDER?.toLowerCase();
  return (ALLOWED as readonly string[]).includes(p ?? "")
    ? (p as Provider)
    : "openai";
};

export const createChatBackend = (): ChatBackend => {
  const provider = resolveProvider();
  if (provider === "fara") {
    const backend = getFaraBackend();
    return backend.id === "ollama"
      ? createFaraOllamaBackend(backend)
      : createFaraVllmBackend(backend);
  }
  const modelName = process.env.LLM_MODEL || DEFAULT_MODELS[provider];
  return createSimpleBackend(provider, modelName);
};
