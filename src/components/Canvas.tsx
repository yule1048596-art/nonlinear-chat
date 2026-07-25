import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  MiniMap,
  ReactFlow,
  useReactFlow,
  type Connection,
  type Edge,
  type Node,
  type NodeChange,
  type NodeTypes,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useStore } from '../store/useStore';
import { collectAncestors } from '../lib/context';
import { MessageNode } from './MessageNode';

const nodeTypes: NodeTypes = { message: MessageNode };

const EDGE_MARKER = { type: MarkerType.ArrowClosed, width: 14, height: 14 } as const;

export function Canvas({ onToast }: { onToast: (msg: string) => void }) {
  const nodes = useStore((s) => s.graph?.nodes);
  const selectedId = useStore((s) => s.selectedId);
  const select = useStore((s) => s.select);
  const moveNode = useStore((s) => s.moveNode);
  const linkNodes = useStore((s) => s.linkNodes);
  const unlinkNodes = useStore((s) => s.unlinkNodes);
  const addRootNode = useStore((s) => s.addRootNode);

  const { screenToFlowPosition } = useReactFlow();
  const nodeCache = useRef(new Map<string, Node>());
  const edgeCache = useRef(new Map<string, Edge>());

  /**
   * 受控模式下 React Flow 只把量到的节点尺寸通过 dimensions 变更回传，
   * 不写回我们的节点对象。小地图判断「节点有没有尺寸」看的正是这个字段，
   * 丢了它小地图就一个节点都不画。尺寸属于视图状态，所以单独存，不进 store。
   */
  const dimsRef = useRef(new Map<string, { width: number; height: number }>());
  const [dimsVersion, setDimsVersion] = useState(0);

  // 拉线过程中把所有节点的连接点都显出来，否则得靠猜往哪儿放
  useEffect(() => () => document.body.classList.remove('is-connecting'), []);

  /** 选中节点的全部祖先 —— 也就是「这一次发送真正会带上的上下文」 */
  const contextSet = useMemo(() => {
    if (!nodes || !selectedId || !nodes[selectedId]) return new Set<string>();
    return collectAncestors(nodes, selectedId);
  }, [nodes, selectedId]);

  /**
   * 流式输出时 nodes 每 33ms 变一次。如果每次都重建 React Flow 的节点对象，
   * 整张画布都会跟着重渲染。这里按 id 缓存，只有位置/选中/上下文变了才换新对象，
   * 内容变化交给 MessageNode 自己订阅 store 处理。
   */
  const rfNodes = useMemo<Node[]>(() => {
    if (!nodes) return [];
    const cache = nodeCache.current;
    const alive = new Set<string>();
    const out: Node[] = [];

    const hasSelection = !!selectedId && !!nodes[selectedId];

    for (const node of Object.values(nodes)) {
      alive.add(node.id);
      const isSelected = node.id === selectedId;
      const inContext = contextSet.has(node.id) && !isSelected;
      // 只有「存在选中节点、需要拿它作对比」时才淡化旁支。
      // 没有选中时整张画布保持正常，否则平时看什么都是灰的。
      const dimmed = hasSelection && !contextSet.has(node.id);
      const measured = dimsRef.current.get(node.id);
      const prev = cache.get(node.id);
      if (
        prev &&
        prev.position.x === node.position.x &&
        prev.position.y === node.position.y &&
        prev.selected === isSelected &&
        prev.measured === measured &&
        (prev.data as { inContext: boolean }).inContext === inContext &&
        (prev.data as { dimmed: boolean }).dimmed === dimmed
      ) {
        out.push(prev);
        continue;
      }
      const next: Node = {
        id: node.id,
        type: 'message',
        position: node.position,
        selected: isSelected,
        measured,
        data: { inContext, dimmed },
      };
      cache.set(node.id, next);
      out.push(next);
    }
    for (const key of [...cache.keys()]) if (!alive.has(key)) cache.delete(key);
    return out;
  }, [nodes, selectedId, contextSet, dimsVersion]);

  const rfEdges = useMemo<Edge[]>(() => {
    if (!nodes) return [];
    const cache = edgeCache.current;
    const alive = new Set<string>();
    const out: Edge[] = [];

    for (const node of Object.values(nodes)) {
      for (const parentId of node.parentIds) {
        if (!nodes[parentId]) continue;
        const id = `${parentId}->${node.id}`;
        alive.add(id);
        const active = contextSet.has(parentId) && contextSet.has(node.id);
        const prev = cache.get(id);
        if (prev && prev.animated === active) {
          out.push(prev);
          continue;
        }
        const next: Edge = {
          id,
          source: parentId,
          target: node.id,
          type: 'smoothstep',
          animated: active,
          className: active ? 'edge-active' : '',
          markerEnd: EDGE_MARKER,
        };
        cache.set(id, next);
        out.push(next);
      }
    }
    for (const key of [...cache.keys()]) if (!alive.has(key)) cache.delete(key);
    return out;
  }, [nodes, contextSet]);

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      let dimsChanged = false;
      for (const change of changes) {
        if (change.type === 'position' && change.position) {
          moveNode(change.id, change.position);
        } else if (change.type === 'select' && change.selected) {
          select(change.id);
        } else if (change.type === 'dimensions' && change.dimensions) {
          const prev = dimsRef.current.get(change.id);
          const { width, height } = change.dimensions;
          if (!prev || prev.width !== width || prev.height !== height) {
            dimsRef.current.set(change.id, { width, height });
            dimsChanged = true;
          }
        }
      }
      if (dimsChanged) setDimsVersion((v) => v + 1);
    },
    [moveNode, select],
  );

  const onConnect = useCallback(
    (conn: Connection) => {
      if (!conn.source || !conn.target) return;
      const rejection = linkNodes(conn.source, conn.target);
      if (rejection) onToast(rejection);
      else onToast('已连接 —— 这条分支的内容会一并进入下游上下文');
    },
    [linkNodes, onToast],
  );

  const onEdgesDelete = useCallback(
    (edges: Edge[]) => {
      for (const edge of edges) unlinkNodes(edge.source, edge.target);
    },
    [unlinkNodes],
  );

  const onPaneDoubleClick = useCallback(
    (event: React.MouseEvent) => {
      // ReactFlow 把 onDoubleClick 透传给根容器，双击节点内部不该新建节点
      const target = event.target as HTMLElement;
      if (!target.classList.contains('react-flow__pane')) return;
      const position = screenToFlowPosition({ x: event.clientX, y: event.clientY });
      addRootNode('user', { x: position.x - 190, y: position.y - 40 });
      onToast('新建了一个游离节点，拖它顶部的圆点可以接到任意节点下面');
    },
    [addRootNode, screenToFlowPosition, onToast],
  );

  return (
    <ReactFlow
      nodes={rfNodes}
      edges={rfEdges}
      nodeTypes={nodeTypes}
      onNodesChange={onNodesChange}
      onConnect={onConnect}
      onConnectStart={() => document.body.classList.add('is-connecting')}
      onConnectEnd={() => document.body.classList.remove('is-connecting')}
      onEdgesDelete={onEdgesDelete}
      onPaneClick={() => select(null)}
      onDoubleClick={onPaneDoubleClick}
      minZoom={0.15}
      maxZoom={2}
      defaultViewport={{ x: 80, y: 80, zoom: 0.8 }}
      deleteKeyCode={null}
      // 必须关掉：d3-zoom 的双击缩放会 stopPropagation，把 onDoubleClick 吃掉。
      // 在这个应用里「双击空白处建节点」也比双击缩放有用得多。
      zoomOnDoubleClick={false}
    >
      <Background variant={BackgroundVariant.Dots} gap={24} size={1.4} />
      <Controls showInteractive={false} position="bottom-left" />
      <MiniMap
        pannable
        zoomable
        position="bottom-right"
        nodeClassName={(n) => `mm-node mm-${nodes?.[n.id]?.role ?? 'user'}`}
        nodeStrokeWidth={0}
        nodeBorderRadius={3}
      />
    </ReactFlow>
  );
}
