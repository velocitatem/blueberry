import type { AppEvent, EventSink } from "./events";

const DEFAULT_CAPACITY = 500;

export class EventTail {
  private readonly capacity: number;
  private buffer: AppEvent[] = [];

  constructor(capacity: number = DEFAULT_CAPACITY) {
    this.capacity = capacity;
  }

  sink: EventSink = (event: AppEvent): void => {
    this.buffer.push(event);
    if (this.buffer.length > this.capacity) {
      this.buffer.splice(0, this.buffer.length - this.capacity);
    }
  };

  snapshot(filter?: (event: AppEvent) => boolean): AppEvent[] {
    return filter ? this.buffer.filter(filter) : [...this.buffer];
  }

  clear(): void {
    this.buffer = [];
  }

  get size(): number {
    return this.buffer.length;
  }
}

export const composeSinks = (...sinks: EventSink[]): EventSink =>
  (event: AppEvent) => {
    for (const sink of sinks) {
      void Promise.resolve(sink(event)).catch(() => undefined);
    }
  };
