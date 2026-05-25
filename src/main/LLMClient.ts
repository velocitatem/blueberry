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
import type { Window } from "./Window";
import { createTools } from "./llm";

// Load environment variables from .env file
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

const DEFAULT_TEMPERATURE = 0.7;
const MAX_TOOL_STEPS = 10;

export class LLMClient {
  private readonly webContents: WebContents;
  private window: Window | null = null;
  private readonly provider: LLMProvider;
  private readonly modelName: string;
  private readonly model: LanguageModel | null;
  private messages: CoreMessage[] = [];

  constructor(webContents: WebContents) {
    this.webContents = webContents;
    this.provider = this.getProvider();
    this.modelName = this.getModelName();
    this.model = this.initializeModel();

    this.logInitializationStatus();
  }

  setWindow(window: Window): void {
    this.window = window;
  }

  private getProvider(): LLMProvider {
    const provider = process.env.LLM_PROVIDER?.toLowerCase();
    return provider === "anthropic" ? "anthropic" : "openai";
  }

  private getModelName = (): string => process.env.LLM_MODEL || DEFAULT_MODELS[this.provider];

  private initializeModel(): LanguageModel | null {
    const apiKey = this.getApiKey();
    if (!apiKey) return null;

    return this.provider === "anthropic" 
      ? anthropic(this.modelName)
      : openai(this.modelName);
  }

  private getApiKey = (): string | undefined => process.env[this.provider === "anthropic" 
    ? "ANTHROPIC_API_KEY"
     : "OPENAI_API_KEY"
  ] as string | undefined;


  private getTools = (): ToolSet => createTools({ window: this.window });

  private logInitializationStatus(): void {
    if (this.model) {
      console.log(
        `✅ LLM Client initialized with ${this.provider} provider using model: ${this.modelName}`
      );
    } else {
      const keyName =
        this.provider === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY";
      console.error(
        `❌ LLM Client initialization failed: ${keyName} not found in environment variables.\n` +
          `Please add your API key to the .env file in the project root.`
      );
    }
  }

  async sendChatMessage(request: ChatRequest): Promise<void> {
    try {
      let screenshot: string | null = null;
      if (this.window) {
        const activeTab = this.window.activeTab;
        if (activeTab) {
          try {
            const image = await activeTab.screenshot();
            screenshot = image.toDataURL();
          } catch (error) {
            console.error("Failed to capture screenshot:", error);
          }
        }
      }

      const userContent: Array<
        | { type: "text"; text: string }
        | { type: "image"; image: string }
      > = [];

      if (screenshot) {
        userContent.push({
          type: "image",
          image: screenshot,
        });
      }

      userContent.push({
        type: "text",
        text: request.message,
      });

      const userMessage: CoreMessage = {
        role: "user",
        content: userContent.length === 1 ? request.message : userContent,
      };

      this.messages.push(userMessage);
      this.sendMessagesToRenderer();

      if (!this.model) {
        this.sendErrorMessage(
          request.messageId,
          "LLM service is not configured. Please add your API key to the .env file."
        );
        return;
      }

      const { messages, system } = await this.prepareMessagesWithContext();
      await this.streamResponse(messages, system, request.messageId);
    } catch (error) {
      console.error("Error in LLM request:", error);
      this.handleStreamError(error, request.messageId);
    }
  }

  clearMessages(): void {
    this.messages = [];
    this.sendMessagesToRenderer();
  }

  getMessages = (): CoreMessage[] => this.messages;

  private sendMessagesToRenderer(): void {
    this.webContents.send("chat-messages-updated", this.messages);
  }

  private async prepareMessagesWithContext(): Promise<{
    messages: CoreMessage[];
    system: string;
  }> {
    let pageUrl: string | null = null;

    if (this.window) {
      const activeTab = this.window.activeTab;
      if (activeTab) {
        pageUrl = activeTab.url;
      }
    }

    return {
      messages: this.messages,
      system: this.buildSystemPrompt(pageUrl),
    };
  }

