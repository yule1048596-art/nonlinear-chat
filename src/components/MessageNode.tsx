import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { useStore } from '../store/useStore';
import { toast } from '../lib/toast';
import { inContextByDefault, isInContext } from '../lib/context';
import { findSiblings } from '../lib/markdown';
import type { NodeRole } from '../types';
import { ContextMenu, type MenuAnchor } from './ContextMenu';
import { Markdown } from './Markdown';
import { AttachButton, NodeAttachments } from './NodeAttachments';

/**
 * 可互相切换的节点类型。assistant 刻意排除在外：它的内容是模型生成的，
 * 改成 user/note 会让「这句话是谁说的」和实际来源脱节，上下文就不可信了。
 */
const SWITCHABLE_ROLES: Array<{ role: Exclude<NodeRole, 'assistant'>; hint: string }> = [
  { role: 'user', hint: '作为提问发出去' },
  { role: 'system', hint: '注入下游所有分支' },
  { role: 'note', hint: '默认不进上下文' },
];

const ROLE_LABEL: Record<NodeRole, string> = {
  system: '系统',
  user: '你',
  assistant: 'AI',
  note: '批注',
};

const PLACEHOLDER: Record<NodeRole, string> = {
  user: '问点什么…',
  system: '作为 system 提示注入下游所有分支',
  note: '画布批注，默认不进入上下文',
  assistant: '',
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
    el.style.height = `${Math.min(el.scrollHeight, 400)}px`;
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
  const setCompare = useStore((s) => s.setCompare);
  const updateNode = useStore((s) => s.updateNode);
  const removeNode = useStore((s) => s.removeNode);
  const addChild = useStore((s) => s.addChild);
  const send = useStore((s) => s.send);
  const regenerate = useStore((s) => s.regenerate);
  const branchRegenerate = useStore((s) => s.branchRegenerate);
  const stop = useStore((s) => s.stop);

  const [showReasoning, setShowReasoning] = useState(false);
  const [copied, setCopied] = useState(false);
  const [roleMenu, setRoleMenu] = useState<MenuAnchor | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  const streaming = node?.status === 'streaming';
  // 只有存在「同一个问题的另一版回答」时，对比才有意义
  const siblingCount = useStore((s) =>
    s.graph ? findSiblings(s.graph.nodes, id).length : 0,
  );

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

  const {
    inContext,
    dimmed,
    hiddenCount = 0,
    hasChildren = false,
  } = (data ?? {}) as {
    inContext?: boolean;
    dimmed?: boolean;
    hiddenCount?: number;
    // 由 Canvas 统一算好下发：每个节点自己遍历全表判断是 O(N²)
    hasChildren?: boolean;
  };
  const isText = node.role !== 'assistant';
  const collapsed = node.collapsed;
  const nodeInContext = isInContext(node);
  // 只有「和该角色的默认行为不一致」时才值得在界面上标出来
  const overridden = nodeInContext !== inContextByDefault(node.role);

  const classes = [
    'node',
    `node-${node.role}`,
    selected ? 'is-selected' : '',
    inContext ? 'in-context' : '',
    dimmed ? 'is-dimmed' : '',
    !nodeInContext ? 'is-muted' : '',
    streaming ? 'is-streaming' : '',
    node.status === 'error' ? 'is-error' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={classes}>
      <Handle type="target" position={Position.Top} className="handle" />

      <header className="node-head">
        <span className="role-dot" />
        {node.role === 'assistant' ? (
          <span className="role-badge">{ROLE_LABEL.assistant}</span>
        ) : (
          <button
            className="role-badge role-switch nodrag"
            title="切换节点类型"
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              setRoleMenu({ x: r.left, y: r.bottom + 4 });
            }}
          >
            {ROLE_LABEL[node.role]}
            <span className="role-caret">▾</span>
          </button>
        )}
        {streaming && <span className="pulse" title="生成中" />}
        {/* 状态徽章常驻可见：它说明的是「这节点会不会被发出去」，藏起来等于没提示 */}
        {overridden && (
          <span className={nodeInContext ? 'context-badge on' : 'context-badge off'}>
            {nodeInContext ? '已加入上下文' : '已静音'}
          </span>
        )}
        {/* 折叠徽章不随悬停隐藏：它是当前状态的说明，藏起来用户就不知道下面还有东西 */}
        {node.subtreeCollapsed && (
          <button
            className="subtree-badge"
            title="展开下游分支"
            onClick={() => updateNode(id, { subtreeCollapsed: false })}
          >
            ▸ {hiddenCount > 0 ? `${hiddenCount} 个节点` : '已折叠'}
          </button>
        )}
        <span className="spacer" />
        <span className="node-meta-group">
          {node.role === 'assistant' && node.model && (
            <span className="node-model">{node.model}</span>
          )}
          {node.usage?.completion != null && (
            <span className="node-tokens" title="prompt → completion tokens">
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
        </span>
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
              placeholder={PLACEHOLDER[node.role]}
              onChange={(v) => updateNode(id, { content: v })}
              onSubmit={node.role === 'user' ? () => void send(id) : undefined}
            />
          ) : (
            <>
              {node.reasoning && (
                <div className="reasoning">
                  <button className="reasoning-toggle" onClick={() => setShowReasoning((v) => !v)}>
                    {showReasoning ? '▾' : '▸'} 思考过程 · {node.reasoning.length} 字
                  </button>
                  {showReasoning && <pre className="reasoning-body">{node.reasoning}</pre>}
                </div>
              )}
              {node.content ? (
                <Markdown>{node.content}</Markdown>
              ) : (
                <div className="node-placeholder">{streaming ? '正在生成…' : '还没有内容'}</div>
              )}
            </>
          )}
          {/* 附件条紧贴正文下方：它是这条消息的一部分，不是操作栏上的按钮 */}
          <NodeAttachments nodeId={id} />
          {node.error && <div className="node-error">{node.error}</div>}
        </div>
      )}

      <footer className="node-actions nodrag">
        {node.role === 'user' && (
          <button
            className="btn primary"
            onClick={() => void send(id)}
            disabled={streaming}
            title="⌘/Ctrl + Enter"
          >
            发送
          </button>
        )}
        {/* 只有用户侧的消息能带附件 —— 模型的回答里不存在这回事 */}
        {isText && <AttachButton nodeId={id} />}
        {node.role === 'assistant' &&
          (streaming ? (
            <button className="btn solid" onClick={() => stop(id)}>
              停止
            </button>
          ) : (
            <>
              <button className="btn solid" onClick={() => addChild(id, 'user')}>
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
                并排
              </button>
              {siblingCount > 1 && (
                <button
                  className="btn"
                  onClick={() => setCompare(id)}
                  title={`和同一个问题的另外 ${siblingCount - 1} 个回答并排比较`}
                >
                  对比 {siblingCount}
                </button>
              )}
            </>
          ))}
        {node.role !== 'assistant' && (
          <button className="btn" onClick={() => addChild(id, 'user')} title="接一个新的提问节点">
            分支
          </button>
        )}
        <span className="spacer" />
        <button
          className="icon-btn"
          title={
            nodeInContext
              ? '在上下文中 · 点击静音（留在画布上但不发出去）'
              : node.role === 'note'
                ? '批注默认不进上下文 · 点击让它参与'
                : '已静音 · 点击恢复'
          }
          onClick={() => updateNode(id, { contextMode: nodeInContext ? 'exclude' : 'include' })}
        >
          {nodeInContext ? '◉' : '◌'}
        </button>
        {hasChildren && (
          <button
            className="icon-btn"
            title={node.subtreeCollapsed ? '展开下游分支' : '折叠下游分支'}
            onClick={() => updateNode(id, { subtreeCollapsed: !node.subtreeCollapsed })}
          >
            {node.subtreeCollapsed ? '⊞' : '⊟'}
          </button>
        )}
        {node.content && (
          <button className="icon-btn" title="复制内容" onClick={copy}>
            {copied ? '✓' : '⧉'}
          </button>
        )}
        <button
          className="icon-btn danger"
          title="删除（按住 Shift 连同所有下游一起删）"
          onClick={(e) => {
            const count = removeNode(id, e.shiftKey);
            // 有撤销之后，模态确认框是更差的选择：挡路，而且删错了本来就能撤回来
            toast(count > 1 ? `已删除 ${count} 个节点 · ⌘Z 撤销` : '已删除 · ⌘Z 撤销');
          }}
        >
          ✕
        </button>
      </footer>

      <Handle type="source" position={Position.Bottom} className="handle" />

      <ContextMenu
        anchor={roleMenu}
        items={SWITCHABLE_ROLES.filter((r) => r.role !== node.role).map((r) => ({
          label: `改为「${ROLE_LABEL[r.role]}」`,
          hint: r.hint,
          onSelect: () => updateNode(id, { role: r.role }),
        }))}
        onClose={() => setRoleMenu(null)}
      />
    </div>
  );
});
