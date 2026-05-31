import { mkdir, writeFile, appendFile } from "fs/promises";
import { join } from "path";
import type { CoreMessage, StepResult, ToolSet, LanguageModelUsage } from "ai";
import { createLogger } from "../logger";
import { tracer } from "../tracer";

const log = createLogger("harness");

export class LimitsExceeded extends Error {
  constructor(message = "Step limit exceeded.") {
    super(message);
    this.name = "LimitsExceeded";
  }
}

export type ErrorClass = "rate-limit" | "transient" | "fatal";

const TRANSIENT_STATUSES = new Set([408, 409, 425, 500, 502, 503, 504]);
const TRANSIENT_SIGNALS = [
  "bad gateway",
  "gateway timeout",
  "server disconnected",
  "temporarily unavailable",
  "connection reset",
  "connection aborted",
  "econnreset",
  "econnrefused",
  "etimedout",
  "timed out",
  "fetch failed",
];

const statusOf = (err: unknown): number | undefined => {
  if (!err || typeof err !== "object") return undefined;
  const e = err as Record<string, unknown>;
  const direct = e.statusCode ?? e.status;
  if (typeof direct === "number") return direct;
  const r = e.response as { status?: number } | undefined;
  return typeof r?.status === "number" ? r.status : undefined;
};

export const classifyError = (err: unknown): ErrorClass => {
  const status = statusOf(err);
  if (status === 429) return "rate-limit";
  if (status && TRANSIENT_STATUSES.has(status)) return "transient";
  const text = (err instanceof Error ? err.message : String(err)).toLowerCase();
  if (text.includes("rate limit") || text.includes("too many requests")) {
    return "rate-limit";
  }
  if (TRANSIENT_SIGNALS.some((s) => text.includes(s))) return "transient";
  return "fatal";
};

export const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

export const withRetries = async <T>(
  fn: () => Promise<T>,
  opts: { maxRetries?: number } = {},
): Promise<T> => {
  const max = opts.maxRetries ?? 5;
  let rl = 0;
  let tr = 0;
  while (true) {
    try {
      return await fn();
    } catch (err) {
      const cls = classifyError(err);
      if (cls === "rate-limit" && rl < max) {
        await sleep(Math.min(5000 * (rl + 1), 30_000));
        rl += 1;
        continue;
      }
      if (cls === "transient" && tr < max) {
        await sleep(Math.min(2000 * (tr + 1), 10_000));
        tr += 1;
        continue;
      }
      throw err;
    }
  }
};

export interface TurnTraceOpts {
  modelName: string;
  modelProvider: string;
  sessionId?: string;
}

export const withTurnTrace = <T>(
  opts: TurnTraceOpts,
  fn: () => Promise<T>,
): Promise<T> => {
  if (!tracer.llmobs?.enabled) return fn();

  return tracer.llmobs.trace(
    {
      kind: "agent",
      name: "agent.turn",
      modelName: opts.modelName,
      modelProvider: opts.modelProvider,
      sessionId: opts.sessionId,
    },
    () => fn(),
  ) as Promise<T>;
};

export const annotateTurnUsage = (usage: UsageSnapshot): void => {
  if (!tracer.llmobs?.enabled) return;
  tracer.llmobs.annotate(undefined, {
    metrics: {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      totalTokens: usage.totalTokens,
    },
  });
};

export const userFacingError = (err: unknown): string => {
  const cls = classifyError(err);
  if (cls === "rate-limit") return "Rate limit exceeded. Try again shortly.";
  const text = (err instanceof Error ? err.message : String(err)).toLowerCase();
  if (text.includes("401") || text.includes("unauthorized")) {
    return "Authentication error: check your API key in .env.";
  }
  if (cls === "transient") return "Network or upstream error. Try again.";
  return "Sorry, an error occurred while processing your request.";
};

export interface Observation {
  toolName: string;
  success: boolean;
  url?: string | null;
  title?: string | null;
  exception?: string | null;
  result?: string | null;
}

const truncate = (s: string, max: number): string =>
  s.length <= max ? s : `${s.slice(0, max)}…`;

export const renderObservation = (obs: Observation): string => {
  const lines = [
    `Status: ${obs.success ? "ok" : "error"}`,
    `Tool: ${obs.toolName}`,
  ];
  if (obs.url) lines.push(`URL: ${obs.url}`);
  if (obs.title) lines.push(`Title: ${obs.title}`);
  if (obs.exception) lines.push(`Exception: ${truncate(obs.exception, 800)}`);
  if (obs.result) lines.push(`Result: ${truncate(obs.result, 1200)}`);
  return lines.join("\n");
};

