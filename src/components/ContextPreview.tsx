import { useMemo, useState } from 'react';
import { useReactFlow } from '@xyflow/react';
import { useStore } from '../store/useStore';
import { toast } from '../lib/toast';
import { EXCLUDE_LABEL, explainContext } from '../lib/context';
import { estimateMessageTokens, estimateTokens, formatTokens } from '../lib/tokens';
import { pathToMarkdown } from '../lib/markdown';
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
  const { setCenter } = useReactFlow();
  const [expanded, setExpanded] = useState<number | null>(null);

  const explained = useMemo(() => {
    if (!nodes || !selectedId || !nodes[selectedId]) return null;
    return explainContext(nodes, selectedId, {
      systemPrompt: settings.systemPrompt,
      limit: settings.contextLimit,
    });
  }, [nodes, selectedId, settings.systemPrompt, settings.contextLimit]);

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
              return (
                <li key={i} className={isOpen ? 'open' : ''}>
                  <div className="preview-msg-head" onClick={() => setExpanded(isOpen ? null : i)}>
                    <span className="preview-index">{i + 1}</span>
                    <span className={`preview-role role-${role}`}>{MESSAGE_ROLE_LABEL[role]}</span>
                    <span className="preview-tokens">≈{formatTokens(estimateTokens(content))}</span>
                    <span className="preview-sources">
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
                  <pre className={isOpen ? 'preview-content' : 'preview-content clipped'}>
                    {content}
                  </pre>
                </li>
              );
            })}
          </ol>

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
