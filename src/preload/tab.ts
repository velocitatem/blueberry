import { contextBridge, ipcRenderer } from "electron";

const ALLOWED_OUTGOING = new Set(["tab-action"]);

const tabBridge = {
  send: (channel: string, payload: unknown): void => {
    if (!ALLOWED_OUTGOING.has(channel)) return;
    try {
      ipcRenderer.send(channel, payload);
    } catch {
      // Page contexts can be torn down between send and receive; ignore.
    }
  },
};

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld("__blueberryBridge", tabBridge);
  } catch (error) {
    console.error("Failed to expose tab bridge", error);
  }
} else {
  // @ts-ignore
  window.__blueberryBridge = tabBridge;
}
