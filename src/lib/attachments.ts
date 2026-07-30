import type { AttachmentKind, ContentPart } from '../types';
import { detectKind } from './parsers';

/**
 * 视觉模型普遍认得的四种图片格式。
 *
 * 刻意不放 svg：它是可执行的 XML，各家处理不一，而且真要送进模型也得先栅格化。
 * heic 也不放 —— 浏览器解不了，送过去多半是一坨认不出的字节。
 */
export const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

/**
 * 单张图的体积上限。
 *
 * 各家上限不一（OpenAI 20MB、Anthropic 5MB），这里取偏保守的一档：
 * 与其让用户等一次上传再收到看不懂的 413，不如当场拦住说清楚。
 */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** 单个文本附件展开后的字数上限，超了截断并注明 —— 免得一份长文档把上下文顶爆 */
export const MAX_TEXT_CHARS = 20000;

export function detectAttachmentKind(file: { name: string; type: string }): AttachmentKind | null {
  if (IMAGE_TYPES.has(file.type)) return 'image';
  return detectKind(file.name) ? 'text' : null;
}

/** 已经取好 data URI、可以直接发出去的附件 */
export interface ResolvedAttachment {
  id: string;
  name: string;
  kind: AttachmentKind;
  /** 图片才有：data:image/png;base64,… */
  dataUrl?: string;
  /** 文本才有：解析出的正文 */
  text?: string;
}

/**
 * 一段文本附件在消息里长什么样。
 *
 * 标出文件名并且说明这是附件而不是用户自己打的字 —— 否则模型容易把
 * 文档内容当成提问的一部分，回答时张冠李戴。和知识库那边是同一个道理。
 */
function textBlock(name: string, text: string): string {
  const body = text.length > MAX_TEXT_CHARS ? `${text.slice(0, MAX_TEXT_CHARS)}\n\n…（后续内容已截断）` : text;
  return `【附件《${name}》的内容】\n${body.trim()}`;
}

/**
 * 把节点正文和它的附件拼成要发出去的消息内容。
 *
 * 没有图片时**返回纯字符串**，不是只有一段 text 的数组 —— 这一条很要紧：
 * 不支持多模态的服务端（本机 llama.cpp 的多数模型、以及不少国内接口）
 * 收到数组形式会直接报错。没有图片就完全保持原来的行为。
 */
export function buildUserContent(
  text: string,
  attachments: ResolvedAttachment[] = [],
): string | ContentPart[] {
  const texts = attachments.filter((a) => a.kind === 'text' && a.text?.trim());
  const images = attachments.filter((a) => a.kind === 'image' && a.dataUrl);

  // 文本附件放在提问**前面**：先给材料再提要求，模型照着答更稳
  const merged = [...texts.map((a) => textBlock(a.name, a.text!)), text.trim()]
    .filter(Boolean)
    .join('\n\n');

  if (images.length === 0) return merged;

  const parts: ContentPart[] = [];
  if (merged) parts.push({ type: 'text', text: merged });
  for (const image of images) {
    parts.push({ type: 'image_url', image_url: { url: image.dataUrl! } });
  }
  return parts;
}

/** 内容里的纯文字部分，用于 token 估算、搜索、导出这些只关心文字的地方 */
export function contentToText(content: string | ContentPart[]): string {
  if (typeof content === 'string') return content;
  return content
    .filter((p): p is Extract<ContentPart, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join('\n');
}

/** 内容里有几张图 */
export function countImages(content: string | ContentPart[]): number {
  if (typeof content === 'string') return 0;
  return content.filter((p) => p.type === 'image_url').length;
}

/**
 * 挑出没有主人的附件。
 *
 * **删节点的那一刻不能挑。** 删节点是可撤销的，⌘Z 之后节点以原来的 id 回来，
 * 附件按 nodeId 挂着就自动接上了 —— 前提是那会儿它还在。节点删了还躺在
 * 撤销栈里，附件是二进制原件，删了就真没了。
 *
 * 所以调用时机是**撤销历史刚被丢弃**：切画布、新建画布、启动。
 * 那之后再没有什么能把节点变回来，剩下的孤儿才是真孤儿。
 */
export function orphanAttachmentIds(
  attachments: { id: string; nodeId: string }[],
  liveNodeIds: Set<string>,
): string[] {
  return attachments.filter((a) => !liveNodeIds.has(a.nodeId)).map((a) => a.id);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Blob → data URI。发请求前才调，平时二进制原样躺在 IndexedDB 里 */
export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('读不出附件内容'));
    reader.readAsDataURL(blob);
  });
}
