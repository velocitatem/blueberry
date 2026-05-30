import { z } from "zod";
import {
  defineTool,
  registerTools,
  truncate,
  withActiveTab,
  maxLengthSchema,
  MAX_PAGE_CONTENT_LENGTH,
} from "./tool";

export const observeTools = registerTools({
  getCurrentUrl: defineTool({
    description: "Get the URL of the currently active browser tab.",
    inputSchema: z.object({}),
    execute: (_input, ctx) =>
      withActiveTab(ctx, async (tab) => ({ url: tab.url }), "url"),
  }),

  getPageState: defineTool({
    description:
      "Get a fresh structured snapshot of the active page: URL/title/scroll plus the interactive elements currently visible in the viewport (id, role, accessible name, pixel bbox, enabled/checked state, and a `ref` CSS selector). Use this instead of a screenshot to decide what to click/type, and to refresh your view after the page changes. Act on an element by passing its `ref` to clickElement/inputText.",
    inputSchema: z.object({}),
    execute: (_input, ctx) =>
      withActiveTab(
        ctx,
        async (tab) => ({ state: await tab.getPageState() }),
        "state"
      ),
  }),

  getPageText: defineTool({
    description:
      "Get the visible text content of the active page. Use this when you need to read or search page content.",
    inputSchema: maxLengthSchema,
    execute: ({ maxLength }, ctx) =>
      withActiveTab(
        ctx,
        async (tab) => ({
          text: truncate(
            (await tab.getTabText()) ?? "",
            maxLength ?? MAX_PAGE_CONTENT_LENGTH
          ),
        }),
        "text"
      ),
  }),

  searchPage: defineTool({
    description:
      "Search the active page's visible text for a query string and return matches with surrounding context. Case-insensitive. Prefer this over getPageText when looking for a specific string.",
    inputSchema: z.object({
      query: z.string().min(1).describe("Substring to search for"),
      maxMatches: z
        .number()
        .int()
        .positive()
        .max(20)
        .optional()
        .describe("Maximum matches to return (default 5)"),
    }),
    execute: ({ query, maxMatches }, ctx) =>
      withActiveTab(
        ctx,
        async (tab) => {
          const result = await tab.runJs(
            `(() => {
              const q = ${JSON.stringify(query)}.toLowerCase();
              const limit = ${maxMatches ?? 5};
              const text = document.documentElement?.innerText ?? '';
              const lower = text.toLowerCase();
              const matches = [];
              let from = 0;
              while (matches.length < limit) {
                const idx = lower.indexOf(q, from);
                if (idx === -1) break;
                const start = Math.max(0, idx - 60);
                const end = Math.min(text.length, idx + q.length + 60);
                matches.push({
                  index: idx,
                  context: text.slice(start, end).replace(/\\s+/g, ' '),
                });
                from = idx + q.length;
              }
              let total = matches.length;
              if (matches.length === limit) {
                let extra = 0, scan = from;
                while ((scan = lower.indexOf(q, scan)) !== -1 && extra < 100) {
                  extra++;
                  scan += q.length;
                }
                total += extra;
              }
              return { matches, total };
            })()`
          );
          return {
            found: (result?.matches?.length ?? 0) > 0,
            matches: result?.matches ?? [],
            total: result?.total ?? 0,
          };
        },
        "found"
      ),
  }),
});
