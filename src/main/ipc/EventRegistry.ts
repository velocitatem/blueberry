import { ipcMain, IpcMainEvent, IpcMainInvokeEvent } from "electron";

export type InvokeHandler = (
  event: IpcMainInvokeEvent,
  ...args: unknown[]
) => unknown | Promise<unknown>;

export type ListenerHandler = (
  event: IpcMainEvent,
  ...args: unknown[]
) => void;

export class EventRegistry {
  private readonly invokeChannels = new Set<string>();
  private readonly listenerChannels = new Map<string, ListenerHandler>();

  handle(channel: string, handler: InvokeHandler): void {
    if (this.invokeChannels.has(channel)) throw new Error(`IPC invoke handler already registered: ${channel}`);

    ipcMain.handle(channel, handler);
    this.invokeChannels.add(channel);
  }

  on(channel: string, handler: ListenerHandler): void {
    if (this.listenerChannels.has(channel)) throw new Error(`IPC listener already registered: ${channel}`);

    ipcMain.on(channel, handler);
    this.listenerChannels.set(channel, handler);
  }

  handleMany(handlers: Record<string, InvokeHandler>): void {
    for (const [channel, handler] of Object.entries(handlers)) {
      this.handle(channel, handler);
    }
  }

  onMany(listeners: Record<string, ListenerHandler>): void {
    for (const [channel, listener] of Object.entries(listeners)) {
      this.on(channel, listener);
    }
  }

  cleanup(): void {
    for (const channel of this.invokeChannels) 
      ipcMain.removeHandler(channel);

    for (const [channel, handler] of this.listenerChannels) 
      ipcMain.off(channel, handler);

    this.invokeChannels.clear();
    this.listenerChannels.clear();
  }
}
