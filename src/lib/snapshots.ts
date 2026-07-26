import type { Graph, Settings } from '../types';

/** 保留多少份；超出后丢最旧的 */
export const SNAPSHOT_LIMIT = 10;

/** 自动快照的最小间隔。太密只会把有用的旧快照挤出保留窗口 */
export const AUTO_INTERVAL_MS = 5 * 60 * 1000;

export type SnapshotReason = '自动' | '删除画布前' | '导入前' | '恢复前' | '手动';

export interface Snapshot {
  id: string;
  createdAt: number;
  reason: SnapshotReason;
  /** 内容签名，用来跳过「什么都没改」的快照 */
  signature: string;
  graphs: Graph[];
  settings: Settings;
}

export interface SnapshotMeta {
  id: string;
  createdAt: number;
  reason: SnapshotReason;
  graphCount: number;
  nodeCount: number;
}

/**
 * 内容签名。
 *
 * 不去哈希整份数据——画布可能几 MB，为了去重把它全序列化一遍不划算。
 * 每次改动都会 bump 画布的 updatedAt（所有变更都走 store 的 commit），
 * 所以「id + updatedAt」的组合已经能精确反映有没有变化，而且是 O(画布数)。
 * 设置很小，直接序列化。
 */
export function buildSignature(graphs: Graph[], settings: Settings): string {
  const graphPart = [...graphs]
    .map((g) => `${g.id}@${g.updatedAt}`)
    .sort()
    .join(',');
  return `${graphPart}|${JSON.stringify(settings)}`;
}

export function toMeta(snapshot: Snapshot): SnapshotMeta {
  return {
    id: snapshot.id,
    createdAt: snapshot.createdAt,
    reason: snapshot.reason,
    graphCount: snapshot.graphs.length,
    nodeCount: snapshot.graphs.reduce((sum, g) => sum + Object.keys(g.nodes ?? {}).length, 0),
  };
}

/** 返回超出保留数量、应当删除的快照 id（最旧的先淘汰） */
export function pruneIds(snapshots: SnapshotMeta[], limit = SNAPSHOT_LIMIT): string[] {
  if (snapshots.length <= limit) return [];
  return [...snapshots]
    .sort((a, b) => a.createdAt - b.createdAt)
    .slice(0, snapshots.length - limit)
    .map((s) => s.id);
}

export interface ShouldSnapshotInput {
  reason: SnapshotReason;
  signature: string;
  /** 最近一份快照，没有就传 undefined */
  latest?: { signature: string; createdAt: number };
  now: number;
}

/**
 * 要不要真的存这一份。
 *
 * 手动和破坏性操作前的快照一律要存 —— 那正是最需要回滚点的时刻，
 * 哪怕内容和上一份完全相同（比如连着删两个画布）。
 * 只有周期性的「自动」快照才做去重和间隔限制。
 */
export function shouldSnapshot({ reason, signature, latest, now }: ShouldSnapshotInput): boolean {
  if (reason !== '自动') return true;
  if (!latest) return true;
  if (latest.signature === signature) return false; // 什么都没改
  return now - latest.createdAt >= AUTO_INTERVAL_MS;
}
