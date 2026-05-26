import type { CoreMessage, LanguageModel } from "ai";
import type { Window } from "../../Window";

export type StreamChunk = { content: string; isComplete: boolean };

/** Mutable view of the conversation the LLMClient owns; backends call these to update it. */
export interface ConversationView {
  readonly messages: CoreMessage[];
  push(msg: CoreMessage): void;
  splice(start: number, deleteCount: number, ...items: CoreMessage[]): void;
  setAt(index: number, msg: CoreMessage): void;
  sync(): void;
}

export interface BackendContext {
  window: Window | null;
  conversation: ConversationView;
  emit(chunk: StreamChunk): void;
  captureScreenshot(): Promise<string | null>;
}

export interface ChatBackend {
  readonly id: string;
  readonly languageModel: LanguageModel | null;
  isReady(): boolean;
  /** Build the user-facing message (may attach a screenshot). */
  prepareUserMessage(text: string, ctx: BackendContext): Promise<CoreMessage>;
  /** Run one full turn — may stream chunks, push assistant/tool messages, run an agent loop. */
  runTurn(userText: string, ctx: BackendContext): Promise<void>;
  /** Map a thrown error to a user-facing message. */
  formatError(error: unknown): Promise<string>;
  /** Optional: log a one-time startup hint (e.g. server reachability). */
  logStartup?(): Promise<void>;
}
