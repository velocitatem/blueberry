import { z } from "zod";
import { defineTool, registerTools } from "./tool";
import { normalizedToViewport, resultToPoint } from "../grounding/Grounder";

export const GROUND_TOOL_NAMES = new Set(["clickByDescription"]);

export const groundTools = registerTools({
  clickByDescription: defineTool({
    description:
      "Click an element described in plain language (e.g. 'the blue Sign in button', 'the magnifying-glass icon'). A local vision model locates it on the current screenshot and clicks the pixel — no CSS selector or HTML needed. Use this when the target is visual/icon-only, ambiguous, or NOT present in page_state. If the element is listed in page_state, prefer clickElement with its `ref` selector instead.",
    inputSchema: z.object({
      description: z
        .string()
        .min(1)
        .describe("Natural-language description of the on-screen element to click"),
    }),
    execute: async ({ description }, ctx) => {
      const tab = ctx.window?.activeTab;
      if (!tab) return { clicked: false as const, error: "No active tab" };
      const grounder = ctx.grounder;
      if (!grounder) {
        return {
          clicked: false as const,
          reason: "grounding_unavailable",
          hint: "Use clickElement with a CSS selector instead.",
        };
      }
      try {
        const imageDataUrl = (await tab.screenshot()).toDataURL();
        const result = await grounder.ground({
          imageDataUrl,
          description,
          output: "point",
        });
        const norm = resultToPoint(result);
        if (!norm) {
          return {
            clicked: false as const,
            reason: "not_found",
            hint: "Target not located. Try a more specific description or clickElement.",
          };
        }
        const viewport = await tab.viewportSize();
        const { x, y } = normalizedToViewport(norm, viewport);
        await tab.clickAt(x, y);
        return { clicked: true as const, x, y, description };
      } catch (error) {
        return {
          clicked: false as const,
          error: error instanceof Error ? error.message : "Grounding click failed",
        };
      }
    },
  }),

  locateElement: defineTool({
    description:
      "Locate an element described in plain language and return its pixel coordinates without clicking. Use to verify something is on screen or to plan an interaction.",
    inputSchema: z.object({
      description: z
        .string()
        .min(1)
        .describe("Natural-language description of the on-screen element to locate"),
    }),
    execute: async ({ description }, ctx) => {
      const tab = ctx.window?.activeTab;
      if (!tab) return { found: false as const, error: "No active tab" };
      const grounder = ctx.grounder;
      if (!grounder) return { found: false as const, reason: "grounding_unavailable" };
      try {
        const imageDataUrl = (await tab.screenshot()).toDataURL();
        const result = await grounder.ground({
          imageDataUrl,
          description,
          output: "point",
        });
        const norm = resultToPoint(result);
        if (!norm) return { found: false as const, reason: "not_found" };
        const viewport = await tab.viewportSize();
        const { x, y } = normalizedToViewport(norm, viewport);
        return { found: true as const, x, y, description };
      } catch (error) {
        return {
          found: false as const,
          error: error instanceof Error ? error.message : "Grounding failed",
        };
      }
    },
  }),
});
