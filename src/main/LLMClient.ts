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
  ReadCache,
  TodoStore,
  INTERACT_TOOL_NAMES,
  GROUND_TOOL_NAMES,
} from "./llm";
import { buildSystemPrompt } from "./llm/prompt";
import { describePage } from "./llm/sense";
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
  sleep,
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

/** Build an in-context nudge that tells the agent it is stuck and how to escape. */
const buildNudgeMessage = (sig: string, isCycling: boolean): string => {
  const toolName = sig.split(":")[0] ?? sig;

  const hints: string[] = [];
  if (toolName === "getPageText" || toolName === "searchPage") {
    hints.push("You already have the page content — use the data you received instead of fetching again.");
    hints.push("If a search returned no results, the term is not on this page. Try a different term, scroll to a new section, or navigate elsewhere.");
  } else if (toolName === "navigateToUrl") {
    hints.push("You are navigating in circles. Check the page you are already on for links, or try a search engine instead.");
  } else if (toolName === "clickTarget" || toolName === "clickByDescription") {
    hints.push("The click may not be having the expected effect. Read the page description carefully and try a different target or tool.");
  } else if (toolName === "todoWrite") {
    hints.push("You just wrote the same task list — writing it again changes nothing.");
    hints.push("Stop updating the list and start acting: use a browser or page tool to perform the next pending task.");
    hints.push("If you cannot find the right tool, say so and stop.");
  } else {
    hints.push("Try a completely different tool or approach.");
  }
  hints.push("If you are genuinely blocked after trying alternatives, say so and stop — do not repeat the failing action.");

  const what = isCycling
    ? "cycling through the same small set of actions without making progress"
    : `calling \`${toolName}\` repeatedly with the same arguments`;

  return [
    `<loop_warning>`,
    `You have been ${what}.`,
    ``,
    `**Stop. Do not issue the same call again.**`,
    ``,
    ...hints.map((h) => `• ${h}`),
    ``,
    `Decide on a genuinely different next action.`,
    `</loop_warning>`,
  ].join("\n");
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

/** Cheap, vision-capable defaults for the separate "sense" (perception) model. */
const SENSE_DEFAULT_MODELS: Record<LLMProvider, string> = {
  openai: "gpt-4o-mini",
  anthropic: "claude-3-5-haiku-20241022",
};

const resolveProvider = (): LLMProvider =>
  process.env.LLM_PROVIDER?.toLowerCase() === "anthropic"
    ? "anthropic"
    : "openai";

const resolveSenseProvider = (fallback: LLMProvider): LLMProvider => {
  const raw = process.env.LLM_SENSE_PROVIDER?.toLowerCase();
  if (raw === "anthropic") return "anthropic";
  if (raw === "openai") return "openai";
  return fallback;
};

const apiKeyFor = (p: LLMProvider): string | undefined =>
  process.env[p === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY"];

const buildModel = (provider: LLMProvider, name: string): LanguageModel =>
  provider === "anthropic" ? anthropic(name) : openai(name);

export class LLMClient {
  private window: Window | null = null;
  private readonly provider: LLMProvider;
  private readonly modelName: string;
  private readonly model: LanguageModel | null;
  private readonly senseProvider: LLMProvider;
  private readonly senseModelName: string;
  private readonly senseModel: LanguageModel | null;
  private readonly webContents: WebContents;
  private readonly grounder: Grounder | null;
  private readonly config: AgentConfig;
  private readonly usage = new UsageTracker();
  private messages: CoreMessage[] = [];
  private lastPageState: string | null = null;
  private stepCount = 0;
  private readonly descriptionCache = new Map<string, { text: string; ts: number }>();
  private pageMaybeChanged = true;
  private lastDescription: string | null = null;
  private readonly todos = new TodoStore();
  private readonly readCache = new ReadCache();
  private readonly senseUsage = new UsageTracker();
  private sigHistory: string[] = [];
  private nudgeCount = 0;
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
    this.senseProvider = resolveSenseProvider(this.provider);
    this.senseModelName =
      process.env.LLM_SENSE_MODEL || SENSE_DEFAULT_MODELS[this.senseProvider];
    this.senseModel = this.initSenseModel();
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
      this.nightRun = { // global state for the night run (nonpersistent) TODO maybe moove to module or storage
        // if we store we can a later use data to posttrain or smth
        startedAt: Date.now(),
        deadlineMs: Date.now() + this.config.nightTimeBudgetMs,
        stepsAtStart: this.stepCount,
        status: "running",
        reason: null,
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

  getMode(): AgentMode { return this.mode; }

  getNightStatus(): NightStatus {
    const r = this.nightRun;
    const base = {
      stepBudget: this.config.nightStepBudget,
      autonomy: this.nightAutonomy,
      packetId: this.activePacketId,
    };
    return r ? {
      active: r.status === "running",
      status: r.status,
        reason: r.reason,
        stepsUsed: this.stepCount - r.stepsAtStart,
        startedAt: r.startedAt,
        deadline: r.deadlineMs,
        ...base,
      }
      : {
        active: false,
        status: "idle",
        reason: null,
        stepsUsed: 0,
        startedAt: null,
        deadline: null,
        ...base,
      };
  };

  get languageModel(): LanguageModel | null { return this.model; }

  getMessages = (): CoreMessage[] => this.messages;

  clearMessages(): void {
    this.messages = [];
    this.lastPageState = null;
    this.stepCount = 0;
    this.descriptionCache.clear();
    this.pageMaybeChanged = true;
    this.todos.clear();
    this.readCache.clear();
    this.sigHistory = [];
    this.nudgeCount = 0;
    this.sendMessagesToRenderer();
  }

  getUsage(): {
    last: UsageSnapshot;
    cumulative: UsageSnapshot;
    sense: { last: UsageSnapshot; cumulative: UsageSnapshot };
  } {
    return {
      last: this.usage.last,
      cumulative: this.usage.cumulative,
      sense: { last: this.senseUsage.last, cumulative: this.senseUsage.cumulative },
    };
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
    return buildModel(this.provider, this.modelName);
  }

  /** Perception model for the sense stage. Falls back to the planner model when
   *  the sense provider has no key of its own. */
  private initSenseModel(): LanguageModel | null {
    if (apiKeyFor(this.senseProvider))
      return buildModel(this.senseProvider, this.senseModelName);
    return this.model;
  }

  private logInit(): void {
    if (this.model) {
      log.info(
        {
          provider: this.provider,
          model: this.modelName,
          senseProvider: this.senseProvider,
          senseModel: this.senseModelName,
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
    const goal = this.latestUserGoal();

    let systemPrompt = buildSystemPrompt(url, title);
    let messages = this.messages;
    let tools = createTools({ window: this.window, grounder: this.grounder, todos: this.todos, readCache: this.readCache });

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

    this.nudgeCount = 0;

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
                  : this.config.maxStepsPerTurn,
              ),
              temperature: this.supportsTemperature()
                ? this.config.temperature || undefined
                : undefined,
              maxRetries: 3,
              prepareStep: ({ messages }) =>
                this.prepareStep(messages as CoreMessage[], goal),
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

  private latestUserGoal(): string | null {
    for (let i = this.messages.length - 1; i >= 0; i -= 1) {
      const m = this.messages[i];
      if (m.role !== "user") continue;
      if (typeof m.content === "string") return m.content;
      const text = m.content
        .filter((p): p is { type: "text"; text: string } => p.type === "text")
        .map((p) => p.text)
        .join("\n")
        .trim();
      if (text) return text;
    }
    return null;
  }

  private enforceNightLimits(messages: CoreMessage[]): void {
    const run = this.nightRun;
    if (!run) return;

    if (Date.now() > run.deadlineMs) {
      run.status = "stopped";
      run.reason = "Night time budget reached.";
      throw new LimitsExceeded(run.reason);
    }

    // we do a check for action rep
    const sig = lastToolSignature(messages); 
    if (!sig) return;
    const runHistory = this.sigHistory.slice(run.stepsAtStart);
    const n = this.config.nightRepeatLimit;
    const sameSigCount = runHistory.filter((s) => s === sig).length;
    if (sameSigCount >= n * 2) {
      run.status = "stopped";
      run.reason =
        "Cycling through the same actions without progress; stopping to avoid a loop.";
      throw new LimitsExceeded(run.reason);
    }
  }

  private async sensePage(
    goal: string | null,
    url: string | null,
    title: string | null,
    recentActions?: string[],
  ): Promise<string | null> {
    if (!this.config.sense || !this.senseModel) return null;
    const key = url ?? "";
    const cached = this.descriptionCache.get(key);
    const cacheAge = cached ? Date.now() - cached.ts : Infinity;
    const cacheValid =
      cached && !this.pageMaybeChanged && cacheAge < this.config.senseMaxCacheAgeMs;
    if (cacheValid) { return cached?.text ?? null; }
    const screenshotDataUrl = await this.captureScreenshotDataUrl();
    if (!screenshotDataUrl) { return cached?.text ?? null; }

    const result = await describePage({ // not too ideal but for now minimize context in main loop
      model: this.senseModel,
      modelName: this.senseModelName,
      provider: this.senseProvider,
      screenshotDataUrl,
      goal,
      url,
      title,
      recentActions,
    });
    this.senseUsage.record(result.usage);
    this.descriptionCache.set(key, { text: result.text, ts: Date.now() });
    this.pageMaybeChanged = false;
    this.lastDescription = result.text;
    return result.text;
  }

  private async captureScreenshotDataUrl(): Promise<string | null> {
    const tab = this.window?.activeTab;
    if (!tab) return null;
    try {
      const image = await tab.screenshot();
      const { width, height } = image.getSize();
      const max = this.config.screenshotMaxDimension;
      const resized =
        Math.max(width, height) > max
          ? image.resize(width >= height ? { width: max } : { height: max })
          : image;
      const jpeg = resized.toJPEG(this.config.screenshotJpegQuality);
      return `data:image/jpeg;base64,${jpeg.toString("base64")}`;
    } catch (error) {
      log.warn({ err: error }, "screenshot capture failed");
      return null;
    }
  }

  private checkThrash(messages: CoreMessage[]): string | null { // HOOK before step to nudge in harness
    const sig = lastToolSignature(messages);
    if (!sig) return null;
    this.sigHistory.push(sig);
    const n = this.config.nightRepeatLimit;

    // Read-only tools already return a cached-result note after the first repeat.
    // A second repeat means the model is ignoring the note — nudge immediately.
    const isReadOnlySig =
      sig === "getPageText" || sig.startsWith("searchPage:");
    const consecutiveThreshold = isReadOnlySig ? 2 : n;

    const consecutive =
      this.sigHistory.length >= consecutiveThreshold &&
      this.sigHistory.slice(-consecutiveThreshold).every((s) => s === sig);
    const win = this.sigHistory.slice(-n * 2);
    const cycling = win.length >= n * 2 && new Set(win).size <= 2;

    if (!consecutive && !cycling) return null;

    this.nudgeCount += 1;
    if (this.nudgeCount > this.config.nudgeLimit) {
      throw new LimitsExceeded(
        consecutive
          ? "Repeated the same action; stopping to avoid a loop."
          : "Cycling through the same actions without making progress.",
      );
    }

    this.sigHistory.splice(-consecutiveThreshold);
    return buildNudgeMessage(sig, cycling && !consecutive);
  }

  private async prepareStep(
    messages: CoreMessage[],
    goal: string | null,
  ): Promise<{ messages: CoreMessage[] } | undefined> {
    const nudge = this.checkThrash(messages);
    if (this.mode === "night") this.enforceNightLimits(messages);

    // If the most recent action changed the page, settle before screenshotting.
    const lastTool = toolCallParts(messages).at(-1)?.toolName;
    if (
      lastTool &&
      (INTERACT_TOOL_NAMES.has(lastTool) || GROUND_TOOL_NAMES.has(lastTool))
    ) {
      this.pageMaybeChanged = true;
      this.readCache.clear();
      if (this.config.pageSettleDelayMs > 0)
        await sleep(this.config.pageSettleDelayMs);
    }

    // Build a compact summary of the last 2 actions to feed the perception model.
    const recentActions = toolCallParts(messages)
      .slice(-2)
      .map((tc) => {
        const name = tc.toolName ?? "unknown";
        const input = tc.input ?? tc.args;
        if (!input || Object.keys(input as object).length === 0) return name;
        try {
          const s = JSON.stringify(input);
          return `${name}(${s.length > 80 ? `${s.slice(0, 80)}…` : s})`;
        } catch {
          return name;
        }
      });

    const { url, title } = this.pageContext();
    const description = await this.sensePage(goal, url, title, recentActions);

    if (this.config.attachPageState)
      this.lastPageState = await this.capturePageState();

    const base =
      this.config.keepToolResults >= 0
        ? maskStaleToolResults(messages, this.config.keepToolResults)
        : messages;

    const trailing: CoreMessage[] = [];
    if (this.config.attachPageState && this.lastPageState)
      trailing.push({
        role: "user",
        content: [{ type: "text", text: this.lastPageState }],
      });
    if (description)
      trailing.push({
        role: "user",
        content: [
          {
            type: "text",
            text: `<page_description>\nURL: ${url ?? "(unknown)"}\n${description}\n</page_description>`,
          },
        ],
      });
    if (nudge)
      trailing.push({
        role: "user",
        content: [{ type: "text", text: nudge }],
      });

    const todoSummary = this.todos.summary();
    if (todoSummary)
      trailing.push({
        role: "user",
        content: [{ type: "text", text: `<todo_list>\n${todoSummary}\n</todo_list>` }],
      });

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

    this.emit(messageId, { content: await result.text, isComplete: true });
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
        description: this.lastDescription ?? undefined,
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
