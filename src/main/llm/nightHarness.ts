import type { CoreMessage } from "ai";
import type { MotifMatch } from "../graph/BehaviorGraph";
import type { TaskPacket, ReplayStep } from "../TaskGraphCompiler";
import type { GraphStore } from "../graph/GraphStore";
import type { PacketStore } from "../TaskGraphCompiler";
import type { ToolPolicy } from "./tool";

export type AgentMode = "normal" | "night";

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
3. After each interact tool call, verify the result before proceeding.
4. Never do anything in neverAutonomouslyDo — ask the user instead.
5. Ask for confirmation before actions in requiresConfirmationBefore.
6. When done, summarise what was accomplished.
</night_agent_policy>
`.trim();

export class NightAgentHarness {
  constructor(
    private readonly graphStore: GraphStore,
    private readonly packetStore: PacketStore,
  ) {}

  buildContext(opts: { packetId: string; currentUrl: string }): HarnessContext | null {
    const packet = this.packetStore.byId(opts.packetId);
    if (!packet) return null;
    const graph = this.graphStore.byId(packet.graphId);
    if (!graph) return null;

    const topMotif = graph.motifs[0] ?? null;
    const lines: string[] = [`Goal: ${packet.goal}`];

    if (topMotif) {
      lines.push(`Task type: ${topMotif.motif}`);
      if (topMotif.urlTemplate) lines.push(`URL template: ${topMotif.urlTemplate}`);
      const complete = topMotif.instances.filter(i => i.complete).map(i => i.paramValue).filter(Boolean);
      const incomplete = topMotif.instances.filter(i => !i.complete).map(i => i.paramValue).filter(Boolean);
      if (complete.length) lines.push(`Already done: ${complete.join(", ")}`);
      if (incomplete.length) lines.push(`Still needed: ${incomplete.join(", ")}`);
    }

    if (packet.replayPlan.length > 0) {
      lines.push("", "Steps to execute:");
      packet.replayPlan.forEach((s: ReplayStep, i: number) => {
        lines.push(`  ${i + 1}. ${s.intent}`);
        lines.push(`     tool: ${s.preferredTool} | done when: ${s.successCheck}`);
      });
    }

    const entities = packet.entities.filter(e => !e.sensitive && e.value);
    if (entities.length) {
      lines.push("", "Known values:");
      for (const e of entities) lines.push(`  ${e.name}: ${e.value}`);
    }

    if (packet.openLoops.length) {
      lines.push("", "Open loops (pause and ask user):");
      for (const l of packet.openLoops) lines.push(`  - ${l}`);
    }

    if (packet.riskPolicy.neverAutonomouslyDo.length) {
      lines.push("", "Never do autonomously:");
      for (const r of packet.riskPolicy.neverAutonomouslyDo) lines.push(`  - ${r}`);
    }

    if (packet.riskPolicy.requiresConfirmationBefore.length) {
      lines.push("", "Requires confirmation:");
      for (const r of packet.riskPolicy.requiresConfirmationBefore) lines.push(`  - ${r}`);
    }

    return {
      systemAddendum: NIGHT_POLICY_ADDENDUM,
      contextBlocks: [{
        role: "user",
        content: `<night_agent_plan>\n${lines.join("\n")}\n</night_agent_plan>`,
      }],
      toolPolicy: { prioritize: motifToolPriority(topMotif) },
    };
  }
}

const motifToolPriority = (motif: MotifMatch | null): string[] => {
  if (!motif) return [];
  switch (motif.motif) {
    case "collection_loop": return ["navigateToUrl", "getPageText", "inputText", "clickElement"];
    case "research_loop":   return ["getPageText", "searchPage", "navigateToUrl"];
    case "form_transaction": return ["inputText", "clickElement", "clickByDescription"];
    default: return ["getPageText", "navigateToUrl", "clickElement"];
  }
};
