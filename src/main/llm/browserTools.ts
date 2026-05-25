import { z } from "zod";
import { defineTool, registerTools, type ToolContext } from "./tool";
import type { Window } from "../Window";

const MAX_PAGE_CONTENT_LENGTH = 4000;
const MAX_WEB_FETCH_LENGTH = 8000;
const DEFAULT_SEARCH_RESULTS = 5;
const TOOL_REQUEST_TIMEOUT_MS = 12000;

type ActiveTab = NonNullable<Window["activeTab"]>;

const truncate = (text: string, maxLength: number): string =>
  text.length <= maxLength ? text : `${text.slice(0, maxLength)}...`;

const ensureWebUrl = (rawUrl: string): URL => {
  const url = new URL(rawUrl);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Only http and https URLs are supported");
  }
  return url;
};

const fetchWithTimeout = async (url: string): Promise<Response> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TOOL_REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
};

const htmlToText = (html: string): string =>
  html
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const withActiveTab = async <T extends Record<string, unknown>>(
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

const maxLengthSchema = z.object({
  maxLength: z
    .number()
    .int()
    .positive()
    .max(MAX_PAGE_CONTENT_LENGTH)
    .optional()
    .describe(
      `Maximum characters to return (default ${MAX_PAGE_CONTENT_LENGTH})`,
    ),
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
            maxLength ?? MAX_PAGE_CONTENT_LENGTH,
          ),
        }),
        "text",
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
            maxLength ?? MAX_PAGE_CONTENT_LENGTH,
          ),
        }),
        "html",
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
        "success",
      ),
  }),

  goBack: defineTool({
    description: "Navigate the active tab back by one page if possible.",
    inputSchema: z.object({}),
    execute: (_input, ctx) =>
      withActiveTab(
        ctx,
        async (tab) => {
          tab.goBack();
          return { success: true as const, url: tab.url };
        },
        "success",
      ),
  }),

  goForward: defineTool({
    description: "Navigate the active tab forward by one page if possible.",
    inputSchema: z.object({}),
    execute: (_input, ctx) =>
      withActiveTab(
        ctx,
        async (tab) => {
          tab.goForward();
          return { success: true as const, url: tab.url };
        },
        "success",
      ),
  }),

  reloadPage: defineTool({
    description: "Reload the active tab.",
    inputSchema: z.object({}),
    execute: (_input, ctx) =>
      withActiveTab(
        ctx,
        async (tab) => {
          tab.reload();
          return { success: true as const, url: tab.url };
        },
        "success",
      ),
  }),

  clickElement: defineTool({
    description:
      "Click an element on the active page using a CSS selector. Use this to interact with page controls.",
    inputSchema: z.object({
      selector: z
        .string()
        .min(1)
        .describe("CSS selector for the target element"),
    }),
    execute: ({ selector }, ctx) =>
      withActiveTab(
        ctx,
        async (tab) => {
          const selectorJson = JSON.stringify(selector);
          const result = (await tab.runJs(`(() => {
            const element = document.querySelector(${selectorJson});
            if (!element) return { success: false, message: "Element not found" };
            if (element instanceof HTMLElement) {
              element.click();
              return { success: true };
            }
            return { success: false, message: "Element is not clickable" };
          })()`)) as { success: boolean; message?: string } | null;

          if (!result) {
            return {
              success: false as const,
              error: "Could not run script on this page",
            };
          }
          return result.success
            ? { success: true as const }
            : {
                success: false as const,
                error: result.message ?? "Element click failed",
              };
        },
        "success",
      ),
  }),

  typeIntoElement: defineTool({
    description:
      "Type text into an input, textarea, or contenteditable element selected by CSS selector.",
    inputSchema: z.object({
      selector: z
        .string()
        .min(1)
        .describe("CSS selector for the target input element"),
      text: z.string().describe("Text to type into the selected element"),
      submit: z
        .boolean()
        .optional()
        .describe(
          "Whether to submit by pressing Enter after typing (default false)",
        ),
    }),
    execute: ({ selector, text, submit = false }, ctx) =>
      withActiveTab(
        ctx,
        async (tab) => {
          const selectorJson = JSON.stringify(selector);
          const textJson = JSON.stringify(text);
          const submitJson = JSON.stringify(submit);
          const result = (await tab.runJs(`(() => {
            const element = document.querySelector(${selectorJson});
            if (!element) return { success: false, message: "Element not found" };

            if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
              element.focus();
              element.value = ${textJson};
              element.dispatchEvent(new Event("input", { bubbles: true }));
              element.dispatchEvent(new Event("change", { bubbles: true }));
              if (${submitJson}) {
                element.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
                element.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", bubbles: true }));
              }
              return { success: true };
            }

            if (element instanceof HTMLElement && element.isContentEditable) {
              element.focus();
              element.textContent = ${textJson};
              element.dispatchEvent(new Event("input", { bubbles: true }));
              if (${submitJson}) {
                element.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
                element.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", bubbles: true }));
              }
              return { success: true };
            }

            return { success: false, message: "Element is not editable" };
          })()`)) as { success: boolean; message?: string } | null;

          if (!result) {
            return {
              success: false as const,
              error: "Could not run script on this page",
            };
          }
          return result.success
            ? { success: true as const }
            : {
                success: false as const,
                error: result.message ?? "Typing failed",
              };
        },
        "success",
      ),
  }),

  scrollPage: defineTool({
    description: "Scroll the active page by pixel offsets.",
    inputSchema: z.object({
      x: z
        .number()
        .int()
        .optional()
        .describe("Horizontal scroll offset in pixels (default 0)"),
      y: z
        .number()
        .int()
        .optional()
        .describe("Vertical scroll offset in pixels (default 600)"),
    }),
    execute: ({ x = 0, y = 600 }, ctx) =>
      withActiveTab(
        ctx,
        async (tab) => {
          const xJson = JSON.stringify(x);
          const yJson = JSON.stringify(y);
          const result = (await tab.runJs(`(() => {
            window.scrollBy(${xJson}, ${yJson});
            return { success: true, scrollX: window.scrollX, scrollY: window.scrollY };
          })()`)) as {
            success: boolean;
            scrollX: number;
            scrollY: number;
          } | null;

          if (!result) {
            return {
              success: false as const,
              error: "Could not run script on this page",
            };
          }
          return result;
        },
        "success",
      ),
  }),

  searchWeb: defineTool({
    description:
      "Search the web and return concise result snippets, URLs, and optional instant answer fields.",
    inputSchema: z.object({
      query: z.string().min(1).describe("Search query"),
      maxResults: z
        .number()
        .int()
        .positive()
        .max(10)
        .optional()
        .describe(
          `Maximum number of results to return (default ${DEFAULT_SEARCH_RESULTS})`,
        ),
    }),
    execute: async ({ query, maxResults = DEFAULT_SEARCH_RESULTS }) => {
      try {
        const searchUrl = ensureWebUrl("https://api.duckduckgo.com/");
        searchUrl.searchParams.set("q", query);
        searchUrl.searchParams.set("format", "json");
        searchUrl.searchParams.set("no_html", "1");
        searchUrl.searchParams.set("skip_disambig", "1");

        const response = await fetchWithTimeout(searchUrl.toString());
        if (!response.ok) {
          return {
            results: [],
            error: `Search failed with status ${response.status}`,
          };
        }

        const payload = (await response.json()) as {
          AbstractText?: string;
          AbstractURL?: string;
          Heading?: string;
          Answer?: string;
          RelatedTopics?: Array<{
            Text?: string;
            FirstURL?: string;
            Topics?: Array<{ Text?: string; FirstURL?: string }>;
          }>;
        };

        const flatTopics = (payload.RelatedTopics ?? []).flatMap((topic) =>
          topic.Topics ? topic.Topics : [topic],
        );

        const results = flatTopics
          .map((topic) => ({
            title: topic.Text?.split(" - ")[0] ?? "",
            snippet: topic.Text ?? "",
            url: topic.FirstURL ?? "",
          }))
          .filter((item) => item.snippet && item.url)
          .slice(0, maxResults);

        return {
          query,
          answer: payload.Answer ?? payload.AbstractText ?? null,
          heading: payload.Heading ?? null,
          answerUrl: payload.AbstractURL ?? null,
          results,
        };
      } catch (error) {
        return {
          query,
          results: [],
          error: error instanceof Error ? error.message : "Search failed",
        };
      }
    },
  }),

  fetchUrlContent: defineTool({
    description:
      "Fetch a URL directly from the web and return text content, final URL, and metadata.",
    inputSchema: z.object({
      url: z.string().url().describe("The URL to fetch"),
      maxLength: z
        .number()
        .int()
        .positive()
        .max(MAX_WEB_FETCH_LENGTH)
        .optional()
        .describe(
          `Maximum characters to return (default ${MAX_WEB_FETCH_LENGTH})`,
        ),
    }),
    execute: async ({ url, maxLength }) => {
      try {
        const parsed = ensureWebUrl(url);
        const response = await fetchWithTimeout(parsed.toString());

        if (!response.ok) {
          return {
            url: parsed.toString(),
            finalUrl: response.url || parsed.toString(),
            status: response.status,
            contentType: response.headers.get("content-type"),
            content: null,
            error: `Request failed with status ${response.status}`,
          };
        }

        const contentType = response.headers.get("content-type") ?? "";
        const body = await response.text();
        const normalized =
          contentType.includes("text/html") ||
          contentType.includes("application/xhtml+xml")
            ? htmlToText(body)
            : body;

        return {
          url: parsed.toString(),
          finalUrl: response.url || parsed.toString(),
          status: response.status,
          contentType,
          content: truncate(normalized, maxLength ?? MAX_WEB_FETCH_LENGTH),
        };
      } catch (error) {
        return {
          url,
          content: null,
          error: error instanceof Error ? error.message : "Failed to fetch URL",
        };
      }
    },
  }),
});
