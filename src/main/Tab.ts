import { NativeImage, WebContentsView, ipcMain, IpcMainEvent } from "electron";
import { join } from "path";
import {
  createTabEvent,
  isSensitiveInputMeta,
  type EventSink,
  type TabEventKind,
} from "./events";
import { createLogger } from "./logger";
import { getPageStateScript, type PageStateSnapshot } from "./PageState";

const log = createLogger("tab");

const CAPTURE_CHANNEL = "tab-action";

export class Tab {
  private webContentsView: WebContentsView;
  private _id: string;
  private _title: string;
  private _url: string;
  private _isVisible: boolean = false;
  private readonly eventSink: EventSink | null;
  private readonly captureListener: (
    event: IpcMainEvent,
    payload: unknown,
  ) => void;

  constructor(
    id: string,
    url: string = "https://google.com",
    eventSink: EventSink | null = null,
  ) {
    this._id = id;
    this._url = url;
    this._title = "Loading ...";
    this.eventSink = eventSink;
    this.captureListener = (event, payload) => {
      if (event.sender !== this.webContentsView.webContents) return;
      this.handleCapturedAction(payload);
    };

    // Create the WebContentsView for web content only
    this.webContentsView = new WebContentsView({
      webPreferences: {
        preload: join(__dirname, "../preload/tab.js"),
        nodeIntegration: false,
        contextIsolation: true,
        // sandbox must be false for executeJavaScript (page text extraction)
        sandbox: false,
        webSecurity: true,
      },
    });

    // Set up event listeners
    this.setupEventListeners();

    // Load the initial URL
    this.loadURL(url);
  }

  private setupEventListeners(): void {
    // Update title when page title changes
    this.webContentsView.webContents.on("page-title-updated", (_, title) => {
      this._title = title;
    });

    // Update URL when navigation occurs
    this.webContentsView.webContents.on("did-navigate", (_, url) => {
      this._url = url;
      this.emitTabEvent("navigation", { transition: "did-navigate" });
    });

    this.webContentsView.webContents.on("did-navigate-in-page", (_, url) => {
      this._url = url;
      this.emitTabEvent("navigation", { transition: "did-navigate-in-page" });
    });

    this.webContentsView.webContents.on("dom-ready", () => {
      void this.injectCaptureBridge();
    });

    ipcMain.on(CAPTURE_CHANNEL, this.captureListener);
  }

  private emitTabEvent(
    kind: TabEventKind,
    data?: Record<string, unknown>,
  ): void {
    if (!this.eventSink) return;
    try {
      const event = createTabEvent({
        kind,
        tabId: this._id,
        url: this._url,
        title: this._title,
        data,
      });
      void Promise.resolve(this.eventSink(event)).catch(() => undefined);
    } catch (error) {
      log.error({ err: error, tabId: this._id }, "Failed to emit tab event");
    }
  }

  private handleCapturedAction(payload: unknown): void {
    if (!payload || typeof payload !== "object") return;
    const { kind, data } = payload as {
      kind?: string;
      data?: Record<string, unknown>;
    };
    if (kind !== "click" && kind !== "input") return;

    if (kind === "input" && data) {
      if (isSensitiveInputMeta(data)) return;
      // Strip value, keep only presence + length
      const { value, ...rest } = data as Record<string, unknown>;
      const valueLength = typeof value === "string" ? value.length : undefined;
      this.emitTabEvent("input", {
        ...rest,
        hasValue: Boolean(value),
        ...(valueLength !== undefined ? { valueLength } : {}),
      });
      return;
    }

    this.emitTabEvent(kind, data);
  }

  private async injectCaptureBridge(): Promise<void> {
    if (!this.canRunPageScript()) return;
    const channel = JSON.stringify(CAPTURE_CHANNEL);
    const script = `(() => {
      if (window.__blueberryCaptureInstalled) return;
      window.__blueberryCaptureInstalled = true;
      const send = (kind, data) => {
        try {
          window.__blueberryBridge?.send(${channel}, { kind, data });
        } catch (_) {}
      };
      const describe = (el) => {
        if (!el || el.nodeType !== 1) return null;
        const rect = el.getBoundingClientRect?.();
        return {
          tag: el.tagName?.toLowerCase?.() ?? null,
          id: el.id || null,
          name: el.getAttribute?.('name') || null,
          role: el.getAttribute?.('role') || null,
          type: el.getAttribute?.('type') || null,
          text: (el.innerText || el.value || '').slice(0, 120) || null,
          href: el.getAttribute?.('href') || null,
          x: rect ? Math.round(rect.x) : null,
          y: rect ? Math.round(rect.y) : null,
        };
      };
      document.addEventListener('click', (e) => {
        const target = e.target;
        if (!(target instanceof Element)) return;
        const clickable = target.closest('a, button, [role=button], input[type=submit], input[type=button]') || target;
        send('click', describe(clickable));
      }, true);
      const onInput = (e) => {
        const el = e.target;
        if (!(el instanceof Element)) return;
        const tag = el.tagName?.toLowerCase?.();
        if (tag === 'input' || tag === 'textarea' || tag === 'select') {
          send('input', {
            tag,
            name: el.getAttribute('name') || null,
            id: el.id || null,
            type: el.getAttribute('type') || null,
            autocomplete: el.getAttribute('autocomplete') || null,
            value: typeof el.value === 'string' ? el.value : '',
          });
        } else if (el.getAttribute('contenteditable') != null) {
          send('input', {
            tag,
            name: el.getAttribute('name') || el.getAttribute('data-name') || null,
            id: el.id || null,
            type: 'contenteditable',
            autocomplete: null,
            value: (el.textContent || '').slice(0, 500),
          });
        }
      };
      document.addEventListener('change', onInput, true);
      document.addEventListener('input', (e) => {
        const el = e.target;
        if (!(el instanceof Element)) return;
        if (el.getAttribute('contenteditable') != null) onInput(e);
      }, true);
    })();`;
    try {
      await this.webContentsView.webContents.executeJavaScript(script, true);
    } catch (error) {
      log.debug(
        { err: error, tabId: this._id },
        "Capture bridge injection skipped",
      );
    }
  }

