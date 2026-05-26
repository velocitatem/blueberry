import "./browserTools";

export {
  createTools,
  createToolsFromDefs,
  defineTool,
  registerTools,
  listRegisteredTools,
} from "./tool";
export type { ToolContext, ToolDef, ToolDefs } from "./tool";

export {
  FARA_REFERENCE_WIDTH,
  FARA_REFERENCE_HEIGHT,
  buildFaraSystemPrompt,
  faraToolDefs,
} from "./fara";

import { createToolsFromDefs } from "./tool";
import { faraToolDefs } from "./fara";
import type { ToolContext } from "./tool";

export const createFaraTools = (ctx: ToolContext) =>
  createToolsFromDefs(faraToolDefs, ctx);

export { createChatBackend } from "./clients";
export type { ChatBackend, BackendContext, ConversationView, StreamChunk } from "./clients";
