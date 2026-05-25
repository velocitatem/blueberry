import type { EventContext } from "./EventContext";
import type { EventRegistry, ListenerHandler } from "./EventRegistry";
import { broadcastDarkMode } from "./utils";

export const registerThemeEvents = (
  registry: EventRegistry,
  ctx: EventContext
): void => {
  const listeners = {
    "dark-mode-changed": (event, isDarkMode) => {
      if (typeof isDarkMode !== "boolean") return;
      broadcastDarkMode(ctx.mainWindow, event.sender, isDarkMode);
    },
  } satisfies Record<string, ListenerHandler>;

  registry.onMany(listeners);
};
