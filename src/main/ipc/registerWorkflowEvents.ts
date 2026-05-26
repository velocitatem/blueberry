import type { EventContext } from "./EventContext";
import type { EventRegistry, InvokeHandler } from "./EventRegistry";
import type { EventTail } from "../eventTail";
import { WorkflowCompiler } from "../WorkflowCompiler";

export const registerWorkflowEvents = (
  registry: EventRegistry,
  ctx: EventContext,
  tail: EventTail,
): void => {
  const { mainWindow } = ctx;

  const getCompiler = (): WorkflowCompiler =>
    new WorkflowCompiler(tail, mainWindow.sidebar.client.languageModel);

  const handlers = {
    "workflow-session-summary": () => getCompiler().sessionSummary(),
    "workflow-session-events": () =>
      getCompiler()
        .recentSessionEvents()
        .map((event) => ({
          id: event.id,
          type: event.type,
          tabId: event.channel,
          timestamp: event.timestamp,
          payload: event.payload ?? {},
        })),
    "workflow-compile": async () => {
      try {
        const workflow = await getCompiler().compile();
        return { ok: true as const, workflow };
      } catch (error) {
        return {
          ok: false as const,
          error: error instanceof Error ? error.message : "Compile failed",
        };
      }
    },
    "workflow-clear-session": () => {
      tail.clear();
      return { ok: true as const };
    },
  } satisfies Record<string, InvokeHandler>;

  registry.handleMany(handlers);
};
