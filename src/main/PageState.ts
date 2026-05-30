import { readFileSync } from "fs";
import { join } from "path";

/**
 * Compact, structured "page state" for the agent loop.
 * Instead of feeding the frontier model a full-resolution screenshot every turn
 * (~1000–1600 vision tokens), we extract a small bundle from the visible,
 * actionable part of the page: the interactive elements only, each with role,
 * accessible name, viewport bbox, and enabled/checked state. This is close to an
 * "interactive accessibility snapshot" and is far cheaper than pixels while
 * keeping enough state for planning. Screenshots are reserved for on-demand
 * visual grounding (clickTarget / clickByDescription / locateElement).
 */

export interface PageStateElement {
  id: string;
  role: string;
  name: string;
  bbox: [number, number, number, number];
  enabled: boolean;
  checked?: boolean;
  value?: string;
  ref: string;
}

export interface PageStateSnapshot {
  url: string;
  title: string;
  scrollY: number;
  scrollMaxY: number;
  viewport: [number, number];
  dialog: boolean;
  focused: string | null;
  elements: PageStateElement[];
  truncated: boolean;
}

export const PAGE_STATE_MAX_ELEMENTS = 40;

let cachedPageStateScript: string | undefined;

export const loadPageStateScript = (): string => 
  readFileSync(join(__dirname, "scripts/page-state.js"), "utf8").replace("__MAX_ELEMENTS__", String(PAGE_STATE_MAX_ELEMENTS));
export const getPageStateScript = (): string => 
  cachedPageStateScript ?? (cachedPageStateScript = loadPageStateScript());

export const serializePageState = (s: PageStateSnapshot): string => {
  const lines: string[] = [];
  lines.push("<page_state>");
  lines.push(
    "Structured state of the active page (interactive, in-viewport elements only; bbox is viewport-relative pixels [x,y,w,h]). " +
      "To click an element, prefer clickTarget with a plain-language description and pass `ref` only as fallbackSelector. Use `ref` directly for inputText. " +
      "ids/refs/bboxes are valid only for this snapshot — call getPageState to refresh after the page changes.",
  );
  lines.push(
    `page: ${JSON.stringify({
      url: s.url,
      title: s.title,
      scrollY: s.scrollY,
      scrollMaxY: s.scrollMaxY,
      viewport: s.viewport,
    })}`,
  );
  lines.push(
    `ui_state: ${JSON.stringify({ dialog: s.dialog, focused: s.focused })}`,
  );
  lines.push(
    `visible_elements (${s.elements.length}${s.truncated ? "+, truncated" : ""}):`,
  );
  if (s.elements.length === 0) {
    lines.push(
      "  (no interactive elements detected in the viewport — scroll, or use getPageText/searchPage)",
    );
  } else {
    for (const e of s.elements) lines.push(`  ${JSON.stringify(e)}`);
  }
  lines.push("</page_state>");
  return lines.join("\n");
};
