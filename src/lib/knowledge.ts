/**
 * 知识库检索。
 *
 * 前提：向量已 L2 归一化（llama-server 的 --embd-normalize 2，或多数 API 默认如此）。
 * 归一化之后余弦相似度就等于点积，省掉每次比较的两次模长计算和一次开方。
 * 如果哪天换了不归一化的 embedding 服务，这里算出来的分数会失真 —— 所以
 * 建库时会顺手校验模长，不对就明确报出来，而不是安静地给出错的排序。
 */

/** 认为「已归一化」的模长容差 */
export const NORM_TOLERANCE = 0.02;

export interface StoredChunk {
  id: string;
  fileId: string;
  index: number;
  text: string;
  embedding: Float32Array;
}

export interface RetrievedChunk {
  chunkId: string;
  fileId: string;
  fileName: string;
  index: number;
  text: string;
  /** 余弦相似度。bge-m3 的分数普遍压在 0.5~0.8，别拿绝对阈值筛 */
  score: number;
}

export function dot(a: Float32Array | number[], b: Float32Array | number[]): number {
  const n = Math.min(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < n; i++) sum += (a[i] as number) * (b[i] as number);
  return sum;
}

export function magnitude(v: Float32Array | number[]): number {
  return Math.sqrt(dot(v, v));
}

export function isNormalized(v: Float32Array | number[]): boolean {
  return Math.abs(magnitude(v) - 1) <= NORM_TOLERANCE;
}

export interface RetrieveOptions {
  /** 取前几块 */
  topK?: number;
  /** 只在这些文件里检索（用户可以逐个文件开关） */
  enabledFileIds?: Set<string>;
  /** id → 文件名，用于回显来源 */
  fileNames?: Map<string, string>;
}

/**
 * 按相似度取 Top-K。
 *
 * 刻意不做相似度阈值过滤：bge-m3 上「两个技术话题」和「技术 vs 天气」的分差
 * 只有 0.07 左右，任何绝对阈值都会一刀切错。把分数如实交给界面显示，
 * 由人判断这次检索准不准 —— 这也是这个应用一贯的做法。
 */
export function retrieve(
  queryEmbedding: Float32Array | number[],
  chunks: StoredChunk[],
  options: RetrieveOptions = {},
): RetrievedChunk[] {
  const { topK = 5, enabledFileIds, fileNames } = options;
  if (topK <= 0 || chunks.length === 0) return [];

  const scored: RetrievedChunk[] = [];
  for (const chunk of chunks) {
    if (enabledFileIds && !enabledFileIds.has(chunk.fileId)) continue;
    scored.push({
      chunkId: chunk.id,
      fileId: chunk.fileId,
      fileName: fileNames?.get(chunk.fileId) ?? '未知文件',
      index: chunk.index,
      text: chunk.text,
      score: dot(queryEmbedding, chunk.embedding),
    });
  }

  scored.sort((a, b) => b.score - a.score || a.fileId.localeCompare(b.fileId) || a.index - b.index);
  return scored.slice(0, topK);
}

/**
 * 把检索到的片段拼成注入上下文的那段文字。
 *
 * 明确告诉模型这是「参考资料」而不是对话的一部分，并标出每段的出处 ——
 * 否则模型容易把资料当成用户说过的话，回答时张冠李戴。
 */
export function formatKnowledgeBlock(chunks: RetrievedChunk[]): string {
  if (chunks.length === 0) return '';
  const body = chunks
    .map((c, i) => `【资料 ${i + 1}·来自《${c.fileName}》】\n${c.text.trim()}`)
    .join('\n\n');
  return `以下是从知识库中检索到的参考资料，供你回答时参考。资料本身不是对话的一部分，如果与问题无关可以忽略。\n\n${body}`;
}
