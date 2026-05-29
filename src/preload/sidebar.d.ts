import { ElectronAPI } from "@electron-toolkit/preload";

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

interface TabInfo {
  id: string;
  title: string;
  url: string;
  isActive: boolean;
}

interface SessionSummary {
  eventCount: number;
  uniqueUrls: number;
  startedAt: string | null;
}

interface SessionEventView {
  id: string;
  type: string;
  tabId: string;
  timestamp: string;
  payload: Record<string, unknown>;
}

interface CompiledWorkflow {
  goal: string;
  steps: string[];
  extractedEntities: string[];
  automationPrompt: string;
  riskLevel: "low" | "medium" | "high";
  riskWarnings: string[];
  repeatabilityScore: number;
  rawJson?: string;
}

type CompileResult =
  | { ok: true; workflow: CompiledWorkflow }
  | { ok: false; error: string };

interface GraphSummaryData {
  pageCount: number;
  actionCount: number;
  entityCount: number;
  openLoopCount: number;
  likelyFinishAction: string | null;
  startUrl: string | null;
  lastUrl: string | null;
}

type BuildGraphResult =
  | { ok: true; graphId: string; summary: GraphSummaryData }
  | { ok: false; error: string };

type GraphSummaryResult =
  | { ok: true; graphId: string; summary: GraphSummaryData }
  | { ok: false; error: string };

type CompilePacketResult =
  | { ok: true; packetId: string; goal: string }
  | { ok: false; error: string };

type StartNightResult =
  | { ok: true; packetId: string }
  | { ok: false; error: string };

interface SidebarAPI {
  // Chat functionality
  sendChatMessage: (request: ChatRequest) => Promise<void>;
  onChatResponse: (callback: (data: ChatResponse) => void) => void;
  removeChatResponseListener: () => void;

  // Page content access
  getPageContent: () => Promise<string | null>;
  getPageText: () => Promise<string | null>;
  getCurrentUrl: () => Promise<string | null>;

  // Tab information
  getActiveTabInfo: () => Promise<TabInfo | null>;

  // Workflow / session compiler
  getSessionSummary: () => Promise<SessionSummary>;
  getSessionEvents: () => Promise<SessionEventView[]>;
  compileWorkflow: () => Promise<CompileResult>;
  clearSession: () => Promise<{ ok: true }>;

  // NightGraph
  buildGraph: () => Promise<BuildGraphResult>;
  getGraphSummary: () => Promise<GraphSummaryResult>;
  compileTaskPacket: () => Promise<CompilePacketResult>;
  startNightAgent: (packetId?: string) => Promise<StartNightResult>;
  stopNightAgent: () => Promise<{ ok: true }>;
  getAgentMode: () => Promise<{ mode: "normal" | "night" }>;
}

declare global {
  interface Window {
    electron: ElectronAPI;
    sidebarAPI: SidebarAPI;
  }
}

