import type { CoreMessage } from "ai";
import type { GraphStore } from "../graph/GraphStore";
import type { PacketStore, TaskPacket } from "../TaskGraphCompiler";
import type { ToolPolicy } from "./tool";
import { INTERACT_TOOL_NAMES } from "./interactTools";
import { GROUND_TOOL_NAMES } from "./groundTools";

export type AgentMode = "normal" | "night";

/**
 * How much the night agent is allowed to do. The floor (`summarize`) is enforced
 * at the tool layer — interaction is physically removed — so it cannot act even
 * if the model tries. `prepare`/`act` differ in intent and are governed by the
 * policy prompt, since the difference (e.g. "fill" vs "submit") is semantic, not
 * a distinct tool.
 */
export type AutonomyLevel = "summarize" | "prepare" | "act";

export interface HarnessContext {
  systemAddendum: string;
  contextBlocks: CoreMessage[];
  toolPolicy: ToolPolicy;
}

const NIGHT_POLICY_ADDENDUM = `
<night_agent_policy>
You are in Night Agent mode. A session digest and replay plan tell you exactly what to do next.
1. Start immediately with a tool call — never respond with text only.
2. Execute replay steps in order. Continue until the goal is complete or you are blocked.
3. After each interact tool call, verify the result before proceeding (check tool output URL/title and the latest page_state).
4. Never do anything in neverAutonomouslyDo — ask the user instead.
5. Ask for confirmation before actions in requiresConfirmationBefore.
6. When the goal is reached (or you are blocked) stop calling tools and summarise what you accomplished.

Extraction discipline (multi-page / multi-entity tasks):
- Call exactly ONE tool per step. Never batch multiple navigateToUrl or getPageText calls in the same step.
- If a tool result or SERP snippet already contains the value you need (e.g. a population figure), record it and move to the next entity — do not re-search or re-open the same source.
- For links labeled "Opens in new tab", prefer navigateToUrl with the link's https URL from page_state (href) instead of clickTarget — same-tab navigation avoids tab sprawl.
- Do not navigate back to Google for a city you already have data for. Use direct article URLs (Wikipedia / Numbeo) when known.
- Maintain a running checklist of entities and which fields are filled; stop when every required field is filled or two distinct strategies failed for a field.
</night_agent_policy>
`.trim();

const autonomyClause = (level: AutonomyLevel): string => {
  switch (level) {
    case "summarize":
      return "Autonomy: SUMMARIZE ONLY. Interaction tools are disabled — read the relevant pages and report what you would do next; take no actions.";
    case "act":
      return "Autonomy: ACT. You may take reversible actions to complete the goal. Still never do anything in neverAutonomouslyDo, and confirm anything in requiresConfirmationBefore.";
    case "prepare":
    default:
      return "Autonomy: PREPARE. Open pages, gather data, and stage drafts/field values for review, but do NOT submit, send, purchase, or otherwise commit — leave the final confirming action to the user.";
  }
};

/**
 * Builds the per-turn night-mode context from a compiled task packet. Nothing
 * here is keyed to a fixed set of task types: the plan, the known values, and the
 * tool ordering are read off the packet the compiler produced, and the tool
 * policy is derived from the chosen autonomy level — so new kinds of work flow
 * through unchanged.
 */
export class NightAgentHarness {
  constructor(
    private readonly graphStore: GraphStore,
    private readonly packetStore: PacketStore,
  ) {}

  buildContext(opts: {
    packetId: string;
    currentUrl: string;
    autonomy: AutonomyLevel;
  }): HarnessContext | null {
    const packet = this.packetStore.byId(opts.packetId);
    if (!packet) return null;

    const startUrl =
      this.graphStore.byId(packet.graphId)?.scores[0]?.url ?? null;

    return {
      systemAddendum: `${NIGHT_POLICY_ADDENDUM}\n${autonomyClause(opts.autonomy)}`,
      contextBlocks: [
        {
          role: "user",
          content: `<night_agent_plan>\n${renderPlan(packet, startUrl)}\n</night_agent_plan>`,
        },
      ],
      toolPolicy: policyFor(opts.autonomy, packet),
    };
  }
}

const policyFor = (level: AutonomyLevel, packet: TaskPacket): ToolPolicy => {
  const policy: ToolPolicy = { prioritize: preferredToolOrder(packet) };
  if (level === "summarize") {
    policy.deny = [...INTERACT_TOOL_NAMES, ...GROUND_TOOL_NAMES];
  }
  return policy;
};

/** Surface the tools the plan itself calls for, in first-use order. */
const preferredToolOrder = (packet: TaskPacket): string[] => {
  const order: string[] = [];
  for (const step of packet.replayPlan) {
    const tool = step.preferredTool?.trim();
    if (tool && !order.includes(tool)) order.push(tool);
  }
  return order;
};

const renderPlan = (packet: TaskPacket, startUrl: string | null): string => {
  const lines: string[] = [`Goal: ${packet.goal}`];
  if (packet.summary) lines.push(packet.summary);
  if (startUrl) lines.push(`Suggested starting point: ${startUrl}`);

  if (packet.replayPlan.length) {
    lines.push("", "Steps to execute:");
    packet.replayPlan.forEach((s, i) => {
      lines.push(`  ${i + 1}. ${s.intent}`);
      lines.push(
        `     tool: ${s.preferredTool} | done when: ${s.successCheck}`,
      );
    });
  }

  const entities = packet.entities.filter((e) => !e.sensitive && e.value);
  if (entities.length) {
    lines.push("", "Known values:");
    for (const e of entities) lines.push(`  ${e.name}: ${e.value}`);
  }

  if (packet.openLoops.length) {
    lines.push("", "Open loops to resolve:");
    for (const l of packet.openLoops) lines.push(`  - ${l}`);
  }

  if (packet.riskPolicy.neverAutonomouslyDo.length) {
    lines.push("", "Never do autonomously:");
    for (const r of packet.riskPolicy.neverAutonomouslyDo)
      lines.push(`  - ${r}`);
  }

  if (packet.riskPolicy.requiresConfirmationBefore.length) {
    lines.push("", "Requires confirmation:");
    for (const r of packet.riskPolicy.requiresConfirmationBefore)
      lines.push(`  - ${r}`);
  }

  return lines.join("\n");
};
