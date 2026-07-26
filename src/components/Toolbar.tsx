import { useRef } from 'react';
import { useReactFlow } from '@xyflow/react';
import { useStore } from '../store/useStore';
import type { Graph } from '../types';
import { MODE_ICON, MODE_LABEL, type ThemeMode } from '../lib/theme';
import { toast } from '../lib/toast';

export function Toolbar({
  themeMode,
  onCycleTheme,
  onOpenGraphs,
  onOpenSettings,
  onOpenSearch,
  onOpenSnapshots,
}: {
  themeMode: ThemeMode;
  onCycleTheme: () => void;
  onOpenGraphs: () => void;
  onOpenSettings: () => void;
  onOpenSearch: () => void;
  onOpenSnapshots: () => void;
}) {
  const graph = useStore((s) => s.graph);
  const renameGraph = useStore((s) => s.renameGraph);
  const newGraph = useStore((s) => s.newGraph);
  const importGraph = useStore((s) => s.importGraph);
  const settings = useStore((s) => s.settings);
  const updateSettings = useStore((s) => s.updateSettings);
  const applyLayout = useStore((s) => s.applyLayout);
  const { getNodes, fitView } = useReactFlow();
  const fileRef = useRef<HTMLInputElement>(null);

  // 画布上可以同时跑多个分支，但正在生成的节点可能在视野外，这里给个总数
  const streamingCount = useStore(
    (s) => Object.values(s.graph?.nodes ?? {}).filter((n) => n.status === 'streaming').length,
  );

  const exportGraph = () => {
    if (!graph) return;
    const blob = new Blob([JSON.stringify(graph, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${graph.title || 'canvas'}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text()) as Graph;
      if (!parsed?.nodes || typeof parsed.nodes !== 'object') throw new Error('缺少 nodes 字段');
      await importGraph(parsed);
      toast('导入成功');
    } catch (err) {
      toast(`导入失败：${(err as Error).message}`);
    } finally {
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const tidy = () => {
    /*
     * 节点尺寸直接从 React Flow 的节点对象上取。Canvas 修小地图时已经把
     * dimensions 变更写回了 measured，这里正好复用，不用再测一遍。
     */
    const dimensions = new Map<string, { width: number; height: number }>();
    for (const n of getNodes()) {
      if (n.measured?.width && n.measured?.height) {
        dimensions.set(n.id, { width: n.measured.width, height: n.measured.height });
      }
    }
    if (applyLayout(dimensions)) {
      void fitView({ duration: 400, padding: 0.15 });
      toast('已整理 · ⌘Z 撤销');
    } else {
      toast('已经是整齐的了');
    }
  };

  const activeProfile = settings.profiles.find((p) => p.id === settings.activeProfileId);

  return (
    <header className="toolbar">
      <div className="brand">
        <span className="brand-mark">◈</span>
        <span className="brand-name">Nexus</span>
      </div>

      <div className="toolbar-group">
        <button className="btn" onClick={onOpenGraphs} title="所有画布">
          画布
        </button>
        <button className="btn" onClick={() => void newGraph()} title="新建画布">
          新建
        </button>
        <button className="btn" onClick={onOpenSearch} title="搜索节点内容　⌘/Ctrl + K">
          搜索
        </button>
        <button className="btn" onClick={tidy} title="按分层自动排版，可撤销">
          整理
        </button>
        <button className="btn" onClick={onOpenSnapshots} title="本地快照与回滚">
          快照
        </button>
      </div>

      <span className="toolbar-sep" />

      <input
        className="title-input"
        value={graph?.title ?? ''}
        placeholder="未命名画布"
        onChange={(e) => renameGraph(e.target.value)}
      />

      <span className="spacer" />

      {streamingCount > 0 && (
        <span className="streaming-badge" title="正在生成的节点数">
          <span className="pulse" />
          {streamingCount} 个生成中
        </span>
      )}

      <select
        className="select"
        value={settings.activeProfileId}
        onChange={(e) => updateSettings({ activeProfileId: e.target.value })}
        title="新节点使用的模型配置"
      >
        {settings.profiles.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name} · {p.model}
          </option>
        ))}
      </select>

      {!activeProfile?.apiKey && (
        <button className="btn warn" onClick={onOpenSettings}>
          未配置 Key
        </button>
      )}

      <span className="toolbar-sep" />

      <div className="toolbar-group">
        <button className="icon-btn" onClick={exportGraph} title="导出为 JSON">
          ↓
        </button>
        <button className="icon-btn" onClick={() => fileRef.current?.click()} title="从 JSON 导入">
          ↑
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          hidden
          onChange={(e) => void onFile(e.target.files?.[0])}
        />
        <button className="icon-btn" onClick={onCycleTheme} title={`主题：${MODE_LABEL[themeMode]}`}>
          {MODE_ICON[themeMode]}
        </button>
        <button className="btn" onClick={onOpenSettings}>
          设置
        </button>
      </div>
    </header>
  );
}