  // Getters
  get id(): string {
    return this._id;
  }

  get title(): string {
    return this._title;
  }

  get url(): string {
    const url = this.webContentsView.webContents.getURL();
    return url && url !== "about:blank" ? url : this._url;
  }

  get isVisible(): boolean {
    return this._isVisible;
  }

  get webContents() {
    return this.webContentsView.webContents;
  }

  get view(): WebContentsView {
    return this.webContentsView;
  }

  // Public methods
  show(): void {
    this._isVisible = true;
    this.webContentsView.setVisible(true);
  }

  hide(): void {
    this._isVisible = false;
    this.webContentsView.setVisible(false);
  }

  async screenshot(): Promise<NativeImage> {
    return await this.webContentsView.webContents.capturePage();
  }

  /**
   * Click at a viewport coordinate (CSS pixels relative to the page).
   * Used by visual grounding, which returns pixels rather than a CSS selector.
   */
  async clickAt(x: number, y: number): Promise<void> {
    const wc = this.webContentsView.webContents;
    wc.sendInputEvent({ type: "mouseMove", x, y });
    wc.sendInputEvent({
      type: "mouseDown",
      x,
      y,
      button: "left",
      clickCount: 1,
    });
    wc.sendInputEvent({
      type: "mouseUp",
      x,
      y,
      button: "left",
      clickCount: 1,
    });
  }

  /** Current CSS viewport size, used to map normalized grounding coords to pixels. */
  async viewportSize(): Promise<{ innerWidth: number; innerHeight: number }> {
    const result = await this.runJs(
      `({ innerWidth: window.innerWidth, innerHeight: window.innerHeight })`,
    );
    return {
      innerWidth: Number(result?.innerWidth) || 0,
      innerHeight: Number(result?.innerHeight) || 0,
    };
  }

  private canRunPageScript(): boolean {
    const url = this.webContentsView.webContents.getURL();
    if (!url || url === "about:blank") return false;
    return !/^(chrome|chrome-extension|devtools|file):/i.test(url);
  }

  private async waitForPageReady(): Promise<void> {
    const webContents = this.webContentsView.webContents;
    if (!webContents.isLoading() || !webContents.getURL()) return;

    await new Promise<void>((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve();
      };
      const timeout = setTimeout(done, 5000);
      webContents.once("dom-ready", done);
      if (!webContents.isLoading()) done();
    });
  }

  async runJs(code: string): Promise<any> {
    if (!this.canRunPageScript()) return null;
    await this.waitForPageReady();
    return await this.webContentsView.webContents.executeJavaScript(code);
  }

  async getTabText(): Promise<string> {
    return ( // for READABLE doms we try to extract main contents not to explode context
      (await this.runJs(
        `(() => {
        try {
          const norm = (s) => (s ?? '').replace(/\\n{3,}/g, '\\n\\n').trim();
          const pick = () =>
            document.querySelector('main#content') ||
            document.getElementById('mw-content-text') ||
            document.querySelector('[role="main"]') ||
            document.querySelector('main') ||
            document.querySelector('article') ||
            document.body;
          const el = pick();
          const text = norm(el?.innerText);
          if (text.length < 200) return norm(document.body?.innerText);
          return text;
        } catch {
          try { return document.body?.innerText ?? ''; } catch { return ''; }
        }
      })()`,
      )) ?? ""
    );
  }

  async getPageState(): Promise<PageStateSnapshot | null> {
    const raw = await this.runJs(getPageStateScript());
    if (!raw || typeof raw !== "object") return null;

    if ("error" in raw && raw.error) {
      log.debug(
        { err: raw.error, tabId: this._id },
        "page state extraction failed",
      );
      return null;
    }

    const snapshot = raw as PageStateSnapshot;
    const currentUrl = this.webContentsView.webContents.getURL();
    return {
      ...snapshot,
      url: snapshot.url || currentUrl || this._url,
      title: this._title || snapshot.title,
    };
  }

  loadURL(url: string): Promise<void> {
    this._url = url;
    return this.webContentsView.webContents.loadURL(url);
  }

  goBack(): void {
    if (!this.webContentsView.webContents.navigationHistory.canGoBack()) return;
    this.webContentsView.webContents.navigationHistory.goBack();
  }

  goForward(): void {
    if (!this.webContentsView.webContents.navigationHistory.canGoForward())
      return;
    this.webContentsView.webContents.navigationHistory.goForward();
  }

  reload(): void {
    this.webContentsView.webContents.reload();
  }

  stop(): void {
    this.webContentsView.webContents.stop();
  }

  destroy(): void {
    ipcMain.off(CAPTURE_CHANNEL, this.captureListener);
    this.webContentsView.webContents.close();
  }
}
