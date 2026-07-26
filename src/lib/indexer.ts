import type { KnowledgeChunk, KnowledgeFile } from '../types';
import { chunkText } from './chunking';
import { embedAll, type EmbeddingConfig } from './embeddings';
import { parseFile } from './parsers';

/**
 * 建索引：解析 → 切块 → 求向量。
 *
 * 刻意不碰 IndexedDB —— 落盘由 store 负责。这样这条流水线可以整条测，
 * 只需要塞两个假函数进去，不必在测试里搭一个数据库。
 */
export interface IndexResult {
  file: KnowledgeFile;
  chunks: KnowledgeChunk[];
}

export interface IndexOptions {
  signal?: AbortSignal;
  /** 分阶段回报进度，大文件建库要好几十秒，界面上得能看出在动 */
  onProgress?: (p: { phase: 'parse' | 'embed'; done: number; total: number }) => void;
  /** 便于测试注入 */
  embed?: typeof embedAll;
  now?: () => number;
  newId?: () => string;
}

export async function indexFile(
  source: File,
  graphId: string,
  config: EmbeddingConfig,
  options: IndexOptions = {},
): Promise<IndexResult> {
  const {
    signal,
    onProgress,
    embed = embedAll,
    now = Date.now,
    newId = () => crypto.randomUUID(),
  } = options;

  onProgress?.({ phase: 'parse', done: 0, total: 1 });
  const parsed = await parseFile(source);
  onProgress?.({ phase: 'parse', done: 1, total: 1 });

  const pieces = chunkText(parsed.text);
  if (pieces.length === 0) {
    throw new Error(`《${source.name}》里没有解析出可用的文字`);
  }

  const vectors = await embed(
    config,
    pieces.map((p) => p.text),
    { signal, onProgress: (p) => onProgress?.({ phase: 'embed', ...p }) },
  );

  const fileId = newId();
  const at = now();
  const chunks: KnowledgeChunk[] = pieces.map((piece, i) => ({
    id: `${fileId}:${piece.index}`,
    graphId,
    fileId,
    index: piece.index,
    text: piece.text,
    embedding: vectors[i]!,
  }));

  return {
    file: {
      id: fileId,
      graphId,
      name: source.name,
      kind: parsed.kind,
      size: source.size,
      charCount: parsed.text.length,
      chunkCount: chunks.length,
      enabled: true,
      createdAt: at,
      status: 'ready',
      warning: parsed.warnings.length ? parsed.warnings.join('；') : undefined,
      embeddingModel: config.model,
    },
    chunks,
  };
}
