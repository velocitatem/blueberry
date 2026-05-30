import { randomUUID } from "crypto";
import type { AppEvent } from "../events";
import { isSensitiveInputMeta } from "../events";
import {
  type BehaviorGraph,
  type GraphNode,
  type PageNode,
  type ActionNode,
  type NodeScore,
  type Pattern,
  type OpenLoop,
  createGraph,
} from "./BehaviorGraph";

/**
 * Every tunable lives here, not scattered as magic numbers, and none of it is
 * keyed to a specific site or task. Weights express *what kind of behavior
 * signals intent*; thresholds express *how much* — both can be tuned without
 * touching the logic, which keeps the system general rather than overfit.
 */
export interface ScoringConfig {
  weights: {
    dwellPerSec: number;
    revisit: number;
    input: number;
    outboundDomain: number;
  };
  /** Visits shorter than this are glances, not engagement. */
  glanceDwellMs: number;
  /** Minimum repeats for a parametric template to register as a pattern. */
  minPatternRepeats: number;
  /** Same-URL navigations closer together than this are collapsed (redirects/SPA). */
  dedupeWindowMs: number;
}

export const defaultScoringConfig = (): ScoringConfig => ({
  weights: { dwellPerSec: 1, revisit: 3, input: 5, outboundDomain: 2 },
  glanceDwellMs: 2000,
  minPatternRepeats: 2,
  dedupeWindowMs: 1000,
});

const hostname = (url: string): string => {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
};

const pathSegments = (url: string): string[] => {
  try {
    return new URL(url).pathname.split("/").filter(Boolean);
  } catch {
    return [];
  }
};

const diffMs = (a: string, b: string): number => {
  try {
    return Math.abs(new Date(b).getTime() - new Date(a).getTime());
  } catch {
    return 0;
  }
};

const str = (v: unknown): string => (typeof v === "string" ? v : "");

const elementSelector = (data: Record<string, unknown>): string => {
  if (str(data.id)) return `#${str(data.id)}`;
  if (str(data.name)) return `[name="${str(data.name)}"]`;
  const tag = str(data.tag);
  const type = str(data.type);
  return tag && type ? `${tag}[type="${type}"]` : tag || "unknown";
};

const isPage = (n: GraphNode): n is PageNode => n.kind === "page";
const isAction = (n: GraphNode): n is ActionNode => n.kind === "action";

export class BehaviorGraphBuilder {
  static buildBehaviorGraph(
    events: AppEvent[],
    config: ScoringConfig = defaultScoringConfig(),
  ): BehaviorGraph {
    const graph = createGraph();

    for (const event of events) {
      const p = (event.payload ?? {}) as Record<string, unknown>;
      const url = str(p.url);

      if (event.type === "tab.navigation") {
        const pages = graph.nodes.filter(isPage);
        const lastPage = pages.at(-1);

        // Collapse rapid same-URL duplicates (redirect chains, SPA hash changes)
        if (
          lastPage &&
          lastPage.url === url &&
          diffMs(lastPage.timestamp, event.timestamp) < config.dedupeWindowMs
        ) {
          continue;
        }

        // Close out dwell on the previous page
        if (lastPage)
          lastPage.dwellMs = diffMs(lastPage.timestamp, event.timestamp);

        const node: PageNode = {
          kind: "page",
          id: randomUUID(),
          url,
          title: str(p.title),
          timestamp: event.timestamp,
          dwellMs: 0,
        };
        if (!graph.entryNodeId) graph.entryNodeId = node.id;
        if (graph.lastNodeId)
          graph.edges.push({ from: graph.lastNodeId, to: node.id });
        graph.nodes.push(node);
        graph.lastNodeId = node.id;
      } else if (event.type === "tab.click" || event.type === "tab.input") {
        const data = (p.data ?? p) as Record<string, unknown>;
        if (event.type === "tab.input" && isSensitiveInputMeta(data)) continue;

        const node: ActionNode = {
          kind: "action",
          id: randomUUID(),
          actionKind: event.type === "tab.input" ? "input" : "click",
          selector: elementSelector(data),
          valueHint: data.hasValue
            ? `[${data.valueLength ?? "?"}chars]`
            : undefined,
          sensitive: false,
          url,
          timestamp: event.timestamp,
        };
        if (graph.lastNodeId)
          graph.edges.push({ from: graph.lastNodeId, to: node.id });
        graph.nodes.push(node);
        graph.lastNodeId = node.id;
      }
    }

    analyze(graph, config);
    return graph;
  }
}

/** Attribute each action to the page that was open when it happened. */
const actionsByPage = (nodes: GraphNode[]): Map<string, ActionNode[]> => {
  const map = new Map<string, ActionNode[]>();
  let current: PageNode | null = null;
  for (const n of nodes) {
    if (isPage(n)) current = n;
    else if (current) map.set(current.id, [...(map.get(current.id) ?? []), n]);
  }
  return map;
};

const analyze = (graph: BehaviorGraph, config: ScoringConfig): void => {
  const pages = graph.nodes.filter(isPage);
  const actions = actionsByPage(graph.nodes);
  graph.scores = scorePages(pages, actions, config);
  graph.patterns = detectPatterns(pages, config);
  graph.openLoops = detectOpenLoops(pages, actions, graph.scores);
};

interface PageStat {
  url: string;
  rep: PageNode;
  visits: number;
  dwellMs: number;
  inputs: number;
  outbound: Set<string>;
}

