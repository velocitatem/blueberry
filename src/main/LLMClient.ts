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
import { createGrounder, type Grounder } from "./grounding";
import { serializePageState } from "./PageState";
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
} from "./llm/harness";
import { type AgentMode, NightAgentHarness } from "./llm/nightHarness";
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

const supportsTemperature = (modelName: string): boolean =>
  !/^(o\d|gpt-5)/i.test(modelName);

const buildSystemPrompt = (
  url: string | null,
  title: string | null,
): string => {
  const pageContext = `
<page_context>
Current URL: ${url || "(no active tab)"}
${title ? `Current page title: ${title}\n` : ""}</page_context>`.trim();

  const prompt = `
<role>
You are an AI assistant embedded in a desktop web browser. You operate in an iterative tool-use loop to help the user accomplish tasks on the active tab.
You excel at:
1. Navigating websites and extracting precise information from the page the user is looking at.
2. Reading the visible page text to answer questions grounded in what is actually on screen.
3. Driving the active tab via tools when fresh data or a navigation is required.
4. Operating efficiently across multiple reasoning + tool steps without losing track of the goal.
</role>

<input>
At each turn your input may include:
1. The user's request — your ultimate objective. It always has the highest priority.
2. A <page_state> block describing the active page: its URL/title/scroll position plus a compact list of the *interactive* elements currently visible in the viewport. Each element has an id, ARIA role, accessible name/text, a viewport pixel bbox [x,y,w,h], enabled/checked state, and a \`ref\` CSS selector you can act on directly. Treat page_state as the primary source of truth for what is on screen and what you can interact with. It refreshes automatically on the first step and after every page-changing action.
3. Page context (current URL and title) provided below.
4. Results of any tools you previously called this turn.

Note: full-resolution screenshots are NOT attached every turn. Rely on page_state and the read tools. The visual grounding tools (clickByDescription / locateElement) run a local vision model on a screenshot only when you call them — use them for targets that are visual/icon-only, ambiguous, or absent from page_state.
</input>

${pageContext}

<autonomy>
- If the user gives a concrete browsing/data-gathering task, proceed with the tools. Do not ask for confirmation of obvious interpretations, intermediate navigation, opening detail pages, scrolling, applying requested filters, or continuing after the user has said to proceed.
- If the user says "keep going", "continue", "proceed", or asks for a specific final artifact (for example "until you have a table"), keep working until that artifact is complete.
- Ask a clarifying question only when a required choice is genuinely ambiguous and cannot be resolved from the page or common sense. For hotel/date/filter tasks, treat the requested site, dates, guest count, filters, and output columns as sufficient instructions.
- If a required value is not visible, do not ask the user to authorize the next obvious retrieval step. Scroll, open the relevant detail page, use getPageText/searchPage, or use grounding as needed. Report a blocker only after at least two distinct retrieval strategies fail or the site prevents access.
- Final answers should contain the requested result, not a proposed plan. Briefly mention caveats only for fields you could not verify after trying reasonable alternatives.
</autonomy>

<tools>
You have two families of tools. Default to interacting with the page the user is already on; only navigate when you genuinely need a different URL.

Observe (read-only, cheap):
- getCurrentUrl: read the URL of the active tab.
- getPageState: refresh the structured page_state (visible interactive elements with ids, roles, names, bboxes, and \`ref\` selectors). Use it to re-check actionable elements after the page changes or when you need an up-to-date inventory.
- getPageText: read the visible text of the active page. Use to read or quote exact content that isn't captured in page_state element names.
- searchPage: find a substring in the page text with surrounding context. Prefer this over getPageText when looking for something specific.
- locateElement(description): run the local vision grounder to get an element's pixel coordinates from a plain-language description (without clicking). Use only when the target isn't in page_state.

Interact (changes page state — re-read page_state after each call):
- clickElement(selector): click by CSS selector. PREFER this for elements listed in page_state — pass the element's \`ref\` (e.g. clickElement('[data-bb="12"]')). Also accepts any normal CSS selector.
- clickByDescription(description): click an element by plain-language description; a local vision model locates it on a screenshot and clicks the pixel. Use when the target is visual/icon-only, ambiguous, or not present in page_state.
- inputText(selector, text, submit?): type into an input/textarea/contenteditable (use the element's \`ref\` from page_state). Set submit=true for search-style fields.
- pressKey(key): send Enter/Tab/Escape/Arrow keys to the focused element.
- scrollPage({direction|selector, amount?}): scroll the window or bring an element into view. Scroll to reveal elements that are below/above the current viewport (page_state only lists what is currently visible).
- goBack: pop one entry from the tab's history.
- navigateToUrl(url): load a different URL. This is a heavy action — see preference rules below.

Rules:
- Prefer page_state and page_context for deciding what to do. Call a read tool only when you need more or fresher data than page_state already gives you.
- To act on something, first try to match it against page_state by role/name/text, then act via clickElement/inputText using its \`ref\`. Only fall back to clickByDescription (visual grounding) when the target is icon-only, visually defined, or not in page_state.
- If the element you need isn't in page_state, it may be off-screen (scrollPage to reveal it), hidden in a menu (open it), disabled, or named differently — investigate rather than assuming the action is impossible.
- Strongly prefer interacting with the current page (click links, fill forms, scroll, press keys) over re-navigating.
- Use navigateToUrl only when (a) the user explicitly gave a URL, (b) no on-page link or control reaches the destination, or (c) you need a known direct URL (e.g. a search engine) to start a task. Do NOT re-navigate to the current URL or guess URL patterns when a visible link or button would do the same thing.
- After every interact call, re-read the refreshed page_state (or call getPageState) before chaining more actions. The page may have changed in ways you didn't predict, and prior ids/refs may be stale.
- Tool outputs may be truncated; ask for a larger maxLength only when needed.
- Do not call the same tool with the same arguments repeatedly — it wastes turns. If something fails twice, change approach or report the blocker.
- If a tool returns an error (e.g. 'No active tab', 'no_match'), report the limitation instead of retrying blindly.
- Place page-changing actions (navigateToUrl, clickElement on a link, goBack) last in any planned sequence — anything you queue after them may run on a different page than you expected.
</tools>

<reasoning>
- Before acting, briefly judge what you already know from page_state, page_context, and prior tool results. Only call a tool if it adds information you don't have.
- After each tool call, verify it achieved its goal (via the refreshed page_state or a quick observe call) before chaining more actions. Never assume an action succeeded just because you issued it.
- If you appear stuck (same action failing 2–3 times, or no progress after several steps), change strategy: try a different tool, a different query, or tell the user what is blocking you.
- Ground every claim in tool output, page_state, or the user's message. Do NOT invent URLs, prices, names, or values from prior knowledge — if it isn't in the page or tool results, say so.
</reasoning>

<completion>
Before declaring a task done, re-read the user's request and check that every concrete requirement is met (correct count, correct format, all filters/criteria applied). For multi-step extraction tasks, continue using tools until the requested artifact is filled in. If any part remains unmet after reasonable retrieval attempts, say exactly what could not be verified and why instead of asking whether to keep going.
</completion>

<style>
- Respond in the same language as the user's request (default English).
- Be concise. Don't narrate every tool call; just give the user the answer plus the evidence that supports it.
- When citing page content, quote it briefly rather than paraphrasing inexactly.
</style>
`.trim();

  return prompt;
};

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

  setMode(mode: AgentMode, packetId?: string): void {
    this.mode = mode;
    this.activePacketId = packetId ?? null;
    log.info({ mode, packetId }, "agent mode set");
  }

  getMode(): AgentMode {
    return this.mode;
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
        {
          provider: this.provider,
          model: this.modelName,
          debug: !!this.recorder,
        },
        "LLM client initialized",
      );
      return;
    }
    const key =
      this.provider === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY";
    log.error(
      { provider: this.provider, key },
      "LLM init failed: missing API key",
    );
  }

  private async appendUserMessage(text: string): Promise<void> {
    // Page context is injected as a structured page_state block via the system
    // prompt in runTurn (see prepareStep), so the persisted/displayed user
    // message stays clean. A full-resolution screenshot is only attached when
    // explicitly opted in (LLM_ATTACH_SCREENSHOT=1).
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

  /** Build a compact structured page-state block for the active tab. */
  private async capturePageState(): Promise<string | null> {
    const tab = this.window?.activeTab;
    if (!tab) return null;
    try {
      const snapshot = await tab.getPageState();
      return snapshot ? serializePageState(snapshot) : null;
    } catch (err) {
      log.error({ err }, "page state capture failed");
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

    let systemPrompt = buildSystemPrompt(url, title);
    let messages = this.messages;
    let tools = createTools({ window: this.window, grounder: this.grounder });

    if (this.mode === "night" && this.activePacketId && this.nightHarness) {
      const harnessCtx = this.nightHarness.buildContext({
        packetId: this.activePacketId,
        currentUrl: url ?? "",
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
              system: systemPrompt,
              messages,
              tools,
              toolChoice: this.mode === "night" ? "required" : "auto",
              stopWhen: stepCountIs(remaining),
              ...(supportsTemperature(this.modelName)
                ? { temperature: this.config.temperature }
                : {}),
              maxRetries: 3,
              prepareStep:
                this.config.attachPageState || this.config.attachScreenshot
                  ? async ({ steps, stepNumber, messages: stepMessages }) => {
                      const last = steps[steps.length - 1];
                      const usedInteract = last
                        ? (last.toolCalls ?? []).some((c) => {
                            const name = (c as { toolName: string }).toolName;
                            return (
                              INTERACT_TOOL_NAMES.has(name) ||
                              GROUND_TOOL_NAMES.has(name)
                            );
                          })
                        : false;
                      // Refresh page context on the first step and after any
                      // page-changing action; otherwise the page is unchanged.
                      const refresh = stepNumber === 0 || usedInteract;
                      if (usedInteract) await new Promise((r) => setTimeout(r, 250));

                      const patch: {
                        system?: string;
                        messages?: CoreMessage[];
                      } = {};

                      if (this.config.attachPageState) {
                        if (refresh) {
                          const state = await this.capturePageState();
                          if (state) this.lastPageState = state;
                        }
                        // Inject via system so it stays current and never clutters
                        // the visible/persisted message history.
                        if (this.lastPageState) {
                          patch.system = `${systemPrompt}\n\n${this.lastPageState}`;
                        }
                      }

                      if (this.config.attachScreenshot && refresh) {
                        const shot = await this.captureScreenshot();
                        if (shot) {
                          patch.messages = [
                            ...stepMessages,
                            {
                              role: "user",
                              content: [
                                { type: "image", image: shot },
                                {
                                  type: "text",
                                  text: "Fresh screenshot of the current page. Verify the result before continuing.",
                                },
                              ],
                            },
                          ];
                        }
                      }

                      return Object.keys(patch).length > 0 ? patch : undefined;
                    }
                  : undefined,
            }),
          ),
        );
        await this.processStream(result, messageId);
      },
    );
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
