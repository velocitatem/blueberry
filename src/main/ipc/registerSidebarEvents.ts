import type { EventContext } from "./EventContext";
import type { EventRegistry, InvokeHandler } from "./EventRegistry";

interface ChatRequest {
  message: string;
  messageId: string;
}

function expectChatRequest(value: unknown): ChatRequest {
  if (typeof value !== "object" || value === null) {
    throw new Error("Expected chat request to be an object");
  }
  const request = value as Record<string, unknown>;
  if (typeof request.message !== "string") {
    throw new Error("Expected request.message to be a string");
  }
  if (typeof request.messageId !== "string") {
    throw new Error("Expected request.messageId to be a string");
  }
  return { message: request.message, messageId: request.messageId };
}

export const registerSidebarEvents = (
  registry: EventRegistry,
  ctx: EventContext
): void => {
  const { mainWindow } = ctx;

  const handlers = {
    "toggle-sidebar": () => {
      mainWindow.sidebar.toggle();
      mainWindow.updateAllBounds();
      return true;
    },
    "sidebar-chat-message": async (_, requestRaw) => {
      await mainWindow.sidebar.client.sendChatMessage(
        expectChatRequest(requestRaw)
      );
    },
    "sidebar-clear-chat": () => {
      mainWindow.sidebar.client.clearMessages();
      return true;
    },
    "sidebar-get-messages": () => mainWindow.sidebar.client.getMessages(),
  } satisfies Record<string, InvokeHandler>;

  registry.handleMany(handlers);
};
