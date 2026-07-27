import { memo } from 'react';
import { Handle, Position, useReactFlow, type NodeProps } from '@xyflow/react';
import { useStore } from '../store/useStore';
import { inContextByDefault, isInContext } from '../lib/context';
import { estimateTokens, formatTokens } from '../lib/tokens';
import { summarize } from '../lib/view';
import type { NodeRole } from '../types';

const ROLE_LABEL: Record<NodeRole, string> = {
  system: '系统',
  user: '你',
  assistant: 'AI',
  note: '批注',
};

const EMPTY_LABEL: Record<NodeRole, string> = {
  user: '空提问',
  system: '空系统提示',
  note: '空批注',
  assistant: '还没有回答',
};

/**
 * 地图视图里的节点。
 *
 * 固定尺寸的小卡片：顶部一行身份（角色 + 模型/token），下面两行摘要。
 * 尺寸写死是为了排版整齐 —— 高矮不齐的方块堆在一起就不像一张图了，
 * 布局也能在渲染之前先算出来。
 *
 * 刻意不放任何编辑入口：这个视图是用来看结构的。想动内容双击回编辑视图，
 * 会自动居中到同一个节点上。
 */
export const MapNode = memo(function MapNode({ id, data, selected }: NodeProps) {
  const node = useStore((s) => s.graph?.nodes[id]);
  const updateNode = useStore((s) => s.updateNode);
  const setViewMode = useStore((s) => s.setViewMode);
  const { setCenter } = useReactFlow();

  if (!node) return null;

  const { inContext, dimmed, hiddenCount = 0 } = (data ?? {}) as {
    inContext?: boolean;
    dimmed?: boolean;
    hiddenCount?: number;
  };

  const streaming = node.status === 'streaming';
  const nodeInContext = isInContext(node);
  const overridden = nodeInContext !== inContextByDefault(node.role);
  const summary = summarize(node.content, 64);
  const tokens = estimateTokens(node.content);

  const classes = [
    'map-node',
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
    <div
      className={classes}
      title={summary || EMPTY_LABEL[node.role]}
      onDoubleClick={() => {
        setViewMode('edit');
        // 编辑视图的卡片高得多，往下偏一点才不会把标题顶到屏幕外
        setCenter(node.position.x + 190, node.position.y + 120, { zoom: 1, duration: 320 });
      }}
    >
      <Handle type="target" position={Position.Top} className="handle" />

      <header className="map-head">
        <span className="role-dot" />
        <span className="map-role">{ROLE_LABEL[node.role]}</span>
        {streaming && <span className="pulse" title="生成中" />}

        <span className="spacer" />

        {node.status === 'error' && (
          <span className="map-flag error" title={node.error}>
            失败
          </span>
        )}
        {/* 「会不会被发出去」在地图视图里更该显眼：一屏能看到几十个节点 */}
        {overridden && (
          <span className={nodeInContext ? 'map-flag on' : 'map-flag off'}>
            {nodeInContext ? '已加入' : '已静音'}
          </span>
        )}
        {node.subtreeCollapsed && (
          <button
            className="map-flag collapsed nodrag"
            title="展开下游分支"
            onClick={(e) => {
              e.stopPropagation();
              updateNode(id, { subtreeCollapsed: false });
            }}
          >
            ▸ {hiddenCount > 0 ? hiddenCount : ''}
          </button>
        )}
        {tokens > 0 && <span className="map-tokens">≈{formatTokens(tokens)}</span>}
      </header>

      <p className={summary ? 'map-summary' : 'map-summary is-empty'}>
        {summary || EMPTY_LABEL[node.role]}
      </p>

      <Handle type="source" position={Position.Bottom} className="handle" />
    </div>
  );
});
