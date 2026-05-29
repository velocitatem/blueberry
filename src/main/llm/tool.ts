import type { Tool, ToolSet } from "ai";
import type { FlexibleSchema } from "@ai-sdk/provider-utils";
import { z } from "zod";
import type { Window } from "../Window";
import type { Grounder } from "../grounding/Grounder";

export type ToolContext = { window: Window | null; grounder?: Grounder | null };

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

const buildTool = (def: ToolDef<any, any>, ctx: ToolContext): Tool<any, any> => ({
  description: def.description,
  inputSchema: def.inputSchema,
  execute: (input) => def.execute(input, ctx),
});

export const createTools = (ctx: ToolContext): ToolSet =>
  Object.fromEntries(
    Object.entries(registry).map(([name, def]) => [name, buildTool(def, ctx)])
  );

export type ToolPolicy = {
  /** Tool names to include. If empty or undefined, all tools are included. */
  allow?: string[];
  /** Tool names to exclude. Applied after allow. */
  deny?: string[];
  /** Re-ranking hints: names moved to front of the toolset. */
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
