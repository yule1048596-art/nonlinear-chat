import { useRef } from 'react';
import { useReactFlow } from '@xyflow/react';
import { useStore } from '../store/useStore';
import { MODE_ICON, MODE_LABEL, type ThemeMode } from '../lib/theme';
import { VIEW_HINT, VIEW_LABEL, VIEW_ORDER } from '../lib/view';
import { toast } from '../lib/toast';
import { parseBackup } from '../lib/backup';
import { downloadJson } from '../lib/download';

export function Toolbar({
  themeMode,
  onCycleTheme,
  onOpenGraphs,
  onOpenSettings,
  onOpenSearch,
  onOpenSnapshots,
  onOpenKnowledge,
}: {
  themeMode: ThemeMode;
  onCycleTheme: () => void;
  onOpenGraphs: () => void;
  onOpenSettings: () => void;
  onOpenSearch: () => void;
  onOpenSnapshots: () => void;
  onOpenKnowledge: () => void;
}) {
  const graph = useStore((s) => s.graph);
  const renameGraph = useStore((s) => s.renameGraph);
  const newGraph = useStore((s) => s.newGraph);
  const importGraph = useStore((s) => s.importGraph);
  const settings = useStore((s) => s.settings);
  const updateSettings = useStore((s) => s.updateSettings);
  const applyLayout = useStore((s) => s.applyLayout);
  const importSettings = useStore((s) => s.importSettings);
  const restoreBackup = useStore((s) => s.restoreBackup);
  const viewMode = useStore((s) => s.viewMode);
  const setViewMode = useStore((s) => s.setViewMode);
  const { getNodes, fitView } = useReactFlow();
  const fileRef = useRef<HTMLInputElement>(null);

  // 知识库开着的时候每一发都会带资料，这是会影响回答的事，得在顶栏看得见
  const knowledgeCount = useStore(
    (s) => s.knowledgeFiles.filter((f) => f.enabled && f.status === 'ready').length,
  );

  // 画布上可以同时跑多个分支，但正在生成的节点可能在视野外，这里给个总数
  const streamingCount = useStore(
    (s) => Object.values(s.graph?.nodes ?? {}).filter((n) => n.status === 'streaming').length,
  );

  const exportGraph = () => {
    if (!graph) return;
    downloadJson(graph, `${graph.title || 'canvas'}.json`);
  };

  /** 一个入口认三种文件：单画布、设置备份、完整备份。认不出就说清楚，不硬塞 */
  const onFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      const parsed = parseBackup(JSON.parse(await file.text()));

      if (parsed.type === 'graph') {
        await importGraph(parsed.data);
        toast('已导入画布');
      } else if (parsed.type === 'settings') {
        const { added, skipped } = importSettings(parsed.data);
        toast(
          added
            ? `已并入 ${added} 套模型配置${skipped ? `，跳过 ${skipped} 套重复的` : ''}`
            : '这些配置本地都已经有了',
        );
      } else {
        if (
          !confirm(
            `完整恢复会用备份里的 ${parsed.data.graphs.length} 个画布和设置替换当前全部内容。\n\n恢复前会自动存一份快照，可以回滚。继续？`,
          )
        ) {
          return;
        }
        const { graphs } = await restoreBackup(parsed.data);
        toast(`已恢复 ${graphs} 个画布 · 恢复前的状态存进快照了`);
      }
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
    /*
     * 地图视图里量到的是 36px 高的 chip，照它排版一回编辑视图卡片就全压在一起了。
     * 两个视图共用坐标，所以布局必须按更占地方的那个来 —— 这里丢掉实测值，
     * 让 computeLayout 走 380×160 的兜底尺寸。
     */
    if (applyLayout(viewMode === 'map' ? undefined : dimensions)) {
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
        <button className="btn quiet" onClick={onOpenSearch} title="搜索节点内容　⌘/Ctrl + K">
          搜索
        </button>
        <button className="btn quiet" onClick={tidy} title="按分层自动排版，可撤销">
          整理
        </button>
        <button className="btn quiet" onClick={onOpenSnapshots} title="本地快照与回滚">
          快照
        </button>
      </div>

      <span className="toolbar-sep" />

      {/*
        * 三个视图是互斥的模式，用分段控件而不是三个独立开关 ——
        * 一眼看得出有几种、现在在哪一种。
        */}
      <div className="segmented" role="group" aria-label="视图">
        {VIEW_ORDER.map((mode) => (
          <button
            key={mode}
            className={viewMode === mode ? 'segment is-active' : 'segment'}
            aria-pressed={viewMode === mode}
            title={`${VIEW_LABEL[mode]}视图：${VIEW_HINT[mode]}`}
            onClick={() => setViewMode(mode)}
          >
            {VIEW_LABEL[mode]}
          </button>
        ))}
      </div>

      <div className="toolbar-group">
        <button
          className={knowledgeCount ? 'btn on' : 'btn'}
          onClick={onOpenKnowledge}
          title="这个画布的公用知识库"
        >
          知识库{knowledgeCount > 0 && ` · ${knowledgeCount}`}
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
        <button
          className="icon-btn"
          onClick={() => fileRef.current?.click()}
          title="导入：画布 / 设置 / 完整备份都认"
        >
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
