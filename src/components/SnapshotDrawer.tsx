import { useEffect, useState } from 'react';
import { useStore } from '../store/useStore';
import { toast } from '../lib/toast';
import { loadSnapshot } from '../lib/db';
import { SNAPSHOT_LIMIT, type Snapshot, type SnapshotReason } from '../lib/snapshots';

const REASON_CLASS: Record<SnapshotReason, string> = {
  自动: 'auto',
  删除画布前: 'guard',
  导入前: 'guard',
  恢复前: 'guard',
  手动: 'manual',
};

function when(ts: number): string {
  const diff = Date.now() - ts;
  const min = Math.floor(diff / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour} 小时前`;
  const day = Math.floor(hour / 24);
  if (day < 7) return `${day} 天前`;
  return new Date(ts).toLocaleDateString('zh-CN');
}

export function SnapshotDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const snapshots = useStore((s) => s.snapshots);
  const refresh = useStore((s) => s.refreshSnapshots);
  const take = useStore((s) => s.takeSnapshot);
  const restore = useStore((s) => s.restoreSnapshot);
  const restoreGraph = useStore((s) => s.restoreGraphFromSnapshot);
  const remove = useStore((s) => s.removeSnapshot);

  const [expanded, setExpanded] = useState<Snapshot | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) void refresh();
    else setExpanded(null);
  }, [open, refresh]);

  if (!open) return null;

  const toggle = async (id: string) => {
    if (expanded?.id === id) return setExpanded(null);
    setExpanded((await loadSnapshot(id)) ?? null);
  };

  const run = async (fn: () => Promise<boolean>, ok: string) => {
    setBusy(true);
    try {
      toast((await fn()) ? ok : '恢复失败：快照已不存在');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <aside className="drawer left">
        <header className="drawer-head">
          <h2>快照</h2>
          <button className="icon-btn" onClick={onClose}>
            ✕
          </button>
        </header>

        <button
          className="btn solid block"
          disabled={busy}
          onClick={async () => {
            await take('手动');
            toast('已保存快照');
          }}
        >
          + 立即快照
        </button>

        <p className="hint">
          删画布、导入、回滚之前会自动打点，平时每 5 分钟在有改动时存一次。保留最近 {SNAPSHOT_LIMIT} 份。
          <br />
          快照和画布存在同一个数据库里 —— 它防的是误删误改，<b>清浏览器数据仍会连它一起清掉</b>。
        </p>

        {snapshots.length === 0 && <div className="empty-list">还没有快照</div>}

        <ul className="snapshot-list">
          {snapshots.map((s) => (
            <li key={s.id} className={expanded?.id === s.id ? 'expanded' : ''}>
              <div className="snapshot-row" onClick={() => void toggle(s.id)}>
                <span className={`snapshot-tag ${REASON_CLASS[s.reason]}`}>{s.reason}</span>
                <span className="snapshot-when">{when(s.createdAt)}</span>
                <span className="snapshot-meta">
                  {s.graphCount} 个画布 · {s.nodeCount} 节点
                </span>
              </div>

              {expanded?.id === s.id && (
                <div className="snapshot-detail">
                  <div className="snapshot-time">
                    {new Date(s.createdAt).toLocaleString('zh-CN')}
                  </div>
                  <ul className="snapshot-graphs">
                    {expanded.graphs.map((g) => (
                      <li key={g.id}>
                        <span className="snapshot-graph-title">
                          {g.title || '未命名画布'}
                          <span className="snapshot-meta"> · {Object.keys(g.nodes).length} 节点</span>
                        </span>
                        <button
                          className="btn"
                          disabled={busy}
                          title="只把这一个画布恢复出来，其他数据不动"
                          onClick={() =>
                            void run(
                              () => restoreGraph(s.id, g.id),
                              `已恢复「${g.title || '未命名画布'}」`,
                            )
                          }
                        >
                          恢复这个
                        </button>
                      </li>
                    ))}
                  </ul>
                  <div className="row">
                    <button
                      className="btn solid grow"
                      disabled={busy}
                      title="用这份快照整份替换当前所有画布和设置"
                      onClick={() => void run(() => restore(s.id), '已整份回滚 · 回滚前的状态也存了一份')}
                    >
                      整份回滚
                    </button>
                    <button
                      className="btn danger"
                      disabled={busy}
                      onClick={async () => {
                        await remove(s.id);
                        setExpanded(null);
                      }}
                    >
                      删除
                    </button>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      </aside>
    </>
  );
}
