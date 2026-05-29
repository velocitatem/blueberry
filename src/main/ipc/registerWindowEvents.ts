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
import { GraphStore } from "../graph/GraphStore";
import { PacketStore } from "../TaskGraphCompiler";

export const registerWindowEvents = (
  registry: EventRegistry,
  mainWindow: Window,
  sessionLog: SessionLog,
): void => {
  const ctx = new EventContext(mainWindow);
  const graphStore = new GraphStore();
  const packetStore = new PacketStore();

  mainWindow.sidebar.client.setNightStores(graphStore, packetStore);

  registerTabEvents(registry, ctx);
  registerSidebarEvents(registry, ctx);
  registerPageContentEvents(registry, ctx);
  registerThemeEvents(registry, ctx);
  registerWorkflowEvents(registry, ctx, sessionLog, graphStore, packetStore);
  registerDebugEvents(registry);
};
