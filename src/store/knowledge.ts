import type { StoreApi } from 'zustand';
import type { EmbeddingSettings } from '../types';
import {
  DEFAULT_EMBEDDING,
  describeEmbeddingError,
  embedOne,
  type EmbeddingConfig,
} from '../lib/embeddings';
import { indexFile } from '../lib/indexer';
import { retrieve } from '../lib/knowledge';
import * as db from '../lib/db';
import { invalidateChunks, loadChunks } from './core';
import type { KnowledgeSlice, State } from './types';

// 别叫 Set / Get —— 那会盖掉全局的 Set<string>，类型位置上悄悄变成 store 的 setter
type SetState = StoreApi<State>['setState'];
type GetState = StoreApi<State>['getState'];

const FALLBACK: EmbeddingSettings = { ...DEFAULT_EMBEDDING, topK: 5 };

/**
 * 公用知识库：建索引与检索。
 *
 * 归属画布 —— 一张画布里的所有对话共用一份资料，换张画布就是另一套。
 * 所以切画布时要作废切块缓存（见 core 里的 afterGraphSwitch）。
 */
export function createKnowledgeSlice(set: SetState, get: GetState): KnowledgeSlice {
  const embeddingConfig = (): EmbeddingConfig => {
    const e = get().settings.embedding ?? FALLBACK;
    return { baseUrl: e.baseUrl, apiKey: e.apiKey, model: e.model };
  };

  return {
    knowledgeFiles: [],
    indexing: null,

    async refreshKnowledge() {
      const graphId = get().graph?.id;
      set({ knowledgeFiles: graphId ? await db.listKnowledgeFiles(graphId) : [] });
    },

    async addKnowledgeFiles(files) {
      const graphId = get().graph?.id;
      if (!graphId) return { ok: 0, failed: [] };

      const config = embeddingConfig();
      const failed: { name: string; error: string }[] = [];
      let ok = 0;

      for (const source of files) {
        set({ indexing: { name: source.name, phase: 'parse', done: 0, total: 1 } });
        try {
          const { file, chunks } = await indexFile(source, graphId, config, {
            onProgress: (p) => set({ indexing: { name: source.name, ...p } }),
          });
          // 先写块再写文件记录：中途断了只会留下一批无主的块，而检索永远
          // 按文件记录过滤，读不到它们；反过来则会出现「有文件却检索不到内容」
          await db.saveKnowledgeChunks(chunks);
          await db.saveKnowledgeFile(file);
          invalidateChunks();
          ok++;
        } catch (err) {
          failed.push({ name: source.name, error: describeEmbeddingError(err) });
        }
      }

      set({ indexing: null });
      await get().refreshKnowledge();
      return { ok, failed };
    },

    async setKnowledgeEnabled(fileId, enabled) {
      const file = get().knowledgeFiles.find((f) => f.id === fileId);
      if (!file) return;
      await db.saveKnowledgeFile({ ...file, enabled });
      await get().refreshKnowledge();
    },

    async removeKnowledgeFile(fileId) {
      await db.deleteKnowledgeFile(fileId);
      invalidateChunks();
      await get().refreshKnowledge();
    },

    async retrieveKnowledge(query) {
      const graphId = get().graph?.id;
      if (!graphId || !query.trim()) return [];

      const files = get().knowledgeFiles.filter((f) => f.enabled && f.status === 'ready');
      if (!files.length) return [];

      const chunks = await loadChunks(graphId);
      if (!chunks.length) return [];

      const vector = await embedOne(embeddingConfig(), query);
      return retrieve(vector, chunks, {
        topK: get().settings.embedding?.topK ?? FALLBACK.topK,
        // 只在启用的文件里找。顺带把没有文件记录的无主块挡在外面
        enabledFileIds: new Set(files.map((f) => f.id)),
        fileNames: new Map(files.map((f) => [f.id, f.name])),
      });
    },
  };
}
