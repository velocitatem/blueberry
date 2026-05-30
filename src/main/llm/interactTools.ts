import { z } from "zod";
import { defineTool, registerTools, withActiveTab } from "./tool";

export const INTERACT_TOOL_NAMES = new Set([
  "navigateToUrl",
  "goBack",
  "clickElement",
  "inputText",
  "pressKey",
  "scrollPage",
]);

export const interactTools = registerTools({
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

  goBack: defineTool({
    description: "Navigate the active tab one step back in its history.",
    inputSchema: z.object({}),
    execute: (_input, ctx) =>
      withActiveTab(
        ctx,
        async (tab) => {
          if (!tab.webContents.navigationHistory.canGoBack()) {
            if (ctx.window?.switchToPreviousTab()) {
              return {
                wentBack: true as const,
                switchedToPreviousTab: true,
                url: ctx.window.activeTab?.url ?? null,
              };
            }
            return { wentBack: false as const, reason: "no_history" };
          }
          tab.goBack();
          return { wentBack: true as const, switchedToPreviousTab: false, url: tab.url };
        },
        "wentBack"
      ),
  }),

  clickElement: defineTool({
    description:
      "Click an element on the active page, matched by CSS selector. Prefer specific selectors (id, role, stable attribute). If multiple match, the first visible one is clicked.",
    inputSchema: z.object({
      selector: z.string().min(1).describe("CSS selector of the element to click"),
    }),
    execute: ({ selector }, ctx) =>
      withActiveTab(
        ctx,
        async (tab) => {
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
              };
            })()`
          );
          return { clicked: !!result?.clicked, ...(result ?? {}) };
        },
        "clicked"
      ),
  }),

  inputText: defineTool({
    description:
      "Type text into an input, textarea, or contenteditable on the active page, matched by CSS selector. Set submit=true to press Enter after typing (e.g. search fields).",
    inputSchema: z.object({
      selector: z
        .string()
        .min(1)
        .describe("CSS selector of the input/textarea/contenteditable element"),
      text: z.string().describe("Text to set as the field value"),
      submit: z
        .boolean()
        .optional()
        .describe("If true, dispatch Enter after typing to submit"),
    }),
    execute: ({ selector, text, submit }, ctx) =>
      withActiveTab(
        ctx,
        async (tab) => {
          const result = await tab.runJs(
            `(() => {
              const sel = ${JSON.stringify(selector)};
              const value = ${JSON.stringify(text)};
              const submit = ${submit ? "true" : "false"};
              const el = document.querySelector(sel);
              if (!el) return { typed: false, reason: 'no_match' };
              el.focus?.();
              if ('value' in el) {
                const setter = Object.getOwnPropertyDescriptor(el.__proto__, 'value')?.set;
                setter ? setter.call(el, value) : (el.value = value);
              } else if (el.isContentEditable) {
                el.textContent = value;
              } else {
                return { typed: false, reason: 'not_editable' };
              }
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
              if (submit) {
                const opts = { bubbles: true, cancelable: true, key: 'Enter', code: 'Enter', keyCode: 13, which: 13 };
                el.dispatchEvent(new KeyboardEvent('keydown', opts));
                el.dispatchEvent(new KeyboardEvent('keypress', opts));
                el.dispatchEvent(new KeyboardEvent('keyup', opts));
                if (el.form && typeof el.form.requestSubmit === 'function') {
                  try { el.form.requestSubmit(); } catch (_) {}
                }
              }
              return {
                typed: true,
                submitted: submit,
                tag: el.tagName?.toLowerCase?.() ?? null,
              };
            })()`
          );
          return { typed: !!result?.typed, ...(result ?? {}) };
        },
        "typed"
      ),
  }),

  pressKey: defineTool({
    description:
      "Send a single keystroke to the active tab (e.g. Enter, Tab, Escape, ArrowDown). Targets whatever element currently has focus.",
    inputSchema: z.object({
      key: z
        .string()
        .min(1)
        .describe("Key name, e.g. 'Enter', 'Tab', 'Escape', 'ArrowDown', 'a'"),
    }),
    execute: ({ key }, ctx) =>
      withActiveTab(
        ctx,
        async (tab) => {
          const wc = tab.webContents;
          wc.sendInputEvent({ type: "keyDown", keyCode: key });
          wc.sendInputEvent({ type: "char", keyCode: key });
          wc.sendInputEvent({ type: "keyUp", keyCode: key });
          return { pressed: true as const, key };
        },
        "pressed"
      ),
  }),

  scrollPage: defineTool({
    description:
      "Scroll the active page. Either provide a selector to scroll an element into view, or a direction with optional pixel amount.",
    inputSchema: z.object({
      selector: z
        .string()
        .optional()
        .describe("If set, scroll this element into view instead of by amount"),
      direction: z
        .enum(["up", "down", "top", "bottom"])
        .optional()
        .describe("Direction to scroll the window (ignored if selector is set)"),
      amount: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Pixels to scroll for up/down (default 600)"),
    }),
    execute: ({ selector, direction, amount }, ctx) =>
      withActiveTab(
        ctx,
        async (tab) => {
          const result = await tab.runJs(
            `(() => {
              const sel = ${selector ? JSON.stringify(selector) : "null"};
              const dir = ${JSON.stringify(direction ?? "down")};
              const px = ${amount ?? 600};
              if (sel) {
                const el = document.querySelector(sel);
                if (!el) return { scrolled: false, reason: 'no_match' };
                el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
                return { scrolled: true, target: 'selector' };
              }
              if (dir === 'top') window.scrollTo({ top: 0 });
              else if (dir === 'bottom') window.scrollTo({ top: document.body.scrollHeight });
              else window.scrollBy({ top: dir === 'up' ? -px : px });
              return {
                scrolled: true,
                target: 'window',
                scrollY: Math.round(window.scrollY),
                maxY: Math.round(document.body.scrollHeight - window.innerHeight),
              };
            })()`
          );
          return { scrolled: !!result?.scrolled, ...(result ?? {}) };
        },
        "scrolled"
      ),
  }),
});
