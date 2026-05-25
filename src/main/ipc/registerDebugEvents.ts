import type { EventRegistry, ListenerHandler } from "./EventRegistry";

export const registerDebugEvents = (registry: EventRegistry): void => {
  const listeners = {
    ping: () => console.log("pong"),
  } satisfies Record<string, ListenerHandler>;

  registry.onMany(listeners);
};
