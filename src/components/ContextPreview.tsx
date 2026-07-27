import { useEffect, useMemo, useState } from 'react';
import { useReactFlow } from '@xyflow/react';
import { useStore } from '../store/useStore';
import { toast } from '../lib/toast';
import { collectAncestors, EXCLUDE_LABEL, explainContext } from '../lib/context';
import { estimateMessageTokens, estimateTokens, formatTokens } from '../lib/tokens';
import { pathToMarkdown } from '../lib/markdown';
import type { RetrievedChunk } from '../lib/knowledge';
import { contentToText, type ResolvedAttachment } from '../lib/attachments';
import type { NodeRole } from '../types';

const ROLE_LABEL: Record<NodeRole, string> = {
  system: '系统',
  user: '你',
  assistant: 'AI',
  note: '批注',
};

const MESSAGE_ROLE_LABEL: Record<string, string> = {
  system: 'system',
  user: 'user',
  assistant: 'assistant',
};

export function ContextPreview({ open, onClose }: { open: boolean; onClose: () => void }) {
  const nodes = useStore((s) => s.graph?.nodes);
  const selectedId = useStore((s) => s.selectedId);
  const settings = useStore((s) => s.settings);
  const select = useStore((s) => s.select);
  const profile = useStore((s) => s.activeProfile());
  const graphTitle = useStore((s) => s.graph?.title);
  const retrieveKnowledge = useStore((s) => s.retrieveKnowledge);
  const hasKnowledge = useStore((s) =>
    s.knowledgeFiles.some((f) => f.enabled && f.status === 'ready'),
  );
  const { setCenter } = useReactFlow();
  const [expanded, setExpanded] = useState<number | null>(null);
  const [hits, setHits] = useState<RetrievedChunk[] | null>(null);
  const [retrieving, setRetrieving] = useState(false);
  const [retrieveError, setRetrieveError] = useState<string | null>(null);
  const [files, setFiles] = useState<Map<string, ResolvedAttachment[]> | undefined>(undefined);
  const resolveAttachments = useStore((s) => s.resolveAttachments);
  const attachmentCount = useStore((s) => s.attachments.length);

  const base = useMemo(
    () => ({ systemPrompt: settings.systemPrompt, limit: settings.contextLimit }),
    [settings.systemPrompt, settings.contextLimit],
  );

  /** 这次会拿去检索的那句话。先算一遍不带知识库的上下文，取最后一条 user */
  const query = useMemo(() => {
    if (!nodes || !selectedId || !nodes[selectedId]) return '';
    const entries = explainContext(nodes, selectedId, base).entries;
    for (let i = entries.length - 1; i >= 0; i--) {
      if (entries[i]!.message.role === 'user') return contentToText(entries[i]!.message.content);
    }
    return '';
  }, [nodes, selectedId, base]);

  /*
   * 检索要发网络请求，只能异步做。面板打开时才跑 —— 预览是个随手看的东西，
   * 不该在后台默默地一直向量化。
   */
  useEffect(() => {
    if (!open || !hasKnowledge || !query.trim()) {
      setHits(null);
      setRetrieveError(null);
      return;
    }
    let cancelled = false;
    setRetrieving(true);
    setRetrieveError(null);
    retrieveKnowledge(query)
      .then((result) => !cancelled && setHits(result))
      .catch((err: unknown) => !cancelled && setRetrieveError((err as Error)?.message ?? String(err)))
      .finally(() => !cancelled && setRetrieving(false));
    return () => {
      cancelled = true;
    };
  }, [open, hasKnowledge, query, retrieveKnowledge]);

  /*
   * 附件要读 Blob 转 data URI，是异步的。预览面板的职责就是「如实显示会发出去
   * 什么」，少显示一张图比不显示更糟，所以这里也得解析一遍。
   */
  useEffect(() => {
    if (!open || !nodes || !selectedId || !nodes[selectedId] || attachmentCount === 0) {
      setFiles(undefined);
      return;
    }
    let cancelled = false;
    void resolveAttachments(collectAncestors(nodes, selectedId)).then(
      (result) => !cancelled && setFiles(result),
    );
    return () => {
      cancelled = true;
    };
    // nodes 每次流式输出都变，但附件只跟着选中节点和附件总数走
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, selectedId, attachmentCount, resolveAttachments]);

  const explained = useMemo(() => {
    if (!nodes || !selectedId || !nodes[selectedId]) return null;
    return explainContext(nodes, selectedId, {
      ...base,
      knowledge: hits ?? undefined,
      attachments: files,
    });
  }, [nodes, selectedId, base, hits, files]);

  if (!open || !explained || !nodes) return null;

  const { entries, excluded, trimmed, usedGlobalPrompt } = explained;
  const totalTokens = estimateMessageTokens(entries.map((e) => e.message));

  const jumpTo = (nodeId: string) => {
    const node = nodes[nodeId];
    if (!node) return;
    select(nodeId);
    setCenter(node.position.x + 190, node.position.y + 100, { zoom: 1, duration: 320 });
    onClose();
  };

  const exportMarkdown = () => {
    if (!nodes || !selectedId) return;
    const md = pathToMarkdown(nodes, selectedId, {
      title: graphTitle,
      systemPrompt: settings.systemPrompt,
    });
    const blob = new Blob([md], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(graphTitle || '对话记录').replace(/[/\\:*?"<>|]/g, '_')}.md`;
    a.click();
    URL.revokeObjectURL(url);
    toast('已导出这条路径的 Markdown');
  };

  const copyPayload = () => {
    const payload = { model: profile.model, messages: entries.map((e) => e.message) };
    void navigator.clipboard
      .writeText(JSON.stringify(payload, null, 2))
      .then(() => toast('请求体已复制到剪贴板'));
  };

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <div className="preview">
        <header className="preview-head">
          <h2>这一发实际会发出去的内容</h2>
          <button className="icon-btn" onClick={onClose}>
            ✕
          </button>
        </header>

        <div className="preview-summary">
          <span>
            <b>{entries.length}</b> 条消息
          </span>
          <span>
            约 <b>{formatTokens(totalTokens)}</b> tokens
          </span>
          <span className="mono preview-model">{profile.model}</span>
          <span className="spacer" />
          <button className="btn" onClick={exportMarkdown} title="把这条路径导成可读的 Markdown">
            导出 Markdown
          </button>
          <button className="btn solid" onClick={copyPayload}>
            复制请求体
          </button>
        </div>

        <div className="preview-body">
          <ol className="preview-list">
            {entries.map((entry, i) => {
              const isOpen = expanded === i;
              const { role, content } = entry.message;
              // 内容可能是「文字 + 图片」的分段数组，文字和图片分开渲染
              const text = contentToText(content);
              const images =
                typeof content === 'string'
                  ? []
                  : content.filter((p) => p.type === 'image_url').map((p) => p.image_url.url);
              return (
                <li key={i} className={isOpen ? 'open' : ''}>
                  <div className="preview-msg-head" onClick={() => setExpanded(isOpen ? null : i)}>
                    <span className="preview-index">{i + 1}</span>
                    <span className={`preview-role role-${entry.knowledge ? 'knowledge' : role}`}>
                      {entry.knowledge ? '知识库' : MESSAGE_ROLE_LABEL[role]}
                    </span>
                    <span className="preview-tokens">≈{formatTokens(estimateTokens(text))}</span>
                    <span className="preview-sources">
                      {entry.knowledge?.map((k) => (
                        <span
                          key={k.chunkId}
                          className="preview-source static"
                          title={`第 ${k.index + 1} 块 · 相似度 ${k.score.toFixed(3)}`}
                        >
                          《{k.fileName}》<b className="mono">{k.score.toFixed(2)}</b>
                        </span>
                      ))}
                      {entry.sourceIds.map((id) => (
                        <button
                          key={id}
                          className="preview-source"
                          title="跳到这个节点"
                          onClick={(e) => {
                            e.stopPropagation();
                            jumpTo(id);
                          }}
                        >
                          {ROLE_LABEL[nodes[id]?.role ?? 'user']}节点
                        </button>
                      ))}
                      {role === 'system' && usedGlobalPrompt && (
                        <span className="preview-source static" title="来自设置里的全局 System 提示词">
                          全局提示词
                        </span>
                      )}
                    </span>
                  </div>
                  {images.length > 0 && (
                    <div className="preview-images">
                      {images.map((url, n) => (
                        <img key={n} src={url} alt={`附件图片 ${n + 1}`} />
                      ))}
                    </div>
                  )}
                  {text && (
                    <pre className={isOpen ? 'preview-content' : 'preview-content clipped'}>
                      {text}
                    </pre>
                  )}
                </li>
              );
            })}
          </ol>

          {retrieving && <div className="preview-note">正在检索知识库…</div>}
          {retrieveError && (
            <div className="preview-note warn">
              知识库检索失败，下面是<b>不带资料</b>的上下文。真正发送时也会失败并给出提示。
              <br />
              {retrieveError}
            </div>
          )}
          {hits?.length === 0 && (
            <div className="preview-note">知识库里没有检索到内容，这一发不会带资料。</div>
          )}

          {trimmed > 0 && (
            <div className="preview-note">
              还有 <b>{trimmed}</b> 条更早的消息因为「上下文条数上限」被裁掉了。上限在设置里调。
            </div>
          )}

          {excluded.length > 0 && (
            <section className="preview-excluded">
              <h3>在这条路径上、但没有发出去的 {excluded.length} 个节点</h3>
              <ul>
                {excluded.map(({ node, reason }) => (
                  <li key={node.id}>
                    <button className="preview-source" onClick={() => jumpTo(node.id)}>
                      {ROLE_LABEL[node.role]}节点
                    </button>
                    <span className="preview-excerpt">
                      {node.content.trim().slice(0, 40).replace(/\s+/g, ' ') || '（空）'}
                    </span>
                    <span className="preview-reason">{EXCLUDE_LABEL[reason]}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      </div>
    </>
  );
}
