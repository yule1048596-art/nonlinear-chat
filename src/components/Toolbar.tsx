import { useRef } from 'react';
import { useStore } from '../store/useStore';
import type { Graph } from '../types';
import { MODE_ICON, MODE_LABEL, type ThemeMode } from '../lib/theme';

export function Toolbar({
  themeMode,
  onCycleTheme,
  onOpenGraphs,
  onOpenSettings,
  onToast,
}: {
  themeMode: ThemeMode;
  onCycleTheme: () => void;
  onOpenGraphs: () => void;
  onOpenSettings: () => void;
  onToast: (msg: string) => void;
}) {
  const graph = useStore((s) => s.graph);
  const renameGraph = useStore((s) => s.renameGraph);
  const newGraph = useStore((s) => s.newGraph);
  const importGraph = useStore((s) => s.importGraph);
  const settings = useStore((s) => s.settings);
  const updateSettings = useStore((s) => s.updateSettings);
  const fileRef = useRef<HTMLInputElement>(null);

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
      onToast('导入成功');
    } catch (err) {
      onToast(`导入失败：${(err as Error).message}`);
    } finally {
      if (fileRef.current) fileRef.current.value = '';
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
      </div>

      <span className="toolbar-sep" />

      <input
        className="title-input"
        value={graph?.title ?? ''}
        placeholder="未命名画布"
        onChange={(e) => renameGraph(e.target.value)}
      />

      <span className="spacer" />

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
