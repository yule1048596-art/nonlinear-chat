import { useEffect } from 'react';
import { useStore } from '../store/useStore';

function relTime(ts: number): string {
  const diff = Date.now() - ts;
  const min = Math.floor(diff / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour} 小时前`;
  return `${Math.floor(hour / 24)} 天前`;
}

export function GraphDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const graphs = useStore((s) => s.graphs);
  const current = useStore((s) => s.graph);
  const refresh = useStore((s) => s.refreshGraphList);
  const openGraph = useStore((s) => s.openGraph);
  const removeGraph = useStore((s) => s.removeGraph);
  const newGraph = useStore((s) => s.newGraph);

  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);

  if (!open) return null;

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <aside className="drawer left">
        <header className="drawer-head">
          <h2>画布</h2>
          <button className="icon-btn" onClick={onClose}>
            ✕
          </button>
        </header>
        <button
          className="btn solid block"
          onClick={() => {
            void newGraph();
            onClose();
          }}
        >
          + 新建画布
        </button>
        <ul className="graph-list">
          {graphs.map((g) => (
            <li
              key={g.id}
              className={g.id === current?.id ? 'active' : ''}
              onClick={() => {
                void openGraph(g.id);
                onClose();
              }}
            >
              <div className="graph-title">{g.title || '未命名画布'}</div>
              <div className="graph-meta">
                {g.nodeCount} 个节点 · {relTime(g.updatedAt)}
              </div>
              <button
                className="icon-btn danger"
                title="删除画布"
                onClick={(e) => {
                  e.stopPropagation();
                  if (confirm(`删除「${g.title || '未命名画布'}」？无法撤销。`)) {
                    void removeGraph(g.id);
                  }
                }}
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      </aside>
    </>
  );
}
