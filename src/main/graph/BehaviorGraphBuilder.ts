import { randomUUID } from "crypto";
import type { AppEvent } from "../events";
import { isSensitiveInputMeta } from "../events";
import {
  type BehaviorGraph,
  type PageNode,
  type ActionNode,
  type MotifMatch,
  type MotifInstance,
  createGraph,
} from "./BehaviorGraph";


const hostname = (url: string): string => {
  try { return new URL(url).hostname; } catch { return url; }
};

const pathSegments = (url: string): string[] => {
  try { return new URL(url).pathname.split("/").filter(Boolean); } catch { return []; }
};


const diffMs = (a: string, b: string): number => {
  try { return Math.abs(new Date(b).getTime() - new Date(a).getTime()); } catch { return 0; }
};

const str = (v: unknown): string => (typeof v === "string" ? v : "");

const elementSelector = (data: Record<string, unknown>): string => {
  if (str(data.id)) return `#${str(data.id)}`;
  if (str(data.name)) return `[name="${str(data.name)}"]`;
  const tag = str(data.tag); const type = str(data.type);
  return tag && type ? `${tag}[type="${type}"]` : tag || "unknown";
};

export class BehaviorGraphBuilder {
  static buildBehaviorGraph(events: AppEvent[]): BehaviorGraph {
    const graph = createGraph();

    for (const event of events) {
      const p = (event.payload ?? {}) as Record<string, unknown>;
      const url = str(p.url);

      if (event.type === "tab.navigation") {

        const pages = graph.nodes.filter((n): n is PageNode => n.kind === "page");
        const lastPage = pages.at(-1);

        // Collapse rapid same-URL duplicates (redirect chains, SPA hash changes)
        if (lastPage && lastPage.url === url && diffMs(lastPage.timestamp, event.timestamp) < 1000) {
          continue;
        }

        // Update dwell on previous page
        if (lastPage) {
          lastPage.dwellMs = diffMs(lastPage.timestamp, event.timestamp);
        }

        const node: PageNode = {
          kind: "page", id: randomUUID(),
          url, title: str(p.title),
          timestamp: event.timestamp, dwellMs: 0,
        };
        if (!graph.entryNodeId) graph.entryNodeId = node.id;
        if (graph.lastNodeId) graph.edges.push({ from: graph.lastNodeId, to: node.id });
        graph.nodes.push(node);
        graph.lastNodeId = node.id;

      } else if (event.type === "tab.click") {
        const data = (p.data ?? p) as Record<string, unknown>;
        const node: ActionNode = {
          kind: "action", id: randomUUID(), actionKind: "click",
          selector: elementSelector(data), sensitive: false,
          url, timestamp: event.timestamp,
        };
        if (graph.lastNodeId) graph.edges.push({ from: graph.lastNodeId, to: node.id });
        graph.nodes.push(node);
        graph.lastNodeId = node.id;

      } else if (event.type === "tab.input") {
        const data = (p.data ?? p) as Record<string, unknown>;
        if (isSensitiveInputMeta(data)) continue;
        const node: ActionNode = {
          kind: "action", id: randomUUID(), actionKind: "input",
          selector: elementSelector(data),
          valueHint: data.hasValue ? `[${data.valueLength ?? "?"}chars]` : undefined,
          sensitive: false, url, timestamp: event.timestamp,
        };
        if (graph.lastNodeId) graph.edges.push({ from: graph.lastNodeId, to: node.id });
        graph.nodes.push(node);
        graph.lastNodeId = node.id;
      }
    }

    detectMotifs(graph);
    return graph;
  }
}


const detectMotifs = (graph: BehaviorGraph): void => {
  const pages = graph.nodes.filter((n): n is PageNode => n.kind === "page");

  const collection = detectCollectionLoop(pages);
  if (collection) { graph.motifs.push(collection); return; }

  const research = detectResearchLoop(pages);
  if (research) graph.motifs.push(research);
};

/**
 * Collection loop: the same hostname appears multiple times with a single
 * path segment varying across visits (e.g. /alpha/a, /alpha/b, /alpha/c).
 * This is detected by finding a parametric URL template across repeated visits.
 */
const detectCollectionLoop = (pages: PageNode[]): MotifMatch | null => {
  const byHost = new Map<string, PageNode[]>();
  for (const p of pages) {
    const h = hostname(p.url);
    byHost.set(h, [...(byHost.get(h) ?? []), p]);
  }

  for (const [host, visits] of byHost) {
    if (visits.length < 2) continue;
    const paths = visits.map(v => pathSegments(v.url));
    const maxLen = Math.max(...paths.map(p => p.length));

    for (let pos = 0; pos < maxLen; pos++) {
      const values = paths.map(p => p[pos] ?? "").filter(Boolean);
      const unique = new Set(values);
      if (unique.size !== values.length || values.length < 2) continue;

      const templateSegs = (paths[0] ?? []).map((seg, i) => i === pos ? "{x}" : seg);
      const instances: MotifInstance[] = visits.map((v, i) => ({
        nodeIds: [v.id],
        paramValue: paths[i]?.[pos],
        complete: v.dwellMs > 2000,
      }));

      return {
        motif: "collection_loop",
        instances,
        periodDomains: [host],
        urlTemplate: `${host}/${templateSegs.join("/")}`,
        confidence: Math.min(0.5 + visits.length * 0.1, 0.95),
      };
    }
  }
  return null;
};

/**
 * Research loop: a search engine hub with multiple different external domains
 * opened from it (search → result A → back → result B → back → ...).
 */
const detectResearchLoop = (pages: PageNode[]): MotifMatch | null => {
  const externalHosts = new Set<string>();
  const instances: MotifInstance[] = [];
  let hubCount = 0;

  for (let i = 0; i < pages.length - 1; i++) {
    hubCount++;
    const extHost = hostname(pages[i + 1].url);
      externalHosts.add(extHost);
    instances.push({ nodeIds: [pages[i].id, pages[i + 1].id], paramValue: extHost, complete: true });
  }

  if (hubCount >= 2 && externalHosts.size >= 2) {
    return {
      motif: "research_loop",
      instances,
      periodDomains: [...externalHosts],
      confidence: Math.min(0.4 + externalHosts.size * 0.1, 0.9),
    };
  }
  return null;
};


export interface GraphSummary {
  pageCount: number;
  actionCount: number;
  openLoopCount: number;
  motif: string | null;
  likelyFinishAction: string | null;
  startUrl: string | null;
  lastUrl: string | null;
}

export const summarizeGraph = (graph: BehaviorGraph): GraphSummary => {
  const pages = graph.nodes.filter((n): n is PageNode => n.kind === "page");
  const actions = graph.nodes.filter((n): n is ActionNode => n.kind === "action");
  const topMotif = graph.motifs[0] ?? null;
  const lastAction = actions.at(-1) ?? null;
  const lastPage = pages.at(-1) ?? null;

  // An open loop exists when the last event is an action with no following page navigation
  const openLoopCount =
    lastAction && lastPage && lastAction.timestamp > lastPage.timestamp ? 1 : 0;

  return {
    pageCount: pages.length,
    actionCount: actions.length,
    openLoopCount,
    motif: topMotif?.motif ?? null,
    likelyFinishAction: lastAction ? `${lastAction.actionKind} ${lastAction.selector}` : null,
    startUrl: pages[0]?.url ?? null,
    lastUrl: lastPage?.url ?? null,
  };
};
