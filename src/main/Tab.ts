import { NativeImage, WebContentsView } from "electron";

export class Tab {
  private webContentsView: WebContentsView;
  private _id: string;
  private _title: string;
  private _url: string;
  private _isVisible: boolean = false;

  constructor(id: string, url: string = "https://strawberrybrowser.com") {
    this._id = id;
    this._url = url;
    this._title = "Strawberry Browser";

    // Create the WebContentsView for web content only
    this.webContentsView = new WebContentsView({
      webPreferences: {
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
    });

    this.webContentsView.webContents.on("did-navigate-in-page", (_, url) => {
      this._url = url;
    });
  }

  // Getters
  get id(): string {
    return this._id;
  }

  get title(): string {
    return this._title;
  }

  get url(): string {
    return this._url;
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
    this.webContentsView.webContents.close();
  }
}
