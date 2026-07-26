import { describe, expect, it } from 'vitest';
import {
  AUTO_INTERVAL_MS,
  buildSignature,
  pruneIds,
  shouldSnapshot,
  toMeta,
  type Snapshot,
  type SnapshotMeta,
} from './snapshots';
import type { Graph, Settings } from '../types';

const settings: Settings = {
  profiles: [
    { id: 'p', name: 'P', baseUrl: 'https://x/v1', apiKey: '', model: 'm', temperature: 0.7 },
  ],
  activeProfileId: 'p',
  systemPrompt: '',
  contextLimit: 0,
};

const graph = (id: string, updatedAt: number, nodeCount = 0): Graph => ({
  id,
  title: id,
  createdAt: 0,
  updatedAt,
  nodes: Object.fromEntries(
    Array.from({ length: nodeCount }, (_, i) => [
      `n${i}`,
      {
        id: `n${i}`,
        role: 'user' as const,
        content: '',
        parentIds: [],
        position: { x: 0, y: 0 },
        createdAt: 0,
        updatedAt: 0,
      },
    ]),
  ),
});

const meta = (id: string, createdAt: number): SnapshotMeta => ({
  id,
  createdAt,
  reason: '自动',
  graphCount: 1,
  nodeCount: 1,
});

describe('buildSignature', () => {
  it('内容没变时签名相同', () => {
    const a = buildSignature([graph('g1', 100), graph('g2', 200)], settings);
    const b = buildSignature([graph('g1', 100), graph('g2', 200)], settings);
    expect(a).toBe(b);
  });

  it('画布顺序不同不影响签名', () => {
    const a = buildSignature([graph('g1', 100), graph('g2', 200)], settings);
    const b = buildSignature([graph('g2', 200), graph('g1', 100)], settings);
    expect(a).toBe(b);
  });

  it('任一画布改动都会改变签名', () => {
    const before = buildSignature([graph('g1', 100)], settings);
    expect(buildSignature([graph('g1', 101)], settings)).not.toBe(before);
  });

  it('新增或删除画布会改变签名', () => {
    const one = buildSignature([graph('g1', 100)], settings);
    const two = buildSignature([graph('g1', 100), graph('g2', 100)], settings);
    expect(one).not.toBe(two);
  });

  it('设置改动会改变签名', () => {
    const before = buildSignature([graph('g1', 100)], settings);
    const after = buildSignature([graph('g1', 100)], { ...settings, systemPrompt: '改了' });
    expect(after).not.toBe(before);
  });
});

describe('shouldSnapshot', () => {
  const sig = 'sig-a';

  it('第一份总是要存', () => {
    expect(shouldSnapshot({ reason: '自动', signature: sig, now: 0 })).toBe(true);
  });

  it('自动快照：内容没变就跳过', () => {
    expect(
      shouldSnapshot({
        reason: '自动',
        signature: sig,
        latest: { signature: sig, createdAt: 0 },
        now: AUTO_INTERVAL_MS * 10,
      }),
    ).toBe(false);
  });

  it('自动快照：内容变了但间隔不够也跳过', () => {
    expect(
      shouldSnapshot({
        reason: '自动',
        signature: 'sig-b',
        latest: { signature: sig, createdAt: 0 },
        now: AUTO_INTERVAL_MS - 1,
      }),
    ).toBe(false);
  });

  it('自动快照：内容变了且间隔够就存', () => {
    expect(
      shouldSnapshot({
        reason: '自动',
        signature: 'sig-b',
        latest: { signature: sig, createdAt: 0 },
        now: AUTO_INTERVAL_MS,
      }),
    ).toBe(true);
  });

  /**
   * 破坏性操作前的快照不能因为「内容和上一份一样」被跳过 ——
   * 连着删两个画布时，第二次删除同样需要自己的回滚点。
   */
  it('破坏性操作前一律要存，哪怕内容没变、间隔很近', () => {
    for (const reason of ['删除画布前', '导入前', '恢复前', '手动'] as const) {
      expect(
        shouldSnapshot({
          reason,
          signature: sig,
          latest: { signature: sig, createdAt: 0 },
          now: 1,
        }),
      ).toBe(true);
    }
  });
});

describe('pruneIds', () => {
  it('没超出上限时不删任何东西', () => {
    expect(pruneIds([meta('a', 1), meta('b', 2)], 5)).toEqual([]);
  });

  it('超出时淘汰最旧的', () => {
    const list = [meta('new', 300), meta('old', 100), meta('mid', 200)];
    expect(pruneIds(list, 2)).toEqual(['old']);
  });

  it('一次淘汰多份', () => {
    const list = [meta('a', 1), meta('b', 2), meta('c', 3), meta('d', 4)];
    expect(pruneIds(list, 1)).toEqual(['a', 'b', 'c']);
  });

  it('不修改传入的数组', () => {
    const list = [meta('a', 3), meta('b', 1)];
    const copy = [...list];
    pruneIds(list, 1);
    expect(list).toEqual(copy);
  });
});

describe('toMeta', () => {
  it('汇总画布数和节点总数', () => {
    const snap: Snapshot = {
      id: 's',
      createdAt: 0,
      reason: '手动',
      signature: '',
      graphs: [graph('g1', 0, 3), graph('g2', 0, 2)],
      settings,
    };
    expect(toMeta(snap)).toMatchObject({ graphCount: 2, nodeCount: 5 });
  });
});
