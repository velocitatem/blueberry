import { z } from "zod";
import { defineTool, registerTools, withActiveTab } from "./tool";

const MAX_PAGE_CONTENT_LENGTH = 4000;

const truncate = (text: string, maxLength: number): string =>
  text.length <= maxLength ? text : `${text.slice(0, maxLength)}...`;

const maxLengthSchema = z.object({
  maxLength: z
    .number()
    .int()
    .positive()
    .max(MAX_PAGE_CONTENT_LENGTH)
    .optional()
    .describe(`Maximum characters to return (default ${MAX_PAGE_CONTENT_LENGTH})`),
});

export const browserTools = registerTools({
  getCurrentUrl: defineTool({
    description: "Get the URL of the currently active browser tab.",
    inputSchema: z.object({}),
    execute: (_input, ctx) =>
      withActiveTab(ctx, async (tab) => ({ url: tab.url }), "url"),
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

  getPageHtml: defineTool({
    description:
      "Get the HTML source of the active page. Use for structure or attributes not visible in plain text.",
    inputSchema: maxLengthSchema,
    execute: ({ maxLength }, ctx) =>
      withActiveTab(
        ctx,
        async (tab) => ({
          html: truncate(
            (await tab.getTabHtml()) ?? "",
            maxLength ?? MAX_PAGE_CONTENT_LENGTH
          ),
        }),
        "html"
      ),
  }),

  navigateToUrl: defineTool({
    description: "Navigate the active tab to a URL.",
    inputSchema: z.object({
      url: z.string().url().describe("The URL to navigate to"),
    }),
    execute: ({ url }, ctx) =>
      withActiveTab(
        ctx,
        async (tab) => {
          await tab.loadURL(url);
          return { success: true as const, url: tab.url };
        },
        "success"
      ),
  }),
});
