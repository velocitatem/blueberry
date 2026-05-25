import type { Tool, ToolSet } from "ai";
import type { FlexibleSchema } from "@ai-sdk/provider-utils";
import type { Window } from "../Window";

export type ToolContext = { window: Window | null };

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

export const listRegisteredTools = (): string[] => Object.keys(registry);
