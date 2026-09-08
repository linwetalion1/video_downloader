// Очередь задач с приоритетами (ТЗ §20). Высокий priority = раньше.
import type { Task } from "../shared/types";

export class TaskQueue {
  private items: Task[] = [];

  push(task: Task): void {
    this.items.push(task);
    this.items.sort((a, b) => {
      if (b.priority !== a.priority) return b.priority - a.priority;
      return a.createdAt - b.createdAt;
    });
  }

  /** Возвращает следующую задачу, учитывая retryAt (отложенный retry). */
  pop(now: number = Date.now()): Task | undefined {
    const idx = this.items.findIndex((t) => (t.retryAt ?? 0) <= now);
    if (idx === -1) return undefined;
    return this.items.splice(idx, 1)[0];
  }

  peek(): Task | undefined {
    return this.items[0];
  }

  removeById(id: string): boolean {
    const idx = this.items.findIndex((t) => t.id === id);
    if (idx === -1) return false;
    this.items.splice(idx, 1);
    return true;
  }

  clear(): void {
    this.items.length = 0;
  }

  byType(type: Task["type"]): Task[] {
    return this.items.filter((t) => t.type === type);
  }

  get size(): number {
    return this.items.length;
  }

  get isEmpty(): boolean {
    return this.items.length === 0;
  }
}