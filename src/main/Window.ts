import { BaseWindow, shell } from "electron";
import { Tab } from "./Tab";
import { TopBar } from "./TopBar";
import { SideBar } from "./SideBar";
import type { EventSink } from "./events";

export class Window {
  private _baseWindow: BaseWindow;
  private tabsMap: Map<string, Tab> = new Map();
  private activeTabId: string | null = null;
  private previousActiveTabId: string | null = null;
  private tabCounter: number = 0;
  private _topBar: TopBar;
  private _sideBar: SideBar;
  private readonly eventSink: EventSink;

  constructor(eventSink: EventSink) {
    this.eventSink = eventSink;
    // Create the browser window.
    this._baseWindow = new BaseWindow({
      width: 1000,
      height: 800,
      show: true,
      autoHideMenuBar: false,
      titleBarStyle: "hidden",
      ...(process.platform !== "darwin" ? { titleBarOverlay: true } : {}),
      trafficLightPosition: { x: 15, y: 13 },
    });

    this._baseWindow.setMinimumSize(1000, 800);

    this._topBar = new TopBar(this._baseWindow);
    this._sideBar = new SideBar(this._baseWindow);

    // Set the window reference on the LLM client to avoid circular dependency
    this._sideBar.client.setWindow(this);

    // Create the first tab
    this.createTab("https://strawberrybrowser.com");

    // Set up window resize handler
    this._baseWindow.on("resize", () => {
      this.updateTabBounds();
      this._topBar.updateBounds();
      this._sideBar.updateBounds();
      // Notify renderer of resize through active tab
      const bounds = this._baseWindow.getBounds();
      if (this.activeTab) {
        this.activeTab.webContents.send("window-resized", {
          width: bounds.width,
          height: bounds.height,
        });
      }
    });

    this.setupEventListeners();
  }

  private setupEventListeners(): void {
    this._baseWindow.on("closed", () => {
      // Clean up all tabs when window is closed
      this.tabsMap.forEach((tab) => tab.destroy());
      this.tabsMap.clear();
    });
  }

  // Getters
  get window(): BaseWindow {
    return this._baseWindow;
  }

  get activeTab(): Tab | null {
    if (this.activeTabId) {
      return this.tabsMap.get(this.activeTabId) || null;
    }
    return null;
  }

  get allTabs(): Tab[] {
    return Array.from(this.tabsMap.values());
  }

  get tabCount(): number {
    return this.tabsMap.size;
  }

  // Tab management methods
  createTab(url?: string): Tab {
    const tabId = `tab-${++this.tabCounter}`;
    const tab = new Tab(tabId, url, this.eventSink);

    // Route window.open / target=_blank / "open in new tab" into our own tab
    // system instead of the OS default browser.
    tab.webContents.setWindowOpenHandler((details) => {
      this.openUrl(details.url, {
        background: details.disposition === "background-tab",
      });
      return { action: "deny" };
    });

    // Add the tab's WebContentsView to the window
    this._baseWindow.contentView.addChildView(tab.view);

    // Set the bounds to fill the window below the topbar and to the left of sidebar
    const bounds = this._baseWindow.getBounds();
    tab.view.setBounds({
      x: 0,
      y: 88, // Start below the topbar
      width: bounds.width - 400, // Subtract sidebar width
      height: bounds.height - 88, // Subtract topbar height
    });

    // Store the tab
    this.tabsMap.set(tabId, tab);

    // If this is the first tab, make it active
    if (this.tabsMap.size === 1) {
      this.switchActiveTab(tabId);
    } else {
      // Hide the tab initially if it's not the first one
      tab.hide();
    }

    return tab;
  }

  /**
   * Open a URL requested by a page (new window / target=_blank). Web URLs open
   * as a new tab inside this window; non-web schemes (mailto:, tel:, etc.) are
   * delegated to the OS. Foreground requests become the active tab; background
   * requests (e.g. ctrl/cmd-click) stay in the background.
   */
  private openUrl(url: string, options: { background?: boolean } = {}): void {
    if (!url) return;
    const isWeb = /^https?:\/\//i.test(url) || url.startsWith("about:");
    if (!isWeb) {
      void shell.openExternal(url).catch(() => undefined);
      return;
    }
    const tab = this.createTab(url);
    if (!options.background) this.switchActiveTab(tab.id);
  }