const scorePages = (
  pages: PageNode[],
  actions: Map<string, ActionNode[]>,
  config: ScoringConfig,
): NodeScore[] => {
  const stats = new Map<string, PageStat>();

  for (const p of pages) {
    const s = stats.get(p.url) ?? {
      url: p.url,
      rep: p,
      visits: 0,
      dwellMs: 0,
      inputs: 0,
      outbound: new Set<string>(),
    };
    s.visits += 1;
    s.dwellMs += p.dwellMs;
    if (p.dwellMs > s.rep.dwellMs) s.rep = p;
    s.inputs += (actions.get(p.id) ?? []).filter(
      (a) => a.actionKind === "input",
    ).length;
    stats.set(p.url, s);
  }

  // Cross-domain bridges: a page that leads somewhere new is a hub worth keeping.
  for (let i = 0; i < pages.length - 1; i++) {
    const from = pages[i],
      to = pages[i + 1];
    const fh = hostname(from.url),
      th = hostname(to.url);
    if (fh !== th) stats.get(from.url)?.outbound.add(th);
  }

  const w = config.weights;
  return [...stats.values()]
    .map((s) => ({
      nodeId: s.rep.id,
      url: s.url,
      salience: round(
        (s.dwellMs / 1000) * w.dwellPerSec +
          (s.visits - 1) * w.revisit +
          s.inputs * w.input +
          s.outbound.size * w.outboundDomain,
      ),
      signals: {
        dwellMs: s.dwellMs,
        visits: s.visits,
        inputs: s.inputs,
        outboundDomains: s.outbound.size,
      },
    }))
    .sort((a, b) => b.salience - a.salience);
};

/**
 * Find a host visited several times where exactly one path segment varies and
 * the rest stay fixed — a parametric workflow the user iterated over. Works for
 * any site; nothing about the host or task is hardcoded.
 */
const detectPatterns = (
  pages: PageNode[],
  config: ScoringConfig,
): Pattern[] => {
  const byHost = new Map<string, PageNode[]>();
  for (const p of pages)
    byHost.set(hostname(p.url), [...(byHost.get(hostname(p.url)) ?? []), p]);

  const patterns: Pattern[] = [];
  for (const [host, visits] of byHost) {
    if (visits.length < config.minPatternRepeats) continue;
    const paths = visits.map((v) => pathSegments(v.url));
    const len = paths[0].length;
    if (!paths.every((p) => p.length === len) || len === 0) continue;

    for (let pos = 0; pos < len; pos++) {
      const values = paths.map((p) => p[pos]);
      const varies = new Set(values).size === values.length;
      const restFixed = paths.every((p) =>
        p.every((seg, i) => i === pos || seg === paths[0][i]),
      );
      if (!varies || !restFixed) continue;

      patterns.push({
        template: `${host}/${paths[0].map((seg, i) => (i === pos ? "{x}" : seg)).join("/")}`,
        domain: host,
        instances: visits.map((v, i) => ({
          nodeId: v.id,
          param: paths[i][pos],
          engaged: v.dwellMs >= config.glanceDwellMs,
        })),
        confidence: Math.min(0.5 + visits.length * 0.1, 0.95),
      });
      break;
    }
  }
  return patterns.sort((a, b) => b.confidence - a.confidence);
};

/**
 * A page is an open loop when the user typed into it but never navigated onward
 * (last page, or the next navigation stayed on the same URL). Generalizes
 * "form started, not submitted" and "search with no follow-through" without
 * naming either.
 */
const detectOpenLoops = (
  pages: PageNode[],
  actions: Map<string, ActionNode[]>,
  scores: NodeScore[],
): OpenLoop[] => {
  const salienceByUrl = new Map(scores.map((s) => [s.url, s.salience]));
  const seen = new Set<string>();
  const loops: OpenLoop[] = [];

  for (let i = 0; i < pages.length; i++) {
    const p = pages[i];
    const inputs = (actions.get(p.id) ?? []).filter(
      (a) => a.actionKind === "input",
    );
    if (inputs.length === 0 || seen.has(p.url)) continue;

    const next = pages[i + 1] ?? null;
    if (next && next.url !== p.url) continue; // navigated on → closed

    seen.add(p.url);
    loops.push({
      nodeId: p.id,
      url: p.url,
      title: p.title,
      salience: salienceByUrl.get(p.url) ?? 0,
      evidence: `${inputs.length} input(s) with no follow-on navigation`,
    });
  }
  return loops.sort((a, b) => b.salience - a.salience);
};

const round = (n: number): number => Math.round(n * 100) / 100;

export interface GraphSummary {
  pageCount: number;
  actionCount: number;
  openLoopCount: number;
  topPattern: string | null;
  topSalientUrl: string | null;
  likelyFinishAction: string | null;
  startUrl: string | null;
  lastUrl: string | null;
}

export const summarizeGraph = (graph: BehaviorGraph): GraphSummary => {
  const pages = graph.nodes.filter(isPage);
  const actions = graph.nodes.filter(isAction);
  const lastAction = actions.at(-1) ?? null;

  return {
    pageCount: pages.length,
    actionCount: actions.length,
    openLoopCount: graph.openLoops.length,
    topPattern: graph.patterns[0]?.template ?? null,
    topSalientUrl: graph.scores[0]?.url ?? null,
    likelyFinishAction: lastAction
      ? `${lastAction.actionKind} ${lastAction.selector}`
      : null,
    startUrl: pages[0]?.url ?? null,
    lastUrl: pages.at(-1)?.url ?? null,
  };
};
