import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { useStore } from '../store/useStore';
import type { NodeRole } from '../types';
import { Markdown } from './Markdown';

const ROLE_LABEL: Record<NodeRole, string> = {
  system: '系统',
  user: '你',
  assistant: 'AI',
  note: '批注',
};

function AutoTextarea({
  value,
  placeholder,
  onChange,
  onSubmit,
}: {
  value: string;
  placeholder: string;
  onChange: (v: string) => void;
  onSubmit?: () => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 420)}px`;
  }, [value]);

  return (
    <textarea
      ref={ref}
      className="node-input nodrag nowheel"
      value={value}
      placeholder={placeholder}
      spellCheck={false}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if (onSubmit && e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          onSubmit();
        }
        // 别让画布把删除键当成「删除选中节点」
        e.stopPropagation();
      }}
    />
  );
}

export const MessageNode = memo(function MessageNode({ id, data, selected }: NodeProps) {
  const node = useStore((s) => s.graph?.nodes[id]);
  const updateNode = useStore((s) => s.updateNode);
  const removeNode = useStore((s) => s.removeNode);
  const addChild = useStore((s) => s.addChild);
  const send = useStore((s) => s.send);
  const regenerate = useStore((s) => s.regenerate);
  const branchRegenerate = useStore((s) => s.branchRegenerate);
  const stop = useStore((s) => s.stop);

  const [showReasoning, setShowReasoning] = useState(false);
  const [copied, setCopied] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);

  const streaming = node?.status === 'streaming';

  // 流式输出时把视野钉在底部，除非用户自己往上滚了
  useEffect(() => {
    const el = bodyRef.current;
    if (!el || !streaming) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }, [node?.content, streaming]);

  const copy = useCallback(() => {
    if (!node) return;
    void navigator.clipboard.writeText(node.content).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  }, [node]);

  if (!node) return null;

  const inContext = (data as { inContext?: boolean })?.inContext;
  const isText = node.role !== 'assistant';
  const collapsed = node.collapsed;

  const classes = [
    'node',
    `node-${node.role}`,
    selected ? 'is-selected' : '',
    inContext ? 'in-context' : '',
    streaming ? 'is-streaming' : '',
    node.status === 'error' ? 'is-error' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={classes}>
      <Handle type="target" position={Position.Top} className="handle" />

      <header className="node-head">
        <span className="role-badge">{ROLE_LABEL[node.role]}</span>
        {node.role === 'assistant' && node.model && <span className="node-model">{node.model}</span>}
        {streaming && <span className="pulse" title="生成中" />}
        <span className="spacer" />
        {node.usage?.completion != null && (
          <span className="node-meta" title="prompt / completion tokens">
            {node.usage.prompt ?? '?'}→{node.usage.completion}
          </span>
        )}
        <button
          className="icon-btn"
          title={collapsed ? '展开' : '折叠'}
          onClick={() => updateNode(id, { collapsed: !collapsed })}
        >
          {collapsed ? '▸' : '▾'}
        </button>
      </header>

      {collapsed ? (
        <div className="node-collapsed" onDoubleClick={() => updateNode(id, { collapsed: false })}>
          {node.content.trim().split('\n')[0]?.slice(0, 80) || '（空）'}
        </div>
      ) : (
        <div className="node-body nowheel" ref={bodyRef}>
          {isText ? (
            <AutoTextarea
              value={node.content}
              placeholder={
                node.role === 'user'
                  ? '问点什么…  ⌘/Ctrl + Enter 发送'
                  : node.role === 'system'
                    ? '这条会作为 system 提示注入下游所有分支'
                    : '画布批注，默认不进入上下文'
              }
              onChange={(v) => updateNode(id, { content: v })}
              onSubmit={node.role === 'user' ? () => void send(id) : undefined}
            />
          ) : (
            <>
              {node.reasoning && (
                <div className="reasoning">
                  <button className="reasoning-toggle" onClick={() => setShowReasoning((v) => !v)}>
                    {showReasoning ? '▾' : '▸'} 思考过程（{node.reasoning.length} 字）
                  </button>
                  {showReasoning && <pre className="reasoning-body">{node.reasoning}</pre>}
                </div>
              )}
              {node.content ? (
                <Markdown>{node.content}</Markdown>
              ) : (
                <div className="node-placeholder">{streaming ? '正在生成…' : '（还没有内容）'}</div>
              )}
            </>
          )}
          {node.error && <div className="node-error">{node.error}</div>}
        </div>
      )}

      <footer className="node-actions nodrag">
        {node.role === 'user' && (
          <button className="btn primary" onClick={() => void send(id)} disabled={streaming}>
            发送
          </button>
        )}
        {node.role === 'assistant' &&
          (streaming ? (
            <button className="btn" onClick={() => stop(id)}>
              停止
            </button>
          ) : (
            <>
              <button className="btn primary" onClick={() => addChild(id, 'user')}>
                追问
              </button>
              <button className="btn" onClick={() => void regenerate(id)} title="就地重新生成">
                重生
              </button>
              <button
                className="btn"
                onClick={() => void branchRegenerate(id)}
                title="保留这个回答，在旁边并排生成另一个版本"
              >
                并排重生
              </button>
            </>
          ))}
        {node.role !== 'assistant' && (
          <button className="btn" onClick={() => addChild(id, 'user')} title="接一个新的提问节点">
            +分支
          </button>
        )}
        {node.role === 'note' && (
          <label className="checkbox" title="勾选后这条批注会作为 user 消息进入上下文">
            <input
              type="checkbox"
              checked={!!node.includeInContext}
              onChange={(e) => updateNode(id, { includeInContext: e.target.checked })}
            />
            入上下文
          </label>
        )}
        <span className="spacer" />
        {node.content && (
          <button className="icon-btn" title="复制内容" onClick={copy}>
            {copied ? '✓' : '⧉'}
          </button>
        )}
        <button
          className="icon-btn danger"
          title="删除（按住 Shift 连同所有下游一起删）"
          onClick={(e) => removeNode(id, e.shiftKey)}
        >
          ✕
        </button>
      </footer>

      <Handle type="source" position={Position.Bottom} className="handle" />
    </div>
  );
});
