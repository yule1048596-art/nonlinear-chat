import { useEffect, useRef, useState } from 'react';
import { useStore } from '../store/useStore';
import { toast } from '../lib/toast';
import { detectKind } from '../lib/parsers';
import type { KnowledgeFile } from '../types';

const ACCEPT = '.txt,.md,.markdown,.mdx,.docx,.epub,.csv,.json,.log,.html,.xml,.yaml,.yml';

const KIND_LABEL: Record<KnowledgeFile['kind'], string> = {
  text: 'TXT',
  markdown: 'MD',
  docx: 'DOCX',
  epub: 'EPUB',
};

function sizeOf(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function KnowledgePanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const files = useStore((s) => s.knowledgeFiles);
  const indexing = useStore((s) => s.indexing);
  const addFiles = useStore((s) => s.addKnowledgeFiles);
  const setEnabled = useStore((s) => s.setKnowledgeEnabled);
  const removeFile = useStore((s) => s.removeKnowledgeFile);
  const refresh = useStore((s) => s.refreshKnowledge);
  const embedding = useStore((s) => s.settings.embedding);
  const graphTitle = useStore((s) => s.graph?.title);

  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);

  if (!open) return null;

  const take = async (list: FileList | null) => {
    const picked = Array.from(list ?? []);
    if (!picked.length) return;

    // 先把认不出的挑出来，别让用户等索引跑完才发现文件类型不支持
    const unsupported = picked.filter((f) => !detectKind(f.name));
    const usable = picked.filter((f) => detectKind(f.name));
    if (unsupported.length) {
      toast(`跳过 ${unsupported.length} 个不支持的文件：${unsupported.map((f) => f.name).join('、')}`);
    }
    if (!usable.length) return;

    const { ok, failed } = await addFiles(usable);
    if (ok) toast(`已加入 ${ok} 个文件`);
    for (const f of failed) toast(`《${f.name}》失败：${f.error}`);
    if (inputRef.current) inputRef.current.value = '';
  };

  const enabledCount = files.filter((f) => f.enabled && f.status === 'ready').length;
  const totalChunks = files
    .filter((f) => f.enabled && f.status === 'ready')
    .reduce((sum, f) => sum + f.chunkCount, 0);

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <aside className="drawer left">
        <header className="drawer-head">
          <h2>知识库</h2>
          <button className="icon-btn" onClick={onClose}>
            ✕
          </button>
        </header>

        <p className="hint">
          这些资料对<b>「{graphTitle || '未命名画布'}」里的所有对话</b>都生效。每次提问会按语义检索
          最相关的几段，附在问题前面发出去 —— 具体带了哪几段，在「上下文预览」里能逐条看到。
        </p>

        <div
          className={`dropzone${dragging ? ' over' : ''}${indexing ? ' busy' : ''}`}
          onClick={() => !indexing && inputRef.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            if (!indexing) void take(e.dataTransfer.files);
          }}
        >
          {indexing ? (
            <>
              <div className="dropzone-title">正在索引《{indexing.name}》</div>
              <div className="dropzone-sub">
                {indexing.phase === 'parse' ? '解析文件…' : `向量化 ${indexing.done} / ${indexing.total} 块`}
              </div>
              <div className="progress">
                <div
                  className="progress-bar"
                  style={{ width: `${indexing.total ? (indexing.done / indexing.total) * 100 : 0}%` }}
                />
              </div>
            </>
          ) : (
            <>
              <div className="dropzone-title">把文件拖到这里，或点击选择</div>
              <div className="dropzone-sub">支持 txt · md · docx · epub 以及常见纯文本</div>
            </>
          )}
        </div>

        <input
          ref={inputRef}
          type="file"
          multiple
          accept={ACCEPT}
          hidden
          onChange={(e) => void take(e.target.files)}
        />

        {files.length > 0 && (
          <div className="kb-summary">
            {enabledCount} / {files.length} 个文件启用 · 共 {totalChunks} 块 · 每次检索取前{' '}
            {embedding?.topK ?? 5} 块
          </div>
        )}

        {files.length === 0 && !indexing && <div className="empty-list">这个画布还没有资料</div>}

        <ul className="kb-list">
          {files.map((f) => (
            <li key={f.id} className={f.enabled ? '' : 'off'}>
              <label className="kb-row">
                <input
                  type="checkbox"
                  checked={f.enabled}
                  onChange={(e) => void setEnabled(f.id, e.target.checked)}
                />
                <span className="kb-name" title={f.name}>
                  {f.name}
                </span>
                <span className="kb-kind">{KIND_LABEL[f.kind]}</span>
                <button
                  className="icon-btn tiny"
                  title="从知识库移除"
                  onClick={(e) => {
                    e.preventDefault();
                    void removeFile(f.id).then(() => toast(`已移除《${f.name}》`));
                  }}
                >
                  ✕
                </button>
              </label>
              <div className="kb-meta">
                {f.chunkCount} 块 · {f.charCount.toLocaleString('zh-CN')} 字 · {sizeOf(f.size)}
              </div>
              {f.warning && <div className="kb-warn">{f.warning}</div>}
              {/* 换了向量模型旧向量就不可比了，得能一眼看出来 */}
              {embedding && f.embeddingModel && f.embeddingModel !== embedding.model && (
                <div className="kb-warn">
                  建库用的是 {f.embeddingModel}，当前配置是 {embedding.model} —— 两套向量不可比，
                  建议移除后重新加入。
                </div>
              )}
            </li>
          ))}
        </ul>

        <p className="hint">
          资料和向量存在本地 IndexedDB 里，<b>不进导出的备份文件</b>（1024 维向量会让备份大出几个量级）。
          换机器时把原始文件重新拖进来即可。
        </p>
      </aside>
    </>
  );
}
