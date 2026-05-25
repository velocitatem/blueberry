import type { EventContext } from "./EventContext";
import type { EventRegistry, InvokeHandler } from "./EventRegistry";
import { safeNull } from "./utils";

export const registerPageContentEvents = (
  registry: EventRegistry,
  ctx: EventContext
): void => {
  const handlers = {
    "get-page-content": async () =>
      ctx.withActiveTab(async (tab) => safeNull(() => tab.getTabHtml()), null),
    "get-page-text": async () =>
      ctx.withActiveTab(async (tab) => safeNull(() => tab.getTabText()), null),
    "get-current-url": () => ctx.withActiveTab((tab) => tab.url, null),
  } satisfies Record<string, InvokeHandler>;

  registry.handleMany(handlers);
};
