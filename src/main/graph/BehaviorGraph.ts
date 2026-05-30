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

/**
 * Per-page engagement signals derived purely from the event stream — no
 * site-specific or task-specific rules. Salience ranks which pages actually
 * mattered so downstream stages can ignore noise.
 */
export interface NodeScore {
  nodeId: string;
  url: string;
  salience: number;
  signals: {
    dwellMs: number;
    visits: number;
    inputs: number;
    outboundDomains: number;
  };
}

/**
 * A repeated, parametric navigation template (e.g. `host/items/{x}`) inferred
 * from revisits where exactly one URL segment varies while the rest stay fixed.
 * Domain-agnostic: it describes structure, not a named workflow.
 */
export interface Pattern {
  template: string;
  domain: string;
  instances: Array<{ nodeId: string; param?: string; engaged: boolean }>;
  confidence: number;
}

/**
 * Engagement that did not reach closure: a page the user typed into with no
 * subsequent navigation away. A generic structural signal of unfinished work,
 * not a hardcoded "form" or "email" rule.
 */
export interface OpenLoop {
  nodeId: string;
  url: string;
  title: string;
  salience: number;
  evidence: string;
}

export interface BehaviorGraph {
  id: string;
  startedAt: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  entryNodeId: string | null;
  lastNodeId: string | null;
  scores: NodeScore[];
  patterns: Pattern[];
  openLoops: OpenLoop[];
}

export const createGraph = (): BehaviorGraph => ({
  id: randomUUID(),
  startedAt: new Date().toISOString(),
  nodes: [],
  edges: [],
  entryNodeId: null,
  lastNodeId: null,
  scores: [],
  patterns: [],
  openLoops: [],
});
