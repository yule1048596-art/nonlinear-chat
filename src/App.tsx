import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import { useStore } from './store/useStore';
import { buildContext } from './lib/context';
import { Canvas } from './components/Canvas';
import { Toolbar } from './components/Toolbar';
import { GraphDrawer } from './components/GraphDrawer';
import { SettingsPanel } from './components/SettingsPanel';

/** 选中节点时告诉用户「这一发到底会带多少上下文」—— 非线性对话最容易失控的就是这个 */
function ContextBar() {
  const nodes = useStore((s) => s.graph?.nodes);
  const selectedId = useStore((s) => s.selectedId);
  const settings = useStore((s) => s.settings);

  const stats = useMemo(() => {
    if (!nodes || !selectedId || !nodes[selectedId]) return null;
    const messages = buildContext(nodes, selectedId, {
      systemPrompt: settings.systemPrompt,
      limit: settings.contextLimit,
    });
    const chars = messages.reduce((sum, m) => sum + m.content.length, 0);
    return {
      count: messages.filter((m) => m.role !== 'system').length,
      hasSystem: messages.some((m) => m.role === 'system'),
      chars,
    };
  }, [nodes, selectedId, settings.systemPrompt, settings.contextLimit]);

  if (!stats) {
    return (
      <div className="context-bar muted">
        点一个节点，看它会带上哪些上下文 · 双击空白处新建节点
      </div>
    );
  }
  return (
    <div className="context-bar">
      <span className="dot" /> 当前上下文：<b>{stats.count}</b> 条消息
      {stats.hasSystem && ' + system'} · 约 <b>{stats.chars.toLocaleString()}</b> 字符
      <span className="context-bar-hint">高亮的节点就是会被发出去的部分</span>
    </div>
  );
}

export default function App() {
  const init = useStore((s) => s.init);
  const ready = useStore((s) => s.ready);
  const [graphsOpen, setGraphsOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    void init();
  }, [init]);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3200);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setGraphsOpen(false);
        setSettingsOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (!ready) {
    return <div className="boot">正在打开画布…</div>;
  }

  return (
    <div className="app">
      <Toolbar
        onOpenGraphs={() => setGraphsOpen(true)}
        onOpenSettings={() => setSettingsOpen(true)}
        onToast={showToast}
      />
      <main className="canvas-wrap">
        <ReactFlowProvider>
          <Canvas onToast={showToast} />
        </ReactFlowProvider>
        <ContextBar />
      </main>
      <GraphDrawer open={graphsOpen} onClose={() => setGraphsOpen(false)} />
      <SettingsPanel open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
