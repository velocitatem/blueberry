import { NativeImage, WebContents } from "electron";
import type { CoreMessage, LanguageModel } from "ai";
import * as dotenv from "dotenv";
import { join } from "path";
import type { Window } from "./Window";
import {
  createChatBackend,
  type BackendContext,
  type ChatBackend,
  type StreamChunk,
} from "./llm";
import { createLogger } from "./logger";

const log = createLogger("llm");

dotenv.config({ path: join(__dirname, "../../.env") });

interface ChatRequest {
  message: string;
  messageId: string;
}

const SCREENSHOT_MAX_WIDTH = 896;

export class LLMClient {
  private readonly webContents: WebContents;
  private readonly backend: ChatBackend;
  private window: Window | null = null;
  private messages: CoreMessage[] = [];

  constructor(webContents: WebContents) {
    this.webContents = webContents;
    this.backend = createChatBackend();
    log.info({ backend: this.backend.id, ready: this.backend.isReady() }, "LLM client initialized");
    void this.backend.logStartup?.();
  }

  setWindow(window: Window): void {
    this.window = window;
  }

  getMessages = (): CoreMessage[] => this.messages;

  get languageModel(): LanguageModel | null {
    return this.backend.languageModel;
  }

  clearMessages(): void {
    this.messages = [];
    this.sync();
  }

  async sendChatMessage(request: ChatRequest): Promise<void> {
    const ctx = this.createContext(request.messageId);
    try {
      const userMessage = await this.backend.prepareUserMessage(request.message, ctx);
      this.messages.push(userMessage);
      this.sync();
      await this.backend.runTurn(request.message, ctx);
    } catch (error) {
      log.error({ err: error }, "Error in LLM request");
      const message = await this.backend.formatError(error);
      this.emit(request.messageId, { content: message, isComplete: true });
    }
  }

  private createContext(messageId: string): BackendContext {
    const sync = () => this.sync();
    const getMessages = () => this.messages;
    return {
      window: this.window,
      conversation: {
        get messages() { return getMessages(); },
        push: (msg) => { this.messages.push(msg); sync(); },
        splice: (s, d, ...items) => { this.messages.splice(s, d, ...items); sync(); },
        setAt: (i, msg) => { this.messages[i] = msg; sync(); },
        sync,
      },
      emit: (chunk) => this.emit(messageId, chunk),
      captureScreenshot: () => this.captureScreenshot(),
    };
  }

  private async captureScreenshot(): Promise<string | null> {
    if (!this.window?.activeTab) return null;
    try {
      const image = await this.window.activeTab.screenshot();
      return this.compressScreenshot(image);
    } catch (error) {
      log.error({ err: error }, "Failed to capture screenshot");
      return null;
    }
  }

  /** Large PNGs in chat history cause Ollama VL models to collapse into gibberish. + TOken saving */
  private compressScreenshot(image: NativeImage): string {
    const { width } = image.getSize();
    const resized = width > SCREENSHOT_MAX_WIDTH
      ? image.resize({ width: SCREENSHOT_MAX_WIDTH })
      : image;
    return `data:image/jpeg;base64,${resized.toJPEG(72).toString("base64")}`;
  }

  private sync(): void {
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
