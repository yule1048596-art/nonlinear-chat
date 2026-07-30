import type { StoreApi } from 'zustand';
import type { Attachment } from '../types';
import {
  detectAttachmentKind,
  formatBytes,
  MAX_IMAGE_BYTES,
  type ResolvedAttachment,
} from '../lib/attachments';
import { parseFile } from '../lib/parsers';
import {
  buildSignature,
  pruneIds,
  shouldSnapshot,
  type Snapshot,
} from '../lib/snapshots';
import { buildFullBackup, buildSettingsBackup, mergeProfiles } from '../lib/backup';
import { buildArchive, countPayload } from '../lib/archive';
import * as db from '../lib/db';
import {
  dataUrlCache,
  detached,
  emptyGraph,
  invalidateChunks,
  now,
  resolveAttachment,
  sanitize,
  saver,
  uid,
  type StoreCore,
} from './core';
import type { State, StorageSlice } from './types';

// 别叫 Set / Get —— 那会盖掉全局的 Set<string>，类型位置上悄悄变成 store 的 setter
type SetState = StoreApi<State>['setState'];
type GetState = StoreApi<State>['getState'];

/**
 * 落在浏览器之外的那些事：快照、备份导入导出、附件二进制。
 *
 * 共同点是它们都**跨画布**、都碰 IndexedDB 里画布之外的那几张表。
 * 画布结构的增删改在 graph.ts，这里只管「怎么存下来、怎么拿回去」。
 */
