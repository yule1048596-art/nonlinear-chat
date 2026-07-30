import { strFromU8, strToU8, unzip, zip } from 'fflate';
import type { Attachment, Graph, KnowledgeChunk, KnowledgeFile, Settings } from '../types';
import { stripKeys } from './backup';

/**
 * 完整备份（.nexus.zip）。
 *
 * v1 的「导出全部」只有 settings + graphs，可节点上挂着 attachmentIds、
 * 画布下挂着知识库 —— 换台电脑导入后，那些 id 指向的东西根本不存在。
 * 用户以为备份完了，实际上图片和资料全丢了，而且要等到点开某张图才发现。
 *
 * 所以 v2 装的是**能独立还原一整套数据**的东西：
 *
 * ```
 * manifest.json            版本、导出时间、各项计数（导入后可自查是否一致）
 * settings.json            设置（默认已抹掉所有 Key）
 * graphs.json              全部画布
 * attachments.json         附件元数据（不含字节）
 * attachments/<id>         附件原始字节
 * knowledge/files.json     知识库文件
 * knowledge/chunks.json    切块正文（不含向量）
 * knowledge/vectors.bin    所有切块的向量，按 chunks.json 的顺序首尾相接
 * ```
 *
 * 向量单独放二进制：几千块 × 1024 维浮点写成 JSON 会把文件撑大好几倍，
 * 而且反复解析文本也慢。放一块连续内存，按 dim 切片就能还原。
 */
export const ARCHIVE_VERSION = 2;

export interface ArchiveCounts {
  graphs: number;
  nodes: number;
  attachments: number;
  attachmentBytes: number;
  knowledgeFiles: number;
  knowledgeChunks: number;
}

export interface ArchiveManifest {
  kind: 'nexus-archive';
  version: number;
  exportedAt: number;
  keysIncluded: boolean;
  counts: ArchiveCounts;
}

export interface ArchivePayload {
  settings: Settings;
  graphs: Graph[];
  attachments: Attachment[];
  knowledgeFiles: KnowledgeFile[];
  knowledgeChunks: KnowledgeChunk[];
}

export interface ParsedArchive {
  manifest: ArchiveManifest;
  payload: ArchivePayload;
  /** 清单里写的数量和实际解出来的对不对得上。对不上说明文件被截断或改过 */
  mismatches: string[];
}

/** 附件除了 blob 之外的部分。字节单独放一个文件，元数据留在 JSON 里好读 */
type AttachmentMeta = Omit<Attachment, 'blob'>;

/** 切块除了向量之外的部分，外加维度——还原时按它切 vectors.bin */
type ChunkMeta = Omit<KnowledgeChunk, 'embedding'> & { dim: number };

export function countPayload(payload: ArchivePayload): ArchiveCounts {
  return {
    graphs: payload.graphs.length,
    nodes: payload.graphs.reduce((sum, g) => sum + Object.keys(g.nodes).length, 0),
    attachments: payload.attachments.length,
    attachmentBytes: payload.attachments.reduce((sum, a) => sum + a.size, 0),
    knowledgeFiles: payload.knowledgeFiles.length,
    knowledgeChunks: payload.knowledgeChunks.length,
  };
}

const json = (value: unknown) => strToU8(JSON.stringify(value));

/** 把一串向量首尾相接成一块连续内存 */
export function packVectors(chunks: KnowledgeChunk[]): Uint8Array {
  const total = chunks.reduce((sum, c) => sum + c.embedding.length, 0);
  const flat = new Float32Array(total);
  let at = 0;
  for (const chunk of chunks) {
    flat.set(chunk.embedding, at);
    at += chunk.embedding.length;
  }
  return new Uint8Array(flat.buffer);
}

/**
 * 从连续内存里按维度切回每一块的向量。
 *
 * 字节数对不上就整体放弃向量（返回空数组填充）—— 半截向量比没有更糟：
 * 检索会照常跑出一个看着正常的相似度排序，只是它是错的。
 */
export function unpackVectors(bytes: Uint8Array, dims: number[]): Float32Array[] {
  const needed = dims.reduce((sum, d) => sum + d, 0) * 4;
  if (bytes.byteLength !== needed) return dims.map(() => new Float32Array(0));
  // 从 zip 解出来的视图未必按 4 字节对齐，先拷一份再当 Float32 看
  const aligned = new Uint8Array(bytes);
  const flat = new Float32Array(aligned.buffer);
  const out: Float32Array[] = [];
  let at = 0;
  for (const dim of dims) {
    out.push(flat.slice(at, at + dim));
    at += dim;
  }
  return out;
}

