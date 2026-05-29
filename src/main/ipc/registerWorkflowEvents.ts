import type { EventContext } from "./EventContext";
import type { EventRegistry, InvokeHandler } from "./EventRegistry";
import type { SessionLog } from "../SessionLog";
import { WorkflowCompiler } from "../WorkflowCompiler";
import { BehaviorGraphBuilder, summarizeGraph } from "../graph/BehaviorGraphBuilder";
import type { GraphStore } from "../graph/GraphStore";
import { TaskGraphCompiler, type PacketStore } from "../TaskGraphCompiler";

export const registerWorkflowEvents = (
  registry: EventRegistry,
  ctx: EventContext,
  sessionLog: SessionLog,
  graphStore: GraphStore,
  packetStore: PacketStore,
): void => {
  const { mainWindow } = ctx;

  const getCompiler = (): WorkflowCompiler =>
    new WorkflowCompiler(sessionLog, mainWindow.sidebar.client.languageModel);

  const handlers = {
    "workflow-session-summary": () => getCompiler().sessionSummary(),
    "workflow-session-events": () =>
      getCompiler()
        .recentSessionEvents()
        .map((event) => ({
          id: event.id,
          type: event.type,
          tabId: event.channel,
          timestamp: event.timestamp,
          payload: event.payload ?? {},
        })),
    "workflow-compile": async () => {
      try {
        const workflow = await getCompiler().compile();
        return { ok: true as const, workflow };
      } catch (error) {
        return {
          ok: false as const,
          error: error instanceof Error ? error.message : "Compile failed",
        };
      }
    },
    "workflow-clear-session": () => {
      sessionLog.clear();
      return { ok: true as const };
    },
    "workflow-build-graph": () => {
      const events = sessionLog.tabEvents();
      const graph = BehaviorGraphBuilder.buildBehaviorGraph(events);
      graphStore.save(graph);
      return { ok: true as const, graphId: graph.id, summary: summarizeGraph(graph) };
    },
    "workflow-get-graph-summary": () => {
      const graph = graphStore.active();
      if (!graph) return { ok: false as const, error: "No graph built yet." };
      return { ok: true as const, graphId: graph.id, summary: summarizeGraph(graph) };
    },
    "workflow-compile-task-packet": async () => {
      const graph = graphStore.active();
      if (!graph) return { ok: false as const, error: "Build a graph first." };
      const model = mainWindow.sidebar.client.languageModel;
      if (!model) return { ok: false as const, error: "LLM not configured." };
      try {
        const compiler = new TaskGraphCompiler(model);
        const packet = await compiler.compile(graph);
        packetStore.save(packet);
        return { ok: true as const, packetId: packet.id, goal: packet.goal };
      } catch (err) {
        return {
          ok: false as const,
          error: err instanceof Error ? err.message : "Compile failed",
        };
      }
    },
    "workflow-start-night-agent": async (_: unknown, args: unknown) => {
      const { packetId } = (args ?? {}) as { packetId?: string };
      const resolved = packetId ?? packetStore.byGraphId(graphStore.active()?.id ?? "")?.id;
      if (!resolved) return { ok: false as const, error: "No packet available." };
      mainWindow.sidebar.client.setMode("night", resolved);
      const packet = packetStore.byId(resolved);
      const messageId = `night-${Date.now()}`;
      const motifInfo = packet?.motif ? ` This is a ${packet.motif} task.` : "";
      const kickMessage = packet
        ? `Night Agent: your goal is "${packet.goal}".${motifInfo} The plan is in the context above. Call your first tool now.`
        : "Night Agent active. The plan is in the context above. Call your first tool now.";
      await mainWindow.sidebar.client.sendChatMessage({ message: kickMessage, messageId });
      return { ok: true as const, packetId: resolved, messageId };
    },
    "workflow-stop-night-agent": () => {
      mainWindow.sidebar.client.setMode("normal");
      return { ok: true as const };
    },
    "workflow-get-agent-mode": () => ({
      mode: mainWindow.sidebar.client.getMode(),
    }),
  } satisfies Record<string, InvokeHandler>;

  registry.handleMany(handlers);
};