export function createStorageSlice(set: SetState, get: GetState, core: StoreCore): StorageSlice {
  const {
    commit,
    currentGraphs,
    abandonRunning,
    abandonGraph,
    resetHistory,
    persistSettings,
    afterGraphSwitch,
  } = core;

  /** 把这条链上用到的附件解析成可直接发送的形式。预览面板和 run() 共用 */
  const resolveAttachmentsFor = async (nodeIds: Set<string>) => {
    const list = get().attachments.filter((a) => nodeIds.has(a.nodeId));
    if (!list.length) return undefined;
    const map = new Map<string, ResolvedAttachment[]>();
    for (const att of list) {
      const resolved = await resolveAttachment(att);
      const bucket = map.get(att.nodeId);
      if (bucket) bucket.push(resolved);
      else map.set(att.nodeId, [resolved]);
    }
    return map;
  };

  return {
    snapshots: [],

    exportSettings(includeKeys) {
      return buildSettingsBackup(get().settings, includeKeys);
    },

    async exportEverything(includeKeys) {
      return buildFullBackup(get().settings, await currentGraphs(), includeKeys);
    },

    async exportArchive(includeKeys) {
      const [graphs, attachments, knowledgeFiles, knowledgeChunks] = await Promise.all([
        currentGraphs(),
        db.loadAllAttachments(),
        db.loadAllKnowledgeFiles(),
        db.loadAllKnowledgeChunks(),
      ]);
      return buildArchive(
        { settings: get().settings, graphs, attachments, knowledgeFiles, knowledgeChunks },
        includeKeys,
      );
    },

    async restoreArchive(parsed) {
      await get().takeSnapshot('导入前');
      // 所有画布都要被换掉，在跑的生成一律作废，否则它们会往新数据上写
      abandonRunning();
      detached.clear();
      saver.flush();

      const { payload } = parsed;
      await db.replaceAllGraphs(payload.graphs);
      await db.replaceAttachmentsAndKnowledge(
        payload.attachments,
        payload.knowledgeFiles,
        payload.knowledgeChunks,
      );
      await db.saveSettings(payload.settings);
      resetHistory();
      invalidateChunks();
      dataUrlCache.clear();

      const first = payload.graphs[0];
      if (first) await db.saveLastGraphId(first.id);

      set({
        settings: payload.settings,
        graph: first ? sanitize(first) : emptyGraph(),
        selectedId: null,
        graphs: await db.listGraphs(),
        snapshots: await db.listSnapshots(),
      });
      await afterGraphSwitch();
      return countPayload(payload);
    },

    importSettings(backup) {
      const current = get().settings;
      const { profiles, added, skipped } = mergeProfiles(
        current.profiles,
        backup.settings.profiles ?? [],
        uid,
      );
      /*
       * 只并配置，不导入 systemPrompt / contextLimit —— 那两个是本机偏好，
       * 而「导入设置」的语义是拿到别处的模型配置，不是拿别人的状态盖掉自己的。
       * 要整体覆盖请用完整备份恢复，那条路径会先打快照。
       */
      persistSettings({ ...current, profiles });
      return { added, skipped };
    },

    async restoreBackup(backup) {
      await get().takeSnapshot('导入前');
      saver.flush();

      await db.replaceAllGraphs(backup.graphs);
      await db.saveSettings(backup.settings);
      resetHistory();

      const first = backup.graphs[0];
      if (first) await db.saveLastGraphId(first.id);

      set({
        settings: backup.settings,
        graph: first ? sanitize(first) : emptyGraph(),
        selectedId: null,
        graphs: await db.listGraphs(),
        snapshots: await db.listSnapshots(),
      });
      await afterGraphSwitch();
      return { graphs: backup.graphs.length };
    },

    async takeSnapshot(reason = '自动') {
      // 内存里那份才是用户眼前的版本，磁盘上的可能落后一个防抖周期
      const [graphs, latestList] = await Promise.all([currentGraphs(), db.listSnapshots()]);
      const settings = get().settings;
      const signature = buildSignature(graphs, settings);

      const latest = latestList[0]
        ? { signature: (await db.loadSnapshot(latestList[0].id))?.signature ?? '', createdAt: latestList[0].createdAt }
        : undefined;

      if (!shouldSnapshot({ reason, signature, latest, now: now() })) return false;

      const snapshot: Snapshot = {
        id: uid(),
        createdAt: now(),
        reason,
        signature,
        graphs,
        settings,
      };
      await db.saveSnapshot(snapshot);

      // 存完再淘汰，保证任何时刻都至少有一份可用的快照
      const all = await db.listSnapshots();
      for (const id of pruneIds(all)) await db.deleteSnapshot(id);

      set({ snapshots: await db.listSnapshots() });
      return true;
    },

    async refreshSnapshots() {
      set({ snapshots: await db.listSnapshots() });
    },

    async restoreSnapshot(snapshotId) {
      const snapshot = await db.loadSnapshot(snapshotId);
      if (!snapshot) return false;

      // 回滚也是破坏性的：先给当前状态留一个回头路
      await get().takeSnapshot('恢复前');

      // 所有画布都要被换掉，后台还在跑的生成一律作废 —— 否则它们会把
      // 刚刚被替换掉的内容一路写回来，回滚就白做了
      abandonRunning();
      detached.clear();

      saver.flush();
      await db.replaceAllGraphs(snapshot.graphs);
      await db.saveSettings(snapshot.settings);

      resetHistory(); // 历史属于被替换掉的那份数据，留着会串台
      const first = snapshot.graphs[0];
      if (first) await db.saveLastGraphId(first.id);

      set({
        settings: snapshot.settings,
        graph: first ? sanitize(first) : emptyGraph(),
        selectedId: null,
        graphs: await db.listGraphs(),
        snapshots: await db.listSnapshots(),
      });
      await afterGraphSwitch();
      return true;
    },

    async restoreGraphFromSnapshot(snapshotId, graphId) {
      const snapshot = await db.loadSnapshot(snapshotId);
      const target = snapshot?.graphs.find((g) => g.id === graphId);
      if (!target) return false;

      await get().takeSnapshot('恢复前');
      abandonGraph(graphId); // 这一张要被整份换掉，它上面在跑的生成同样得作废
      saver.flush();
      await db.saveGraph(target);
      await db.saveLastGraphId(target.id);
      resetHistory();

      set({
        graph: sanitize(target),
        selectedId: null,
        graphs: await db.listGraphs(),
        snapshots: await db.listSnapshots(),
      });
      await afterGraphSwitch();
      return true;
    },

    async removeSnapshot(snapshotId) {
      await db.deleteSnapshot(snapshotId);
      set({ snapshots: await db.listSnapshots() });
    },

    attachments: [],

    resolveAttachments: (nodeIds) => resolveAttachmentsFor(nodeIds),

    async refreshAttachments() {
      const graphId = get().graph?.id;
      set({ attachments: graphId ? await db.listAttachments(graphId) : [] });
    },

    async addAttachments(nodeId, files) {
      const graph = get().graph;
      if (!graph) return { ok: 0, failed: [] };

      const failed: { name: string; error: string }[] = [];
      const added: Attachment[] = [];

      for (const file of files) {
        const kind = detectAttachmentKind(file);
        if (!kind) {
          failed.push({ name: file.name, error: '不支持这个类型' });
          continue;
        }
        if (kind === 'image' && file.size > MAX_IMAGE_BYTES) {
          failed.push({
            name: file.name,
            error: `图片 ${formatBytes(file.size)}，超过 ${formatBytes(MAX_IMAGE_BYTES)} 上限`,
          });
          continue;
        }
        try {
          let text: string | undefined;
          let warning: string | undefined;
          if (kind === 'text') {
            // 复用知识库那套解析器：txt/md/docx/epub 已经支持
            const parsed = await parseFile(file);
            if (!parsed.text.trim()) throw new Error('没有解析出可用的文字');
            text = parsed.text;
            warning = parsed.warnings.length ? parsed.warnings.join('；') : undefined;
          }
          const attachment: Attachment = {
            id: uid(),
            graphId: graph.id,
            nodeId,
            name: file.name,
            mime: file.type,
            size: file.size,
            kind,
            // File 本身就是 Blob，直接存，不转 base64
            blob: file,
            text,
            warning,
            createdAt: now(),
          };
          await db.saveAttachment(attachment);
          added.push(attachment);
        } catch (err) {
          failed.push({ name: file.name, error: (err as Error)?.message ?? String(err) });
        }
      }

      if (added.length) {
        commit(
          (nodes) => {
            const current = nodes[nodeId];
            if (!current) return;
            nodes[nodeId] = {
              ...current,
              attachmentIds: [...(current.attachmentIds ?? []), ...added.map((a) => a.id)],
              updatedAt: now(),
            };
          },
          { label: '添加附件' },
        );
        set({ attachments: [...get().attachments, ...added] });
      }
      return { ok: added.length, failed };
    },

    async removeAttachment(attachmentId) {
      const att = get().attachments.find((a) => a.id === attachmentId);
      await db.deleteAttachment(attachmentId);
      dataUrlCache.delete(attachmentId);

      if (att) {
        /*
         * 这一步刻意不进撤销历史：二进制已经删了，撤销只能把 id 放回节点上，
         * 指向一个不存在的文件。与其给一个撤了也回不来的承诺，不如不给。
         */
        commit(
          (nodes) => {
            const current = nodes[att.nodeId];
            if (!current) return;
            nodes[att.nodeId] = {
              ...current,
              attachmentIds: (current.attachmentIds ?? []).filter((id) => id !== attachmentId),
              updatedAt: now(),
            };
          },
          { history: false },
        );
      }
      set({ attachments: get().attachments.filter((a) => a.id !== attachmentId) });
    },
  };
}
