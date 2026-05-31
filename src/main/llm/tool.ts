import type { Tool, ToolSet } from "ai";
import type { FlexibleSchema } from "@ai-sdk/provider-utils";
import { z } from "zod";
import type { Window } from "../Window";
import type { Grounder } from "../grounding/Grounder";
import type { TodoStore } from "./todoTools";
import { createLogger } from "../logger";

const log = createLogger("tool");

export class ReadCache {
  private readonly entries = new Map<string, unknown>(); // TODO: offload to local storage maybe

  private key(toolName: string, url: string, argsKey: string): string {
    return `${toolName}\0${url}\0${argsKey}`;
  }

  get(toolName: string, url: string, argsKey: string): unknown | undefined {
    return this.entries.get(this.key(toolName, url, argsKey));
  }

  set(toolName: string, url: string, argsKey: string, result: unknown): void {
    this.entries.set(this.key(toolName, url, argsKey), result);
  }

  clear(): void {
    this.entries.clear();
  }
}

export type ToolContext = {
  window: Window | null;
  grounder?: Grounder | null;
  todos?: TodoStore;
  readCache?: ReadCache;
};

export const MAX_PAGE_CONTENT_LENGTH = 4000;

export type ActiveTab = NonNullable<Window["activeTab"]>;

export const truncate = (text: string, maxLength: number): string =>
  text.length <= maxLength ? text : `${text.slice(0, maxLength)}...`;

export const withActiveTab = async <T extends Record<string, unknown>>(
  ctx: ToolContext,
  fn: (tab: ActiveTab) => Promise<T>,
  errorKey: keyof T
): Promise<T> => {
  const tab = ctx.window?.activeTab;
  if (!tab) return { [errorKey]: null, error: "No active tab" } as unknown as T;
  try {
    return await fn(tab);
  } catch (error) {
    return {
      [errorKey]: null,
      error: error instanceof Error ? error.message : "Operation failed",
    } as unknown as T;
  }
};

export const maxLengthSchema = z.object({
  maxLength: z
    .number()
    .int()
    .positive()
    .max(MAX_PAGE_CONTENT_LENGTH)
    .optional()
    .describe(`Maximum characters to return (default ${MAX_PAGE_CONTENT_LENGTH})`),
});

export type ToolDef<TInput = unknown, TResult = unknown> = {
  description: string;
  inputSchema: FlexibleSchema<TInput>;
  execute: (input: TInput, ctx: ToolContext) => Promise<TResult>;
  cacheable?: boolean;
};

export type ToolDefs = Record<string, ToolDef<any, any>>;

export const defineTool = <TInput, TResult>(
  def: ToolDef<TInput, TResult>
): ToolDef<TInput, TResult> => def;

const registry: ToolDefs = {};

export const registerTools = <T extends ToolDefs>(defs: T): T => {
  Object.assign(registry, defs);
  return defs;
};

const CACHED_NOTE =
  "Same result as your previous call - the page has not changed. Use the data you already have instead of calling again.";

const stableKey = (v: unknown): string => {
  if (!v || typeof v !== "object") return String(v ?? ""); // if not object or null, return stringified value
  const obj: Record<string, unknown> = {};
  for (const k of Object.keys(v as object).sort()) // sort keys to make it deterministic
    obj[k] = (v as Record<string, unknown>)[k];
  try { return JSON.stringify(obj); } catch { return ""; }
};

const preview = (v: unknown, m = 600): string => {
  if (v == null) return "";
  let s: string;
  if (typeof v === "string") s = v;
  else try { s = JSON.stringify(v); } catch { s = String(v); }
  return s.length <= m ? s : `${s.slice(0, m)}...(+${s.length - m})`;
};

const resultFailed = (r: unknown): boolean => {
  if (!r || typeof r !== "object") return false;
  const o = r as Record<string, unknown>;
  return o.error != null || o.reason != null;
};

const buildTool = (
  name: string,
  def: ToolDef<any, any>,
  ctx: ToolContext
): Tool<any, any> => ({
  description: def.description,
  inputSchema: def.inputSchema,
  execute: async (input) => {
    const startedAt = Date.now();
    log.info({ tool: name, input: preview(input) }, `tool:call ${name}`);

    // Read-cache check: return the previous result immediately for cacheable tools.
    if (def.cacheable && ctx.readCache) {
      const url = ctx.window?.activeTab?.url ?? "";
      const argsKey = stableKey(input);
      const cached = ctx.readCache.get(name, url, argsKey);
      if (cached !== undefined) {
        log.info({ tool: name, ms: 0 }, `tool:cached ${name}`);
        return { ...(cached as Record<string, unknown>), note: CACHED_NOTE };
      }
    }

    try {
      const result = await def.execute(input, ctx);
      const ms = Date.now() - startedAt;
      const meta = { tool: name, ms, result: preview(result) };
      if (resultFailed(result)) {
        log.warn(meta, `tool:fail ${name}`);
      } else {
        log.info(meta, `tool:ok ${name}`);
        // Populate cache on success for cacheable tools.
        if (def.cacheable && ctx.readCache) {
          const url = ctx.window?.activeTab?.url ?? "";
          ctx.readCache.set(name, url, stableKey(input), result);
        }
      }
      return result;
    } catch (error) {
      log.error({ tool: name, ms: Date.now() - startedAt, err: error instanceof Error ? error.message : String(error) }, `tool:error ${name}`);
      throw error;
    }
  },
});

export const createTools = (ctx: ToolContext): ToolSet =>
  Object.fromEntries(
    Object.entries(registry).map(([name, def]) => [name, buildTool(name, def, ctx)])
  );

export type ToolPolicy = {
  allow?: string[];
  deny?: string[];
  prioritize?: string[];
};

export const filterTools = (tools: ToolSet, policy: ToolPolicy): ToolSet => {
  let entries = Object.entries(tools);

  if (policy.allow && policy.allow.length > 0) {
    const allowed = new Set(policy.allow);
    entries = entries.filter(([name]) => allowed.has(name));
  }

  if (policy.deny && policy.deny.length > 0) {
    const denied = new Set(policy.deny);
    entries = entries.filter(([name]) => !denied.has(name));
  }

  if (policy.prioritize && policy.prioritize.length > 0) {
    const front = policy.prioritize;
    entries.sort(([a], [b]) => {
      const ai = front.indexOf(a);
      const bi = front.indexOf(b);
      if (ai === -1 && bi === -1) return 0;
      if (ai === -1) return 1;
      if (bi === -1) return -1;
      return ai - bi;
    });
  }

  return Object.fromEntries(entries);
};

export const listRegisteredTools = (): string[] => Object.keys(registry);
