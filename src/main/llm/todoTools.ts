import { z } from "zod";
import { defineTool, registerTools } from "./tool";

export type TodoStatus = "pending" | "in_progress" | "completed";

export interface TodoItem {
  id: number;
  content: string;
  status: TodoStatus;
  /** Present-progressive label shown while the task is in_progress (e.g. "Reading files…"). */
  activeForm?: string;
  addedAt: number;
}

/** In-memory TODO list scoped to one agent session. Cleared on clearMessages(). */
export class TodoStore {
  private items: TodoItem[] = [];
  private nextId = 1;

  write(todos: Array<{ content: string; status: TodoStatus; activeForm?: string }>): TodoItem[] {
    // Merge: match existing items by content to preserve ids across writes.
    const existing = new Map(this.items.map((i) => [i.content, i]));
    this.items = todos.map((t) => {
      const prev = existing.get(t.content);
      return {
        id: prev?.id ?? this.nextId++,
        content: t.content,
        status: t.status,
        activeForm: t.activeForm,
        addedAt: prev?.addedAt ?? Date.now(),
      };
    });
    return [...this.items];
  }

  list(): TodoItem[] {
    return [...this.items];
  }

  pending(): TodoItem[] {
    return this.items.filter((i) => i.status !== "completed");
  }

  clear(): void {
    this.items = [];
    this.nextId = 1;
  }

  /** Compact summary injected into every prepareStep context. */
  summary(): string | null {
    if (this.items.length === 0) return null;
    const lines = this.items.map((i) => {
      const label =
        i.status === "in_progress" && i.activeForm ? i.activeForm : i.content;
      const tag =
        i.status === "completed" ? "[done]" :
        i.status === "in_progress" ? "[active]" : "[todo]";
      return `${tag} ${label}`;
    });
    const done = this.items.filter((i) => i.status === "completed").length;
    return `Tasks (${done}/${this.items.length} done):\n${lines.join("\n")}`;
  }
}

const todoItemSchema = z.object({
  content: z.string().min(1).max(300).describe("Short description of the task"),
  status: z
    .enum(["pending", "in_progress", "completed"])
    .describe(
      "pending = not started, in_progress = currently working on it, completed = done",
    ),
  activeForm: z
    .string()
    .max(200)
    .optional()
    .describe(
      "Present-progressive label shown while in_progress, e.g. 'Reading files…' vs 'Read files'. Omit for pending/completed.",
    ),
});

export const todoTools = registerTools({
  todoWrite: defineTool({
    description:
      "Replace the entire TODO list with a new snapshot. Call this whenever the plan changes or a task's status changes. Pass ALL tasks (pending, in_progress, and completed) in order — omitting a task removes it. This is the only way to add tasks, start them, or mark them done.",
    inputSchema: z.object({
      todos: z
        .array(todoItemSchema)
        .describe("Full ordered list of tasks for this session"),
    }),
    execute: async ({ todos }, ctx) => {
      if (!ctx.todos) return { error: "TODO store not available" };
      const items = ctx.todos.write(todos);
      const pending = items.filter((i) => i.status !== "completed").length;
      const done = items.filter((i) => i.status === "completed").length;
      return {
        tasks: items.map((i) => ({ id: i.id, content: i.content, status: i.status })),
        summary: `${done} done, ${pending} remaining`,
      };
    },
  }),

  todoList: defineTool({
    description:
      "Show the current TODO list. Use before declaring a task complete or when you lose track of what remains.",
    inputSchema: z.object({}),
    execute: async (_input, ctx) => {
      if (!ctx.todos) return { error: "TODO store not available" };
      const all = ctx.todos.list();
      if (all.length === 0) return { tasks: [], summary: "No tasks recorded" };
      const done = all.filter((i) => i.status === "completed").length;
      return {
        tasks: all.map((i) => ({ id: i.id, content: i.content, status: i.status, activeForm: i.activeForm })),
        summary: `${done}/${all.length} completed`,
      };
    },
  }),
});