  private buildSystemPrompt = (url: string | null): string => {
    const parts = [
      "You are a helpful AI assistant integrated into a web browser.",
      "You can analyze and discuss web pages with the user.",
      "The user's messages may include a screenshot of the current page as the first image.",
      "You have tools to read page text/HTML, get the current URL, and navigate the active tab.",
      "Use tools when you need up-to-date page content instead of guessing.",
    ];

    if (url) {
      parts.push(`\nCurrent page URL: ${url}`);
    }

    parts.push(
      "\nProvide helpful, accurate, and contextual responses about the current webpage.",
      "If the user asks about specific content, use your tools to inspect the page when needed."
    );

    return parts.join("\n") as string;
  }

  private async streamResponse(
    messages: CoreMessage[],
    system: string,
    messageId: string
  ): Promise<void> {
    if (!this.model) {
      throw new Error("Model not initialized");
    }

    const tools = this.getTools();

    const result = streamText({
      model: this.model,
      system,
      messages,
      tools,
      stopWhen: stepCountIs(MAX_TOOL_STEPS),
      temperature: DEFAULT_TEMPERATURE,
      maxRetries: 3,
    });

    await this.processStream(result, messageId);
  }

  private async processStream(
    result: StreamTextResult<ToolSet, never>,
    messageId: string
  ): Promise<void> {
    const assistantMessage: CoreMessage = {
      role: "assistant",
      content: "",
    };

    const messageIndex = this.messages.length;
    this.messages.push(assistantMessage);

    let accumulatedText = "";

    for await (const chunk of result.textStream) {
      accumulatedText += chunk;

      this.messages[messageIndex] = {
        role: "assistant",
        content: accumulatedText,
      };
      this.sendMessagesToRenderer();

      this.sendStreamChunk(messageId, {
        content: chunk,
        isComplete: false,
      });
    }

    const steps = await result.steps;
    this.applyStepMessagesToHistory(steps, messageIndex);

    const finalText = await result.text;

    this.sendStreamChunk(messageId, {
      content: finalText,
      isComplete: true,
    });
  }

  private applyStepMessagesToHistory(
    steps: Array<StepResult<ToolSet>>,
    placeholderIndex: number
  ): void {
    const turnMessages: CoreMessage[] = [];

    for (const step of steps) {
      for (const message of step.response.messages) {
        turnMessages.push(message as CoreMessage);
      }
    }

    if (turnMessages.length === 0) {
      return;
    }

    this.messages.splice(placeholderIndex, 1, ...turnMessages);
    this.sendMessagesToRenderer();
  }

  private handleStreamError(error: unknown, messageId: string): void {
    console.error("Error streaming from LLM:", error);

    const errorMessage = this.getErrorMessage(error);
    this.sendErrorMessage(messageId, errorMessage);
  }

  private getErrorMessage(error: unknown): string {
    if (!(error instanceof Error)) {
      return "An unexpected error occurred. Please try again.";
    }

    const message = error.message.toLowerCase();

    if (message.includes("401") || message.includes("unauthorized")) {
      return "Authentication error: Please check your API key in the .env file.";
    }

    if (message.includes("429") || message.includes("rate limit")) {
      return "Rate limit exceeded. Please try again in a few moments.";
    }

    if (
      message.includes("network") ||
      message.includes("fetch") ||
      message.includes("econnrefused")
    ) {
      return "Network error: Please check your internet connection.";
    }

    if (message.includes("timeout")) {
      return "Request timeout: The service took too long to respond. Please try again.";
    }

    return "Sorry, I encountered an error while processing your request. Please try again.";
  }

  private sendErrorMessage(messageId: string, errorMessage: string): void {
    this.sendStreamChunk(messageId, {
      content: errorMessage,
      isComplete: true,
    });
  }

  private sendStreamChunk(messageId: string, chunk: StreamChunk): void {
    this.webContents.send("chat-response", {
      messageId,
      content: chunk.content,
      isComplete: chunk.isComplete,
    });
  }
}
