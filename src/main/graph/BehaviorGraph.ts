import { randomUUID } from "crypto";

export interface PageNode {
  kind: "page";
  id: string;
  url: string;
  title: string;
  timestamp: string;
  dwellMs: number;
}

export interface ActionNode {
  kind: "action";
  id: string;
  actionKind: "click" | "input";
  selector: string;
  valueHint?: string;
  sensitive: boolean;
  url: string;
  timestamp: string;
}

export type GraphNode = PageNode | ActionNode;

export interface GraphEdge {
  from: string;
  to: string;
}

export type TaskMotif =
  | "collection_loop"
  | "research_loop"
  | "form_transaction"
  | "unknown";

export interface MotifInstance {
  nodeIds: string[];
  paramValue?: string;
  complete: boolean;
}

export interface MotifMatch {
  motif: TaskMotif;
  instances: MotifInstance[];
  periodDomains: string[];
  urlTemplate?: string;
  confidence: number;
}

export interface BehaviorGraph {
  id: string;
  startedAt: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  entryNodeId: string | null;
  lastNodeId: string | null;
  motifs: MotifMatch[];
}

export const createGraph = (): BehaviorGraph => ({
  id: randomUUID(),
  startedAt: new Date().toISOString(),
  nodes: [],
  edges: [],
  entryNodeId: null,
  lastNodeId: null,
  motifs: [],
});
