import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import { useStore } from './store/useStore';
import { buildContext } from './lib/context';
import { estimateMessageTokens, formatTokens } from './lib/tokens';
import { applyThemeMode, loadThemeMode, watchSystemTheme, NEXT_MODE, type ThemeMode } from './lib/theme';
import { subscribeToast, toast } from './lib/toast';
import { Canvas } from './components/Canvas';
import { Toolbar } from './components/Toolbar';
import { GraphDrawer } from './components/GraphDrawer';
import { SettingsPanel } from './components/SettingsPanel';
import { SearchPalette } from './components/SearchPalette';
import { SnapshotDrawer } from './components/SnapshotDrawer';
import { ContextPreview } from './components/ContextPreview';
import { BranchCompare } from './components/BranchCompare';
import { AUTO_INTERVAL_MS } from './lib/snapshots';

/** 选中节点时告诉用户「这一发到底会带多少上下文」—— 非线性对话最容易失控的就是这个 */
function ContextBar({ onOpen }: { onOpen: () => void }) {
  const nodes = useStore((s) => s.graph?.nodes);
  const selectedId = useStore((s) => s.selectedId);
  const settings = useStore((s) => s.settings);

  /*
   * 流式输出时 nodes 每 33ms 就换一个新对象，而算一次上下文要走完整祖先链
   * 再拼字符串。用 deferred 值把这个计算降到浏览器空闲时做：状态栏的数字
   * 晚几十毫秒更新完全无所谓，卡住画布才是问题。
   */
  const deferredNodes = useDeferredValue(nodes);

  const stats = useMemo(() => {
    if (!deferredNodes || !selectedId || !deferredNodes[selectedId]) return null;
    const messages = buildContext(deferredNodes, selectedId, {
      systemPrompt: settings.systemPrompt,
      limit: settings.contextLimit,
    });
    return {
      count: messages.filter((m) => m.role !== 'system').length,
      hasSystem: messages.some((m) => m.role === 'system'),
      tokens: estimateMessageTokens(messages),
    };
  }, [deferredNodes, selectedId, settings.systemPrompt, settings.contextLimit]);

  if (!stats) return null;

  return (
    <button className="context-bar" onClick={onOpen} title="点开看实际会发出去的完整内容">
      <span className="dot" />
      这一发会带上 <b>{stats.count}</b> 条消息
      {stats.hasSystem && ' + system'} · 约 <b>{formatTokens(stats.tokens)}</b> tokens
      <span className="context-bar-hint">点开逐条查看</span>
    </button>
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

/** 对比面板的开关在 store 里，单独包一层免得 App 为它整体重渲染 */
function BranchCompareHost() {
  const compareNodeId = useStore((s) => s.compareNodeId);
  const setCompare = useStore((s) => s.setCompare);
  return <BranchCompare nodeId={compareNodeId} onClose={() => setCompare(null)} />;
}

export default function App() {
  const init = useStore((s) => s.init);
  const ready = useStore((s) => s.ready);
  const undo = useStore((s) => s.undo);
  const redo = useStore((s) => s.redo);
  const takeSnapshot = useStore((s) => s.takeSnapshot);
  const [graphsOpen, setGraphsOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [snapshotsOpen, setSnapshotsOpen] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => loadThemeMode());
  const toastTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    void init();
  }, [init]);

  /*
   * 周期性自动快照。takeSnapshot 内部会在内容没变时跳过，所以这里定时器
   * 打得比实际存盘频繁没关系。ready 之前不能打——那时还没读出数据，
   * 会存下一份空的把有用的挤出保留窗口。
   */
  useEffect(() => {
    if (!ready) return;
    void takeSnapshot('自动');
    const timer = setInterval(() => void takeSnapshot('自动'), AUTO_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [ready, takeSnapshot]);

  useEffect(() => {
    applyThemeMode(themeMode);
    if (themeMode !== 'system') return;
    return watchSystemTheme(() => applyThemeMode('system'));
  }, [themeMode]);

  useEffect(
    () =>
      subscribeToast((msg) => {
        setToastMsg(msg);
        clearTimeout(toastTimer.current);
        toastTimer.current = setTimeout(() => setToastMsg(null), 3200);
      }),
    [],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setGraphsOpen(false);
        setSettingsOpen(false);
        setPreviewOpen(false);
        useStore.getState().setCompare(null);
        return;
      }
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSearchOpen((v) => !v);
        return;
      }
      if (e.key.toLowerCase() !== 'z') return;
      // 全局拦截，textarea 里也走我们自己的撤销：受控输入上浏览器原生撤销
      // 行为不可靠（React 每次都会把 value 覆盖回去）。文本粒度靠 coalesce 保证。
      e.preventDefault();
      const label = e.shiftKey ? redo() : undo();
      if (label) toast(`${e.shiftKey ? '重做' : '撤销'}：${label}`);
      else toast(e.shiftKey ? '没有可重做的操作' : '没有可撤销的操作');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, redo]);

  if (!ready) return <div className="boot">正在打开画布…</div>;

  return (
    <ReactFlowProvider>
      <div className="app">
        <Toolbar
          themeMode={themeMode}
          onCycleTheme={() => setThemeMode((m) => NEXT_MODE[m])}
          onOpenGraphs={() => setGraphsOpen(true)}
          onOpenSettings={() => setSettingsOpen(true)}
          onOpenSearch={() => setSearchOpen(true)}
          onOpenSnapshots={() => setSnapshotsOpen(true)}
        />
        <main className="canvas-wrap">
          <Canvas />
          <EmptyHint />
          <ContextBar onOpen={() => setPreviewOpen(true)} />
        </main>
        <GraphDrawer open={graphsOpen} onClose={() => setGraphsOpen(false)} />
        <SettingsPanel open={settingsOpen} onClose={() => setSettingsOpen(false)} />
        <SearchPalette open={searchOpen} onClose={() => setSearchOpen(false)} />
        <SnapshotDrawer open={snapshotsOpen} onClose={() => setSnapshotsOpen(false)} />
        <ContextPreview open={previewOpen} onClose={() => setPreviewOpen(false)} />
        <BranchCompareHost />
        {toastMsg && <div className="toast">{toastMsg}</div>}
      </div>
    </ReactFlowProvider>
  );
}
