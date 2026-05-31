import { z } from "zod";
import { defineTool, registerTools } from "./tool";

export interface TodoItem {
  id: number;
  text: string;
  done: boolean;
  addedAt: number;
}

/** In-memory TODO list scoped to one agent session. Cleared on clearMessages(). */
export class TodoStore {
  private items: TodoItem[] = [];
  private nextId = 1;

  add(text: string): TodoItem {
    const item: TodoItem = {
      id: this.nextId++,
      text,
      done: false,
      addedAt: Date.now(),
    };
    this.items.push(item);
    return item;
  }

  complete(id: number): boolean {
    const item = this.items.find((i) => i.id === id);
    if (!item || item.done) return false;
    item.done = true;
    return true;
  }

  remove(id: number): boolean {
    const idx = this.items.findIndex((i) => i.id === id);
    if (idx === -1) return false;
    this.items.splice(idx, 1);
    return true;
  }

  list(): TodoItem[] {
    return [...this.items];
  }

  pending(): TodoItem[] {
    return this.items.filter((i) => !i.done);
  }

  clear(): void {
    this.items = [];
    this.nextId = 1;
  }
}

export const todoTools = registerTools({
  todoAdd: defineTool({
    description:
      "Add a sub-task or reminder to your TODO list. Use this to track what still needs to be done on a complex multi-step task so you don't lose track as context grows. Returns the assigned id.",
    inputSchema: z.object({
      text: z
        .string()
        .min(1)
        .max(300)
        .describe("Short description of what needs to be done"),
    }),
    execute: async ({ text }, ctx) => {
      if (!ctx.todos) return { error: "TODO store not available" };
      const item = ctx.todos.add(text);
      return { id: item.id, text: item.text, pending: ctx.todos.pending().length };
    },
  }),

  todoComplete: defineTool({
    description:
      "Mark a TODO item as done by its id. Call this as soon as you finish a sub-task so the list stays accurate.",
    inputSchema: z.object({
      id: z.number().int().positive().describe("Id returned by todoAdd"),
    }),
    execute: async ({ id }, ctx) => {
      if (!ctx.todos) return { error: "TODO store not available" };
      const ok = ctx.todos.complete(id);
      if (!ok) return { error: `No pending item with id ${id}` };
      return { completed: id, remaining: ctx.todos.pending().length };
    },
  }),

  todoList: defineTool({
    description:
      "List all TODO items (pending and done). Use this when you need a reminder of what's left on the current task.",
    inputSchema: z.object({}),
    execute: async (_input, ctx) => {
      if (!ctx.todos) return { error: "TODO store not available" };
      const all = ctx.todos.list();
      const pending = all.filter((i) => !i.done);
      const done = all.filter((i) => i.done);
      return {
        pending: pending.map((i) => ({ id: i.id, text: i.text })),
        done: done.map((i) => ({ id: i.id, text: i.text })),
        summary: `${pending.length} pending, ${done.length} done`,
      };
    },
  }),

  todoRemove: defineTool({
    description:
      "Remove a TODO item entirely (use when a planned step turns out to be unnecessary rather than completed).",
    inputSchema: z.object({
      id: z.number().int().positive().describe("Id of the item to remove"),
    }),
    execute: async ({ id }, ctx) => {
      if (!ctx.todos) return { error: "TODO store not available" };
      const ok = ctx.todos.remove(id);
      if (!ok) return { error: `No item with id ${id}` };
      return { removed: id, remaining: ctx.todos.pending().length };
    },
  }),
});
