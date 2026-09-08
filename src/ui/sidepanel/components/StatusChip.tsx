import type { JobStatus } from "../../../shared/types";

const LABELS: Record<JobStatus, string> = {
  idle: "Ожидание",
  running: "Выполняется",
  paused: "Пауза",
  completed: "Завершено",
  cancelled: "Отменено",
  failed: "Ошибка",
};

export function StatusChip({ status }: { status: JobStatus }) {
  return <span className={`status-chip ${status}`}>{LABELS[status]}</span>;
}