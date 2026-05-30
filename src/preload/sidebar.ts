import { contextBridge } from "electron";
import { electronAPI } from "@electron-toolkit/preload";

interface ChatRequest {
  message: string;
  context: {
    url: string | null;
    content: string | null;
    text: string | null;
  };
  messageId: string;
}

interface ChatResponse {
  messageId: string;
  content: string;
  isComplete: boolean;
}

interface GroundRequest {
  id: string;
  imageDataUrl: string;
  description: string;
  output: "box" | "point";
}

interface GroundResultMessage {
  id: string;
  result: {
    point?: { x: number; y: number };
    box?: { x1: number; y1: number; x2: number; y2: number };
  } | null;
  error?: string;
}

// Sidebar specific APIs
const sidebarAPI = {
  // Chat functionality
  sendChatMessage: (request: Partial<ChatRequest>) =>
    electronAPI.ipcRenderer.invoke("sidebar-chat-message", request),

  clearChat: () => electronAPI.ipcRenderer.invoke("sidebar-clear-chat"),

  getMessages: () => electronAPI.ipcRenderer.invoke("sidebar-get-messages"),

  onChatResponse: (callback: (data: ChatResponse) => void) => {
    electronAPI.ipcRenderer.on("chat-response", (_, data) => callback(data));
  },

  onMessagesUpdated: (callback: (messages: any[]) => void) => {
    electronAPI.ipcRenderer.on("chat-messages-updated", (_, messages) =>
      callback(messages),
    );
  },

  removeChatResponseListener: () => {
    electronAPI.ipcRenderer.removeAllListeners("chat-response");
  },

  removeMessagesUpdatedListener: () => {
    electronAPI.ipcRenderer.removeAllListeners("chat-messages-updated");
  },

  // Visual grounding (runs in this renderer via WebGPU)
  onGroundRequest: (callback: (req: GroundRequest) => void) => {
    electronAPI.ipcRenderer.on("ground:request", (_, req) => callback(req));
  },
  sendGroundResult: (payload: GroundResultMessage) =>
    electronAPI.ipcRenderer.send("ground:result", payload),

  // Page content access
  getPageText: () => electronAPI.ipcRenderer.invoke("get-page-text"),
  getCurrentUrl: () => electronAPI.ipcRenderer.invoke("get-current-url"),

  // Tab information
  getActiveTabInfo: () => electronAPI.ipcRenderer.invoke("get-active-tab-info"),

  // Workflow / session compiler
  getSessionSummary: () =>
    electronAPI.ipcRenderer.invoke("workflow-session-summary"),
  getSessionEvents: () =>
    electronAPI.ipcRenderer.invoke("workflow-session-events"),
  compileWorkflow: () =>
    electronAPI.ipcRenderer.invoke("workflow-compile"),
  clearSession: () =>
    electronAPI.ipcRenderer.invoke("workflow-clear-session"),

  // NightGraph
  buildGraph: () =>
    electronAPI.ipcRenderer.invoke("workflow-build-graph"),
  getGraphSummary: () =>
    electronAPI.ipcRenderer.invoke("workflow-get-graph-summary"),
  compileTaskPacket: () =>
    electronAPI.ipcRenderer.invoke("workflow-compile-task-packet"),
  startNightAgent: (packetId?: string) =>
    electronAPI.ipcRenderer.invoke("workflow-start-night-agent", { packetId }),
  stopNightAgent: () =>
    electronAPI.ipcRenderer.invoke("workflow-stop-night-agent"),
  getAgentMode: () =>
    electronAPI.ipcRenderer.invoke("workflow-get-agent-mode"),
};

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld("electron", electronAPI);
    contextBridge.exposeInMainWorld("sidebarAPI", sidebarAPI);
  } catch (error) {
    console.error("Failed to expose sidebar preload APIs", error);
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI;
  // @ts-ignore (define in dts)
  window.sidebarAPI = sidebarAPI;
}
