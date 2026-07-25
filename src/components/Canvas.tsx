import { useCallback, useMemo, useRef } from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
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
const ROLE_COLOR: Record<string, string> = {
  system: '#a78bfa',
  user: '#38bdf8',
  assistant: '#34d399',
  note: '#fbbf24',
};

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

    for (const node of Object.values(nodes)) {
      alive.add(node.id);
      const isSelected = node.id === selectedId;
      const inContext = contextSet.has(node.id) && !isSelected;
      const prev = cache.get(node.id);
      if (
        prev &&
        prev.position.x === node.position.x &&
        prev.position.y === node.position.y &&
        prev.selected === isSelected &&
        (prev.data as { inContext: boolean }).inContext === inContext
      ) {
        out.push(prev);
        continue;
      }
      const next: Node = {
        id: node.id,
        type: 'message',
        position: node.position,
        selected: isSelected,
        data: { inContext },
      };
      cache.set(node.id, next);
      out.push(next);
    }
    for (const key of [...cache.keys()]) if (!alive.has(key)) cache.delete(key);
    return out;
  }, [nodes, selectedId, contextSet]);

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
        if (prev && prev.animated === active && prev.className === (active ? 'edge-active' : '')) {
          out.push(prev);
          continue;
        }
        const next: Edge = {
          id,
          source: parentId,
          target: node.id,
          animated: active,
          className: active ? 'edge-active' : '',
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
      for (const change of changes) {
        if (change.type === 'position' && change.position) {
          moveNode(change.id, change.position);
        } else if (change.type === 'select' && change.selected) {
          select(change.id);
        }
      }
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
      onToast('新建了一个游离节点，拖它的顶部圆点可以接到任意节点下面');
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
      onEdgesDelete={onEdgesDelete}
      onPaneClick={() => select(null)}
      onDoubleClick={onPaneDoubleClick}
      minZoom={0.15}
      maxZoom={2}
      defaultViewport={{ x: 80, y: 80, zoom: 0.8 }}
      proOptions={{ hideAttribution: false }}
      deleteKeyCode={null}
      // 必须关掉：d3-zoom 的双击缩放会 stopPropagation，把 onDoubleClick 吃掉。
      // 在这个应用里「双击空白处建节点」也比双击缩放有用得多。
      zoomOnDoubleClick={false}
    >
      <Background variant={BackgroundVariant.Dots} gap={22} size={1.5} color="#2a3346" />
      <Controls showInteractive={false} />
      <MiniMap
        pannable
        zoomable
        nodeColor={(n) => {
          const role = nodes?.[n.id]?.role ?? 'user';
          return ROLE_COLOR[role] ?? '#64748b';
        }}
        maskColor="rgba(9,12,20,0.75)"
      />
    </ReactFlow>
  );
}
