/**
 * 通用撤销栈。做成纯函数是为了能脱离 store 单测——撤销一旦有 bug
 * 就是静默丢数据，这块必须测得动。
 *
 * 这里存的是整份状态快照而不是 diff。看着奢侈，其实不是：store 里每次
 * 改动都是 `nodes[id] = { ...old, ... }` 整体替换、从不原地改，所以两份
 * 快照之间未变的节点是同一个对象引用。一条历史记录 = 一个含 N 个指针的
 * 对象，不是深拷贝。
 */

export interface HistoryEntry<T> {
  state: T;
  label: string;
  /** 同 key 且间隔够近的连续操作合并成一条（连续打字、一次拖拽） */
  coalesceKey?: string;
  at: number;
}

export interface History<T> {
  past: HistoryEntry<T>[];
  future: HistoryEntry<T>[];
}

export const COALESCE_WINDOW_MS = 600;
export const HISTORY_LIMIT = 100;

export function emptyHistory<T>(): History<T> {
  return { past: [], future: [] };
}

/**
 * 记录一次变更前的状态。
 * 注意传入的是「变更前」的快照——撤销要回到的是那里。
 */
export function record<T>(
  history: History<T>,
  entry: HistoryEntry<T>,
  limit = HISTORY_LIMIT,
): History<T> {
  const last = history.past[history.past.length - 1];
  const canCoalesce =
    !!entry.coalesceKey &&
    last?.coalesceKey === entry.coalesceKey &&
    entry.at - last.at < COALESCE_WINDOW_MS;

  // 合并时保留更早的那个 state（撤销要一路退回到这串操作开始之前），
  // 但把时间戳推到最新，这样连续操作能一直滚下去
  const past = canCoalesce
    ? [...history.past.slice(0, -1), { ...last!, at: entry.at }]
    : [...history.past, entry];

  return {
    past: past.length > limit ? past.slice(past.length - limit) : past,
    // 产生新分支，之前的重做链作废
    future: [],
  };
}

export interface StepResult<T> {
  history: History<T>;
  state: T;
  label: string;
}

/** 返回 null 表示没有可撤销的了 */
export function undo<T>(history: History<T>, current: T): StepResult<T> | null {
  const entry = history.past[history.past.length - 1];
  if (!entry) return null;
  return {
    history: {
      past: history.past.slice(0, -1),
      future: [...history.future, { ...entry, state: current }],
    },
    state: entry.state,
    label: entry.label,
  };
}

export function redo<T>(history: History<T>, current: T): StepResult<T> | null {
  const entry = history.future[history.future.length - 1];
  if (!entry) return null;
  return {
    history: {
      past: [...history.past, { ...entry, state: current }],
      future: history.future.slice(0, -1),
    },
    state: entry.state,
    label: entry.label,
  };
}
