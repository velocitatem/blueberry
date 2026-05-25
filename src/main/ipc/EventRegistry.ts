import { ipcMain, IpcMainEvent, IpcMainInvokeEvent } from "electron";
import { createIpcEvent, type EventSink } from "../events";
import { createLogger } from "../logger";

const log = createLogger("ipc");

export type InvokeHandler = (
  event: IpcMainInvokeEvent,
  ...args: unknown[]
) => unknown | Promise<unknown>;
export type ListenerHandler = (event: IpcMainEvent, ...args: unknown[]) => void;

export class EventRegistry {
  private readonly invokeChannels = new Set<string>();
  private readonly listenerChannels = new Map<string, ListenerHandler>();

  constructor(private readonly eventSink?: EventSink) {}

  private emitEvent = (event: ReturnType<typeof createIpcEvent>): void =>
    this.eventSink &&
    void Promise.resolve(this.eventSink(event)).catch((error) =>
      log.error({ err: error }, "Failed to publish IPC event")
    );

  private trackInvoke =
    (channel: string, handler: InvokeHandler): InvokeHandler =>
    async (event, ...args) => {
      const startedAt = Date.now();
      try {
        const result = await handler(event, ...args);
        this.emitEvent(createIpcEvent({ channel, status: "completed", kind: "invoke", args, startedAt }));
        return result;
      } catch (error) {
        this.emitEvent(createIpcEvent({ channel, status: "failed", kind: "invoke", args, startedAt, error }));
        throw error;
      }
    };

  private trackListener =
    (channel: string, listener: ListenerHandler): ListenerHandler =>
    (event, ...args) => {
      const startedAt = Date.now();
      try {
        listener(event, ...args);
        this.emitEvent(createIpcEvent({ channel, status: "received", kind: "listener", args, startedAt }));
      } catch (error) {
        this.emitEvent(createIpcEvent({ channel, status: "failed", kind: "listener", args, startedAt, error }));
        throw error;
      }
    };

  handle(channel: string, handler: InvokeHandler): void {
    if (this.invokeChannels.has(channel))
      throw new Error(`IPC invoke handler already registered: ${channel}`);
    ipcMain.handle(channel, this.trackInvoke(channel, handler));
    this.invokeChannels.add(channel);
  }

  on(channel: string, handler: ListenerHandler): void {
    if (this.listenerChannels.has(channel))
      throw new Error(`IPC listener already registered: ${channel}`);
    const trackedHandler = this.trackListener(channel, handler);
    ipcMain.on(channel, trackedHandler);
    this.listenerChannels.set(channel, trackedHandler);
  }

  handleMany(handlers: Record<string, InvokeHandler>): void {
    Object.entries(handlers).forEach(([channel, handler]) => this.handle(channel, handler));
  }

  onMany(listeners: Record<string, ListenerHandler>): void {
    Object.entries(listeners).forEach(([channel, listener]) => this.on(channel, listener));
  }

  cleanup(): void {
    this.invokeChannels.forEach((channel) => ipcMain.removeHandler(channel));
    this.listenerChannels.forEach((handler, channel) => ipcMain.off(channel, handler));
    this.invokeChannels.clear();
    this.listenerChannels.clear();
  }
}
