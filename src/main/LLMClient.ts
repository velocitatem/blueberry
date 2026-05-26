import { WebContents } from "electron";
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
import * as dotenv from "dotenv";
import { join } from "path";
import { randomUUID } from "crypto";
import type { Window } from "./Window";
import { createTools } from "./llm";
import { createLogger } from "./logger";
import {
  LimitsExceeded,
  StepRecorder,
  UsageTracker,
  defaultAgentConfig,
  observationsFromStep,
  userFacingError,
  withRetries,
  type AgentConfig,
} from "./llm/harness";

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

type LLMProvider = "openai" | "anthropic";

const DEFAULT_MODELS: Record<LLMProvider, string> = {
  openai: "gpt-5-nano",
  anthropic: "claude-3-5-sonnet-20241022",
};

const resolveProvider = (): LLMProvider =>
  process.env.LLM_PROVIDER?.toLowerCase() === "anthropic" ? "anthropic" : "openai";

const apiKeyFor = (p: LLMProvider): string | undefined =>
  process.env[p === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY"];

const buildSystemPrompt = (url: string | null, title: string | null): string => {
  const sections: string[] = [];

  sections.push(
    [
      "<role>",
      "You are an AI assistant embedded in a desktop web browser. You operate in an iterative tool-use loop to help the user accomplish tasks on the active tab.",
      "You excel at:",
      "1. Navigating websites and extracting precise information from the page the user is looking at.",
      "2. Reading page content (text and HTML) to answer questions grounded in what is actually on screen.",
      "3. Driving the active tab via tools when fresh data or a navigation is required.",
      "4. Operating efficiently across multiple reasoning + tool steps without losing track of the goal.",
      "</role>",
    ].join("\n"),
  );

  sections.push(
    [
      "<input>",
      "At each turn your input may include:",
      "1. The user's request — your ultimate objective. It always has the highest priority.",
      "2. A screenshot of the current page attached to the user's message. Treat it as ground truth for what the user can see.",
      "3. Page context (current URL and title) provided below.",
      "4. Results of any tools you previously called this turn.",
      "</input>",
    ].join("\n"),
  );

  const ctx: string[] = ["<page_context>"];
  ctx.push(url ? `Current URL: ${url}` : "Current URL: (no active tab)");
  if (title) ctx.push(`Current page title: ${title}`);
  ctx.push("</page_context>");
  sections.push(ctx.join("\n"));

  sections.push(
    [
      "<tools>",
      "You have tools to inspect and control the active tab:",
      "- getCurrentUrl: read the URL of the active tab.",
      "- getPageText: read the visible text of the active page. Use this when the screenshot is insufficient or when you need to quote/search exact text.",
      "- getPageHtml: read the HTML source. Use when you need structure or attributes not visible in plain text.",
      "- navigateToUrl: load a URL in the active tab. This changes the page — call it last in a sequence.",
      "Rules:",
      "- Prefer the screenshot and page_context for simple visual questions. Call a tool only when you actually need more or fresher data than you already have.",
      "- Tool outputs may be truncated; ask for a larger maxLength only when needed.",
      "- Do not call the same tool with the same arguments repeatedly — it wastes turns and produces the same result.",
      "- If a tool returns an error (e.g. 'No active tab'), report the limitation instead of retrying blindly.",
      "</tools>",
    ].join("\n"),
  );

  sections.push(
    [
      "<reasoning>",
      "- Before acting, briefly judge what you already know from the screenshot, page_context, and prior tool results. Only call a tool if it adds information you don't have.",
      "- After each tool call, verify it achieved its goal before chaining more actions. Never assume an action succeeded just because you issued it.",
      "- If you appear stuck (same action failing 2–3 times, or no progress after several steps), change strategy: try a different tool, a different query, or tell the user what is blocking you.",
      "- Ground every claim in tool output, the screenshot, or the user's message. Do NOT invent URLs, prices, names, or values from prior knowledge — if it isn't in the page or tool results, say so.",
      "</reasoning>",
    ].join("\n"),
  );

  sections.push(
    [
      "<completion>",
      "Before declaring a task done, re-read the user's request and check that every concrete requirement is met (correct count, correct format, all filters/criteria applied). If any part is unmet or uncertain, say so explicitly instead of overclaiming success. Partial results with honest caveats are more valuable than confident-but-wrong answers.",
      "</completion>",
    ].join("\n"),
  );

  sections.push(
    [
      "<style>",
      "- Respond in the same language as the user's request (default English).",
      "- Be concise. Don't narrate every tool call; just give the user the answer plus the evidence that supports it.",
      "- When citing page content, quote it briefly rather than paraphrasing inexactly.",
      "</style>",
    ].join("\n"),
  );

  return sections.join("\n\n");
};

export class LLMClient {
  private readonly webContents: WebContents;
  private window: Window | null = null;
  private readonly provider: LLMProvider;
  private readonly modelName: string;
  private readonly model: LanguageModel | null;
  private readonly config: AgentConfig;
  private readonly usage = new UsageTracker();
  private messages: CoreMessage[] = [];
  private stepCount = 0;
  private recorder: StepRecorder | null = null;

  constructor(webContents: WebContents) {
    this.webContents = webContents;
    this.provider = resolveProvider();
    this.modelName = process.env.LLM_MODEL || DEFAULT_MODELS[this.provider];
    this.model = this.initModel();
    this.config = defaultAgentConfig();
    this.recorder = this.config.debugDir
      ? new StepRecorder(join(this.config.debugDir, `run-${randomUUID()}`))
      : null;
    this.logInit();
  }

  setWindow(window: Window): void {
    this.window = window;
  }

  get languageModel(): LanguageModel | null {
    return this.model;
  }

  getMessages = (): CoreMessage[] => this.messages;

  clearMessages(): void {
    this.messages = [];
    this.stepCount = 0;
    this.sendMessagesToRenderer();
  }

  getUsage() {
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
        { provider: this.provider, model: this.modelName, debug: !!this.recorder },
        "LLM client initialized",
      );
      return;
    }
    const key = this.provider === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY";
    log.error({ provider: this.provider, key }, "LLM init failed: missing API key");
  }

  private async appendUserMessage(text: string): Promise<void> {
    const screenshot = this.config.attachScreenshot
      ? await this.captureScreenshot()
      : null;
    const message: CoreMessage = screenshot
      ? {
          role: "user",
          content: [
            { type: "image", image: screenshot },
            { type: "text", text },
          ],
        }
      : { role: "user", content: text };
    this.messages.push(message);
    this.sendMessagesToRenderer();
  }

  private async captureScreenshot(): Promise<string | null> {
    const tab = this.window?.activeTab;
    if (!tab) return null;
    try {
      return (await tab.screenshot()).toDataURL();
    } catch (err) {
      log.error({ err }, "screenshot failed");
      return null;
    }
  }

  private pageContext(): { url: string | null; title: string | null } {
    const tab = this.window?.activeTab ?? null;
    return { url: tab?.url ?? null, title: tab?.title ?? null };
  }

  private async runTurn(messageId: string): Promise<void> {
    if (!this.model) throw new Error("Model not initialized");
    const remaining = this.config.stepLimit - this.stepCount;
    if (remaining <= 0) throw new LimitsExceeded();

    const { url, title } = this.pageContext();
    const result = await withRetries(() =>
      Promise.resolve(
        streamText({
          model: this.model!,
          system: buildSystemPrompt(url, title),
          messages: this.messages,
          tools: createTools({ window: this.window }),
          stopWhen: stepCountIs(remaining),
          temperature: this.config.temperature,
          maxRetries: 3,
        }),
      ),
    );

    await this.processStream(result, messageId);
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
    this.applyStepMessagesToHistory(steps, messageIndex);
    this.usage.record(await result.usage);
    await this.recordSteps(steps);

    this.emit(messageId, { content: await result.text, isComplete: true });
  }

  private applyStepMessagesToHistory(
    steps: Array<StepResult<ToolSet>>,
    placeholderIndex: number,
  ): void {
    const turn: CoreMessage[] = [];
    for (const step of steps) {
      for (const m of step.response.messages) turn.push(m as CoreMessage);
    }
    if (turn.length === 0) return;
    this.messages.splice(placeholderIndex, 1, ...turn);
    this.sendMessagesToRenderer();
  }

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

  private sendMessagesToRenderer(): void {
    this.webContents.send("chat-messages-updated", this.messages);
  }

  private emit(messageId: string, chunk: StreamChunk): void {
    this.webContents.send("chat-response", {
      messageId,
      content: chunk.content,
      isComplete: chunk.isComplete,
    });
  }
}
