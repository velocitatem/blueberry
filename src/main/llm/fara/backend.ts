import { createLogger } from "../../logger";

const log = createLogger("fara");

export type FaraBackendId = "vllm" | "ollama";

export interface FaraBackend {
  readonly id: FaraBackendId;
  readonly baseURL: string;
  readonly defaultModel: string;
  listModels(): Promise<string[]>;
  resolveModel(configured: string): Promise<string>;
  healthCheck(): Promise<boolean>;
  modelNotFoundHelp(model: string, available: string[]): string;
  connectionHelp(): string;
  logStartupHint(model: string): Promise<void>;
}

const trimSlash = (s: string): string => s.replace(/\/$/, "");
const ollamaRoot = (baseURL: string): string => baseURL.replace(/\/v1\/?$/, "");

const ping = async (baseURL: string): Promise<boolean> => {
  try {
    const r = await fetch(`${baseURL}/models`, {
      signal: AbortSignal.timeout(4000),
    });
    return r.ok;
  } catch {
    return false;
  }
};

const listOllamaTags = async (baseURL: string): Promise<string[]> => {
  try {
    const r = await fetch(`${ollamaRoot(baseURL)}/api/tags`, {
      signal: AbortSignal.timeout(4000),
    });
    if (!r.ok) return [];
    const data = (await r.json()) as { models?: Array<{ name?: string }> };
    return (data.models ?? [])
      .map((m) => m.name)
      .filter((n): n is string => Boolean(n));
  } catch {
    return [];
  }
};

const OLLAMA_ALIASES = [
  "fara:7b",
  "fara:latest",
  "fara",
  "maternion/fara:7b",
  "maternion/fara:latest",
];

const createVllmBackend = (baseURL: string): FaraBackend => ({
  id: "vllm",
  baseURL,
  defaultModel: process.env.LLM_MODEL || "microsoft/Fara-7B",
  listModels: async () => [],
  resolveModel: async (configured) => configured,
  healthCheck: () => ping(baseURL),
  modelNotFoundHelp: (model) => `vLLM does not have model "${model}".`,
  connectionHelp: () =>
    [
      `Cannot reach the model server at ${baseURL}.`,
      "Nothing is listening on that port — start a server first.",
      "",
      "Low VRAM (8–12GB) — Ollama + quantized Fara:",
      "  ollama pull maternion/fara:7b",
      "  ollama serve",
      "  LLM_BACKEND=ollama",
      "  LLM_MODEL=maternion/fara:7b",
      "",
      "16GB+ VRAM — vLLM (reduced context):",
      "  vllm serve microsoft/Fara-7B --port 5000 --dtype half --max-model-len 4096 --gpu-memory-utilization 0.85",
    ].join("\n"),
  async logStartupHint(model) {
    if (!(await ping(baseURL))) {
      log.warn(
        { baseURL },
        "vLLM not reachable. See README for low-VRAM Ollama setup.",
      );
      return;
    }
    log.info({ baseURL, backend: "vllm", model }, "Fara server reachable");
  },
});

const createOllamaBackend = (baseURL: string): FaraBackend => ({
  id: "ollama",
  baseURL,
  defaultModel: process.env.LLM_MODEL || "maternion/fara:7b",
  listModels: () => listOllamaTags(baseURL),
  async resolveModel(configured) {
    const available = await listOllamaTags(baseURL);
    if (available.length === 0) return configured;
    if (available.includes(configured)) return configured;
    for (const alias of OLLAMA_ALIASES) {
      if (available.includes(alias)) {
        if (alias !== configured) {
          log.info(
            { configured, resolved: alias },
            "Resolved Ollama Fara model name",
          );
        }
        return alias;
      }
    }
    const fuzzy = available.find((n) => /fara/i.test(n));
    if (fuzzy) {
      log.info(
        { configured, resolved: fuzzy },
        "Resolved Ollama Fara model name",
      );
      return fuzzy;
    }
    return configured;
  },
  healthCheck: () => ping(baseURL),
  modelNotFoundHelp(model, available) {
    const list =
      available.length > 0
        ? available.join(", ")
        : "(none — run ollama pull maternion/fara:7b)";
    return [
      `Ollama does not have model "${model}".`,
      `Installed models: ${list}`,
      "",
      "Pull Fara and use the exact tag:",
      "  ollama pull maternion/fara:7b",
      "  LLM_MODEL=maternion/fara:7b",
    ].join("\n");
  },
  connectionHelp: () =>
    [
      `Cannot reach Ollama at ${baseURL}.`,
      "Start the model (fits ~8GB VRAM with Q4):",
      "  ollama pull maternion/fara:7b",
      "  ollama serve",
      "Then set LLM_MODEL=maternion/fara:7b in .env.",
    ].join("\n"),
  async logStartupHint(model) {
    if (!(await ping(baseURL))) {
      log.warn(
        { baseURL },
        "Ollama not reachable. Run: ollama pull maternion/fara:7b && ollama serve",
      );
      return;
    }
    const available = await listOllamaTags(baseURL);
    if (!available.includes(model)) {
      log.warn(
        { configuredModel: model, available },
        "Fara model not installed. Run: ollama pull maternion/fara:7b",
      );
      return;
    }
    log.info({ baseURL, model, backend: "ollama" }, "Fara server reachable");
  },
});

const resolveBaseURL = (id: FaraBackendId): string => {
  if (process.env.LLM_BASE_URL) return trimSlash(process.env.LLM_BASE_URL);
  return id === "ollama"
    ? "http://127.0.0.1:11434/v1"
    : "http://127.0.0.1:5000/v1";
};

const resolveBackendId = (): FaraBackendId =>
  process.env.LLM_BACKEND?.toLowerCase() === "ollama" ? "ollama" : "vllm";

export const getFaraBackend = (): FaraBackend => {
  const id = resolveBackendId();
  const baseURL = resolveBaseURL(id);
  return id === "ollama"
    ? createOllamaBackend(baseURL)
    : createVllmBackend(baseURL);
};
