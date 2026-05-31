import { generateText, type LanguageModel, type LanguageModelUsage } from "ai";
import { createLogger } from "../logger";
import { withRetries, withTurnTrace } from "./harness";

const log = createLogger("sense");

/**
 * Perception stage of the sense → plan → act loop. A separate (typically cheaper)
 * vision model looks at the current screenshot and writes a plain-language
 * description of the page for the planner. This module is deliberately isolated:
 * it knows nothing about tools or the running transcript — it only turns pixels
 * into words.
 */

export const buildSensePrompt = (
  goal: string | null,
  url: string | null,
  title: string | null,
  recentActions?: string[],
): string => {
  const recentActionsSection =
    recentActions && recentActions.length > 0
      ? `\nRecent actions by the agent (most recent last — focus on what likely changed):\n${recentActions.map((a) => `  - ${a}`).join("\n")}\n`
      : "";

  return `
You are the perception module of a browser agent. You are given a screenshot of
the current browser viewport. Your description is the planning agent's ONLY view of
the page — it cannot see the screenshot, so anything you omit does not exist to it.
Describe what is on screen factually and completely. Describe — do not plan,
suggest, or act.

Write your description with these sections, in this order:

BLOCKERS: Always start here. State explicitly whether anything is blocking or
overlaying the main content — cookie/consent banners, login or signup walls, modal
dialogs, captchas, paywalls, newsletter/promo popups, age gates, "accept terms"
prompts. For each blocker, name it, describe its exact accept/dismiss/close buttons
with their visible label and location (e.g. 'a cookie banner across the bottom with
"Accept all" and "Reject all" buttons'), and say whether it covers the content the
agent likely needs. If nothing is blocking, write "BLOCKERS: none visible."

PAGE: Page identity (what site/app and what kind of page), then the layout regions
(header, nav, main content, sidebars, footer) and the key text and values actually
visible (headings, prices, names, counts, status/error messages).

CONTROLS: The interactive elements the agent could act on — buttons, links, inputs,
dropdowns, checkboxes, search boxes, and table rows/cells. Give each its visible
label/placeholder and rough location (e.g. "top-right", "row 2 of the results
table"). Note which input appears focused, if any.

Report only what is visible in the screenshot. Do not invent values, and do not
guess at content scrolled out of view — note if the page appears to continue below
the fold.

Context (for relevance only, not part of the screenshot):
- Current URL: ${url || "(unknown)"}
${title ? `- Page title: ${title}\n` : ""}- The agent's goal: ${goal || "(not specified)"}${recentActionsSection}
`.trim();
};

export interface DescribePageArgs {
  model: LanguageModel;
  modelName: string;
  provider: string;
  screenshotDataUrl: string;
  goal: string | null;
  url: string | null;
  title: string | null;
  recentActions?: string[];
}

export interface DescribePageResult {
  text: string;
  usage: LanguageModelUsage | undefined;
}

/** Run the perception model on one screenshot and return its description + token usage. */
export const describePage = async (
  args: DescribePageArgs,
): Promise<DescribePageResult> => {
  const prompt = buildSensePrompt(
    args.goal,
    args.url,
    args.title,
    args.recentActions,
  );
  try {
    const result = await withTurnTrace(
      { modelName: args.modelName, modelProvider: args.provider },
      () =>
        withRetries(() =>
          generateText({
            model: args.model,
            maxRetries: 3,
            messages: [
              {
                role: "user",
                content: [
                  { type: "text", text: prompt },
                  { type: "image", image: args.screenshotDataUrl },
                ],
              },
            ],
          }),
        ),
    );
    return { text: result.text.trim(), usage: result.usage };
  } catch (err) {
    log.warn({ err }, "page description failed");
    return {
      text: "(page description unavailable — perception model error)",
      usage: undefined,
    };
  }
};
