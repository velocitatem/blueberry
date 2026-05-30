import { ipcMain, type IpcMainEvent, type WebContents } from "electron";
import { randomUUID } from "crypto";
import { createLogger } from "../logger";
import type { Grounder, GroundRequest, GroundResult } from "./Grounder";

const log = createLogger("grounder");
const REQUEST_CHANNEL = "ground:request";
const RESULT_CHANNEL = "ground:result";

interface GroundResultMessage {
  id: string;
  result: GroundResult | null;
  error?: string;
}

/**
 * Main-process proxy for the sidebar WebGPU grounder.
 *
 * The sidebar renderer owns WebGPU/model execution; main owns screenshots and
 * clicks. This class keeps those boundaries explicit and correlates IPC replies.
 */
export class WebGpuGrounder implements Grounder {
  private readonly pending = new Map<
    string,
    {
      resolve: (result: GroundResult | null) => void;
      timer: NodeJS.Timeout;
    }
  >();

  private readonly resultListener = (
    event: IpcMainEvent,
    payload: GroundResultMessage,
  ): void => {
    if (event.sender !== this.webContents) return;
    const request = this.pending.get(payload?.id);
    if (!request) return;

    clearTimeout(request.timer);
    this.pending.delete(payload.id);

    if (payload.error) {
      log.warn({ error: payload.error }, "webgpu grounding failed");
      request.resolve(null);
      return;
    }

    request.resolve(payload.result ?? null);
  };

  constructor(
    private readonly webContents: WebContents,
    private readonly timeoutMs = 30_000,
  ) {
    ipcMain.on(RESULT_CHANNEL, this.resultListener);
    this.webContents.once("destroyed", () => this.dispose());
  }

  async ground(req: GroundRequest): Promise<GroundResult | null> {
    if (this.webContents.isDestroyed()) return null;

    const id = randomUUID();
    return await new Promise<GroundResult | null>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        log.warn({ id }, "webgpu grounding timed out");
        resolve(null);
      }, this.timeoutMs);

      this.pending.set(id, { resolve, timer });
      this.webContents.send(REQUEST_CHANNEL, { ...req, id });
    });
  }

  dispose(): void {
    ipcMain.off(RESULT_CHANNEL, this.resultListener);
    for (const [id, request] of this.pending) {
      clearTimeout(request.timer);
      this.pending.delete(id);
      request.resolve(null);
    }
  }
}