const stringifyResult = (r: unknown): string | null => {
  if (r === undefined || r === null) return null;
  if (typeof r === "string") return r;
  try {
    return JSON.stringify(r);
  } catch {
    return String(r);
  }
};

export const observationsFromStep = (
  step: StepResult<ToolSet>,
  page: { url?: string | null; title?: string | null },
): Observation[] => {
  const results = new Map<string, unknown>();
  for (const r of step.toolResults ?? []) {
    const tr = r as { toolCallId?: string; output?: unknown; result?: unknown };
    if (tr.toolCallId) results.set(tr.toolCallId, tr.output ?? tr.result);
  }
  return (step.toolCalls ?? []).map((call) => {
    const tc = call as { toolCallId?: string; toolName: string };
    const raw = tc.toolCallId ? results.get(tc.toolCallId) : undefined;
    const err =
      raw && typeof raw === "object"
        ? (raw as Record<string, unknown>).error
        : undefined;
    return {
      toolName: tc.toolName,
      success: !err,
      url: page.url ?? null,
      title: page.title ?? null,
      exception: err ? String(err) : null,
      result: stringifyResult(raw),
    };
  });
};

export interface UsageSnapshot {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

const zeroUsage = (): UsageSnapshot => ({
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
});

const readUsage = (u: LanguageModelUsage | undefined): UsageSnapshot => {
  if (!u) return zeroUsage();
  const a = u as unknown as Record<string, number | undefined>;
  return {
    inputTokens: Number(a.inputTokens ?? a.promptTokens ?? 0),
    outputTokens: Number(a.outputTokens ?? a.completionTokens ?? 0),
    totalTokens: Number(a.totalTokens ?? 0),
  };
};

export class UsageTracker {
  last: UsageSnapshot = zeroUsage();
  cumulative: UsageSnapshot = zeroUsage();

  record(u: LanguageModelUsage | undefined): void {
    const s = readUsage(u);
    this.last = s;
    this.cumulative = {
      inputTokens: this.cumulative.inputTokens + s.inputTokens,
      outputTokens: this.cumulative.outputTokens + s.outputTokens,
      totalTokens: this.cumulative.totalTokens + s.totalTokens,
    };
  }
}

export interface StepArtifact {
  step: number;
  /** Perception (sense stage): the page description the planner acted on. */
  description?: string;
  thought: string;
  toolCalls: Array<{ name: string; input: unknown }>;
  observations: Observation[];
  usage?: UsageSnapshot;
}

const sanitizeForDisk = (msg: CoreMessage): CoreMessage => {
  if (!Array.isArray(msg.content)) return msg;
  return {
    ...msg,
    content: msg.content.map((part) => {
      const p = part as Record<string, unknown>;
      return p.type === "image" && typeof p.image === "string"
        ? ({ ...part, image: "<omitted:data-url>" } as typeof part)
        : part;
    }),
  } as CoreMessage;
};

export class StepRecorder {
  private readonly stepsDir: string;
  private readonly summaryPath: string;
  private ready = false;

  constructor(readonly debugDir: string) {
    this.stepsDir = join(debugDir, "steps");
    this.summaryPath = join(debugDir, "steps.md");
  }

  private async ensure(): Promise<void> {
    if (this.ready) return;
    await mkdir(this.stepsDir, { recursive: true });
    this.ready = true;
  }

  async record(a: StepArtifact): Promise<void> {
    try {
      await this.ensure();
      const padded = String(a.step).padStart(4, "0");
      await writeFile(
        join(this.stepsDir, `step_${padded}.json`),
        JSON.stringify(a, null, 2),
      );
      const md: string[] = [`## Step ${a.step}\n`];
      if (a.description) md.push(`### Page description\n\n${a.description}\n`);
      if (a.thought) md.push(`### Thought\n\n${a.thought}\n`);
      for (const c of a.toolCalls) {
        md.push(
          `### ${c.name}\n\n\`\`\`json\n${JSON.stringify(c.input, null, 2)}\n\`\`\`\n`,
        );
      }
      for (const o of a.observations) {
        md.push(`### Observation\n\n\`\`\`\n${renderObservation(o)}\n\`\`\`\n`);
      }
      await appendFile(this.summaryPath, `${md.join("\n")}\n`);
    } catch (err) {
      log.warn({ err }, "step recorder failed");
    }
  }

