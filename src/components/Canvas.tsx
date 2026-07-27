import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  MiniMap,
  Panel,
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
import { collectAncestors, collectDescendants, computeHidden, type NodeMap } from '../lib/context';
import { computeLayout } from '../lib/autoLayout';
import {
  MAP_NODE_HEIGHT,
  MAP_NODE_SEP,
  MAP_NODE_WIDTH,
  MAP_RANK_SEP,
  MAP_TURN_HEIGHT,
  pairTurns,
} from '../lib/view';
import { toast } from '../lib/toast';
import { ContextMenu, type MenuAnchor, type MenuItem } from './ContextMenu';
import { MessageNode } from './MessageNode';
import { MapNode } from './MapNode';

const nodeTypes: NodeTypes = { message: MessageNode, map: MapNode };

// 箭头做小：连线是背景信息，不该比节点还抢眼
const EDGE_MARKER = { type: MarkerType.ArrowClosed, width: 11, height: 11 } as const;

export function Canvas() {
  const nodes = useStore((s) => s.graph?.nodes);
  const selectedId = useStore((s) => s.selectedId);
  const select = useStore((s) => s.select);
  const moveNode = useStore((s) => s.moveNode);
  const linkNodes = useStore((s) => s.linkNodes);
  const unlinkNodes = useStore((s) => s.unlinkNodes);
  const addRootNode = useStore((s) => s.addRootNode);
  const viewMode = useStore((s) => s.viewMode);

  const { screenToFlowPosition, fitView } = useReactFlow();
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

  /*
   * 进地图视图时自动 fit —— 那个视图本来就是用来看全局的。回编辑视图不 fit：
   * 卡片高得多，fit 出来会缩到看不清，而且用户刚才看的地方会被一脚踹飞。
   *
   * 不能在切换的那一刻就 fit：那时 React Flow 还没量到新的节点高度，
   * 拿旧尺寸（或者没尺寸）算出来的包围盒是错的，会一路怼到最大缩放。
   * 所以只挂一个「待 fit」标记，等下一次尺寸回传到了再真正执行。
   */
  const firstRender = useRef(true);
  const pendingFit = useRef(false);

  useEffect(() => {
    /*
     * 必须主动清空实测尺寸。受控模式下节点对象自带 measured 时 React Flow
     * 认为尺寸已知，不会重新量 —— 那样切到地图视图后它仍以为节点有两百多像素高，
     * 小地图和 fitView 全都按旧尺寸算。
     */
    dimsRef.current.clear();
    setDimsVersion((v) => v + 1);
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    if (viewMode === 'map') pendingFit.current = true;
  }, [viewMode]);

  useEffect(() => {
    // size 为 0 说明这次是上面那个 clear 触发的，真正的尺寸还没量出来，再等一轮
    if (!pendingFit.current || dimsRef.current.size === 0) return;
    /*
     * React Flow 是一个节点一次回传尺寸的（实测 12 个节点会触发 12 次 onNodesChange），
     * 在第一次回传时就 fit，算出来的包围盒里只有一个节点，视口会被怼到最大缩放。
     * 所以这里等尺寸彻底不再变化了再 fit —— 每来一条就重置计时器。
     */
    const timer = setTimeout(() => {
      pendingFit.current = false;
      void fitView({ duration: 360, padding: 0.12 });
    }, 120);
    return () => clearTimeout(timer);
  }, [dimsVersion, fitView]);

  /*
   * 图的「形状」签名：id + 角色 + 父节点 + 是否折叠子树。
   *
   * 下面这一整组派生量只跟形状有关，跟正文一个字都没关系。可正文每敲一个字、
   * 流式输出每 33ms，nodes 就是一个全新的对象 —— 直接用 nodes 当依赖的话，
   * 拓扑排序、dagre 排版、问答配对全都会跟着重算一遍，结果还完全一样。
   *
   * 所以先拼一个签名（O(N) 的字符串拼接，比后面那些便宜得多），
   * 其余的都挂在签名上；nodes 本身通过 ref 拿，故意不进依赖。
   */
  const nodesRef = useRef<NodeMap | undefined>(undefined);
  nodesRef.current = nodes;

  const structureKey = useMemo(() => {
    if (!nodes) return '';
    return Object.values(nodes)
      .map((n) => `${n.id}:${n.role}>${n.parentIds.join(',')}${n.subtreeCollapsed ? '#' : ''}`)
      .sort()
      .join('|');
  }, [nodes]);

  /** 哪些节点有下游 */
  const parentIds = useMemo(() => {
    const set = new Set<string>();
    for (const node of Object.values(nodesRef.current ?? {})) {
      for (const p of node.parentIds) set.add(p);
    }
    return set;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [structureKey]);

  /**
   * 每个 assistant 节点有几个「同一个问题的另一版回答」。
   *
   * 原来是每个 MessageNode 自己调 findSiblings 遍历全表 —— N 个节点就是
   * O(N²)，实测 400 节点时流式输出每秒要为此烧掉 170ms，而这个数只在
   * 结构变化时才会变。这里一次分好组，再按 id 发下去。
   */
  const siblingCounts = useMemo(() => {
    const groups = new Map<string, string[]>();
    for (const node of Object.values(nodesRef.current ?? {})) {
      if (node.role !== 'assistant') continue;
      const key = [...node.parentIds].sort().join('|');
      const bucket = groups.get(key);
      if (bucket) bucket.push(node.id);
      else groups.set(key, [node.id]);
    }
    const counts = new Map<string, number>();
    for (const ids of groups.values()) {
      for (const id of ids) counts.set(id, ids.length);
    }
    return counts;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [structureKey]);

  /** 被折叠子树藏起来的节点 */
  const hidden = useMemo(() => {
    const all = nodesRef.current;
    return all ? computeHidden(all) : new Set<string>();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [structureKey]);

  /** 每个折叠节点藏了多少东西，显示在徽章上，否则用户不知道下面还有内容 */
  const hiddenCounts = useMemo(() => {
    const counts = new Map<string, number>();
    const all = nodesRef.current;
    if (!all || hidden.size === 0) return counts;
    for (const node of Object.values(all)) {
      if (!node.subtreeCollapsed) continue;
      let n = 0;
      for (const id of collectDescendants(all, node.id)) {
        if (id !== node.id && hidden.has(id)) n++;
      }
      counts.set(node.id, n);
    }
    return counts;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [structureKey, hidden]);

  /** 选中节点的全部祖先 —— 也就是「这一次发送真正会带上的上下文」 */
  const contextSet = useMemo(() => {
    const all = nodesRef.current;
    if (!all || !selectedId || !all[selectedId]) return new Set<string>();
    return collectAncestors(all, selectedId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [structureKey, selectedId]);


  /** 能合成一张卡的「一问一答」。底层数据不动，纯渲染层的事 */
  const pairing = useMemo(() => {
    const all = nodesRef.current;
    if (viewMode !== 'map' || !all) return null;
    return pairTurns(all, hidden);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewMode, structureKey, hidden]);

  const mapPositions = useMemo(() => {
    const all = nodesRef.current;
    if (viewMode !== 'map' || !all || !pairing) return null;

    /*
     * 排版用的是一张「合并之后」的图：被并进卡片的回答不再是独立节点，
     * 它的下游得改挂到提问上，否则 computeLayout 找不到父节点，
     * 会把整条下游当成新的根节点甩到一边去。
     */
    const resolve = (id: string) => pairing.mergedInto.get(id) ?? id;
    const visible: NodeMap = {};
    for (const [id, node] of Object.entries(all)) {
      if (hidden.has(id) || pairing.mergedInto.has(id)) continue;
      const parentIds = [
        ...new Set(
          node.parentIds
            .map(resolve)
            .filter((p) => p !== id && !hidden.has(p) && !pairing.mergedInto.has(p)),
        ),
      ];
      visible[id] = { ...node, parentIds };
    }

    const dimensions = new Map(
      Object.keys(visible).map((id) => [
        id,
        {
          width: MAP_NODE_WIDTH,
          height: pairing.answerOf.has(id) ? MAP_TURN_HEIGHT : MAP_NODE_HEIGHT,
        },
      ]),
    );
    return computeLayout(visible, {
      dimensions,
      nodeSep: MAP_NODE_SEP,
      rankSep: MAP_RANK_SEP,
    });
    // nodesRef 不入依赖是有意的，见上面的说明
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewMode, structureKey, hidden, pairing]);

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
    const isMap = viewMode === 'map';
    const type = isMap ? 'map' : 'message';

    for (const node of Object.values(nodes)) {
      // 被并进某张卡片的回答不再单独出节点
      if (isMap && pairing?.mergedInto.has(node.id)) continue;
      alive.add(node.id);
      const answerId = isMap ? pairing?.answerOf.get(node.id) : undefined;
      const isSelected = node.id === selectedId;
      const inContext = contextSet.has(node.id) && !isSelected;
      // 只有「存在选中节点、需要拿它作对比」时才淡化旁支。
      // 没有选中时整张画布保持正常，否则平时看什么都是灰的。
      const dimmed = hasSelection && !contextSet.has(node.id);
      const measured = dimsRef.current.get(node.id);
      // 地图视图排完的坐标只用于渲染，不写回节点数据
      const position = mapPositions?.[node.id] ?? node.position;
      const isHidden = hidden.has(node.id);
      const hiddenCount = hiddenCounts.get(node.id) ?? 0;
      const hasChildren = parentIds.has(node.id);
      const siblingCount = siblingCounts.get(node.id) ?? 0;
      const prev = cache.get(node.id);
      if (
        prev &&
        prev.type === type &&
        prev.position.x === position.x &&
        prev.position.y === position.y &&
        prev.selected === isSelected &&
        prev.measured === measured &&
        prev.hidden === isHidden &&
        (prev.data as { inContext: boolean }).inContext === inContext &&
        (prev.data as { dimmed: boolean }).dimmed === dimmed &&
        (prev.data as { hiddenCount: number }).hiddenCount === hiddenCount &&
        (prev.data as { hasChildren: boolean }).hasChildren === hasChildren &&
        (prev.data as { siblingCount: number }).siblingCount === siblingCount &&
        (prev.data as { answerId?: string }).answerId === answerId
      ) {
        out.push(prev);
        continue;
      }
      const next: Node = {
        id: node.id,
        type,
        position,
        selected: isSelected,
        measured,
        hidden: isHidden,
        // 地图视图的坐标是算出来的，拖动它没有意义，拖了也会在下次重排时被冲掉
        draggable: !isMap,
        // 地图视图是只读的：合并之后连线的两端和数据里的父子关系已经对不上了，
        // 让它可连可删只会连错、删错
        connectable: !isMap,
        data: { inContext, dimmed, hiddenCount, hasChildren, siblingCount, answerId },
      };
      cache.set(node.id, next);
      out.push(next);
    }
    for (const key of [...cache.keys()]) if (!alive.has(key)) cache.delete(key);
    return out;
  }, [
    nodes,
    selectedId,
    contextSet,
    dimsVersion,
    hidden,
    hiddenCounts,
    parentIds,
    siblingCounts,
    viewMode,
    mapPositions,
    pairing,
  ]);

  const rfEdges = useMemo<Edge[]>(() => {
    // 边只跟结构有关，跟正文无关 —— 挂 nodes 的话每敲一个字都要重建一遍
    const nodes = nodesRef.current;
    if (!nodes) return [];
    const cache = edgeCache.current;
    const alive = new Set<string>();
    const out: Edge[] = [];

    const isMap = viewMode === 'map';

    for (const node of Object.values(nodes)) {
      // 被并进卡片的回答不出边：它和提问之间那条边成了卡片内部的事
      if (isMap && pairing?.mergedInto.has(node.id)) continue;
      for (const parentId of node.parentIds) {
        if (!nodes[parentId]) continue;
        // 父节点被并进某张卡时，边改从那张卡（也就是提问节点）出发
        const source = isMap ? (pairing?.mergedInto.get(parentId) ?? parentId) : parentId;
        if (source === node.id) continue;
        const id = `${source}->${node.id}`;
        // 改挂之后可能和已有的边重合（比如同时挂着提问和它的回答）
        if (alive.has(id)) continue;
        alive.add(id);
        const active = contextSet.has(parentId) && contextSet.has(node.id);
        // 只要有一端被折叠藏起来，这条边就没有意义了
        const isHidden = hidden.has(parentId) || hidden.has(node.id);
        /*
         * 地图视图换成贝塞尔曲线，并且去掉箭头。
         * 直角折线在稀疏的编辑视图里指向明确，但地图视图里节点挨得近、
         * 连线密，一堆折角和箭头会把画面剁碎；曲线才是「一张图」的样子。
         * 走向靠上下两个连接点已经说清楚了，箭头是多余的。
         */
        // 两个视图统一用贝塞尔曲线。直角折线在节点少时指向明确，
        // 但一屏十几个节点时满画面折角，看着像技术图而不是设计过的东西
        const type = 'default';
        // 曲线上跑蚂蚁线太吵，改用「实线 = 在上下文里 / 虚线 = 旁支」区分
        const animated = isMap ? false : active;
        const className = isMap ? (active ? 'edge-path' : 'edge-alt') : active ? 'edge-active' : '';
        const prev = cache.get(id);
        if (
          prev &&
          prev.type === type &&
          prev.animated === animated &&
          prev.hidden === isHidden &&
          prev.className === className
        ) {
          out.push(prev);
          continue;
        }
        const next: Edge = {
          id,
          source,
          target: node.id,
          type,
          animated,
          hidden: isHidden,
          className,
          // 合并之后这条边的两端和数据里的父子关系对不上，删它会断错连接
          deletable: !isMap,
          ...(isMap ? {} : { markerEnd: EDGE_MARKER }),
        };
        cache.set(id, next);
        out.push(next);
      }
    }
    for (const key of [...cache.keys()]) if (!alive.has(key)) cache.delete(key);
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [structureKey, contextSet, hidden, viewMode, pairing]);

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
        {viewMode === 'map' && (
          <Panel position="top-left" className="map-legend">
            <div>
              <span className="legend-line" />
              在当前上下文里
            </div>
            <div>
              <span className="legend-line alt" />
              其他分支
            </div>
          </Panel>
        )}
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
