// Приоритетная очередь задач.
import type { Task, TaskType } from "../shared/types";

export class TaskQueue {
  private items: Task[] = [];

  push(task: Task): void {
    this.items.push(task);
    this.items.sort((a, b) => {
      if (b.priority !== a.priority) return b.priority - a.priority;
      return a.createdAt - b.createdAt;
    });
  }

  pop(now: number = Date.now()): Task | undefined {
    const idx = this.items.findIndex((t) => (t.retryAt ?? 0) <= now);
    if (idx === -1) return undefined;
    return this.items.splice(idx, 1)[0];
  }

  removeByCandidate(candidateId: string): number {
    let n = 0;
    this.items = this.items.filter((t) => {
      if (t.candidateId === candidateId) { n++; return false; }
      return true;
    });
    return n;
  }

  clear(): void {
    this.items.length = 0;
  }

  byType(type: TaskType): Task[] {
    return this.items.filter((t) => t.type === type);
  }

  get size(): number { return this.items.length; }
  get isEmpty(): boolean { return this.items.length === 0; }
  get all(): readonly Task[] { return this.items; }
}
