import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { app } from "electron";
import { generateText, type LanguageModel } from "ai";
import { randomUUID } from "crypto";
import type { BehaviorGraph, PageNode } from "./graph/BehaviorGraph";
import { summarizeGraph } from "./graph/BehaviorGraphBuilder";
import { createLogger } from "./logger";

const log = createLogger("task-compiler");

export interface ReplayStep {
  stepId: string;
  intent: string;
  preferredTool: string;
  successCheck: string;
}

export interface TaskPacket {
  id: string;
  graphId: string;
  compiledAt: string;
  goal: string;
  summary: string;
  motif: string | null;
  entities: Array<{ name: string; value: string; sensitive: boolean }>;
  replayPlan: ReplayStep[];
  openLoops: string[];
  riskPolicy: {
    requiresConfirmationBefore: string[];
    neverAutonomouslyDo: string[];
  };
}

const SYSTEM_PROMPT = [
  "You analyze a browser session digest and produce a structured task packet for an AI agent to continue the workflow.",
  "Respond with ONLY a JSON object matching this schema (no markdown fences):",
  "{",
  '  "goal": string,',
  '  "summary": string,',
  '  "entities": [{ "name": string, "value": string, "sensitive": boolean }],',
  '  "replayPlan": [{ "stepId": string, "intent": string, "preferredTool": string, "successCheck": string }],',
  '  "openLoops": string[],',
  '  "riskPolicy": { "requiresConfirmationBefore": string[], "neverAutonomouslyDo": string[] }',
  "}",
].join("\n");

const stripJsonFence = (text: string): string => {
  const m = text.trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return m ? m[1].trim() : text.trim();
};

const hostname = (url: string): string => {
  try { return new URL(url).hostname; } catch { return url; }
};

const buildDigest = (graph: BehaviorGraph): string => {
  const pages = graph.nodes.filter((n): n is PageNode => n.kind === "page");
  const topMotif = graph.motifs[0];
  const lines: string[] = [];

  if (topMotif) {
    lines.push(`Detected motif: ${topMotif.motif} (confidence ${Math.round(topMotif.confidence * 100)}%)`);
    if (topMotif.urlTemplate) lines.push(`URL template: ${topMotif.urlTemplate}`);
    const complete = topMotif.instances.filter(i => i.complete).map(i => i.paramValue).filter(Boolean);
    const incomplete = topMotif.instances.filter(i => !i.complete).map(i => i.paramValue).filter(Boolean);
    if (complete.length) lines.push(`Completed iterations: ${complete.join(", ")}`);
    if (incomplete.length) lines.push(`Incomplete iterations: ${incomplete.join(", ")}`);
    lines.push(`Domains visited: ${topMotif.periodDomains.join(", ")}`);
  }

  // Compact domain-level breadcrumb (deduplicated consecutive)
  const domainSeq: string[] = [];
  for (const p of pages) {
    const h = hostname(p.url);
    if (domainSeq.at(-1) !== h) domainSeq.push(h);
  }
  lines.push("", `Domain path: ${domainSeq.join(" → ")}`);

  // Meaningful page titles (unique, non-search-engine, max 10)
  const meaningfulTitles = pages
    .filter(p => p.title && !["google.com", "www.google.com"].includes(hostname(p.url)))
    .map(p => p.title)
    .filter((t, i, arr) => arr.indexOf(t) === i)
    .slice(0, 10);
  if (meaningfulTitles.length) {
    lines.push("", "Key pages:", ...meaningfulTitles.map(t => `  - ${t}`));
  }

  return lines.join("\n");
};

export class TaskGraphCompiler {
  constructor(private readonly model: LanguageModel | null) {}

  async compile(graph: BehaviorGraph): Promise<TaskPacket> {
    if (!this.model) throw new Error("LLM not configured.");

    const digest = buildDigest(graph);
    const result = await generateText({
      model: this.model,
      system: SYSTEM_PROMPT,
      prompt: `Session digest:\n${digest}\n\nProduce the TaskPacket JSON.`,
      temperature: 0.2,
      maxRetries: 2,
    });

    const raw = stripJsonFence(result.text);
    try {
      const parsed = JSON.parse(raw) as Omit<TaskPacket, "id" | "graphId" | "compiledAt" | "motif">;
      return {
        id: randomUUID(),
        graphId: graph.id,
        compiledAt: new Date().toISOString(),
        motif: graph.motifs[0]?.motif ?? null,
        ...parsed,
      };
    } catch (err) {
      log.error({ err, raw }, "Failed to parse task packet JSON");
      throw new Error("Task compiler returned malformed JSON.");
    }
  }
}

export class PacketStore {
  private readonly filePath: string;
  private store: Map<string, TaskPacket> = new Map();

  constructor() {
    this.filePath = join(app.getPath("userData"), "packets.json");
    this.load();
  }

  private load(): void {
    if (!existsSync(this.filePath)) return;
    try {
      const packets = JSON.parse(readFileSync(this.filePath, "utf8")) as TaskPacket[];
      for (const p of packets) this.store.set(p.id, p);
    } catch (err) {
      log.warn({ err }, "could not load packet store");
    }
  }

  private persist(): void {
    try {
      writeFileSync(this.filePath, JSON.stringify([...this.store.values()], null, 2));
    } catch (err) {
      log.warn({ err }, "could not persist packet store");
    }
  }

  save(packet: TaskPacket): void { this.store.set(packet.id, packet); this.persist(); }
  byId(id: string): TaskPacket | null { return this.store.get(id) ?? null; }
  byGraphId(graphId: string): TaskPacket | null {
    for (const p of this.store.values()) if (p.graphId === graphId) return p;
    return null;
  }
}
