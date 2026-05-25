import { createLogger } from "../logger";
import type { EventRegistry, ListenerHandler } from "./EventRegistry";

const log = createLogger("debug");

export const registerDebugEvents = (registry: EventRegistry): void => {
  const listeners = {
    ping: () => log.debug("pong"),
  } satisfies Record<string, ListenerHandler>;

  registry.onMany(listeners);
};
