import type { StoreApi } from 'zustand';
import type { ChatNode, Graph, Settings } from '../types';
import { collectDescendants, wouldCreateCycle, type NodeMap } from '../lib/context';
import { loadViewMode, saveViewMode } from '../lib/view';
import { demoGraph } from '../lib/demo';
import { placeChild, placeSibling } from '../lib/layout';
import { computeLayout, isSameLayout } from '../lib/autoLayout';
import * as db from '../lib/db';
import {
  controllers,
  DEFAULT_SETTINGS,
  detached,
  emptyGraph,
  now,
  sanitize,
  saver,
  uid,
  type StoreCore,
} from './core';
import type { GraphSlice, State } from './types';

// 别叫 Set / Get —— 那会盖掉全局的 Set<string>，类型位置上悄悄变成 store 的 setter
type SetState = StoreApi<State>['setState'];
type GetState = StoreApi<State>['getState'];

/**
 * 画布与节点结构。
 *
 * 这一片只管**图长什么样**：增删节点、连断线、撤销重做、排版、切换画布。
 * 内容怎么生成在 generation.ts，怎么存下来在 storage.ts。
 */
export function createGraphSlice(set: SetState, get: GetState, core: StoreCore): GraphSlice {
  const { commit, resetHistory, leaveCurrentGraph, abandonGraph, gcAttachments, afterGraphSwitch } =
    core;

  return {
    graph: null,
    graphs: [],
    selectedId: null,
    compareNodeId: null,
    ready: false,
    canUndo: false,
    canRedo: false,

    undo: core.undo,
    redo: core.redo,

    async init() {
      const [settings, lastId, graphs, demoSeeded] = await Promise.all([
        db.loadSettings(),
        db.loadLastGraphId(),
        db.listGraphs(),
        db.loadDemoSeeded(),
      ]);
      // 老版本存的设置可能缺字段，跟默认值合一次
      const merged: Settings = { ...DEFAULT_SETTINGS, ...(settings ?? {}) };
      if (!merged.profiles?.length) merged.profiles = DEFAULT_SETTINGS.profiles;

      resetHistory();
      let graph = lastId ? await db.loadGraph(lastId) : undefined;
      if (!graph && graphs.length) graph = await db.loadGraph(graphs[0]!.id);
      if (!graph) {
        /*
         * 真正的头一次：给一张预填好的示例画布，而不是一张空的。
         *
         * 这个应用最值钱的是「两条分支汇进同一个提问」，可它要发三四轮、
         * 再手动拖一条边才看得见 —— 而且得先去申请一个 API Key。
         * 于是最该被看到的东西恰好落在漏斗最深处。示例画布不需要 Key
         * 就能读、能选中看上下文高亮。
         *
         * 只在**从没播过**时给。删光了再打开又冒出来的话，它就成了
         * 一个删不掉的东西 —— 比一个没用的东西更烦人。
         */
        graph = demoSeeded ? emptyGraph() : demoGraph(uid, now());
        await db.saveGraph(graph);
        if (!demoSeeded) await db.markDemoSeeded();
      }
      graph = sanitize(graph);

      await db.saveLastGraphId(graph.id);
      set({ settings: merged, graph, graphs: await db.listGraphs(), ready: true });
      await afterGraphSwitch();
      // 上一次会话里删掉的节点，撤销栈已经随页面一起没了，附件可以收了
      void gcAttachments(graph);
    },

    async refreshGraphList() {
      set({ graphs: await db.listGraphs() });
    },

    async newGraph() {
      leaveCurrentGraph();
      const graph = emptyGraph();
      await db.saveGraph(graph);
      await db.saveLastGraphId(graph.id);
      set({ graph, selectedId: null, graphs: await db.listGraphs() });
      await afterGraphSwitch();
    },

    async openGraph(id) {
      /*
       * 后台那份优先于磁盘那份。
       *
       * 切走时如果还有生成在跑，内存里的副本一直在被写，而磁盘落后一个
       * 防抖周期 —— 从磁盘读就会把刚生成出来的几百个字盖掉。
       */
      const live = detached.get(id);
      const graph = live ?? (await db.loadGraph(id));
      if (!graph) return;
      leaveCurrentGraph();
      await db.saveLastGraphId(id);
      /*
       * 后台那份不能过 sanitize：它把 streaming 洗成 idle，是为了收拾
       * 「流式输出中途关了页面」留下的残状态。可这里的 streaming 是真在跑，
       * 洗掉就成了「转圈突然停了、下一次 flush 又转起来」。
       */
      set({ graph: live ?? sanitize(graph), selectedId: null });
      await afterGraphSwitch();
    },

    async removeGraph(id) {
      // 删之前留一个回滚点
      await get().takeSnapshot('删除画布前');
      abandonGraph(id); // 画布都要删了，上面在跑的生成必须先掐掉并作废
      // 必须先丢弃待写入：防抖存盘里可能还压着这个画布，删完定时器一到
      // 又会把它写回去，用户看到的就是「删了又自己回来了」
      saver.discard(id);
      await db.deleteGraph(id);
      const graphs = await db.listGraphs();
      set({ graphs });
      if (get().graph?.id === id) {
        if (graphs.length) await get().openGraph(graphs[0]!.id);
        else await get().newGraph();
      }
    },

    renameGraph(title) {
      const graph = get().graph;
      if (!graph) return;
      const next = { ...graph, title, updatedAt: now() };
      set({ graph: next });
      saver.queue(next);
      void get().refreshGraphList();
    },

    async importGraph(incoming) {
      await get().takeSnapshot('导入前');
      // 换一套 id，避免和已有画布撞车
      const idMap = new Map<string, string>();
      for (const id of Object.keys(incoming.nodes)) idMap.set(id, uid());
      const nodes: NodeMap = {};
      for (const [oldId, node] of Object.entries(incoming.nodes)) {
        const newId = idMap.get(oldId)!;
        nodes[newId] = {
          ...node,
          id: newId,
          parentIds: node.parentIds.map((p) => idMap.get(p)).filter((p): p is string => !!p),
          status: node.status === 'streaming' ? 'idle' : node.status,
          /*
           * 附件引用必须清掉。附件的二进制从来不在导出文件里，而且这里连
           * 节点 id 都重新映射过 —— 留着就是一串指向不存在文件的悬空 id。
           * 更要命的是「有附件就不算空节点」那条判断会认下它，
           * 于是一个空正文的节点会被当成有内容，发出一条 content 为空的消息。
           */
          attachmentIds: undefined,
        };
      }
      const graph: Graph = {
        id: uid(),
        title: incoming.title || '导入的画布',
        nodes,
        createdAt: now(),
        updatedAt: now(),
      };
      await db.saveGraph(graph);
      await db.saveLastGraphId(graph.id);
      resetHistory();
      set({ graph, selectedId: null, graphs: await db.listGraphs() });
      await afterGraphSwitch();
    },

    viewMode: loadViewMode(),

    setViewMode(mode) {
      if (get().viewMode === mode) return;
      saveViewMode(mode);
      set({ viewMode: mode });
    },

    select(id) {
      set({ selectedId: id });
    },

    setCompare(id) {
      set({ compareNodeId: id });
    },

    updateNode(id, patch) {
      // 连续打字合并成一条历史，否则每敲一个字符就是一次撤销
      const isTyping = 'content' in patch && Object.keys(patch).length === 1;
      commit(
        (nodes) => {
          const current = nodes[id];
          if (!current) return;
          nodes[id] = { ...current, ...patch, updatedAt: now() };
        },
        isTyping ? { label: '编辑内容', coalesceKey: `text:${id}` } : { label: '修改节点' },
      );
    },

    moveNode(id, position) {
      commit(
        (nodes) => {
          const current = nodes[id];
          if (!current) return;
          nodes[id] = { ...current, position };
        },
        // 拖拽期间每次 mousemove 都会调进来，一次拖拽只该留一条历史
        { label: '移动节点', coalesceKey: `move:${id}` },
      );
    },

    removeNode(id, cascade) {
      const graph = get().graph;
      if (!graph) return 0;
      const doomed = cascade ? collectDescendants(graph.nodes, id) : new Set([id]);
      for (const victim of doomed) controllers.get(victim)?.controller.abort();

      commit(
        (nodes) => {
          for (const victim of doomed) delete nodes[victim];
          // 幸存者不能挂着已删除的父节点
          for (const [nodeId, node] of Object.entries(nodes)) {
            if (node.parentIds.some((p) => doomed.has(p))) {
              nodes[nodeId] = {
                ...node,
                parentIds: node.parentIds.filter((p) => !doomed.has(p)),
              };
            }
          }
        },
        { label: doomed.size > 1 ? `删除 ${doomed.size} 个节点` : '删除节点' },
      );
      if (doomed.has(get().selectedId ?? '')) set({ selectedId: null });
      return doomed.size;
    },

    addChild(parentId, role) {
      const graph = get().graph;
      const parent = graph?.nodes[parentId];
      if (!graph || !parent) return null;
      const id = uid();
      const node: ChatNode = {
        id,
        role,
        content: '',
        parentIds: [parentId],
        position: placeChild(graph.nodes, [parent]),
        createdAt: now(),
        updatedAt: now(),
      };
      commit(
        (nodes) => {
          nodes[id] = node;
        },
        { label: '新建节点' },
      );
      set({ selectedId: id });
      return id;
    },

    addSibling(nodeId) {
      const graph = get().graph;
      const source = graph?.nodes[nodeId];
      if (!graph || !source) return null;
      const id = uid();
      const node: ChatNode = {
        id,
        role: source.role,
        content: '',
        parentIds: [...source.parentIds],
        position: placeSibling(graph.nodes, source),
        createdAt: now(),
        updatedAt: now(),
      };
      commit(
        (nodes) => {
          nodes[id] = node;
        },
        { label: '新建并列分支' },
      );
      set({ selectedId: id });
      return id;
    },

    addRootNode(role, position) {
      const graph = get().graph;
      if (!graph) return null;
      const id = uid();
      commit(
        (nodes) => {
          nodes[id] = {
            id,
            role,
            content: '',
            parentIds: [],
            position,
            createdAt: now(),
            updatedAt: now(),
          };
        },
        { label: '新建节点' },
      );
      set({ selectedId: id });
      return id;
    },

    applyLayout(dimensions) {
      const graph = get().graph;
      if (!graph || Object.keys(graph.nodes).length === 0) return false;

      const positions = computeLayout(graph.nodes, { dimensions });
      // 已经是整齐的就别白占一条撤销记录
      if (isSameLayout(graph.nodes, positions)) return false;

      commit(
        (nodes) => {
          for (const [id, position] of Object.entries(positions)) {
            const node = nodes[id];
            if (node) nodes[id] = { ...node, position };
          }
        },
        { label: '整理布局' },
      );
      return true;
    },

    /** 返回 null 表示成功，否则返回拒绝原因 */
    linkNodes(from, to) {
      const graph = get().graph;
      if (!graph || !graph.nodes[from] || !graph.nodes[to]) return '节点不存在';
      if (graph.nodes[to]!.parentIds.includes(from)) return '这条连线已经存在了';
      if (wouldCreateCycle(graph.nodes, from, to)) return '不能连成环 —— 上下文没法拓扑排序';
      commit(
        (nodes) => {
          const node = nodes[to]!;
          nodes[to] = { ...node, parentIds: [...node.parentIds, from], updatedAt: now() };
        },
        { label: '连接节点' },
      );
      return null;
    },

    unlinkNodes(from, to) {
      commit(
        (nodes) => {
          const node = nodes[to];
          if (!node) return;
          nodes[to] = {
            ...node,
            parentIds: node.parentIds.filter((p) => p !== from),
            updatedAt: now(),
          };
        },
        { label: '断开连接' },
      );
    },
  };
}
