import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { app } from "electron";
import type { BehaviorGraph } from "./BehaviorGraph";
import { createLogger } from "../logger";

const log = createLogger("graph-store");

export class GraphStore {
  private readonly filePath: string;
  private store: Map<string, BehaviorGraph> = new Map();
  private activeId: string | null = null;

  constructor() {
    this.filePath = join(app.getPath("userData"), "graphs.json");
    this.load();
  }

  private load(): void {
    if (!existsSync(this.filePath)) return;
    try {
      const raw = readFileSync(this.filePath, "utf8");
      const data = JSON.parse(raw) as { activeId: string | null; graphs: BehaviorGraph[] };
      this.activeId = data.activeId ?? null;
      for (const g of data.graphs ?? []) {
        this.store.set(g.id, g);
      }
    } catch (err) {
      log.warn({ err }, "could not load graph store");
    }
  }

  private persist(): void {
    try {
      writeFileSync(
        this.filePath,
        JSON.stringify({ activeId: this.activeId, graphs: [...this.store.values()] }, null, 2),
      );
    } catch (err) {
      log.warn({ err }, "could not persist graph store");
    }
  }

  save(graph: BehaviorGraph): void {
    this.store.set(graph.id, graph);
    this.activeId = graph.id;
    this.persist();
  }

  byId(id: string): BehaviorGraph | null {
    return this.store.get(id) ?? null;
  }

  active(): BehaviorGraph | null {
    if (!this.activeId) return null;
    return this.store.get(this.activeId) ?? null;
  }

  list(): BehaviorGraph[] {
    return [...this.store.values()];
  }
}
