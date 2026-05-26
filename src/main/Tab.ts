import { NativeImage, WebContents, WebContentsView, ipcMain, IpcMainEvent } from "electron";
import { join } from "path";
import {
  FARA_REFERENCE_HEIGHT,
  FARA_REFERENCE_WIDTH,
} from "./llm/fara";
import {
  createTabEvent,
  isSensitiveInputMeta,
  type EventSink,
  type TabEventKind,
} from "./events";
import { createLogger } from "./logger";

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
    url: string = "https://strawberrybrowser.com",
    eventSink: EventSink | null = null,
  ) {
    this._id = id;
    this._url = url;
    this._title = "Strawberry Browser";
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
        if (tag !== 'input' && tag !== 'textarea' && tag !== 'select') return;
        send('input', {
          tag,
          name: el.getAttribute('name') || null,
          id: el.id || null,
          type: el.getAttribute('type') || null,
          autocomplete: el.getAttribute('autocomplete') || null,
          value: typeof el.value === 'string' ? el.value : '',
        });
      };
      document.addEventListener('change', onInput, true);
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
  get id(): string { return this._id; }

  get title(): string { return this._title; }

  get url(): string { return this._url; }
  get isVisible(): boolean { return this._isVisible; }
  get webContents(): WebContents { return this.webContentsView.webContents; }
  get view(): WebContentsView { return this.webContentsView; }

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

  async getViewportSize(): Promise<{ width: number; height: number }> {
    const size = await this.runJs(`(() => ({
      width: Math.max(document.documentElement?.clientWidth ?? 0, window.innerWidth ?? 0),
      height: Math.max(document.documentElement?.clientHeight ?? 0, window.innerHeight ?? 0),
    }))()`);
    if (
      size &&
      typeof size.width === "number" &&
      typeof size.height === "number" &&
      size.width > 0 &&
      size.height > 0
    ) {
      return { width: size.width, height: size.height };
    }
    return { width: FARA_REFERENCE_WIDTH, height: FARA_REFERENCE_HEIGHT };
  }

  private async scaleFromFaraSpace(x: number, y: number): Promise<{ x: number; y: number }> {
    const { width, height } = await this.getViewportSize();
    return {
      x: Math.round((x * width) / FARA_REFERENCE_WIDTH),
      y: Math.round((y * height) / FARA_REFERENCE_HEIGHT),
    };
  }

  private get webContentsForInput(): WebContents {
    return this.webContentsView.webContents;
  }

  async mouseMove(faraX: number, faraY: number): Promise<void> {
    const { x, y } = await this.scaleFromFaraSpace(faraX, faraY);
    this.webContentsForInput.sendInputEvent({ type: "mouseMove", x, y });
  }

  async leftClick(faraX?: number, faraY?: number): Promise<void> {
    let x = 0;
    let y = 0;
    if (faraX !== undefined && faraY !== undefined) {
      const scaled = await this.scaleFromFaraSpace(faraX, faraY);
      x = scaled.x;
      y = scaled.y;
      this.webContentsForInput.sendInputEvent({ type: "mouseMove", x, y });
      await this.focusAtViewportPoint(x, y);
    }
    this.webContentsForInput.sendInputEvent({
      type: "mouseDown",
      x,
      y,
      button: "left",
      clickCount: 1,
    });
    this.webContentsForInput.sendInputEvent({
      type: "mouseUp",
      x,
      y,
      button: "left",
      clickCount: 1,
    });
  }

  async typeText(text: string, faraX?: number, faraY?: number): Promise<void> {
    if (faraX !== undefined && faraY !== undefined) {
      await this.leftClick(faraX, faraY);
    }
    this.webContentsForInput.insertText(text);
  }

  async scroll(pixels: number): Promise<void> {
    const { width, height } = await this.getViewportSize();
    const x = Math.round(width / 2);
    const y = Math.round(height / 2);
    this.webContentsForInput.sendInputEvent({ type: "mouseMove", x, y });
    this.webContentsForInput.sendInputEvent({
      type: "mouseWheel",
      x,
      y,
      deltaX: 0,
      deltaY: pixels,
    });
  }

  async pressKeys(keys: string[]): Promise<void> {
    for (const key of keys) {
      const keyCode = mapDomKeyToElectron(key);
      this.webContentsForInput.sendInputEvent({ type: "keyDown", keyCode });
    }
    for (const key of [...keys].reverse()) {
      const keyCode = mapDomKeyToElectron(key);
      this.webContentsForInput.sendInputEvent({ type: "keyUp", keyCode });
    }
  }

  async waitForSettle(ms: number): Promise<void> {
    await this.waitForPageReady();
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
  }

  private async focusAtViewportPoint(x: number, y: number): Promise<void> {
    await this.runJs(
      `(() => {
        const el = document.elementFromPoint(${x}, ${y});
        if (el && typeof el.focus === 'function') el.focus();
      })()`,
    );
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

  async getTabHtml(): Promise<string> {
    return await this.runJs(
      `(() => {
        try {
          return document.documentElement?.outerHTML ?? '';
        } catch {
          return '';
        }
      })()`
    ) ?? "";
  }

  async getTabText(): Promise<string> {
    return await this.runJs(
      `(() => {
        try {
          return document.documentElement?.innerText ?? ''
        } catch {
          return '';
        }
      })()`
    ) ?? "";
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
    if (!this.webContentsView.webContents.navigationHistory.canGoForward()) return;
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

const DOM_KEY_TO_ELECTRON: Record<string, string> = {
  Enter: "Return",
  Return: "Return",
  Tab: "Tab",
  Escape: "Escape",
  Backspace: "Backspace",
  Delete: "Delete",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  PageUp: "PageUp",
  PageDown: "PageDown",
  Control: "Control",
  Alt: "Alt",
  Shift: "Shift",
};

const mapDomKeyToElectron = (key: string): string =>
  DOM_KEY_TO_ELECTRON[key] ?? key;
