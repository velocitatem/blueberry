import { generateText, type LanguageModel } from "ai";
import type { AppEvent } from "./events";
import type { EventTail } from "./eventTail";
import { createLogger } from "./logger";

const log = createLogger("workflow");

export interface CompiledWorkflow {
  goal: string;
  steps: string[];
  extractedEntities: string[];
  automationPrompt: string;
  riskLevel: "low" | "medium" | "high";
  riskWarnings: string[];
  repeatabilityScore: number;
  rawJson?: string;
}

const MAX_EVENTS_FOR_PROMPT = 80;

const isTabEvent = (event: AppEvent): boolean => event.source === "tab";

const summarizeEvent = (event: AppEvent): Record<string, unknown> => {
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  return {
    t: event.timestamp,
    kind: event.type.replace(/^tab\./, ""),
    tab: event.channel,
    url: payload.url,
    title: payload.title,
    data: payload.data,
  };
};

const SYSTEM_PROMPT = [
  "You analyze a user's recent browsing session and compile it into a reusable workflow.",
  "Infer the user's high-level goal, the repeatable steps they performed, any data they appeared to extract, and risks of automating the task.",
  "Respond with ONLY a JSON object — no markdown fences, no commentary — matching this schema:",
  "{",
  '  "goal": string,',
  '  "steps": string[],',
  '  "extractedEntities": string[],',
  '  "automationPrompt": string,    // prompt suitable for handing to a browser agent',
  '  "riskLevel": "low" | "medium" | "high",',
  '  "riskWarnings": string[],',
  '  "repeatabilityScore": number   // 0..1',
  "}",
].join("\n");

const stripJsonFence = (text: string): string => {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1].trim() : trimmed;
};

export class WorkflowCompiler {
  constructor(
    private readonly tail: EventTail,
    private readonly model: LanguageModel | null,
  ) {}

  recentSessionEvents(): AppEvent[] {
    const all = this.tail.snapshot(isTabEvent);
    return all.slice(-MAX_EVENTS_FOR_PROMPT);
  }

  sessionSummary(): {
    eventCount: number;
    uniqueUrls: number;
    startedAt: string | null;
  } {
    const events = this.tail.snapshot(isTabEvent);
    const urls = new Set<string>();
    for (const event of events) {
      const url = (event.payload as { url?: string } | undefined)?.url;
      if (url) urls.add(url);
    }
    return {
      eventCount: events.length,
      uniqueUrls: urls.size,
      startedAt: events[0]?.timestamp ?? null,
    };
  }

  async compile(): Promise<CompiledWorkflow> {
    if (!this.model) {
      throw new Error(
        "LLM is not configured. Add an API key to .env to compile workflows.",
      );
    }

    const events = this.recentSessionEvents();
    if (events.length === 0) {
      throw new Error(
        "No session events recorded yet. Browse a few pages, then try again.",
      );
    }

    const timeline = events.map(summarizeEvent);
    const userPrompt = [
      "Here is the user's recent session timeline as JSON:",
      "```json",
      JSON.stringify(timeline, null, 2),
      "```",
      "Compile it into a reusable workflow JSON object as specified.",
    ].join("\n");

    const result = await generateText({
      model: this.model,
      system: SYSTEM_PROMPT,
      prompt: userPrompt,
      temperature: 0.2,
      maxRetries: 2,
    });

    const raw = stripJsonFence(result.text);
    try {
      const parsed = JSON.parse(raw) as CompiledWorkflow;
      return { ...parsed, rawJson: raw };
    } catch (error) {
      log.error({ err: error, raw }, "Failed to parse workflow JSON");
      throw new Error("Workflow compiler returned malformed JSON.");
    }
  }
}
