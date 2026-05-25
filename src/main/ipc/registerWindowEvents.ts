import type { Window } from "../Window";
import { EventContext } from "./EventContext";
import type { EventRegistry } from "./EventRegistry";
import { registerDebugEvents } from "./registerDebugEvents";
import { registerPageContentEvents } from "./registerPageContentEvents";
import { registerSidebarEvents } from "./registerSidebarEvents";
import { registerTabEvents } from "./registerTabEvents";
import { registerThemeEvents } from "./registerThemeEvents";

export const registerWindowEvents = (
  registry: EventRegistry,
  mainWindow: Window
): void => {
  const ctx = new EventContext(mainWindow);

  registerTabEvents(registry, ctx);
  registerSidebarEvents(registry, ctx);
  registerPageContentEvents(registry, ctx);
  registerThemeEvents(registry, ctx);
  registerDebugEvents(registry);
};
