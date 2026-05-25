import { randomUUID } from "crypto";

export type AppEventStatus = "completed" | "failed" | "received";

export type AppEvent = {
  id: string;
  type: string;
  source: "ipc";
  channel: string;
  status: AppEventStatus;
  timestamp: string;
  durationMs?: number;
  payload?: Record<string, unknown>;
  error?: string;
};

export type EventSink = (event: AppEvent) => void | Promise<void>;

type IpcEventInput = {
  channel: string;
  status: AppEventStatus;
  kind: "invoke" | "listener";
  args: unknown[];
  startedAt: number;
  error?: unknown;
};

const MAX_STRING_LENGTH = 1000;
const MAX_ARRAY_LENGTH = 20;
const MAX_OBJECT_KEYS = 20;

const truncate = (value: string): string =>
  value.length > MAX_STRING_LENGTH
    ? `${value.slice(0, MAX_STRING_LENGTH)}...`
    : value;

const getErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const toEventValue = (
  value: unknown,
  seen = new WeakSet<object>(),
): unknown => {
  if (value === null || value === undefined) return value;

  if (typeof value === "string") return truncate(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function" || typeof value === "symbol")
    return String(value);

  if (value instanceof Error)
    return { message: value.message, name: value.name };

  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_ARRAY_LENGTH)
      .map((item) => toEventValue(item, seen));
  }

  if (typeof value === "object") {
    if (seen.has(value)) return "[Circular]";
    seen.add(value);

    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, MAX_OBJECT_KEYS)
        .map(([key, item]) => [key, toEventValue(item, seen)]),
    );
  }

  return String(value);
};

export const createIpcEvent = ({
  channel,
  status,
  kind,
  args,
  startedAt,
  error,
}: IpcEventInput): AppEvent => ({
  id: randomUUID(),
  type: `ipc.${kind}.${status}`,
  source: "ipc",
  channel,
  status,
  timestamp: new Date().toISOString(),
  durationMs: Date.now() - startedAt,
  payload: {
    args: toEventValue(args),
  },
  ...(error ? { error: getErrorMessage(error) } : {}),
});
