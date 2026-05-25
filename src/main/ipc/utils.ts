import type { WebContents } from "electron";
import type { Tab } from "../Tab";
import type { Window } from "../Window";
import { createLogger } from "../logger";

const log = createLogger("ipc");

export function expectString(value: unknown, name: string): string {
  if (typeof value !== "string") {
    throw new Error(`Expected ${name} to be a string`);
  }
  return value;
}

export async function safeNull<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (error) {
    log.error({ err: error }, "IPC handler failed");
    return null;
  }
}

export function serializeTab(
  tab: Pick<Tab, "id" | "title" | "url">,
  activeTabId?: string
) {
  return {
    id: tab.id,
    title: tab.title,
    url: tab.url,
    isActive: activeTabId === tab.id,
  };
}

export function broadcastDarkMode(
  mainWindow: Window,
  sender: WebContents,
  isDarkMode: boolean
): void {
  const { topBar, sidebar } = mainWindow;
  const targets = [
    topBar.view.webContents,
    sidebar.view.webContents,
    ...mainWindow.allTabs.map((tab) => tab.webContents),
  ];

  for (const target of targets) {
    if (target !== sender) {
      target.send("dark-mode-updated", isDarkMode);
    }
  }
}
