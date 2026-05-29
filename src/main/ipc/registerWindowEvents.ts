import type { Window } from "../Window";
import type { SessionLog } from "../SessionLog";
import { EventContext } from "./EventContext";
import type { EventRegistry } from "./EventRegistry";
import { registerDebugEvents } from "./registerDebugEvents";
import { registerPageContentEvents } from "./registerPageContentEvents";
import { registerSidebarEvents } from "./registerSidebarEvents";
import { registerTabEvents } from "./registerTabEvents";
import { registerThemeEvents } from "./registerThemeEvents";
import { registerWorkflowEvents } from "./registerWorkflowEvents";

export const registerWindowEvents = (
  registry: EventRegistry,
  mainWindow: Window,
  sessionLog: SessionLog,
): void => {
  const ctx = new EventContext(mainWindow);

  registerTabEvents(registry, ctx);
  registerSidebarEvents(registry, ctx);
  registerPageContentEvents(registry, ctx);
  registerThemeEvents(registry, ctx);
  registerWorkflowEvents(registry, ctx, sessionLog);
  registerDebugEvents(registry);
};
