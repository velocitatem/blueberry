import type { Tab } from "../Tab";
import type { Window } from "../Window";

export class EventContext {
  constructor(public readonly mainWindow: Window) {}

  withTab<R>(
    tabId: string,
    fn: (tab: Tab) => R | Promise<R>,
    fallback: R
  ): R | Promise<R> {
    const tab = this.mainWindow.getTab(tabId);
    return tab ? fn(tab) : fallback;
  }

  withActiveTab<R>(
    fn: (tab: Tab) => R | Promise<R>,
    fallback: R
  ): R | Promise<R> {
    const tab = this.mainWindow.activeTab;
    return tab ? fn(tab) : fallback;
  }
}
