import type { Tool, ToolSet } from "ai";
import type { FlexibleSchema } from "@ai-sdk/provider-utils";
import type { Window } from "../Window";

export type ToolContext = { window: Window | null };
type ActiveTab = NonNullable<Window["activeTab"]>;

/** Run `fn` against the active tab, returning a uniform error shape if no tab or on throw. */
export const withActiveTab = async <T extends Record<string, unknown>>(
  ctx: ToolContext,
  fn: (tab: ActiveTab) => Promise<T>,
  errorKey: keyof T,
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

export const createToolsFromDefs = (
  defs: ToolDefs,
  ctx: ToolContext,
): ToolSet =>
  Object.fromEntries(
    Object.entries(defs).map(([name, def]) => [name, buildTool(def, ctx)]),
  );

export const listRegisteredTools = (): string[] => Object.keys(registry);
