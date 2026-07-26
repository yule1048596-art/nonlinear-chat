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
import { collectAncestors, collectDescendants, computeHidden } from '../lib/context';
import { toast } from '../lib/toast';
import { ContextMenu, type MenuAnchor, type MenuItem } from './ContextMenu';
import { MessageNode } from './MessageNode';

const nodeTypes: NodeTypes = { message: MessageNode };

const EDGE_MARKER = { type: MarkerType.ArrowClosed, width: 14, height: 14 } as const;

export function Canvas() {
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
  const [menu, setMenu] = useState<{ anchor: MenuAnchor; items: MenuItem[] } | null>(null);

  // 拉线过程中把所有节点的连接点都显出来，否则得靠猜往哪儿放
  useEffect(() => () => document.body.classList.remove('is-connecting'), []);

  /**
   * 哪些节点有下游。放这里算一次是必要的：原来每个 MessageNode 各自
   * 遍历全表判断，N 个节点就是 O(N²)，而流式输出每 33ms 就触发一轮。
   */
  const parentIds = useMemo(() => {
    const set = new Set<string>();
    for (const node of Object.values(nodes ?? {})) {
      for (const p of node.parentIds) set.add(p);
    }
    return set;
  }, [nodes]);

  /** 被折叠子树藏起来的节点 */
  const hidden = useMemo(() => (nodes ? computeHidden(nodes) : new Set<string>()), [nodes]);

  /** 每个折叠节点藏了多少东西，显示在徽章上，否则用户不知道下面还有内容 */
  const hiddenCounts = useMemo(() => {
    const counts = new Map<string, number>();
    if (!nodes || hidden.size === 0) return counts;
    for (const node of Object.values(nodes)) {
      if (!node.subtreeCollapsed) continue;
      let n = 0;
      for (const id of collectDescendants(nodes, node.id)) {
        if (id !== node.id && hidden.has(id)) n++;
      }
      counts.set(node.id, n);
    }
    return counts;
  }, [nodes, hidden]);

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
      const isHidden = hidden.has(node.id);
      const hiddenCount = hiddenCounts.get(node.id) ?? 0;
      const hasChildren = parentIds.has(node.id);
      const prev = cache.get(node.id);
      if (
        prev &&
        prev.position.x === node.position.x &&
        prev.position.y === node.position.y &&
        prev.selected === isSelected &&
        prev.measured === measured &&
        prev.hidden === isHidden &&
        (prev.data as { inContext: boolean }).inContext === inContext &&
        (prev.data as { dimmed: boolean }).dimmed === dimmed &&
        (prev.data as { hiddenCount: number }).hiddenCount === hiddenCount &&
        (prev.data as { hasChildren: boolean }).hasChildren === hasChildren
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
        hidden: isHidden,
        data: { inContext, dimmed, hiddenCount, hasChildren },
      };
      cache.set(node.id, next);
      out.push(next);
    }
    for (const key of [...cache.keys()]) if (!alive.has(key)) cache.delete(key);
    return out;
  }, [nodes, selectedId, contextSet, dimsVersion, hidden, hiddenCounts, parentIds]);

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
        // 只要有一端被折叠藏起来，这条边就没有意义了
        const isHidden = hidden.has(parentId) || hidden.has(node.id);
        const prev = cache.get(id);
        if (prev && prev.animated === active && prev.hidden === isHidden) {
          out.push(prev);
          continue;
        }
        const next: Edge = {
          id,
          source: parentId,
          target: node.id,
          type: 'smoothstep',
          animated: active,
          hidden: isHidden,
          className: active ? 'edge-active' : '',
          markerEnd: EDGE_MARKER,
        };
        cache.set(id, next);
        out.push(next);
      }
    }
    for (const key of [...cache.keys()]) if (!alive.has(key)) cache.delete(key);
    return out;
  }, [nodes, contextSet, hidden]);

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
      if (rejection) toast(rejection);
      else toast('已连接 —— 这条分支的内容会一并进入下游上下文');
    },
    [linkNodes],
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
      toast('新建了一个游离节点，拖它顶部的圆点可以接到任意节点下面');
    },
    [addRootNode, screenToFlowPosition],
  );

  /** 右键空白处：这是 system / note 节点唯一的创建入口 */
  const onPaneContextMenu = useCallback(
    (event: React.MouseEvent | MouseEvent) => {
      event.preventDefault();
      const flow = screenToFlowPosition({ x: event.clientX, y: event.clientY });
      const at = { x: flow.x - 190, y: flow.y - 40 };
      setMenu({
        anchor: { x: event.clientX, y: event.clientY },
        items: [
          { label: '新建提问', hint: '双击空白处', onSelect: () => addRootNode('user', at) },
          {
            label: '新建系统提示',
            hint: '注入下游所有分支',
            onSelect: () => addRootNode('system', at),
          },
          {
            label: '新建批注',
            hint: '默认不进上下文',
            onSelect: () => addRootNode('note', at),
          },
        ],
      });
    },
    [addRootNode, screenToFlowPosition],
  );

  return (
    <>
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
        onPaneContextMenu={onPaneContextMenu}
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
      <ContextMenu
        anchor={menu?.anchor ?? null}
        items={menu?.items ?? []}
        onClose={() => setMenu(null)}
      />
    </>
  );
}
