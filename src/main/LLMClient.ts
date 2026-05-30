import {
  streamText,
  stepCountIs,
  type LanguageModel,
  type CoreMessage,
  type StepResult,
  type StreamTextResult,
  type ToolSet,
} from "ai";
import { openai } from "@ai-sdk/openai";
import { anthropic } from "@ai-sdk/anthropic";
import type { WebContents } from "electron";
import * as dotenv from "dotenv";
import { join } from "path";
import { randomUUID } from "crypto";
import type { Window } from "./Window";
import {
  createTools,
  filterTools,
  INTERACT_TOOL_NAMES,
  GROUND_TOOL_NAMES,
} from "./llm";
import { buildSystemPrompt } from "./llm/prompt";
import { createGrounder, type Grounder } from "./grounding";
import { serializePageState } from "./PageState";
import { maskStaleToolResults } from "./llm/compaction";
import { createLogger } from "./logger";
import {
  LimitsExceeded,
  StepRecorder,
  UsageTracker,
  annotateTurnUsage,
  defaultAgentConfig,
  observationsFromStep,
  userFacingError,
  withRetries,
  withTurnTrace,
  type AgentConfig,
  type UsageSnapshot,
} from "./llm/harness";
import {
  type AgentMode,
  type AutonomyLevel,
  NightAgentHarness,
} from "./llm/nightHarness";
import type { GraphStore } from "./graph/GraphStore";
import type { PacketStore } from "./TaskGraphCompiler";

const log = createLogger("llm");

dotenv.config({ path: join(__dirname, "../../.env") });

interface ChatRequest {
  message: string;
  messageId: string;
}

interface StreamChunk {
  content: string;
  isComplete: boolean;
}

interface NightRunState {
  startedAt: number;
  deadlineMs: number;
  stepsAtStart: number;
  status: "running" | "done" | "stopped";
  reason: string | null;
  sigHistory: string[];
}

export interface NightStatus {
  active: boolean;
  status: "idle" | "running" | "done" | "stopped";
  reason: string | null;
  stepsUsed: number;
  stepBudget: number;
  autonomy: AutonomyLevel;
  packetId: string | null;
  startedAt: number | null;
  deadline: number | null;
}

const toolCallParts = (
  messages: CoreMessage[],
): Array<{ toolName?: string; input?: unknown; args?: unknown }> => {
  const parts: Array<{ toolName?: string; input?: unknown; args?: unknown }> =
    [];

  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content) {
      const candidate = part as {
        type?: string;
        toolName?: string;
        input?: unknown;
        args?: unknown;
      };
      if (candidate.type === "tool-call") parts.push(candidate);
    }
  }

  return parts;
};

/** Canonical signature for loop detection (strips noisy URL params, etc.). */
const normalizeToolSignature = (
  toolName: string | undefined,
  input: unknown,
): string | null => {
  if (!toolName) return null;
  const raw = (input ?? {}) as Record<string, unknown>;

  if (toolName === "navigateToUrl" && typeof raw.url === "string") {
    try {
      const u = new URL(raw.url);
      if (u.hostname.includes("google.") && u.pathname === "/search") {
        const q = u.searchParams.get("q") ?? "";
        return `navigateToUrl:google:${q.toLowerCase()}`;
      }
      return `navigateToUrl:${u.hostname}${u.pathname}`;
    } catch {
      return `navigateToUrl:${raw.url}`;
    }
  }

  if (toolName === "clickTarget" || toolName === "clickByDescription") {
    const desc =
      typeof raw.description === "string" ? raw.description.trim() : "";
    return desc ? `${toolName}:${desc}` : toolName;
  }

  if (toolName === "getPageText") return "getPageText";

  if (toolName === "searchPage" && typeof raw.query === "string") {
    return `searchPage:${raw.query.toLowerCase().trim()}`;
  }

  try {
    return `${toolName}:${JSON.stringify(input)}`;
  } catch {
    return toolName;
  }
};

/** The most recent tool call in a transcript, as a canonical signature. */
const lastToolSignature = (messages: CoreMessage[]): string | null => {
  const last = toolCallParts(messages).at(-1);
  if (!last) return null;
  return normalizeToolSignature(last.toolName, last.input ?? last.args);
};

type LLMProvider = "openai" | "anthropic";

