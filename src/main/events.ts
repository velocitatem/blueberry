import { randomUUID } from "crypto";

export type AppEventStatus = "completed" | "failed" | "received" | "observed";

export type AppEventSource = "ipc" | "tab";

export type AppEvent = {
  id: string;
  type: string;
  source: AppEventSource;
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

export type TabEventKind =
  | "navigation"
  | "click"
  | "input"
  | "extract";

type TabEventInput = {
  kind: TabEventKind;
  tabId: string;
  url: string;
  title: string;
  data?: Record<string, unknown>;
};

const SENSITIVE_INPUT_TYPES = new Set([
  "password",
  "credit-card",
  "cc-number",
  "cc-csc",
  "ssn",
]);

const SENSITIVE_NAME_PATTERN = /pass(word)?|secret|token|otp|cvv|ccv|card|ssn/i;

export const isSensitiveInputMeta = (data: Record<string, unknown>): boolean => {
  const type = typeof data.type === "string" ? data.type.toLowerCase() : "";
  const name = typeof data.name === "string" ? data.name : "";
  const autocomplete =
    typeof data.autocomplete === "string" ? data.autocomplete.toLowerCase() : "";
  if (type && SENSITIVE_INPUT_TYPES.has(type)) return true;
  if (autocomplete && SENSITIVE_INPUT_TYPES.has(autocomplete)) return true;
  if (name && SENSITIVE_NAME_PATTERN.test(name)) return true;
  return false;
};

export const createTabEvent = ({
  kind,
  tabId,
  url,
  title,
  data,
}: TabEventInput): AppEvent => ({
  id: randomUUID(),
  type: `tab.${kind}`,
  source: "tab",
  channel: tabId,
  status: "observed",
  timestamp: new Date().toISOString(),
  payload: {
    url,
    title,
    ...(data ? { data: toEventValue(data) as Record<string, unknown> } : {}),
  },
});

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
