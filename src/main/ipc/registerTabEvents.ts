import type { EventContext } from "./EventContext";
import type { EventRegistry, InvokeHandler } from "./EventRegistry";
import { expectString, serializeTab } from "./utils";

export const registerTabEvents = (
  registry: EventRegistry,
  ctx: EventContext
): void => {
  const { mainWindow } = ctx;

  const handlers = {
    "create-tab": (_, urlRaw) => {
      const tab = mainWindow.createTab(
        typeof urlRaw === "string" ? urlRaw : undefined
      );
      return serializeTab(tab, mainWindow.activeTab?.id);
    },
    "close-tab": (_, idRaw) => {
      mainWindow.closeTab(expectString(idRaw, "id"));
    },
    "switch-tab": (_, idRaw) => {
      mainWindow.switchActiveTab(expectString(idRaw, "id"));
    },
    "get-tabs": () => {
      const activeTabId = mainWindow.activeTab?.id;
      return mainWindow.allTabs.map((tab) => serializeTab(tab, activeTabId));
    },
    "navigate-to": (_, urlRaw) => {
      const url = expectString(urlRaw, "url");
      ctx.withActiveTab((tab) => tab.loadURL(url), undefined);
    },
    "navigate-tab": async (_, tabIdRaw, urlRaw) => {
      const tabId = expectString(tabIdRaw, "tabId");
      const url = expectString(urlRaw, "url");
      return ctx.withTab(
        tabId,
        async (tab) => {
          await tab.loadURL(url);
          return true;
        },
        false
      );
    },
    "go-back": () => {
      ctx.withActiveTab((tab) => tab.goBack(), undefined);
    },
    "go-forward": () => {
      ctx.withActiveTab((tab) => tab.goForward(), undefined);
    },
    reload: () => {
      ctx.withActiveTab((tab) => tab.reload(), undefined);
    },
    "tab-go-back": (_, tabIdRaw) => {
      const tabId = expectString(tabIdRaw, "tabId");
      return ctx.withTab(
        tabId,
        (tab) => {
          tab.goBack();
          return true;
        },
        false
      );
    },
    "tab-go-forward": (_, tabIdRaw) => {
      const tabId = expectString(tabIdRaw, "tabId");
      return ctx.withTab(
        tabId,
        (tab) => {
          tab.goForward();
          return true;
        },
        false
      );
    },
    "tab-reload": (_, tabIdRaw) => {
      const tabId = expectString(tabIdRaw, "tabId");
      return ctx.withTab(
        tabId,
        (tab) => {
          tab.reload();
          return true;
        },
        false
      );
    },
    "tab-screenshot": async (_, tabIdRaw) => {
      const tabId = expectString(tabIdRaw, "tabId");
      return ctx.withTab(
        tabId,
        async (tab) => (await tab.screenshot()).toDataURL(),
        null
      );
    },
    "tab-run-js": async (_, tabIdRaw, codeRaw) => {
      const tabId = expectString(tabIdRaw, "tabId");
      const code = expectString(codeRaw, "code");
      return ctx.withTab(tabId, (tab) => tab.runJs(code), null);
    },
    "get-active-tab-info": () => {
      const tab = mainWindow.activeTab;
      if (!tab) return null;

      return {
        id: tab.id,
        url: tab.url,
        title: tab.title,
        canGoBack: tab.webContents.canGoBack(),
        canGoForward: tab.webContents.canGoForward(),
      };
    },
  } satisfies Record<string, InvokeHandler>;

  registry.handleMany(handlers);
};