const DEFAULT_MODELS: Record<LLMProvider, string> = {
  openai: "gpt-5-nano",
  anthropic: "claude-3-5-sonnet-20241022",
};

const resolveProvider = (): LLMProvider =>
  process.env.LLM_PROVIDER?.toLowerCase() === "anthropic"
    ? "anthropic"
    : "openai";

const apiKeyFor = (p: LLMProvider): string | undefined =>
  process.env[p === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY"];

export class LLMClient {
  private window: Window | null = null;
  private readonly provider: LLMProvider;
  private readonly modelName: string;
  private readonly model: LanguageModel | null;
  private readonly webContents: WebContents;
  private readonly grounder: Grounder | null;
  private readonly config: AgentConfig;
  private readonly usage = new UsageTracker();
  private messages: CoreMessage[] = [];
  private lastPageState: string | null = null;
  private stepCount = 0;
  private recorder: StepRecorder | null = null;
  private mode: AgentMode = "normal";
  private activePacketId: string | null = null;
  private nightHarness: NightAgentHarness | null = null;
  private nightAutonomy: AutonomyLevel = "prepare";
  private nightRun: NightRunState | null = null;

  constructor(webContents: WebContents) {
    this.webContents = webContents;
    this.provider = resolveProvider();
    this.modelName = process.env.LLM_MODEL || DEFAULT_MODELS[this.provider];
    this.model = this.initModel();
    this.grounder = createGrounder(webContents);
    this.config = defaultAgentConfig();
    this.recorder = this.config.debugDir
      ? new StepRecorder(join(this.config.debugDir, `run-${randomUUID()}`))
      : null;
    this.logInit();
  }

  setWindow(window: Window): void {
    this.window = window;
  }

  setNightStores(graphStore: GraphStore, packetStore: PacketStore): void {
    this.nightHarness = new NightAgentHarness(graphStore, packetStore);
  }

  setMode(mode: AgentMode, packetId?: string, autonomy?: AutonomyLevel): void {
    this.mode = mode;
    this.activePacketId = packetId ?? null;
    if (mode === "night") {
      this.nightAutonomy = autonomy ?? "prepare";
      this.nightRun = {
        startedAt: Date.now(),
        deadlineMs: Date.now() + this.config.nightTimeBudgetMs,
        stepsAtStart: this.stepCount,
        status: "running",
        reason: null,
        sigHistory: [],
      };
    } else if (this.nightRun?.status === "running") {
      this.nightRun.status = "stopped";
      this.nightRun.reason = "Stopped by user.";
    }
    log.info(
      { mode, packetId, autonomy: this.nightAutonomy },
      "agent mode set",
    );
  }

  getMode(): AgentMode {
    return this.mode;
  }

  getNightStatus(): NightStatus {
    const r = this.nightRun;
    const base = {
      stepBudget: this.config.nightStepBudget,
      autonomy: this.nightAutonomy,
      packetId: this.activePacketId,
    };
    if (!r) {
      return {
        active: false,
        status: "idle",
        reason: null,
        stepsUsed: 0,
        startedAt: null,
        deadline: null,
        ...base,
      };
    }
    return {
      active: r.status === "running",
      status: r.status,
      reason: r.reason,
      stepsUsed: this.stepCount - r.stepsAtStart,
      startedAt: r.startedAt,
      deadline: r.deadlineMs,
      ...base,
    };
  }

  get languageModel(): LanguageModel | null {
    return this.model;
  }

  getMessages = (): CoreMessage[] => this.messages;

  clearMessages(): void {
    this.messages = [];
    this.lastPageState = null;
    this.stepCount = 0;
    this.sendMessagesToRenderer();
  }

  getUsage(): { last: UsageSnapshot; cumulative: UsageSnapshot } {
    return { last: this.usage.last, cumulative: this.usage.cumulative };
  }

  async sendChatMessage(request: ChatRequest): Promise<void> {
    try {
      if (!this.model) {
        this.emit(request.messageId, {
          content: "LLM not configured. Add an API key to .env.",
          isComplete: true,
        });
        return;
      }
      await this.appendUserMessage(request.message);
      await this.runTurn(request.messageId);
    } catch (error) {
      if (error instanceof LimitsExceeded) {
        this.emit(request.messageId, {
          content: `\n\n(${error.message})`,
          isComplete: true,
        });
        return;
      }
      log.error({ err: error }, "chat turn failed");
      this.emit(request.messageId, {
        content: userFacingError(error),
        isComplete: true,
      });
    }
  }

  private initModel(): LanguageModel | null {
    if (!apiKeyFor(this.provider)) return null;
    return this.provider === "anthropic"
      ? anthropic(this.modelName)
      : openai(this.modelName);
  }

  private logInit(): void {
    if (this.model) {
      log.info(
        {
          provider: this.provider,
          model: this.modelName,
          debug: !!this.recorder,
        },
        "LLM client initialized",
      );
      return;
    }
    log.error({ provider: this.provider }, "LLM init failed: missing API key");
  }

  private async appendUserMessage(text: string): Promise<void> {
    const message: CoreMessage = {
      role: "user",
      content: [{ type: "text", text }],
    };
    this.messages.push(message);
    this.sendMessagesToRenderer();
  }

  private async capturePageState(): Promise<string | null> {
    const tab = this.window?.activeTab;
    if (!tab) return null;
    const snapshot = await tab.getPageState();
    return snapshot ? serializePageState(snapshot) : null;
  }

  private pageContext(): { url: string | null; title: string | null } {
    const tab = this.window?.activeTab ?? null;
    const { url = null, title = null } = tab ?? {};
    return { url, title };
  }

  private async runTurn(messageId: string): Promise<void> {
    if (!this.model) throw new Error("Model not initialized");
    if (this.stepCount >= this.config.stepLimit) throw new LimitsExceeded();

    const { url, title } = this.pageContext();

    let systemPrompt = buildSystemPrompt(url, title);
    let messages = this.messages;
    let tools = createTools({ window: this.window, grounder: this.grounder });

    if (this.mode === "night" && this.activePacketId && this.nightHarness) {
      const harnessCtx = this.nightHarness.buildContext({
        packetId: this.activePacketId,
        currentUrl: url ?? "",
        autonomy: this.nightAutonomy,
      });
      if (harnessCtx) {
        systemPrompt = `${systemPrompt}\n\n${harnessCtx.systemAddendum}`;
        messages = [...harnessCtx.contextBlocks, ...this.messages];
        tools = filterTools(tools, harnessCtx.toolPolicy);
      }
    }

    await withTurnTrace(
      { modelName: this.modelName, modelProvider: this.provider },
      async () => {
        const result = await withRetries(() =>
          Promise.resolve(
            streamText({
              model: this.model!,
              system: systemPrompt, // cached by the provider
              messages,
              tools,
              toolChoice: "auto",
              stopWhen: stepCountIs(
                this.mode === "night"
                  ? this.config.nightStepBudget
                  : this.config.stepLimit,
              ),
              temperature: this.supportsTemperature()
                ? this.config.temperature || undefined
                : undefined,
              maxRetries: 3,
              prepareStep: ({ messages }) =>
                this.prepareStep(messages as CoreMessage[]),
            }),
          ),
        );
        await this.processStream(result, messageId);
      },
    );

    if (this.mode === "night" && this.nightRun?.status === "running") {
      const used = this.stepCount - this.nightRun.stepsAtStart;
      this.nightRun.status = "done";
      this.nightRun.reason =
        used >= this.config.nightStepBudget
          ? "Step budget reached."
          : "Completed.";
    }
  }

  /** Stop a night run that has exceeded its time budget or is looping. */
  private enforceNightLimits(messages: CoreMessage[]): void {
    const run = this.nightRun;
    if (!run) return;

    if (Date.now() > run.deadlineMs) {
      run.status = "stopped";
      run.reason = "Night time budget reached.";
      throw new LimitsExceeded(run.reason);
    }

    const sig = lastToolSignature(messages);
    if (!sig) return;
    run.sigHistory.push(sig);
    const n = this.config.nightRepeatLimit;

    // 1) Same action repeated back-to-back (e.g. getPageText:{} x N).
    if (
      run.sigHistory.length >= n &&
      run.sigHistory.slice(-n).every((s) => s === sig)
    ) {
      run.status = "stopped";
      run.reason = "Repeated the same action; stopping to avoid a loop.";
      throw new LimitsExceeded(run.reason);
    }

    // 2) Non-consecutive thrash: the agent cycles among a few actions/URLs
    //    (navigate A → read → navigate B → read → navigate A …) without making
    //    progress. Catch it when a recent window collapses to few distinct
    //    signatures, or one signature recurs far too often overall.
    const window = run.sigHistory.slice(-n * 2);
    const distinct = new Set(window).size;
    const sameSigCount = run.sigHistory.filter((s) => s === sig).length;
    if ((window.length >= n * 2 && distinct <= n) || sameSigCount >= n * 2) {
      run.status = "stopped";
      run.reason =
        "Cycling through the same actions without progress; stopping to avoid a loop.";
      throw new LimitsExceeded(run.reason);
    }
  }

  private async prepareStep(
    messages: CoreMessage[],
  ): Promise<{ messages: CoreMessage[] } | undefined> {
    if (this.mode === "night") this.enforceNightLimits(messages);

    const calledNames = toolCallParts(messages)
      .map((part) => part.toolName)
      .filter((name): name is string => !!name);

    const changedPage = calledNames.some(
      (n) => INTERACT_TOOL_NAMES.has(n) || GROUND_TOOL_NAMES.has(n),
    );

    const requestedState = calledNames.includes("getPageState");
    const refresh = this.stepCount === 0 || changedPage || requestedState;

    if (this.config.attachPageState && refresh)
      this.lastPageState = await this.capturePageState();

    const base =
      this.config.keepToolResults >= 0
        ? maskStaleToolResults(messages, this.config.keepToolResults) // removing context to save space
        : messages;

    const trailing: CoreMessage[] =
      this.config.attachPageState && this.lastPageState
        ? [
            {
              role: "user",
              content: [{ type: "text", text: this.lastPageState }],
            },
          ]
        : [];

    if (base === messages && trailing.length === 0) return undefined;
    return { messages: [...base, ...trailing] };
  }

  private async processStream(
    result: StreamTextResult<ToolSet, never>,
    messageId: string,
  ): Promise<void> {
    const messageIndex = this.messages.length;
    this.messages.push({ role: "assistant", content: "" });

    let accumulated = "";
    for await (const chunk of result.textStream) {
      accumulated += chunk;
      this.messages[messageIndex] = { role: "assistant", content: accumulated };
      this.sendMessagesToRenderer();
      this.emit(messageId, { content: chunk, isComplete: false });
    }

    const steps = await result.steps;
    const responseMessages = (await result.response).messages as CoreMessage[];
    this.replacePlaceholderWithTurn(responseMessages, messageIndex);

    this.usage.record(await result.usage);
    annotateTurnUsage(this.usage.last);
    await this.recordSteps(steps);

    this.emit(messageId, { content: await result.text, isComplete: true }); // finishi it  ooff
  }

  private replacePlaceholderWithTurn(
    turn: CoreMessage[],
    placeholderIndex: number,
  ): void {
    if (turn.length === 0) return;
    this.messages.splice(placeholderIndex, 1, ...turn);
    this.sendMessagesToRenderer();
  }

  // TODO: maybe move outside of this class
  private async recordSteps(steps: Array<StepResult<ToolSet>>): Promise<void> {
    if (!this.recorder) {
      this.stepCount += steps.length;
      return;
    }
    const page = this.pageContext();
    for (const step of steps) {
      this.stepCount += 1;
      const toolCalls = (step.toolCalls ?? []).map((c) => {
        const tc = c as { toolName: string; input?: unknown; args?: unknown };
        return { name: tc.toolName, input: tc.input ?? tc.args };
      });
      await this.recorder.record({
        step: this.stepCount,
        thought: step.text ?? "",
        toolCalls,
        observations: observationsFromStep(step, page),
        usage: this.usage.last,
      });
    }
    await this.recorder.saveTrajectory(this.messages, {
      provider: this.provider,
      model: this.modelName,
      steps: this.stepCount,
      usage: this.usage.cumulative,
    });
  }

  private sendMessagesToRenderer = (): void =>
    this.webContents.send("chat-messages-updated", this.messages);

  private emit = (messageId: string, chunk: StreamChunk): void =>
    this.webContents.send("chat-response", {
      messageId,
      content: chunk.content,
      isComplete: chunk.isComplete,
    });

  private supportsTemperature(): boolean {
    return !this.modelName.toLowerCase().startsWith("gpt-5");
  }
}
