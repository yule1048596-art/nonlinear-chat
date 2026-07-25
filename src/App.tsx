import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import { useStore } from './store/useStore';
import { buildContext } from './lib/context';
import { applyThemeMode, loadThemeMode, watchSystemTheme, NEXT_MODE, type ThemeMode } from './lib/theme';
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

  if (!stats) return null;

  return (
    <div className="context-bar">
      <span className="dot" />
      这一发会带上 <b>{stats.count}</b> 条消息
      {stats.hasSystem && ' + system'} · 约 <b>{stats.chars.toLocaleString()}</b> 字符
      <span className="context-bar-hint">清晰显示的节点就是会被发出去的部分</span>
    </div>
  );
}

/** 画布只有一个空节点时给点引导，免得对着一片空白发愣 */
function EmptyHint() {
  const nodes = useStore((s) => s.graph?.nodes);
  const selectedId = useStore((s) => s.selectedId);

  const isBlank = useMemo(() => {
    if (!nodes) return false;
    const list = Object.values(nodes);
    return list.length <= 1 && list.every((n) => !n.content.trim());
  }, [nodes]);

  if (!isBlank || selectedId) return null;

  return (
    <div className="empty-hint">
      <h2>在节点里写下第一个问题</h2>
      <div>
        <kbd>⌘</kbd> / <kbd>Ctrl</kbd> + <kbd>Enter</kbd> 发送
      </div>
      <div>双击空白处新建游离节点</div>
      <div>拖节点底部的圆点连到另一个节点，就能合并两条分支的上下文</div>
    </div>
  );
}

export default function App() {
  const init = useStore((s) => s.init);
  const ready = useStore((s) => s.ready);
  const [graphsOpen, setGraphsOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => loadThemeMode());
  const toastTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    void init();
  }, [init]);

  useEffect(() => {
    applyThemeMode(themeMode);
    if (themeMode !== 'system') return;
    return watchSystemTheme(() => applyThemeMode('system'));
  }, [themeMode]);

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

  if (!ready) return <div className="boot">正在打开画布…</div>;

  return (
    <div className="app">
      <Toolbar
        themeMode={themeMode}
        onCycleTheme={() => setThemeMode((m) => NEXT_MODE[m])}
        onOpenGraphs={() => setGraphsOpen(true)}
        onOpenSettings={() => setSettingsOpen(true)}
        onToast={showToast}
      />
      <main className="canvas-wrap">
        <ReactFlowProvider>
          <Canvas onToast={showToast} />
        </ReactFlowProvider>
        <EmptyHint />
        <ContextBar />
      </main>
      <GraphDrawer open={graphsOpen} onClose={() => setGraphsOpen(false)} />
      <SettingsPanel open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
