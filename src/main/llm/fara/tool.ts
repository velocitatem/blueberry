import { z } from "zod";
import {
  defineTool,
  withActiveTab,
  type ToolContext,
  type ToolDef,
  type ToolDefs,
} from "../tool";
import {
  normalizeComputerUseInput,
  type ComputerUseAction,
  type ComputerUseInput,
} from "./parser";

const coordinate = z.tuple([z.number(), z.number()]);

/**
 * Each action is a normal AI-SDK-style tool with a focused schema and execute.
 * Fara is trained on a single `computer_use` tool, so we expose them as one wrapper
 * below and dispatch on `action` — but internally they're independent tool defs
 * we can register elsewhere (e.g. for providers that prefer per-action tools).
 */
export const computerUseActions: Record<ComputerUseAction, ToolDef> = {
  visit_url: defineTool({
    description: "Navigate the active tab to a URL.",
    inputSchema: z.object({ url: z.string() }),
    execute: ({ url }, ctx) =>
      withActiveTab(
        ctx,
        async (tab) => {
          await tab.loadURL(url);
          await tab.waitForSettle(800);
          return { action: "visit_url", url: tab.url };
        },
        "url",
      ),
  }),

  web_search: defineTool({
    description: "Run a Google search and load the results page.",
    inputSchema: z.object({ query: z.string() }),
    execute: ({ query }, ctx) =>
      withActiveTab(
        ctx,
        async (tab) => {
          await tab.loadURL(
            `https://www.google.com/search?q=${encodeURIComponent(query)}`,
          );
          await tab.waitForSettle(800);
          return { action: "web_search", url: tab.url, query };
        },
        "url",
      ),
  }),

  history_back: defineTool({
    description: "Go back one entry in the active tab's history.",
    inputSchema: z.object({}),
    execute: (_input, ctx) =>
      withActiveTab(
        ctx,
        async (tab) => {
          tab.goBack();
          await tab.waitForSettle(600);
          return { action: "history_back", url: tab.url };
        },
        "url",
      ),
  }),

  wait: defineTool({
    description: "Wait for the page to settle for `time` seconds (clamped 0.2–30s).",
    inputSchema: z.object({ time: z.number().optional() }),
    execute: ({ time }, ctx) =>
      withActiveTab(
        ctx,
        async (tab) => {
          const ms = Math.min(Math.max((time ?? 1) * 1000, 200), 30_000);
          await tab.waitForSettle(ms);
          return { action: "wait", waitedMs: ms, url: tab.url };
        },
        "waitedMs",
      ),
  }),

  mouse_move: defineTool({
    description: "Move the mouse to a coordinate (Fara reference space).",
    inputSchema: z.object({ coordinate }),
    execute: ({ coordinate: [x, y] }, ctx) =>
      withActiveTab(
        ctx,
        async (tab) => {
          await tab.mouseMove(x, y);
          return { action: "mouse_move", coordinate: [x, y] };
        },
        "coordinate",
      ),
  }),

  left_click: defineTool({
    description: "Left click, optionally at a coordinate (Fara reference space).",
    inputSchema: z.object({ coordinate: coordinate.optional() }),
    execute: ({ coordinate }, ctx) =>
      withActiveTab(
        ctx,
        async (tab) => {
          if (coordinate) await tab.leftClick(coordinate[0], coordinate[1]);
          else await tab.leftClick();
          await tab.waitForSettle(400);
          return { action: "left_click", url: tab.url, coordinate: coordinate ?? null };
        },
        "url",
      ),
  }),

  type: defineTool({
    description: "Type text, optionally clicking a coordinate first.",
    inputSchema: z.object({ text: z.string(), coordinate: coordinate.optional() }),
    execute: ({ text, coordinate }, ctx) =>
      withActiveTab(
        ctx,
        async (tab) => {
          await tab.typeText(text, coordinate?.[0], coordinate?.[1]);
          await tab.waitForSettle(300);
          return { action: "type", url: tab.url };
        },
        "url",
      ),
  }),

  scroll: defineTool({
    description: "Scroll the active tab by `pixels` (negative = up).",
    inputSchema: z.object({ pixels: z.number().optional() }),
    execute: ({ pixels }, ctx) =>
      withActiveTab(
        ctx,
        async (tab) => {
          const px = pixels ?? -300;
          await tab.scroll(px);
          await tab.waitForSettle(300);
          return { action: "scroll", pixels: px };
        },
        "pixels",
      ),
  }),

  key: defineTool({
    description: "Press a sequence of keys.",
    inputSchema: z.object({ keys: z.array(z.string()).min(1) }),
    execute: ({ keys }, ctx) =>
      withActiveTab(
        ctx,
        async (tab) => {
          await tab.pressKeys(keys);
          await tab.waitForSettle(300);
          return { action: "key", keys };
        },
        "keys",
      ),
  }),

  pause_and_memorize_fact: defineTool({
    description: "Record a fact gathered from the page for later use.",
    inputSchema: z.object({ fact: z.string().optional() }),
    execute: async ({ fact }, ctx) => ({
      action: "pause_and_memorize_fact",
      memorized: fact ?? null,
      url: ctx.window?.activeTab?.url ?? null,
    }),
  }),

  terminate: defineTool({
    description: "End the agent loop with success or failure.",
    inputSchema: z.object({ status: z.enum(["success", "failure"]).optional() }),
    execute: async ({ status }, ctx) => ({
      action: "terminate",
      terminated: true,
      status: status ?? "success",
      url: ctx.window?.activeTab?.url ?? null,
    }),
  }),
};

/** Fara's single trained tool surface — dispatches on `action` into the per-action tools. */
const wrapperSchema = z.preprocess(
  (value) => {
    if (!value || typeof value !== "object") return value;
    return normalizeComputerUseInput(value as Record<string, unknown>) ?? value;
  },
  z.object({
    action: z.enum(Object.keys(computerUseActions) as [ComputerUseAction]),
    keys: z.array(z.string()).optional(),
    text: z.string().optional(),
    coordinate: coordinate.optional(),
    pixels: z.number().optional(),
    url: z.string().optional(),
    query: z.string().optional(),
    fact: z.string().optional(),
    time: z.number().optional(),
    status: z.enum(["success", "failure"]).optional(),
  }),
);

const DESCRIPTION = [
  "Use a mouse and keyboard to interact with the browser and complete web tasks.",
  "Actions: key, type, mouse_move, left_click, scroll, visit_url, web_search, history_back,",
  "pause_and_memorize_fact, wait, terminate.",
  "Coordinates are in the Fara reference space (1428x896); they are scaled to the active tab viewport.",
  "Call terminate with status when the task is finished or cannot proceed.",
].join(" ");

export const faraToolDefs: ToolDefs = {
  computer_use: defineTool({
    description: DESCRIPTION,
    inputSchema: wrapperSchema,
    execute: (input, ctx) =>
      computerUseActions[input.action].execute(input, ctx) as Promise<
        Record<string, unknown>
      >,
  }),
};

export const runComputerUse = (
  input: ComputerUseInput,
  ctx: ToolContext,
): Promise<Record<string, unknown>> =>
  computerUseActions[input.action].execute(input, ctx) as Promise<
    Record<string, unknown>
  >;
