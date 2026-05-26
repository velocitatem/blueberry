import { buildOllamaPlannerSystemPrompt } from "./prompt";
import type { ComputerUseInput } from "./parser";

export type OllamaFaraDecision =
  | { kind: "answer"; text: string }
  | ({ kind: "tool" } & ComputerUseInput);

const VALID_ACTIONS = [
  "visit_url",
  "web_search",
  "history_back",
  "wait",
  "terminate",
] as const;

const KNOWN_SITES: Record<string, string> = {
  github: "https://github.com/",
  google: "https://www.google.com/",
  youtube: "https://www.youtube.com/",
  reddit: "https://www.reddit.com/",
  wikipedia: "https://www.wikipedia.org/",
};

const coerceString = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() ? v.trim() : undefined;

const normalizeUrl = (v: string): string =>
  /^https?:\/\//i.test(v.trim()) ? v.trim() : `https://${v.trim()}`;

const actionFromUnknown = (obj: Record<string, unknown>): string | undefined => {
  const kind = coerceString(obj.kind);
  const action = coerceString(obj.action) ?? coerceString(obj.name);
  if (action) return action;
  if (kind && (VALID_ACTIONS as readonly string[]).includes(kind)) return kind;
  return undefined;
};

const inferNavigationFromText = (text: string): OllamaFaraDecision | null => {
  const lower = text.toLowerCase();
  if (!/\b(open|navigate|go to|visit)\b/.test(lower)) return null;
  const explicit = text.match(/https?:\/\/[^\s"'<>),]+/i)?.[0];
  if (explicit) return { kind: "tool", action: "visit_url", url: normalizeUrl(explicit) };
  for (const [name, url] of Object.entries(KNOWN_SITES)) {
    if (lower.includes(name)) return { kind: "tool", action: "visit_url", url };
  }
  return null;
};

const coerceDecision = (raw: unknown): OllamaFaraDecision | null => {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const kind = coerceString(obj.kind);

  if (kind === "answer") {
    const text = coerceString(obj.text) ?? "I could not determine an answer.";
    return inferNavigationFromText(text) ?? { kind: "answer", text };
  }

  const action = actionFromUnknown(obj);
  if (!action || !(VALID_ACTIONS as readonly string[]).includes(action)) return null;

  return {
    kind: "tool",
    action: action as ComputerUseInput["action"],
    url: coerceString(obj.url) ? normalizeUrl(coerceString(obj.url)!) : undefined,
    query: coerceString(obj.query),
    status: obj.status === "failure" ? "failure" : "success",
    time: typeof obj.time === "number" ? obj.time : undefined,
  };
};

const parseJsonDecision = (text: string): OllamaFaraDecision | null => {
  try {
    return coerceDecision(JSON.parse(text)) ?? inferNavigationFromText(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return inferNavigationFromText(text);
    try {
      return coerceDecision(JSON.parse(match[0])) ?? inferNavigationFromText(text);
    } catch {
      return inferNavigationFromText(text);
    }
  }
};

export const summarizeInvalidDecision = (rawText: string): string =>
  `Invalid structured response from local Fara: ${rawText.slice(0, 240)}`;

export const requestOllamaFaraDecision = async (opts: {
  model: string;
  baseURL: string;
  task: string;
  pageUrl: string | null;
  pageTitle?: string | null;
  lastStepSummary?: string;
}): Promise<{ decision: OllamaFaraDecision | null; rawText: string }> => {
  const root = opts.baseURL.replace(/\/v1\/?$/, "").replace(/\/$/, "");
  const user = [
    `User task: ${opts.task}`,
    opts.pageUrl ? `Current URL: ${opts.pageUrl}` : "Current URL: unknown",
    opts.pageTitle ? `Current title: ${opts.pageTitle}` : "",
    opts.lastStepSummary ? `Last step result: ${opts.lastStepSummary}` : "",
    "Choose the next browser action or answer.",
  ].filter(Boolean).join("\n");

  const response = await fetch(`${root}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: opts.model,
      messages: [
        { role: "system", content: buildOllamaPlannerSystemPrompt() },
        { role: "user", content: user },
      ],
      stream: false,
      format: "json",
      options: { temperature: 0, top_p: 0.1, num_predict: 220 },
    }),
    signal: AbortSignal.timeout(120_000),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Ollama error ${response.status}: ${body.slice(0, 400)}`);
  }

  const data = (await response.json()) as { message?: { content?: string } };
  const rawText = data.message?.content?.trim() ?? "";
  return { decision: parseJsonDecision(rawText), rawText };
};