export async function buildArchive(
  payload: ArchivePayload,
  includeKeys: boolean,
): Promise<{ blob: Blob; manifest: ArchiveManifest }> {
  const manifest: ArchiveManifest = {
    kind: 'nexus-archive',
    version: ARCHIVE_VERSION,
    exportedAt: Date.now(),
    keysIncluded: includeKeys,
    counts: countPayload(payload),
  };

  const files: Record<string, Uint8Array> = {
    'manifest.json': json(manifest),
    'settings.json': json(includeKeys ? payload.settings : stripKeys(payload.settings)),
    'graphs.json': json(payload.graphs),
    'attachments.json': json(
      payload.attachments.map(({ blob: _blob, ...meta }): AttachmentMeta => meta),
    ),
    'knowledge/files.json': json(payload.knowledgeFiles),
    'knowledge/chunks.json': json(
      payload.knowledgeChunks.map(({ embedding, ...meta }): ChunkMeta => ({
        ...meta,
        dim: embedding.length,
      })),
    ),
    'knowledge/vectors.bin': packVectors(payload.knowledgeChunks),
  };

  for (const att of payload.attachments) {
    files[`attachments/${att.id}`] = new Uint8Array(await att.blob.arrayBuffer());
  }

  const zipped = await new Promise<Uint8Array>((resolve, reject) => {
    // 附件多半已经是压缩过的（png/jpg），再压一遍只是白烧 CPU；
    // JSON 那几个才值得压，让 fflate 按 level 自己权衡
    zip(files, { level: 6 }, (err, data) => (err ? reject(err) : resolve(data)));
  });

  return { blob: new Blob([zipped as BlobPart], { type: 'application/zip' }), manifest };
}

/**
 * 认出这是不是一个备份包 —— 看**头四个字节**，不看文件名。
 *
 * 按扩展名认会在两种很平常的情况下失灵：用户把文件改了名，或者某些
 * 系统/浏览器在下载时把后缀吞掉。那时导入会走进 JSON 那条路、抛一个
 * 「不是合法的 JSON」，而用户手里明明是一个好好的备份 —— 备份恢复
 * 通常是最后一根救命稻草，不该败在文件名上。
 *
 * `PK\x03\x04` 是 zip 本地文件头的固定签名。
 */
export function looksLikeArchive(head: Uint8Array): boolean {
  return head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04;
}

export async function readArchive(data: Uint8Array): Promise<ParsedArchive> {
  const entries = await new Promise<Record<string, Uint8Array>>((resolve, reject) => {
    unzip(data, (err, out) => (err ? reject(err) : resolve(out)));
  });

  const readJson = <T,>(name: string, fallback: T): T => {
    const raw = entries[name];
    if (!raw) return fallback;
    try {
      return JSON.parse(strFromU8(raw)) as T;
    } catch {
      throw new Error(`备份包里的 ${name} 不是合法 JSON，文件可能损坏了`);
    }
  };

  const manifest = readJson<ArchiveManifest | null>('manifest.json', null);
  if (!manifest || manifest.kind !== 'nexus-archive') {
    throw new Error('这不是 Nexus 的完整备份包（缺少 manifest.json）');
  }
  if (manifest.version > ARCHIVE_VERSION) {
    throw new Error(
      `备份包是 v${manifest.version} 的，当前版本只认到 v${ARCHIVE_VERSION}。请先升级再导入。`,
    );
  }

  const chunkMetas = readJson<ChunkMeta[]>('knowledge/chunks.json', []);
  const vectors = unpackVectors(
    entries['knowledge/vectors.bin'] ?? new Uint8Array(0),
    chunkMetas.map((c) => c.dim),
  );

  const payload: ArchivePayload = {
    settings: readJson<Settings>('settings.json', {
      profiles: [],
      activeProfileId: '',
      systemPrompt: '',
      contextLimit: 0,
    }),
    graphs: readJson<Graph[]>('graphs.json', []),
    attachments: readJson<AttachmentMeta[]>('attachments.json', []).flatMap((meta) => {
      const bytes = entries[`attachments/${meta.id}`];
      // 元数据在、字节没了：宁可少一个附件，也不要造一个打不开的空文件
      if (!bytes) return [];
      return [{ ...meta, blob: new Blob([bytes as BlobPart], { type: meta.mime }) }];
    }),
    knowledgeFiles: readJson<KnowledgeFile[]>('knowledge/files.json', []),
    knowledgeChunks: chunkMetas.map(({ dim: _dim, ...meta }, i) => ({
      ...meta,
      embedding: vectors[i] ?? new Float32Array(0),
    })),
  };

  return { manifest, payload, mismatches: compareCounts(manifest.counts, countPayload(payload)) };
}

const COUNT_LABEL: Record<keyof ArchiveCounts, string> = {
  graphs: '画布',
  nodes: '节点',
  attachments: '附件',
  attachmentBytes: '附件字节数',
  knowledgeFiles: '知识库文件',
  knowledgeChunks: '知识库切块',
};

/**
 * 对一遍清单里写的数量和实际解出来的。
 *
 * 备份最怕的不是导入失败，是**导入成功但少了东西** —— 少了什么要过很久
 * 才会被发现，那时原始数据可能已经没了。宁可当场吵一句。
 */
export function compareCounts(declared: ArchiveCounts, actual: ArchiveCounts): string[] {
  const out: string[] = [];
  for (const key of Object.keys(COUNT_LABEL) as (keyof ArchiveCounts)[]) {
    if (declared[key] !== actual[key]) {
      out.push(`${COUNT_LABEL[key]}：清单写 ${declared[key]}，实际 ${actual[key]}`);
    }
  }
  return out;
}

export function archiveFilename(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `nexus-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.nexus.zip`;
}