  async saveTrajectory(
    messages: CoreMessage[],
    meta: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.ensure();
      await writeFile(
        join(this.debugDir, "trajectory.json"),
        JSON.stringify(
          { meta, messages: messages.map(sanitizeForDisk) },
          null,
          2,
        ),
      );
    } catch (err) {
      log.warn({ err }, "trajectory save failed");
    }
  }
}

export interface AgentConfig {
  /** Hard ceiling on total steps across the whole conversation. */
  stepLimit: number;
  /**
   * Ceiling on steps within a single user turn. Caps the `n` in the O(n²)
   * context-replay cost (every step re-sends the growing transcript). Keeps a
   * runaway turn from ballooning input tokens.
   */
  maxStepsPerTurn: number;
  /**
   * How many of the most recent tool results to keep verbatim when sending the
   * transcript to the model. Older tool results are masked with a short stub
   * (the tool *call* is preserved). 0 disables masking. This is the main lever
   * against input-token growth, since tool outputs are the bulkiest content.
   */
  keepToolResults: number;
  temperature: number;
  debugDir: string | null;
  /**
   * Feed a compact structured page-state snapshot (AX tree + geometry) each
   * turn. This is the default per-turn page context and replaces full-resolution
   * screenshots. On by default.
   */
  attachPageState: boolean;
  /**
   * Also attach a full-resolution screenshot each turn. Off by default — the
   * agent relies on page_state + on-demand visual grounding instead. Opt in with
   * LLM_ATTACH_SCREENSHOT=1 (e.g. for debugging or escalation).
   */
  attachScreenshot: boolean;
  /**
   * Sense → plan → act: run a separate vision model to describe the screenshot
   * before each planning step. On by default; disable with LLM_SENSE=0 to fall
   * back to a perception-free loop.
   */
  sense: boolean;
  /** Resize the sense screenshot so its longest side is at most this many px. */
  screenshotMaxDimension: number;
  /** JPEG quality (1-100) for the sense screenshot. Lower = fewer vision tokens. */
  screenshotJpegQuality: number;
  /**
   * After an interact/ground tool fires, wait this many ms before taking the next
   * screenshot. Lets SPAs paint before the perception model describes a loading state.
   */
  pageSettleDelayMs: number;
  /**
   * Max age of a cached page description in ms. After this time the description is
   * re-taken even when the URL and pageMaybeChanged flag haven't changed.
   */
  senseMaxCacheAgeMs: number;
  /**
   * How many loop-warning nudges to inject before hard-stopping a stuck turn.
   * 0 = skip nudges and throw immediately (old behaviour).
   */
  nudgeLimit: number;
  /**
   * Night mode safety ceilings so an unattended run always terminates: a hard
   * step budget, a wall-clock budget, and how many identical consecutive actions
   * the watchdog tolerates before stopping a stuck run.
   */
  nightStepBudget: number;
  nightTimeBudgetMs: number;
  nightRepeatLimit: number;
}

export const defaultAgentConfig = (): AgentConfig => ({
  stepLimit: Number(process.env.LLM_STEP_LIMIT) || 1_000_000,
  maxStepsPerTurn: Number(process.env.LLM_MAX_STEPS_PER_TURN) || 1_000,
  keepToolResults:
    process.env.LLM_KEEP_TOOL_RESULTS !== undefined
      ? Number(process.env.LLM_KEEP_TOOL_RESULTS)
      : 5,
  temperature: Number(process.env.LLM_TEMPERATURE) || 0.7,
  debugDir: process.env.LLM_DEBUG_DIR || null,
  attachPageState: process.env.LLM_ATTACH_PAGE_STATE !== "0",
  attachScreenshot: process.env.LLM_ATTACH_SCREENSHOT === "1",
  sense: process.env.LLM_SENSE !== "0",
  screenshotMaxDimension:
    Number(process.env.LLM_SCREENSHOT_MAX_DIMENSION) || 1280,
  screenshotJpegQuality: Number(process.env.LLM_SCREENSHOT_JPEG_QUALITY) || 70,
  pageSettleDelayMs: Number(process.env.LLM_PAGE_SETTLE_MS ?? 400),
  senseMaxCacheAgeMs: Number(process.env.LLM_SENSE_CACHE_AGE_MS ?? 30_000),
  nudgeLimit: Number(process.env.LLM_NUDGE_LIMIT ?? 2),
  nightStepBudget: Number(process.env.NIGHT_STEP_BUDGET) || 60,
  nightTimeBudgetMs: Number(process.env.NIGHT_TIME_BUDGET_MS) || 30 * 60 * 1000,
  nightRepeatLimit: Number(process.env.NIGHT_REPEAT_LIMIT) || 4,
});
