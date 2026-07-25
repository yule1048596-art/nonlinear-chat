import { describe, expect, it } from 'vitest';
import {
  COALESCE_WINDOW_MS,
  emptyHistory,
  record,
  redo,
  undo,
  type History,
} from './history';

/** 用简单字符串当状态，撤销逻辑跟状态形状无关 */
const entry = (state: string, at: number, coalesceKey?: string, label = state) => ({
  state,
  label,
  coalesceKey,
  at,
});

function build(...entries: Parameters<typeof entry>[]): History<string> {
  return entries.reduce<History<string>>((h, args) => record(h, entry(...args)), emptyHistory());
}

describe('record', () => {
  it('依次追加', () => {
    const h = build(['a', 1], ['b', 2]);
    expect(h.past.map((e) => e.state)).toEqual(['a', 'b']);
  });

  it('同 key 且在时间窗内合并，保留更早的那份状态', () => {
    // 连续打字：撤销一次应该退回到这串输入开始之前，而不是退一个字符
    const h = build(['', 1000, 'text:n1'], ['a', 1100, 'text:n1'], ['ab', 1200, 'text:n1']);
    expect(h.past).toHaveLength(1);
    expect(h.past[0]!.state).toBe('');
  });

  it('超出时间窗就断开，不再合并', () => {
    const h = build(
      ['', 1000, 'text:n1'],
      ['a', 1000 + COALESCE_WINDOW_MS + 1, 'text:n1'],
    );
    expect(h.past.map((e) => e.state)).toEqual(['', 'a']);
  });

  it('key 不同不合并', () => {
    const h = build(['x', 1000, 'text:n1'], ['y', 1050, 'text:n2']);
    expect(h.past).toHaveLength(2);
  });

  it('没有 key 一律不合并', () => {
    const h = build(['x', 1000], ['y', 1001]);
    expect(h.past).toHaveLength(2);
  });

  it('新变更清空重做栈', () => {
    const h = build(['a', 1], ['b', 2]);
    const undone = undo(h, 'c')!;
    expect(undone.history.future).toHaveLength(1);
    const after = record(undone.history, entry('d', 3));
    expect(after.future).toEqual([]);
  });

  it('超出上限丢弃最旧的', () => {
    let h = emptyHistory<string>();
    for (let i = 0; i < 6; i++) h = record(h, entry(`s${i}`, i), 3);
    expect(h.past.map((e) => e.state)).toEqual(['s3', 's4', 's5']);
  });
});

describe('undo / redo', () => {
  it('撤销回到上一个状态并把当前状态推入重做栈', () => {
    const h = build(['a', 1], ['b', 2]);
    const step = undo(h, 'c')!;
    expect(step.state).toBe('b');
    expect(step.label).toBe('b');
    expect(step.history.past.map((e) => e.state)).toEqual(['a']);
    expect(step.history.future.map((e) => e.state)).toEqual(['c']);
  });

  it('撤销到底返回 null', () => {
    expect(undo(emptyHistory<string>(), 'x')).toBeNull();
  });

  it('重做返回 null 当没有可重做的', () => {
    expect(redo(emptyHistory<string>(), 'x')).toBeNull();
  });

  it('撤销后重做回到原处', () => {
    const h = build(['a', 1], ['b', 2]);
    const back = undo(h, 'c')!;
    const forward = redo(back.history, back.state)!;
    expect(forward.state).toBe('c');
    expect(forward.history.past.map((e) => e.state)).toEqual(['a', 'b']);
    expect(forward.history.future).toEqual([]);
  });

  it('连续撤销能一路退回起点', () => {
    const h = build(['s0', 1], ['s1', 2], ['s2', 3]);
    let state = 's3';
    let hist = h;
    const seen: string[] = [];
    for (;;) {
      const step = undo(hist, state);
      if (!step) break;
      hist = step.history;
      state = step.state;
      seen.push(state);
    }
    expect(seen).toEqual(['s2', 's1', 's0']);
  });
});
