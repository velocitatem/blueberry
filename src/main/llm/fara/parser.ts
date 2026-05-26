export type ComputerUseAction =
  | "key"
  | "type"
  | "mouse_move"
  | "left_click"
  | "scroll"
  | "visit_url"
  | "web_search"
  | "history_back"
  | "pause_and_memorize_fact"
  | "wait"
  | "terminate";

export type ComputerUseInput = {
  action: ComputerUseAction;
  keys?: string[];
  text?: string;
  coordinate?: [number, number];
  pixels?: number;
  url?: string;
  query?: string;
  fact?: string;
  time?: number;
  status?: "success" | "failure";
};

const ACTIONS: readonly ComputerUseAction[] = [
  "key",
  "type",
  "mouse_move",
  "left_click",
  "scroll",
  "visit_url",
  "web_search",
  "history_back",
  "pause_and_memorize_fact",
  "wait",
  "terminate",
];

const ALIASES: Record<string, ComputerUseAction> = {
  visit: "visit_url",
  navigate: "visit_url",
  open: "visit_url",
  click: "left_click",
  leftclick: "left_click",
  mousemove: "mouse_move",
  search: "web_search",
  back: "history_back",
  stop: "terminate",
  done: "terminate",
};

export const normalizeAction = (raw: string): ComputerUseAction | null => {
  const key = raw.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if ((ACTIONS as readonly string[]).includes(key)) {
    return key as ComputerUseAction;
  }
  return ALIASES[key.replace(/_/g, "")] ?? ALIASES[key] ?? null;
};

export const normalizeComputerUseInput = (
  args: Record<string, unknown>,
): ComputerUseInput | null => {
  const rawAction =
    (args.action as string | undefined) ??
    (args.type as string | undefined) ??
    (args.command as string | undefined) ??
    (args.name as string | undefined) ??
    (args.kind as string | undefined);
  if (!rawAction) return null;

  const action = normalizeAction(rawAction);
  if (!action) return null;

  const out: ComputerUseInput = {
    action,
    ...(typeof args.url === "string" ? { url: args.url } : {}),
    ...(typeof args.query === "string" ? { query: args.query } : {}),
    ...(typeof args.text === "string" ? { text: args.text } : {}),
    ...(typeof args.fact === "string" ? { fact: args.fact } : {}),
    ...(typeof args.pixels === "number" ? { pixels: args.pixels } : {}),
    ...(typeof args.time === "number" ? { time: args.time } : {}),
    ...(args.status === "success" || args.status === "failure" ? { status: args.status } : {}),
    ...(Array.isArray(args.keys) ? { keys: args.keys.filter((k): k is string => typeof k === "string") } : {}),
  };
  const coord = Array.isArray(args.coordinate)
    ? args.coordinate
    : Array.isArray(args.coordinates)
      ? args.coordinates
      : null;
  if (coord && coord.length >= 2) {
    out.coordinate = [Number(coord[0]), Number(coord[1])];
  }
  return out;
};

const ACCEPTED_TOOL_NAMES = ["computer_use", "browser", "computer", "tool"];

const parseToolJson = (payload: string): ComputerUseInput | null => {
  try {
    const parsed = JSON.parse(payload) as {
      name?: string;
      arguments?: Record<string, unknown> | string;
      args?: Record<string, unknown>;
    };
    if (!ACCEPTED_TOOL_NAMES.includes(
      (parsed.name ?? "").toLowerCase() || ""
    )) return null;

    let args: Record<string, unknown> = {};
    args = typeof parsed.arguments === "string"
      ? JSON.parse(parsed.arguments)
      : typeof parsed.arguments === "object" && parsed.arguments
        ? parsed.arguments
        : parsed.args || {};
    return normalizeComputerUseInput(args);
  } catch { return null; }
};

export const isDegenerateModelOutput = (text: string): boolean => {
  const t = text.trim();
  if (t.length < 40) return false;
  if ((t.match(/[a-zA-Z]{3,}/g) ?? []).length < 4) return true;
  const cjk = t.match(/[一-鿿぀-ヿ가-힯֐-׿؀-ۿ]/g)?.length ?? 0;
  if (cjk / t.length > 0.12) return true;
  if ((t.match(/\blep\b|「|」|iso by|spy in|ReadWrite|główna/gi)?.length ?? 0) >= 4) return true;
  const printable = t.replace(/\s/g, "").length;
  const weird = t.replace(/[\x20-\x7e]/g, "").length;
  return printable > 80 && weird / printable > 0.35;
};

/** Fara on Ollama often emits tool calls as XML in text instead of native tool_calls. */
export const parseToolCallFromText = (text: string): ComputerUseInput | null => {
  const xml = text.match(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/i);
  if (xml?.[1]) {
    return (
      parseToolJson(xml[0].trim()) ||
      parseToolJson(xml[1].trim()) ||
      null
    );
  }

  const jsonBlock = text.match(
    /\{[\s\S]*"name"\s*:\s*"(?:Browser|computer_use)"[\s\S]*\}/i,
  );

  return jsonBlock ? parseToolJson(jsonBlock[0]) : null;
};
