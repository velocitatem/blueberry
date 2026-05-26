import type { Tool, ToolSet } from "ai";
import type { FlexibleSchema } from "@ai-sdk/provider-utils";
import { z } from "zod";
import type { Window } from "../Window";

export type ToolContext = { window: Window | null };

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

export const listRegisteredTools = (): string[] => Object.keys(registry);