  closeTab(tabId: string): boolean {
    const tab = this.tabsMap.get(tabId);
    if (!tab) {
      return false;
    }

    // Remove the WebContentsView from the window
    this._baseWindow.contentView.removeChildView(tab.view);

    // Destroy the tab
    tab.destroy();

    // Remove from our tabs map
    this.tabsMap.delete(tabId);
    if (this.previousActiveTabId === tabId) {
      this.previousActiveTabId = null;
    }

    // If this was the active tab, switch to another tab
    if (this.activeTabId === tabId) {
      this.activeTabId = null;
      const remainingTabs = Array.from(this.tabsMap.keys());
      if (remainingTabs.length > 0) {
        this.switchActiveTab(remainingTabs[0]);
      }
    }

    // If no tabs left, close the window
    if (this.tabsMap.size === 0) {
      this._baseWindow.close();
    }

    return true;
  }

  switchActiveTab(tabId: string): boolean {
    const tab = this.tabsMap.get(tabId);
    if (!tab) {
      return false;
    }

    // Hide the currently active tab
    if (this.activeTabId && this.activeTabId !== tabId) {
      this.previousActiveTabId = this.activeTabId;
      const currentTab = this.tabsMap.get(this.activeTabId);
      if (currentTab) {
        currentTab.hide();
      }
    }

    // Show the new active tab
    tab.show();
    this.activeTabId = tabId;

    // Update the window title to match the tab title
    this._baseWindow.setTitle(tab.title || "Blueberry Browser");

    return true;
  }

  switchToPreviousTab(): boolean {
    const tabId = this.previousActiveTabId;
    if (!tabId || tabId === this.activeTabId || !this.tabsMap.has(tabId)) {
      this.previousActiveTabId = null;
      return false;
    }
    return this.switchActiveTab(tabId);
  }

  /** Focus the tab whose loaded URL best matches (e.g. after a background new-tab open). */
  switchToTabWithUrl(url: string): boolean {
    if (!url) return false;
    let target: Tab | null = null;
    for (const tab of this.allTabs) {
      if (tab.url === url) target = tab;
    }
    if (!target) {
      try {
        const want = new URL(url);
        for (const tab of this.allTabs) {
          try {
            const have = new URL(tab.url);
            if (
              have.hostname === want.hostname &&
              have.pathname === want.pathname
            ) {
              target = tab;
            }
          } catch {
            /* skip malformed tab url */
          }
        }
      } catch {
        return false;
      }
    }
    if (!target || target.id === this.activeTabId) return !!target;
    return this.switchActiveTab(target.id);
  }

  getTab(tabId: string): Tab | null {
    return this.tabsMap.get(tabId) || null;
  }

  // Window methods
  show(): void {
    this._baseWindow.show();
  }

  hide(): void {
    this._baseWindow.hide();
  }

  close(): void {
    this._baseWindow.close();
  }

  focus(): void {
    this._baseWindow.focus();
  }

  minimize(): void {
    this._baseWindow.minimize();
  }

  maximize(): void {
    this._baseWindow.maximize();
  }

  unmaximize(): void {
    this._baseWindow.unmaximize();
  }

  isMaximized(): boolean {
    return this._baseWindow.isMaximized();
  }

  setTitle(title: string): void {
    this._baseWindow.setTitle(title);
  }

  setBounds(bounds: {
    x?: number;
    y?: number;
    width?: number;
    height?: number;
  }): void {
    this._baseWindow.setBounds(bounds);
  }

  getBounds(): { x: number; y: number; width: number; height: number } {
    return this._baseWindow.getBounds();
  }

  // Handle window resize to update tab bounds
  private updateTabBounds(): void {
    const bounds = this._baseWindow.getBounds();
    // Only subtract sidebar width if it's visible
    const sidebarWidth = this._sideBar.getIsVisible() ? 400 : 0;

    this.tabsMap.forEach((tab) => {
      tab.view.setBounds({
        x: 0,
        y: 88, // Start below the topbar
        width: bounds.width - sidebarWidth,
        height: bounds.height - 88, // Subtract topbar height
      });
    });
  }

  // Public method to update all bounds when sidebar is toggled
  updateAllBounds(): void {
    this.updateTabBounds();
    this._sideBar.updateBounds();
  }

  // Getter for sidebar to access from main process
  get sidebar(): SideBar {
    return this._sideBar;
  }

  // Getter for topBar to access from main process
  get topBar(): TopBar {
    return this._topBar;
  }

  // Getter for all tabs as array
  get tabs(): Tab[] {
    return Array.from(this.tabsMap.values());
  }

  // Getter for baseWindow to access from Menu
  get baseWindow(): BaseWindow {
    return this._baseWindow;
  }
}
