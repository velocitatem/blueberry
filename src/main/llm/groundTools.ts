import { z } from "zod";
import {
  defineTool,
  registerTools,
  type ActiveTab,
  type ToolContext,
} from "./tool";
import { normalizedToViewport, resultToPoint } from "../grounding/Grounder";

export const GROUND_TOOL_NAMES = new Set(["clickTarget", "clickByDescription"]);

const targetSchema = z.object({
  description: z
    .string()
    .min(1)
    .describe("Natural-language description of the on-screen element to click"),
  fallbackSelector: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Optional fresh page_state ref/CSS selector to try only if visual grounding cannot locate the target",
    ),
});

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const pageEvidence = (ctx: ToolContext) => {
  const tab = ctx.window?.activeTab;
  return {
    tabId: tab?.id ?? null,
    url: tab?.url ?? null,
    title: tab?.title ?? null,
    tabCount: ctx.window?.tabCount ?? null,
  };
};

const transitionEvidence = (
  before: ReturnType<typeof pageEvidence>,
  after: ReturnType<typeof pageEvidence>,
) => ({
  urlChanged: before.url !== after.url,
  tabChanged: before.tabId !== after.tabId,
  tabCountChanged: before.tabCount !== after.tabCount,
});

const elementAtPoint = async (tab: ActiveTab, x: number, y: number) => {
  return await tab.runJs(
    `(() => {
      const x = ${JSON.stringify(x)};
      const y = ${JSON.stringify(y)};
      const describe = (el) => {
        if (!el || el.nodeType !== 1) return null;
        const r = el.getBoundingClientRect?.();
        return {
          tag: el.tagName?.toLowerCase?.() ?? null,
          id: el.id || null,
          role: el.getAttribute?.('role') || null,
          ariaLabel: el.getAttribute?.('aria-label') || null,
          text: (el.innerText || el.value || '').replace(/\\s+/g, ' ').trim().slice(0, 160) || null,
          href: el.href || el.getAttribute?.('href') || null,
          bbox: r ? [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] : null,
        };
      };
      const element = document.elementFromPoint(x, y);
      const clickable = element?.closest?.('a, button, [role=button], [role=link], input[type=submit], input[type=button]') ?? element;
      return {
        point: { x, y },
        element: describe(element),
        clickable: describe(clickable),
      };
    })()`,
  );
};

const clickSelector = async (tab: ActiveTab, selector: string) => {
  const result = await tab.runJs(
    `(() => {
      const sel = ${JSON.stringify(selector)};
      const all = Array.from(document.querySelectorAll(sel));
      const visible = all.find((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      }) ?? all[0];
      if (!visible) return { clicked: false, reason: 'no_match', count: 0 };
      visible.scrollIntoView({ block: 'center', inline: 'center' });
      visible.click?.();
      return {
        clicked: true,
        count: all.length,
        tag: visible.tagName?.toLowerCase?.() ?? null,
        text: (visible.innerText || visible.value || '').slice(0, 120) || null,
        href: visible.href || visible.getAttribute?.('href') || null,
      };
    })()`,
  );
  return { clicked: !!result?.clicked, ...(result ?? {}) };
};

const clickWithVisualGrounding = async (
  description: string,
  ctx: ToolContext,
) => {
  const tab = ctx.window?.activeTab;
  if (!tab) return { clicked: false as const, error: "No active tab" };
  const grounder = ctx.grounder;
  if (!grounder) {
    return {
      clicked: false as const,
      reason: "grounding_unavailable",
      hint: "Use a fresh page_state selector fallback if one is available.",
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
        hint: "Target not located. Try a more specific description or a fresh selector fallback.",
      };
    }
    const viewport = await tab.viewportSize();
    const { x, y } = normalizedToViewport(norm, viewport);
    const before = pageEvidence(ctx);
    const target = await elementAtPoint(tab, x, y);
    await tab.clickAt(x, y);
    await sleep(300);
    const after = pageEvidence(ctx);
    return {
      clicked: true as const,
      method: "visual" as const,
      target,
      before,
      after,
      transition: transitionEvidence(before, after),
      x,
      y,
      description,
    };
  } catch (error) {
    return {
      clicked: false as const,
      error: error instanceof Error ? error.message : "Grounding click failed",
    };
  }
};

const clickTarget = async (
  { description, fallbackSelector }: z.infer<typeof targetSchema>,
  ctx: ToolContext,
) => {
  const visual = await clickWithVisualGrounding(description, ctx);
  if (visual.clicked) return visual;

  const tab = ctx.window?.activeTab;
  if (!fallbackSelector || !tab) return visual;

  const before = pageEvidence(ctx);
  const fallback = await clickSelector(tab, fallbackSelector);
  await sleep(300);
  const after = pageEvidence(ctx);
  if (fallback.clicked) {
    return {
      clicked: true as const,
      method: "selector_fallback" as const,
      target: fallback,
      before,
      after,
      transition: transitionEvidence(before, after),
      description,
      fallbackSelector,
      visualFailure: "error" in visual ? visual.error : visual.reason,
      selectorResult: fallback,
    };
  }

  return {
    clicked: false as const,
    reason: "visual_and_selector_failed",
    description,
    fallbackSelector,
    visualResult: visual,
    selectorResult: fallback,
  };
};

export const groundTools = registerTools({
  clickTarget: defineTool({
    description:
      "Preferred way to click a visible target. Describe the target in plain language; visual grounding clicks it from the current screenshot first. Provide fallbackSelector only as a fallback using a fresh page_state ref/CSS selector.",
    inputSchema: targetSchema,
    execute: clickTarget,
  }),

  clickByDescription: defineTool({
    description:
      "Click an element described in plain language using visual grounding first. Prefer clickTarget for new code; this tool is kept as a direct natural-language click alias. Provide fallbackSelector only if you have a fresh page_state ref/CSS selector.",
    inputSchema: targetSchema,
    execute: clickTarget,
  }),

  locateElement: defineTool({
    description:
      "Locate an element described in plain language and return its pixel coordinates without clicking. Use to verify something is on screen or to plan an interaction.",
    inputSchema: z.object({
      description: z
        .string()
        .min(1)
        .describe(
          "Natural-language description of the on-screen element to locate",
        ),
    }),
    execute: async ({ description }, ctx) => {
      const tab = ctx.window?.activeTab;
      if (!tab) return { found: false as const, error: "No active tab" };
      const grounder = ctx.grounder;
      if (!grounder)
        return { found: false as const, reason: "grounding_unavailable" };
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
