import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDebouncedSaver } from './db';
import type { Graph } from '../types';

const graph = (id: string, title = id): Graph => ({
  id,
  title,
  nodes: {},
  createdAt: 0,
  updatedAt: 0,
});

describe('createDebouncedSaver', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('攒够 wait 才写一次', () => {
    const write = vi.fn();
    const saver = createDebouncedSaver(600, 3000, write);

    saver.queue(graph('g'));
    saver.queue(graph('g'));
    saver.queue(graph('g'));
    expect(write).not.toHaveBeenCalled();

    vi.advanceTimersByTime(600);
    expect(write).toHaveBeenCalledTimes(1);
  });

  /** 流式输出每 33ms 一次，纯防抖永远等不到静默期，必须有 maxWait 兜底 */
  it('持续排队时靠 maxWait 强制落盘', () => {
    const write = vi.fn();
    const saver = createDebouncedSaver(600, 1000, write);

    for (let t = 0; t < 1200; t += 100) {
      saver.queue(graph('g'));
      vi.advanceTimersByTime(100);
    }
    expect(write).toHaveBeenCalled();
  });

  it('flush 立即写并清空待写入', () => {
    const write = vi.fn();
    const saver = createDebouncedSaver(600, 3000, write);

    saver.queue(graph('g'));
    saver.flush();
    expect(write).toHaveBeenCalledTimes(1);

    // 没有新的排队，再 flush 不该重复写
    saver.flush();
    expect(write).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(5000);
    expect(write).toHaveBeenCalledTimes(1);
  });

  /**
   * 这条是 bug 回归测试：删除画布时若不丢弃待写入，定时器一到会把刚删掉的
   * 画布重新写回 IndexedDB —— 用户看到的现象是「删了又自己回来了」。
   */
  it('discard 阻止已删除的画布被写回', () => {
    const write = vi.fn();
    const saver = createDebouncedSaver(600, 3000, write);

    saver.queue(graph('doomed'));
    saver.discard('doomed');

    vi.advanceTimersByTime(5000);
    expect(write).not.toHaveBeenCalled();
  });

  it('discard 只丢弃匹配的画布，不影响别的', () => {
    const write = vi.fn();
    const saver = createDebouncedSaver(600, 3000, write);

    saver.queue(graph('keep'));
    saver.discard('other'); // 待写入的是 keep，不该被误伤

    vi.advanceTimersByTime(600);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0]![0].id).toBe('keep');
  });

  it('discard 之后仍能正常排队新的写入', () => {
    const write = vi.fn();
    const saver = createDebouncedSaver(600, 3000, write);

    saver.queue(graph('doomed'));
    saver.discard('doomed');
    saver.queue(graph('fresh'));

    vi.advanceTimersByTime(600);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0]![0].id).toBe('fresh');
  });
});
