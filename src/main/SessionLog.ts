import { appendFileSync, existsSync, readFileSync, renameSync } from "fs";
import { join } from "path";
import { app } from "electron";
import type { AppEvent, EventSink } from "./events";
import { createLogger } from "./logger";

const log = createLogger("session-log");

const isTabEvent = (e: AppEvent): boolean => e.source === "tab";

export interface SessionSummary {
  eventCount: number;
  uniqueUrls: number;
  startedAt: string | null;
}

export interface SessionLog {
  readonly sink: EventSink;
  tabEvents(): AppEvent[];
  recentTabEvents(max: number): AppEvent[];
  summary(): SessionSummary;
  clear(): void;
  readonly size: number;
}

const buildSummary = (events: AppEvent[]): SessionSummary => {
  const urls = new Set<string>();
  for (const e of events) {
    const url = (e.payload as { url?: string } | undefined)?.url;
    if (url) urls.add(url);
  }
  return {
    eventCount: events.length,
    uniqueUrls: urls.size,
    startedAt: events[0]?.timestamp ?? null,
  };
};

export class InMemorySessionLog implements SessionLog {
  private buffer: AppEvent[] = [];

  sink: EventSink = (event): void => {
    this.buffer.push(event);
  };

  tabEvents(): AppEvent[] {
    return this.buffer.filter(isTabEvent);
  }

  recentTabEvents(max: number): AppEvent[] {
    return this.tabEvents().slice(-max);
  }

  summary(): SessionSummary {
    return buildSummary(this.tabEvents());
  }

  clear(): void {
    this.buffer = [];
  }

  get size(): number {
    return this.buffer.length;
  }
}

const parseEvents = (raw: string): AppEvent[] =>
  raw
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as AppEvent];
      } catch {
        return [];
      }
    });

export class FileSessionLog implements SessionLog {
  private buffer: AppEvent[] = [];
  private readonly filePath: string;

  private constructor(filePath: string, initial: AppEvent[]) {
    this.filePath = filePath;
    this.buffer = initial;
  }

  static load(): FileSessionLog {
    const filePath = join(app.getPath("userData"), "session.ndjson");
    let initial: AppEvent[] = [];
    if (existsSync(filePath)) {
      try {
        initial = parseEvents(readFileSync(filePath, "utf8"));
      } catch (err) {
        log.warn({ err }, "could not load session from disk; starting fresh");
      }
    }
    return new FileSessionLog(filePath, initial);
  }

  sink: EventSink = (event): void => {
    this.buffer.push(event);
    try {
      appendFileSync(this.filePath, JSON.stringify(event) + "\n");
    } catch (err) {
      log.warn({ err }, "failed to append event to session file");
    }
  };

  tabEvents(): AppEvent[] {
    return this.buffer.filter(isTabEvent);
  }

  recentTabEvents(max: number): AppEvent[] {
    return this.tabEvents().slice(-max);
  }

  summary(): SessionSummary {
    return buildSummary(this.tabEvents());
  }

  clear(): void {
    this.buffer = [];
    try {
      if (existsSync(this.filePath)) {
        const archived = this.filePath.replace(
          ".ndjson",
          `-${Date.now()}.ndjson`,
        );
        renameSync(this.filePath, archived);
      }
    } catch (err) {
      log.warn({ err }, "failed to archive session file on clear");
    }
  }

  get size(): number {
    return this.buffer.length;
  }
}
